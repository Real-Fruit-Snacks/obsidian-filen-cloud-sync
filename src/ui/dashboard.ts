/**
 * Status dashboard (v0.4.0 feature F): right-sidebar ItemView with the
 * connection state, last run summary, conflicts from the last plan,
 * skipped/excluded counts, account storage quota, and action buttons.
 * Refreshes ONLY on: open, after each completed run (engine→plugin callback)
 * and on settings save — no live timers inside the view. Quota is fetched on
 * open and after manual syncs; a failure shows "quota unavailable".
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type { SyncDirection } from "../sync/types";
import { formatQuota, relativeTime } from "../util";
import { ConfirmModal } from "./confirm";

export const VIEW_TYPE_FILEN_DASHBOARD = "filen-cloud-sync-dashboard";

export type DashboardConnection =
	| { status: "connected"; email: string; remoteFolder: string }
	| { status: "locked"; email: string; remoteFolder: string }
	| { status: "disconnected"; remoteFolder: string };

export interface DashboardLastRun {
	finishedAt: number; // ms epoch
	status: string;
	message: string;
	/** Conflict paths from the last plan (empty = none). */
	conflicts: string[];
	/** Skipped + excluded paths from the last local scan. */
	skippedCount: number;
}

export interface DashboardDeps {
	getConnection: () => DashboardConnection;
	getLastRun: () => DashboardLastRun | null;
	/** Account quota; null → "quota unavailable" (failure or not connected). */
	getQuota: () => Promise<{ storage: number; maxStorage: number } | null>;
	/** v0.7.1 feature B: pause state for the banner + Pause/Resume button. */
	getSyncPaused: () => boolean;
	/** v0.7.1 feature A: the persisted default direction (for the note). */
	getSyncDirection: () => SyncDirection;
	/** v0.8.1 feature 2: offline state for the Connection section. */
	getOffline: () => boolean;
	/**
	 * v0.8.1 feature 8: "Next auto sync in ~N min" line (null = hidden).
	 * Composed by the plugin at render/refresh time — no timers in the view.
	 */
	getNextAutoSync: () => string | null;
	onSyncNow: () => void;
	/** v0.7.1 feature A: one-time direction overrides (never persisted). */
	onPushNow: () => void;
	onPullNow: () => void;
	/** v0.7.1 feature B: one-click pause/resume, persisted. */
	onSetPaused: (paused: boolean) => void;
	/** v0.6.0 feature A: dry-run plan preview. */
	onPreviewPlan: () => void;
	onSelfTest: () => void;
	onOpenSettings: () => void;
	onShowLog: () => void;
	/** v0.8.0 feature 1: open the conflict cleanup view. */
	onReviewConflicts: () => void;
}

