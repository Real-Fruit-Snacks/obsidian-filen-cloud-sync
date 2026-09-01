/**
 * Status dashboard (v0.4.0 feature F): right-sidebar ItemView with the
 * connection state, last run summary, conflicts from the last plan,
 * skipped/excluded counts, account storage quota, and action buttons.
 * Refreshes ONLY on: open, after each completed run (engine→plugin callback)
 * and on settings save — no live timers inside the view. Quota is fetched on
 * open and after manual syncs; a failure shows "quota unavailable".
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import { formatQuota, relativeTime } from "../util";

export const VIEW_TYPE_FILEN_DASHBOARD = "filen-sync-dashboard";

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
	onSyncNow: () => void;
	/** v0.6.0 feature A: dry-run plan preview. */
	onPreviewPlan: () => void;
	onSelfTest: () => void;
	onOpenSettings: () => void;
	onShowLog: () => void;
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
		return "Filen sync";
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
		root.createEl("h4", { cls: "filen-sync-dashboard-heading" }).setText(title);
		return root.createDiv({ cls: "filen-sync-dashboard-section" });
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("filen-sync-dashboard");

		/* ---- Connection ---- */
		const connection = this.deps.getConnection();
		const connectionEl = this.section(root, "Connection");
		if (connection.status === "connected") {
			connectionEl.createDiv().setText(`Connected as ${connection.email}`);
		} else if (connection.status === "locked") {
			connectionEl.createDiv().setText(`Locked — unlock to sync (${connection.email})`);
		} else {
			connectionEl.createDiv().setText("Not connected — connect your account in settings");
		}
		connectionEl.createDiv({ cls: "filen-sync-dashboard-muted" })
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
			runEl.createDiv({ cls: "filen-sync-dashboard-muted" }).setText(lastRun.message);
		}

		/* ---- Conflicts ---- */
		const conflictsEl = this.section(root, "Conflicts");
		const conflicts = lastRun?.conflicts ?? [];
		if (conflicts.length === 0) {
			conflictsEl.setText("None in the last plan.");
		} else {
			for (const path of conflicts) {
				conflictsEl.createDiv({ cls: "filen-sync-dashboard-conflict" }).setText(path);
			}
		}

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
			const bar = storageEl.createEl("progress", { cls: "filen-sync-dashboard-quota-bar" });
			bar.max = 1;
			bar.value = quota.ratio;
		}

		/* ---- Actions ---- */
		const buttons = root.createDiv({ cls: "filen-sync-dashboard-buttons" });
		this.addButton(buttons, "Sync now", () => this.deps.onSyncNow(), true);
		this.addButton(buttons, "Preview sync plan", () => this.deps.onPreviewPlan());
		this.addButton(buttons, "Run self-test", () => this.deps.onSelfTest());
		this.addButton(buttons, "Open settings", () => this.deps.onOpenSettings());
		this.addButton(buttons, "Show sync log", () => this.deps.onShowLog());
	}

	private addButton(container: HTMLElement, label: string, onClick: () => void, cta = false): void {
		const button = container.createEl("button", { cls: "filen-sync-dashboard-button" });
		if (cta) button.addClass("mod-cta");
		button.setText(label);
		button.addEventListener("click", onClick);
	}
}
