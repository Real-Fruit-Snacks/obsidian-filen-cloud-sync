/**
 * filen-cloud-sync — two-way sync between an Obsidian vault and Filen
 * (zero-knowledge E2EE cloud). Desktop + mobile. See the design docs.
 */

import {
	App,
	debounce,
	Debouncer,
	Modal,
	Notice,
	Platform,
	Plugin,
	setIcon,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import { setDebugLogging } from "./debug";
import { FilenClient } from "./filen/client";
import type { StoredCredentials } from "./filen/types";
import { obsidianHttp } from "./http";
import { defaultSettings, FilenSyncSettings, FilenSyncSettingTab, resolveRemoteFolder } from "./settings";
import { errMsg, SyncEngine, SyncRunResult } from "./sync/engine";
import { SyncLog } from "./sync/log";
import type { MergeDecision } from "./sync/planner";
import { SharedPrefsSync } from "./sync/sharedPrefsSync";
import { clearDeviceId, clearLog, clearState, loadCredentials, loadDeviceId, loadState } from "./sync/state";
import { ConflictMergeModal } from "./ui/conflictMerge";
import { DashboardDeps, FilenSyncDashboardView, VIEW_TYPE_FILEN_DASHBOARD } from "./ui/dashboard";
import { DryRunModal } from "./ui/dryRun";
import { ExplorerDecorations } from "./ui/explorerDecorations";
import { SyncProgressModal } from "./ui/progress";
import { runSelfTest, SelfTestModal } from "./ui/selfTest";
import { UnlockModal } from "./ui/unlock";
import { VersionHistoryModal } from "./ui/versions";
import { friendlyError, normalizeVaultPath, relativeTime, setDestructiveCompat } from "./util";

export default class FilenSyncPlugin extends Plugin {
	settings!: FilenSyncSettings;
	private client!: FilenClient;
	private engine!: SyncEngine;
	private sharedPrefs!: SharedPrefsSync;
	private syncLog!: SyncLog;
	private statusBarItem: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private debouncedSyncOnSave!: Debouncer<[], void>;
	private lastSyncResult: SyncRunResult | null = null;
	private lastSyncFinishedAt: number | null = null;
	private autoSyncIntervalId: number | null = null;
	/** Feature C: credentials held only in memory (never persisted). */
	private memoryCredentials: StoredCredentials | null = null;
	private lockedNoticeShown = false;
	/** v0.6.0 feature D: file-explorer "changed since last sync" dots. */
	private explorerDecorations!: ExplorerDecorations;

	async onload(): Promise<void> {
		this.settings = Object.assign(
			{},
			defaultSettings(this.app.vault.getName()),
			await this.loadData() as Partial<FilenSyncSettings> | null,
		);

		setDebugLogging(this.settings.debugLog);
		this.syncLog = new SyncLog(this.app, () => this.settings.debugLog);
		this.client = new FilenClient(obsidianHttp);
		this.engine = new SyncEngine(
			this.app,
			this.client,
			() => this.settings,
			() => this.memoryCredentials ?? loadCredentials(this.app),
			this.syncLog,
			message => this.friendlyNotice(message),
			// v0.4.0 feature E: ask-mode conflicts pause the run on this modal.
			request => new Promise<MergeDecision>(resolve => {
				new ConflictMergeModal(this.app, request, resolve).open();
			}),
		);

		// v0.5.0: opt-in shared settings (glue — pure logic in sync/sharedPrefs*).
		this.sharedPrefs = new SharedPrefsSync({
			client: this.client,
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			getCredentials: () => this.memoryCredentials ?? loadCredentials(this.app),
			deviceId: () => loadDeviceId(this.app),
			log: this.syncLog,
			notify: message => this.friendlyNotice(message),
		});

		this.debouncedSyncOnSave = debounce(() => {
			void this.runSync({ manual: false });
		}, 5000, true);

		// v0.6.0 feature D: explorer "changed since last sync" indicators.
		// Created + started here (registered lifecycle); vault listeners are
		// attached inside onLayoutReady below, disposed in onunload.
		this.explorerDecorations = new ExplorerDecorations();
		this.explorerDecorations.start();

		this.addSettingTab(new FilenSyncSettingTab(this.app, this));

		// v0.4.0 feature F: status dashboard (right sidebar).
		this.registerView(
			VIEW_TYPE_FILEN_DASHBOARD,
			leaf => new FilenSyncDashboardView(leaf, this.makeDashboardDeps()),
		);

		this.addCommand({
			id: "open-sync-dashboard",
			name: "Open sync dashboard",
			callback: () => void this.toggleDashboard(),
		});
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.runSync({ manual: true }),
		});
		this.addCommand({
			id: "sync-now-ignore-guard",
			name: "Sync now (ignore mass-change guard)",
			callback: () => void this.runSync({ manual: true, ignoreMassChangeGuard: true }),
		});
		this.addCommand({
			id: "preview-sync-plan",
			name: "Preview sync plan (dry run)",
			callback: () => void this.runSync({ manual: true, dryRun: true }),
		});
		this.addCommand({
			id: "unlock-sync",
			name: "Unlock sync",
			callback: () => {
				if (!this.settings.memoryOnlyCredentials) {
					new Notice("Memory-only mode is off — connect in settings instead");
					return;
				}
				if (!this.isLocked()) {
					new Notice("Filen Cloud Sync is already unlocked");
					return;
				}
				this.openUnlockModal();
			},
		});
		this.addCommand({
			id: "browse-version-history",
			name: "Browse version history",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice("Filen Cloud Sync: open a file first");
					return;
				}
				void this.openVersionHistory(file);
			},
		});
		this.addCommand({
			id: "reset-local-sync-state",
			name: "Reset local sync state",
			callback: () => {
				clearState(this.app);
				clearLog(this.app);
				clearDeviceId(this.app);
				this.syncLog.clear();
				new Notice("Filen Cloud Sync state reset — next sync runs as a fresh seed");
			},
		});
		this.addCommand({
			id: "show-sync-log",
			name: "Show sync log",
			callback: () => new SyncLogModal(this.app, this.syncLog, () => this.lastRunSummary()).open(),
		});
		this.addCommand({
			id: "run-self-test",
			name: "Run self-test",
			callback: () => this.openSelfTest(),
		});

		// Right-click a folder → ignore/un-ignore (feature A); right-click a
		// file → version history (feature B).
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFolder) {
				const path = normalizeVaultPath(file.path);
				if (path.length === 0) return;
				const ignored = this.settings.ignoredFolders.includes(path);
				menu.addItem(item => item
					.setTitle(ignored ? "Remove from Filen ignore list" : "Ignore in Filen Cloud Sync")
					.setIcon("cloud-off")
					.onClick(() => {
						if (ignored) {
							this.settings.ignoredFolders =
								this.settings.ignoredFolders.filter(folder => folder !== path);
						} else {
							this.settings.ignoredFolders.push(path);
						}
						void this.saveSettings();
						this.onSharedSettingChanged(); // ignoredFolders is a shared key
					}));
				return;
			}
			if (file instanceof TFile) {
				menu.addItem(item => item
					.setTitle("Filen version history")
					.setIcon("history")
					.onClick(() => void this.openVersionHistory(file)));
			}
		}));

		this.ribbonEl = this.addRibbonIcon(
			this.isLocked() ? "lock" : "cloud",
			this.isLocked() ? "Filen Cloud Sync: unlock" : "Filen Cloud Sync: dashboard",
			() => {
				// Locked keeps the unlock behavior; otherwise the ribbon toggles
				// the dashboard leaf (v0.4.0 feature F).
				if (this.isLocked()) this.openUnlockModal();
				else void this.toggleDashboard();
			},
		);

		if (Platform.isDesktopApp) {
			this.statusBarItem = this.addStatusBarItem();
			this.statusBarItem.addClass("filen-cloud-sync-statusbar");
			this.updateStatusBar("idle");
		}

		// Guard 7: vault listeners ONLY inside onLayoutReady (create fires for
		// every file at load).
		this.app.workspace.onLayoutReady(() => {
			void this.engine.cleanupStrayTmpFiles();
			this.registerEvent(this.app.vault.on("create", file => this.onVaultChange(file)));
			this.registerEvent(this.app.vault.on("modify", file => this.onVaultChange(file)));
			// v0.6.0 feature D: local file edits mark the explorer row dirty
			// (folders have no file-title row; only TFiles are decorated).
			this.registerEvent(this.app.vault.on("create", file => {
				if (file instanceof TFile) this.explorerDecorations.mark(file.path);
			}));
			this.registerEvent(this.app.vault.on("modify", file => {
				if (file instanceof TFile) this.explorerDecorations.mark(file.path);
			}));
			this.registerEvent(this.app.vault.on("delete", file => this.onVaultChange(file)));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
				this.syncLog.info(`renamed ${oldPath} → ${file.path}`);
				this.onVaultChange(file);
			}));
			this.rescheduleAutoSync();
			if (this.settings.autoSyncOnStart && (this.hasCredentials() || this.isLocked())) {
				void this.runSync({ manual: false });
			}
		});
	}

	onunload(): void {
		this.explorerDecorations?.dispose(); // v0.6.0 feature D
		this.syncLog.persist();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshDashboards();
	}

	/* ---------------- shared settings (v0.5.0) ---------------- */

	/** Settings-tab hook: one of the six shared keys changed locally. */
	onSharedSettingChanged(): void {
		this.sharedPrefs.onSharedKeyChanged();
	}

	/** Settings-tab hook: share-settings toggle off→on. False = revert. */
	async enableSharedSettings(): Promise<boolean> {
		return await this.sharedPrefs.enable();
	}

	/** Settings-tab hook: share-settings toggle →off (stops both directions). */
	disableSharedSettings(): void {
		this.sharedPrefs.disable();
	}

	/** Called by the settings tab after a successful connect. */
	onConnected(): void {
		if (this.settings.autoSyncOnStart) {
			void this.runSync({ manual: true });
		}
	}

	/* ---------------- memory-only credentials (feature C) ---------------- */

	getMemoryCredentials(): StoredCredentials | null {
		return this.memoryCredentials;
	}

	setMemoryCredentials(credentials: StoredCredentials | null): void {
		this.memoryCredentials = credentials;
		this.lockedNoticeShown = false;
		this.updateRibbon();
	}

	private hasCredentials(): boolean {
		return this.memoryCredentials !== null || loadCredentials(this.app) !== null;
	}

	/** Locked = memory-only on, no keys anywhere, but an account is configured. */
	private isLocked(): boolean {
		return this.settings.memoryOnlyCredentials
			&& this.memoryCredentials === null
			&& loadCredentials(this.app) === null
			&& this.settings.email.trim().length > 0;
	}

	private openUnlockModal(): void {
		new UnlockModal(this.app, this.settings.email, async (password, twoFactorCode) => {
			const credentials = await this.client.connect(
				this.settings.email.trim(), password, twoFactorCode,
			);
			const chain = resolveRemoteFolder(this.settings.remoteFolder, this.app.vault.getName());
			credentials.syncRootUuid = await this.client.ensureFolderChain(
				credentials.rootUuid, chain, loadDeviceId(this.app),
			);
			this.setMemoryCredentials(credentials);
			new Notice(`Filen Cloud Sync unlocked as ${this.settings.email}`);
			this.onConnected();
		}).open();
	}

	private updateRibbon(): void {
		if (!this.ribbonEl) return;
		const locked = this.isLocked();
		setIcon(this.ribbonEl, locked ? "lock" : "cloud");
		this.ribbonEl.setAttribute("aria-label", locked ? "Filen Cloud Sync: unlock" : "Filen Cloud Sync: dashboard");
	}

	/* ---------------- status dashboard (v0.4.0 feature F) ---------------- */

	/** Toggle the dashboard leaf in the right sidebar. */
	private async toggleDashboard(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_FILEN_DASHBOARD);
		if (existing.length > 0) {
			for (const leaf of existing) leaf.detach();
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_FILEN_DASHBOARD, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Dashboard refresh triggers: after each completed run (fetchQuota only
	 * after MANUAL syncs) and on settings save. No timers inside the view.
	 */
	private refreshDashboards(fetchQuota = false): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FILEN_DASHBOARD)) {
			const view = leaf.view;
			if (view instanceof FilenSyncDashboardView) void view.refresh(fetchQuota);
		}
	}

	private makeDashboardDeps(): DashboardDeps {
		return {
			getConnection: () => {
				const remoteFolder = resolveRemoteFolder(
					this.settings.remoteFolder, this.app.vault.getName(),
				);
				const credentials = this.memoryCredentials ?? loadCredentials(this.app);
				if (credentials) return { status: "connected", email: credentials.email, remoteFolder };
				if (this.isLocked()) return { status: "locked", email: this.settings.email, remoteFolder };
				return { status: "disconnected", remoteFolder };
			},
			getLastRun: () => this.lastRunSummary(),
			getQuota: async () => {
				const credentials = this.memoryCredentials ?? loadCredentials(this.app);
				if (!credentials) return null;
				this.client.setCredentials(credentials);
				const account = await this.client.userAccount();
				return { storage: account.storage, maxStorage: account.maxStorage };
			},
			onSyncNow: () => void this.runSync({ manual: true }),
			onPreviewPlan: () => void this.runSync({ manual: true, dryRun: true }),
			onSelfTest: () => this.openSelfTest(),
			onOpenSettings: () => {
				// App.setting is public API in practice but not in the typings.
				const setting = (this.app as unknown as {
					setting?: { open(): void; openTabById(id: string): void };
				}).setting;
				setting?.open();
				setting?.openTabById("filen-cloud-sync");
			},
			onShowLog: () => new SyncLogModal(this.app, this.syncLog, () => this.lastRunSummary()).open(),
		};
	}

	/* ---------------- version history (feature B) ---------------- */

	private async openVersionHistory(file: TFile): Promise<void> {
		const credentials = this.memoryCredentials ?? loadCredentials(this.app);
		if (!credentials) {
			new Notice("Filen Cloud Sync: not connected — connect your Filen account in settings");
			return;
		}
		const path = normalizeVaultPath(file.path);
		const record = loadState(this.app).files[path];
		if (!record) {
			const message = `${path} is not synced yet — sync first`;
			this.syncLog.warn(`version history: ${message}`);
			new Notice(`Filen Cloud Sync: ${message}`);
			return;
		}
		this.client.setCredentials(credentials);
		try {
			const { versions } = await this.client.fileVersions(record.remoteUuid);
			new VersionHistoryModal(
				this.app, file, versions, record.remoteUuid, this.client, this.syncLog,
				() => this.engine.isRunning,
			).open();
		} catch (e) {
			const message = `could not load versions for ${path}: ${errMsg(e)}`;
			this.syncLog.error(message);
			new Notice(`Filen Cloud Sync: ${message}`);
		}
	}

	/* ---------------- self-test (v0.4.0 feature B) ---------------- */

	private openSelfTest(): void {
		const credentials = this.memoryCredentials ?? loadCredentials(this.app);
		if (!credentials) {
			new Notice("Filen Cloud Sync: not connected — connect your Filen account in settings");
			return;
		}
		this.client.setCredentials(credentials);
		const deviceId = loadDeviceId(this.app);
		new SelfTestModal(this.app, onStage => runSelfTest(this.client, {
			rootUuid: credentials.rootUuid,
			deviceId,
			log: this.syncLog,
			onStage,
		})).open();
	}

	/* ---------------- scheduling ---------------- */

	rescheduleAutoSync(): void {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
		const minutes = this.settings.syncIntervalMinutes;
		if (minutes >= 1 && this.settings.autoSyncInterval) {
			this.autoSyncIntervalId = window.setInterval(() => {
				if (this.hasCredentials() || this.isLocked()) void this.runSync({ manual: false });
			}, minutes * 60000);
			this.registerInterval(this.autoSyncIntervalId);
		}
	}

	private onVaultChange(file: TAbstractFile): void {
		if (!this.settings.syncOnSave) return;
		if (file.path.endsWith(".filen-tmp")) return;
		if (!this.hasCredentials()) return;
		this.debouncedSyncOnSave();
	}

	private lastRunSummary(): {
		finishedAt: number;
		status: string;
		message: string;
		conflicts: string[];
		skippedCount: number;
	} | null {
		if (!this.lastSyncResult || this.lastSyncFinishedAt === null) return null;
		return {
			finishedAt: this.lastSyncFinishedAt,
			status: this.lastSyncResult.status,
			message: this.lastSyncResult.message,
			conflicts: this.lastSyncResult.plan?.conflicts.map(conflict => conflict.path) ?? [],
			skippedCount: this.lastSyncResult.skippedCount ?? 0,
		};
	}

	/**
	 * User-facing notices get plain-language titles + a next step (v0.5.2);
	 * the raw detailed message stays in the sync log for debugging.
	 */
	private friendlyNotice(rawMessage: string, prefix?: string): void {
		const friendly = friendlyError(rawMessage);
		const lead = prefix ? `${prefix}: ` : "Filen Cloud Sync: ";
		new Notice(friendly.hint ? `${lead}${friendly.title} — ${friendly.hint}` : `${lead}${friendly.title}`);
	}

	private async runSync(options: {
		manual: boolean;
		ignoreMassChangeGuard?: boolean;
		dryRun?: boolean;
	}): Promise<void> {
		if (this.isLocked()) {
			// Locked: one Notice per manual run, and only the first auto run —
			// no retry spam while locked.
			if (options.manual || !this.lockedNoticeShown) {
				new Notice("Filen Cloud Sync is locked — run the 'Unlock sync' command");
				this.lockedNoticeShown = true;
			}
			return;
		}
		if (options.manual && this.engine.isRunning) {
			// Join the single-flight queue without opening a second (dead) modal.
			new Notice("Filen Cloud Sync already running — queued");
			void this.engine.run(options);
			return;
		}
		if (options.dryRun) {
			// v0.6.0 feature A: plan preview — NO progress modal and NO sticky
			// notice; the plan opens in the DryRunModal instead. A dry run is
			// not a real run: lastSyncResult/dashboard stay untouched.
			this.updateStatusBar("running");
			try {
				const result = await this.engine.run(options);
				this.updateStatusBar(result.status === "error" ? "error" : "idle");
				if (result.status === "dry-run" && result.plan) {
					new DryRunModal(
						this.app,
						result.plan,
						result.guardWouldAbort ?? false,
						() => void this.runSync({ manual: true }),
					).open();
				} else if (result.status === "error") {
					this.friendlyNotice(result.message, "Filen Cloud Sync failed");
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				this.syncLog.error(`dry run crashed: ${message}`);
				new Notice(`Filen Cloud Sync failed: ${message}`);
				this.updateStatusBar("error");
			}
			return;
		}
		// Progress modal: manual runs only — auto runs stay silent (feature E).
		const modal = options.manual
			? new SyncProgressModal(
				this.app, this.syncLog,
				() => new SyncLogModal(this.app, this.syncLog, () => this.lastRunSummary()).open(),
			)
			: null;
		modal?.open();
		this.updateStatusBar("running");
		const previousStatus = this.lastSyncResult?.status ?? null;
		try {
			const result = await this.engine.run({
				...options,
				onProgress: modal ? progress => modal.update(progress) : undefined,
				isCancelled: modal ? () => modal.isCancelRequested : undefined,
			});
			this.lastSyncResult = result;
			this.lastSyncFinishedAt = Date.now();
			if (modal) {
				const clean = (result.status === "ok" || result.status === "empty")
					&& (result.opFailures ?? 0) === 0
					&& (result.plan?.conflicts.length ?? 0) === 0;
				modal.finish(result.message, clean);
				if (result.status === "error") this.friendlyNotice(result.message, "Filen Cloud Sync failed");
				else if (result.status === "aborted") this.friendlyNotice(result.message, "Filen Cloud Sync aborted");
			} else if (result.status === "error") {
				// Auto runs: surface a Notice only on the ok→error transition
				// (rate-limited, not every failing run); status bar always updates.
				if (previousStatus !== "error") this.friendlyNotice(result.message, "Filen Cloud Sync failed");
			}
			this.updateStatusBar(result.status === "error" ? "error" : "idle");
			// v0.5.0: post-run shared-prefs check on the run's own remote tree
			// (no extra API call). Failures here must never fail the sync.
			if (result.status === "ok" || result.status === "empty") {
				try {
					await this.sharedPrefs.afterRun(result.remoteTree ?? null);
				} catch (e) {
					this.syncLog.warn(`shared settings check failed: ${errMsg(e)}`);
				}
				// v0.6.0 feature D: a fully successful run clears the explorer
				// "changed since last sync" marks (documented choice: main.ts
				// clears after runSync — the engine stays UI-free).
				this.explorerDecorations.clear();
			}
			// Dashboard: refresh after each completed run; quota refetch only
			// after manual syncs (v0.4.0 feature F).
			this.refreshDashboards(options.manual);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.syncLog.error(`sync crashed: ${message}`);
			modal?.finish(`failed: ${message}`, false);
			if (options.manual || previousStatus !== "error") new Notice(`Filen Cloud Sync failed: ${message}`);
			this.lastSyncResult = { status: "error", message };
			this.lastSyncFinishedAt = Date.now();
			this.updateStatusBar("error");
			this.refreshDashboards(options.manual);
		}
	}

	private updateStatusBar(state: "idle" | "running" | "error"): void {
		if (!this.statusBarItem) return;
		this.statusBarItem.removeClass("filen-cloud-sync-error");
		if (state === "running") {
			this.statusBarItem.setText("Filen: syncing…");
		} else if (state === "error") {
			this.statusBarItem.addClass("filen-cloud-sync-error");
			const detail = this.lastSyncResult ? ` — ${this.lastSyncResult.message}` : "";
			this.statusBarItem.setText("Filen: error");
			this.statusBarItem.setAttribute("aria-label", `Filen Cloud Sync error${detail}`);
		} else {
			this.statusBarItem.setText("Filen: idle");
			if (this.lastSyncResult) {
				this.statusBarItem.setAttribute("aria-label", `Filen Cloud Sync: ${this.lastSyncResult.message}`);
			}
		}
	}
}