export class FilenSyncDashboardView extends ItemView {
	private quota: { storage: number; maxStorage: number } | null = null;
	private quotaLoaded = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: DashboardDeps,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_FILEN_DASHBOARD;
	}

	getDisplayText(): string {
		return "Filen Cloud Sync";
	}

	getIcon(): string {
		return "cloud";
	}

	async onOpen(): Promise<void> {
		this.render();
		await this.refreshQuota();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}

	/** Plugin callback: re-render; refetch quota only when asked (manual sync). */
	async refresh(fetchQuota = false): Promise<void> {
		this.render();
		if (fetchQuota) await this.refreshQuota();
	}

	private async refreshQuota(): Promise<void> {
		const quota = await this.deps.getQuota().catch(() => null);
		this.quota = quota;
		this.quotaLoaded = true;
		this.render();
	}

	private section(root: HTMLElement, title: string): HTMLElement {
		root.createEl("h4", { cls: "filen-cloud-sync-dashboard-heading" }).setText(title);
		return root.createDiv({ cls: "filen-cloud-sync-dashboard-section" });
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("filen-cloud-sync-dashboard");

		/* ---- Pause state (v0.7.1 feature B) ---- */
		const paused = this.deps.getSyncPaused();
		if (paused) {
			const banner = root.createDiv({ cls: "filen-cloud-sync-paused-banner" });
			banner.createDiv({ cls: "filen-cloud-sync-paused-banner-text" })
				.setText("Syncing is paused");
			this.addButton(banner, "Resume", () => this.deps.onSetPaused(false), true);
		}

		/* ---- Connection ---- */
		const connection = this.deps.getConnection();

		// v0.8.1 feature 1: never connected → guided empty state INSTEAD of
		// the (all-empty) sections: a 3-step checklist with buttons.
		if (connection.status === "disconnected") {
			this.renderGetStarted(root, connection.remoteFolder);
			return;
		}

		const connectionEl = this.section(root, "Connection");
		if (connection.status === "connected") {
			connectionEl.createDiv().setText(`Connected as ${connection.email}`);
		} else if (connection.status === "locked") {
			connectionEl.createDiv().setText(`Locked — unlock to sync (${connection.email})`);
		}
		// v0.8.1 feature 2: offline state in the Connection section.
		if (this.deps.getOffline()) {
			connectionEl.createDiv({ cls: "filen-cloud-sync-dashboard-offline" })
				.setText("Offline — sync resumes when you're back");
		}
		connectionEl.createDiv({ cls: "filen-cloud-sync-dashboard-muted" })
			.setText(`Remote folder: ${connection.remoteFolder}`);

		/* ---- Last run ---- */
		const lastRun = this.deps.getLastRun();
		const runEl = this.section(root, "Last run");
		if (!lastRun) {
			runEl.setText("No sync run yet this session.");
		} else {
			const line = runEl.createDiv();
			line.setText(`${relativeTime(lastRun.finishedAt)} — ${lastRun.status}`);
			// Absolute timestamp on hover for precision.
			line.setAttr("title", new Date(lastRun.finishedAt).toLocaleString());
			runEl.createDiv({ cls: "filen-cloud-sync-dashboard-muted" }).setText(lastRun.message);
		}
		// v0.8.1 feature 8: muted "Next auto sync in ~N min" line (hidden when
		// paused/off/disconnected — the composer returns null then).
		const nextAutoSync = this.deps.getNextAutoSync();
		if (nextAutoSync) {
			runEl.createDiv({ cls: "filen-cloud-sync-dashboard-muted" }).setText(nextAutoSync);
		}

		/* ---- Conflicts ---- */
		const conflictsEl = this.section(root, "Conflicts");
		const conflicts = lastRun?.conflicts ?? [];
		if (conflicts.length === 0) {
			conflictsEl.setText("None in the last plan.");
		} else {
			for (const path of conflicts) {
				conflictsEl.createDiv({ cls: "filen-cloud-sync-dashboard-conflict" }).setText(path);
			}
		}
		// v0.8.0 feature 1: the cleanup view lists every conflict copy still in
		// the vault (not just the last plan's) with open/delete actions.
		this.addButton(conflictsEl, "Review conflict copies", () => this.deps.onReviewConflicts());

		/* ---- Skipped / excluded ---- */
		const skippedEl = this.section(root, "Skipped / excluded");
		skippedEl.setText(
			lastRun
				? `${lastRun.skippedCount} path(s) skipped or excluded in the last local scan`
				: "—",
		);

		/* ---- Storage ---- */
		const storageEl = this.section(root, "Storage");
		if (!this.quotaLoaded) {
			storageEl.setText("Loading quota…");
		} else if (!this.quota) {
			storageEl.setText("Quota unavailable");
		} else {
			const quota = formatQuota(this.quota.storage, this.quota.maxStorage);
			storageEl.createDiv().setText(quota.text);
			const bar = storageEl.createEl("progress", { cls: "filen-cloud-sync-dashboard-quota-bar" });
			bar.max = 1;
			bar.value = quota.ratio;
		}

		/* ---- Actions ---- */
		const buttons = root.createDiv({ cls: "filen-cloud-sync-dashboard-buttons" });
		// One-time directional runs (v0.7.3): dropdown + single action button
		// instead of three easy-to-misclick buttons. Destructive directions
		// confirm before running. The persisted default direction is never
		// mutated by these runs.
		const runRow = buttons.createDiv({ cls: "filen-cloud-sync-dashboard-runrow" });
		const select = runRow.createEl("select", { cls: "dropdown filen-cloud-sync-dashboard-select" });
		for (const [value, label] of [
			["twoWay", "Two-way sync"],
			["push", "Push — overwrite cloud"],
			["pull", "Pull — overwrite this device"],
		] as Array<[SyncDirection, string]>) {
			const opt = select.createEl("option");
			opt.value = value;
			opt.textContent = label;
		}
		select.value = this.deps.getSyncDirection();
		const runBtn = runRow.createEl("button", { cls: "filen-cloud-sync-dashboard-button mod-cta" });
		runBtn.setText("Sync now");
		runBtn.addEventListener("click", () => {
			const choice = select.value as SyncDirection;
			if (choice === "twoWay") this.deps.onSyncNow();
			else this.confirmOneTimeRun(choice);
		});
		buttons.createDiv({ cls: "filen-cloud-sync-dashboard-muted" })
			.setText(
				`Default direction: ${directionLabel(this.deps.getSyncDirection())}. `
				+ "One-time run uses the dropdown selection — the default is unchanged.",
			);
		// v0.7.1 feature B: Pause while running, Resume in the banner above.
		if (!paused) {
			this.addButton(buttons, "Pause", () => this.deps.onSetPaused(true));
		}
		this.addButton(buttons, "Preview sync plan", () => this.deps.onPreviewPlan());
		this.addButton(buttons, "Run self-test", () => this.deps.onSelfTest());
		this.addButton(buttons, "Open settings", () => this.deps.onOpenSettings());
		this.addButton(buttons, "Show sync log", () => this.deps.onShowLog());
	}

	/**
	 * v0.8.1 feature 1: guided empty state shown when there are no
	 * credentials anywhere — a "Get started" heading + three numbered steps
	 * with buttons. Steps 2 and 3 stay disabled until connected.
	 */
	private renderGetStarted(root: HTMLElement, remoteFolder: string): void {
		root.createEl("h4", { cls: "filen-cloud-sync-dashboard-heading" }).setText("Get started");
		const section = root.createDiv({ cls: "filen-cloud-sync-dashboard-section" });
		section.createDiv({ cls: "filen-cloud-sync-dashboard-muted" })
			.setText(`Remote folder: ${remoteFolder}`);

		const steps: Array<{ label: string; button: string; enabled: boolean; onClick: () => void }> = [
			{
				label: "Connect your Filen account",
				button: "Open settings",
				enabled: true,
				onClick: () => this.deps.onOpenSettings(),
			},
			{
				label: "Run self-test",
				button: "Run self-test",
				enabled: false, // until connected
				onClick: () => this.deps.onSelfTest(),
			},
			{
				label: "Sync now",
				button: "Sync now",
				enabled: false, // until connected
				onClick: () => this.deps.onSyncNow(),
			},
		];
		steps.forEach((step, index) => {
			const row = section.createDiv({ cls: "filen-cloud-sync-dashboard-step" });
			row.createSpan({ cls: "filen-cloud-sync-dashboard-step-number" })
				.setText(`${index + 1}.`);
			row.createSpan({ cls: "filen-cloud-sync-dashboard-step-label" }).setText(step.label);
			const button = row.createEl("button", { cls: "filen-cloud-sync-dashboard-button" });
			button.setText(step.button);
			button.disabled = !step.enabled;
			button.addEventListener("click", step.onClick);
		});
	}

	/** Push/pull one-time runs are destructive mirrors — confirm first (v0.7.3). */
	private confirmOneTimeRun(direction: "push" | "pull"): void {
		const isPush = direction === "push";
		new ConfirmModal(
			this.app,
			isPush ? "One-time push — overwrite the cloud?" : "One-time pull — overwrite this device?",
			isPush
				? "This run MIRRORS the vault to Filen: files changed on Filen are overwritten by your local copies, and files missing locally are trashed on Filen. Your default sync direction is unchanged."
				: "This run MIRRORS Filen to this vault: local changes are overwritten by the cloud versions, and files missing on Filen are trashed locally. Your default sync direction is unchanged.",
			isPush ? "Run push" : "Run pull",
			() => {
				if (isPush) this.deps.onPushNow();
				else this.deps.onPullNow();
			},
		).open();
	}

	private addButton(container: HTMLElement, label: string, onClick: () => void, cta = false): void {
		const button = container.createEl("button", { cls: "filen-cloud-sync-dashboard-button" });
		if (cta) button.addClass("mod-cta");
		button.setText(label);
		button.addEventListener("click", onClick);
	}
}

/** Display label for the persisted default direction (the one-time note). */
function directionLabel(direction: SyncDirection): string {
	switch (direction) {
		case "push": return "push";
		case "pull": return "pull";
		default: return "two-way";
	}
}