class SyncLogModal extends Modal {
	constructor(
		app: App,
		private readonly log: SyncLog,
		private readonly getLastRun: () => { finishedAt: number; status: string; message: string } | null,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Filen Cloud Sync log");
		this.render();
	}

	private render(): void {
		this.contentEl.empty();

		// Header: last-run summary + actions.
		const lastRun = this.getLastRun();
		if (lastRun) {
			const summary = this.contentEl.createDiv({ cls: "filen-cloud-sync-log-summary" });
			summary.setText(`Last sync: ${relativeTime(lastRun.finishedAt)} — ${lastRun.message}`);
		}
		new Setting(this.contentEl)
			.addButton(button => button
				.setButtonText("Copy log")
				.onClick(() => {
					void navigator.clipboard.writeText(this.log.render());
					new Notice("Log copied — paste it anywhere to share");
				}))
			.addButton(button => {
				setDestructiveCompat(button);
				button.setButtonText("Clear log")
					.onClick(() => {
						this.log.clear();
						this.render();
					});
			})
			.addButton(button => button
				.setButtonText("Close")
				.onClick(() => this.close()));

		const view = this.contentEl.createDiv({ cls: "filen-cloud-sync-log-view" });
		const entries = this.log.getEntries();
		if (entries.length === 0) {
			view.setText("Nothing logged yet — run a sync and entries will appear here.");
			return;
		}
		for (const entry of entries.slice().reverse()) {
			const line = view.createDiv({ cls: "filen-cloud-sync-log-entry" });
			if (entry.level === "error") line.addClass("filen-cloud-sync-log-error");
			if (entry.level === "warn" || entry.level === "conflict") line.addClass("filen-cloud-sync-log-warn");
			line.setText(
				`${new Date(entry.ts).toLocaleString()}  ${entry.level.toUpperCase()}  ${entry.message}`,
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
