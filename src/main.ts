/**
 * filen-cloud-sync — two-way sync between an Obsidian vault and Filen
 * (zero-knowledge E2EE cloud). Desktop + mobile. See the design docs.
 */

import {
	debounce,
	Debouncer,
	Notice,
	Platform,
	Plugin,
	setIcon,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import { setDebugLogging } from "./debug";
import { FilenClient } from "./filen/client";
import type { StoredCredentials } from "./filen/types";
import { obsidianHttp } from "./http";
import { defaultSettings, FilenSyncSettings, FilenSyncSettingTab, resolveRemoteFolder } from "./settings";
import { errMsg, SYNC_PAUSED_MESSAGE, SyncEngine, SyncRunResult } from "./sync/engine";
import { SyncLog } from "./sync/log";
import type { MergeDecision } from "./sync/planner";
import type { SyncDirection } from "./sync/types";
import { SharedPrefsSync } from "./sync/sharedPrefsSync";
import { clearDeviceId, clearLog, clearState, loadCredentials, loadDeviceId, loadState } from "./sync/state";
import { ConfirmModal } from "./ui/confirm";
import { ConflictMergeModal } from "./ui/conflictMerge";
import { ConflictReviewModal } from "./ui/conflictReview";
import { DashboardDeps, FilenSyncDashboardView, VIEW_TYPE_FILEN_DASHBOARD } from "./ui/dashboard";
import { DryRunModal } from "./ui/dryRun";
import { ExplorerDecorations } from "./ui/explorerDecorations";
import { SyncLogModal } from "./ui/logView";
import { SyncProgressModal } from "./ui/progress";
import { runSelfTest, SelfTestModal } from "./ui/selfTest";
import { UnlockModal } from "./ui/unlock";
import { VersionHistoryModal } from "./ui/versions";
import {
	backgroundChangeNotice,
	friendlyError,
	isNetworkError,
	nextAutoSyncText,
	normalizeVaultPath,
	NoticeThrottle,
	OfflineTracker,
	statusBarText,
} from "./util";

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
	private statusBarState: "idle" | "running" | "error" = "idle";
	/** Feature C: credentials held only in memory (never persisted). */
	private memoryCredentials: StoredCredentials | null = null;
	private lockedNoticeShown = false;
	/** v0.6.0 feature D: file-explorer "changed since last sync" dots. */
	private explorerDecorations!: ExplorerDecorations;
	/** v0.8.1 feature 2: offline state machine (in-memory). */
	private readonly offlineTracker = new OfflineTracker();
	/** v0.8.1 feature 3: identical background notices at most once per 15 min. */
	private readonly noticeThrottle = new NoticeThrottle();

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
			setTimer: (cb, ms) => window.setTimeout(cb, ms),
			clearTimer: id => window.clearTimeout(id),
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
		// v0.7.1 feature A: one-time direction overrides — the persisted
		// syncDirection setting is never mutated by these runs.
		this.addCommand({
			id: "push-now-one-time",
			name: "Push now (one-time)",
			callback: () => void this.runSync({ manual: true, direction: "push" }),
		});
		this.addCommand({
			id: "pull-now-one-time",
			name: "Pull now (one-time)",
			callback: () => void this.runSync({ manual: true, direction: "pull" }),
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
		// v0.8.0 feature 3: explicit one-file upload — works in ANY sync
		// direction (user intent beats the mode) and never opens the merge view.
		this.addCommand({
			id: "force-sync-current-file",
			name: "Force sync current file",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice("Filen Cloud Sync: open a file first");
					return;
				}
				void this.forceSyncFile(file);
			},
		});
		// v0.8.0 feature 1: conflict cleanup view.
		this.addCommand({
			id: "review-conflict-copies",
			name: "Review conflict copies",
			callback: () => new ConflictReviewModal(this.app).open(),
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
				// v0.8.0 feature 3: right-click a file → force upload.
				menu.addItem(item => item
					.setTitle("Force sync to Filen")
					.setIcon("upload-cloud")
					.onClick(() => void this.forceSyncFile(file)));
			}
		}));

		this.ribbonEl = this.addRibbonIcon(
			this.isLocked() ? "lock" : "cloud",
			this.ribbonLabel(),
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
			// v0.8.0 feature 4: refresh the idle relative timestamp every minute
			// (cheap; registerInterval auto-cleans on unload). No-op on mobile —
			// the status bar is hidden there anyway.
			this.registerInterval(window.setInterval(() => {
				if (this.statusBarState === "idle") this.updateStatusBar("idle");
			}, 60_000));
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

	/* ---------------- pause switch (v0.7.1 feature B) ---------------- */

	/**
	 * One-click pause/resume, persisted. Called by the dashboard Pause/Resume
	 * buttons and the settings-tab toggle. Pausing blocks every trigger path
	 * (engine-level guard); resuming restores normal operation.
	 */
	async setSyncPaused(paused: boolean): Promise<void> {
		this.settings.syncPaused = paused;
		await this.saveSettings(); // persists + refreshes dashboards
		this.updateStatusBar(this.statusBarState);
		this.updateRibbon();
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

	private ribbonLabel(): string {
		if (this.isLocked()) return "Filen Cloud Sync: unlock";
		// v0.7.1 feature B: the tooltip notes the paused state.
		if (this.settings.syncPaused) return "Filen Cloud Sync: dashboard (syncing paused)";
		return "Filen Cloud Sync: dashboard";
	}

	private updateRibbon(): void {
		if (!this.ribbonEl) return;
		const locked = this.isLocked();
		setIcon(this.ribbonEl, locked ? "lock" : "cloud");
		this.ribbonEl.setAttribute("aria-label", this.ribbonLabel());
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
			getSyncPaused: () => this.settings.syncPaused,
			getSyncDirection: () => this.settings.syncDirection,
			// v0.8.1 feature 2: offline state in the Connection section.
			getOffline: () => this.offlineTracker.isOffline(),
			// v0.8.1 feature 8: composed here (render/refresh only — no timers
			// in the view); hidden when paused/off/disconnected.
			getNextAutoSync: () => nextAutoSyncText({
				connected: this.hasCredentials(),
				paused: this.settings.syncPaused,
				autoSyncInterval: this.settings.autoSyncInterval,
				syncIntervalMinutes: this.settings.syncIntervalMinutes,
				lastSyncFinishedAt: this.lastSyncFinishedAt,
			}),
			onSyncNow: () => void this.runSync({ manual: true }),
			// v0.7.1 feature A: one-time direction overrides (no setting mutation).
			onPushNow: () => void this.runSync({ manual: true, direction: "push" }),
			onPullNow: () => void this.runSync({ manual: true, direction: "pull" }),
			// v0.7.1 feature B: one-click pause/resume, persisted.
			onSetPaused: paused => void this.setSyncPaused(paused),
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
			// v0.8.0 feature 1: conflict cleanup view from the dashboard.
			onReviewConflicts: () => new ConflictReviewModal(this.app).open(),
		};
	}

	/* ---------------- force sync current file (v0.8.0 feature 3) ---------------- */

	/**
	 * Upload one file to Filen right now, whatever the sync direction. When the
	 * remote copy changed since the last sync, the ConfirmModal is the ONLY
	 * prompt — the merge view never opens for a force sync.
	 */
	private async forceSyncFile(file: TFile): Promise<void> {
		if (this.isLocked()) {
			new Notice("Filen Cloud Sync is locked — run the 'Unlock sync' command");
			return;
		}
		await this.engine.forceUploadFile(
			normalizeVaultPath(file.path),
			() => new Promise<boolean>(resolve => {
				new ConfirmModal(
					this.app,
					"Force sync to Filen",
					"Remote copy changed since the last sync — overwrite it on Filen? "
					+ "(Your current remote version is kept as a Filen version.)",
					"Overwrite",
					() => resolve(true),
					() => resolve(false),
				).open();
			}),
		);
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
	 * v0.8.1 feature 3: identical AUTO/background messages are throttled to
	 * one Notice per 15 minutes; manual-run results (opts.manual) always
	 * notify — they're user-invoked.
	 */
	private friendlyNotice(rawMessage: string, prefix?: string, opts?: { manual?: boolean }): void {
		// v0.8.1 feature 2: while offline, a manual run's network-class failure
		// is covered by the ONE "you're offline" notice already shown — don't
		// stack a second notice on top of it.
		if (opts?.manual && this.offlineTracker.isOffline() && isNetworkError(rawMessage)) return;
		const friendly = friendlyError(rawMessage);
		const lead = prefix ? `${prefix}: ` : "Filen Cloud Sync: ";
		const text = friendly.hint ? `${lead}${friendly.title} — ${friendly.hint}` : `${lead}${friendly.title}`;
		if (!opts?.manual && !this.noticeThrottle.shouldShow(text)) return;
		new Notice(text);
	}

	private async runSync(options: {
		manual: boolean;
		ignoreMassChangeGuard?: boolean;
		dryRun?: boolean;
		/** v0.7.1 feature A: one-time direction override (never persisted). */
		direction?: SyncDirection;
	}): Promise<void> {
		// v0.7.1 feature B: paused blocks EVERY trigger path. Manual triggers
		// get the Notice; auto triggers (interval, sync-on-save, startup) skip
		// silently — the status bar shows the paused state. (The engine guards
		// again itself, so even a direct engine.run() is a no-op while paused.)
		if (this.settings.syncPaused) {
			if (options.manual) new Notice(SYNC_PAUSED_MESSAGE);
			this.updateStatusBar(this.statusBarState);
			return;
		}
		if (this.isLocked()) {
			// Locked: one Notice per manual run, and only the first auto run —
			// no retry spam while locked.
			if (options.manual || !this.lockedNoticeShown) {
				new Notice("Filen Cloud Sync is locked — run the 'Unlock sync' command");
				this.lockedNoticeShown = true;
			}
			return;
		}
		// v0.8.1 feature 2: offline awareness. navigator.onLine === false at
		// run start marks offline immediately (2 consecutive network-failed
		// runs also get here — see OfflineTracker). While offline: AUTO
		// triggers (interval/save/startup) skip SILENTLY — no engine run, so
		// no error-log spam; MANUAL runs show ONE notice and still proceed,
		// because a successful run is the way back online.
		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			this.offlineTracker.noteNavigatorOffline();
		}
		if (this.offlineTracker.isOffline() && !options.manual) return;
		if (this.offlineTracker.isOffline()) {
			new Notice("Filen Cloud Sync: you're offline — sync resumes when you're back");
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
				this.offlineTracker.noteRunFinished(result);
				this.updateStatusBar(result.status === "error" ? "error" : "idle");
				if (result.status === "dry-run" && result.plan) {
					new DryRunModal(
						this.app,
						result.plan,
						result.guardWouldAbort ?? false,
						() => void this.runSync({ manual: true }),
					).open();
				} else if (result.status === "error") {
					this.friendlyNotice(result.message, "Filen Cloud Sync failed", { manual: true });
				}
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				this.syncLog.error(`dry run crashed: ${message}`);
				this.offlineTracker.noteRunFinished({ status: "error", message });
				new Notice(`Filen Cloud Sync failed: ${message}`);
				this.updateStatusBar("error");
			}
			return;
		}
		// Progress modal: manual runs only — auto runs stay silent (feature E).
		const modal = options.manual
			? new SyncProgressModal(
				this.app,
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
			// v0.8.1 feature 2: feed the offline state machine (a run that
			// reached the gateway clears offline; network errors count up).
			this.offlineTracker.noteRunFinished(result);
			if (modal) {
				const clean = (result.status === "ok" || result.status === "empty")
					&& (result.opFailures ?? 0) === 0
					&& (result.plan?.conflicts.length ?? 0) === 0;
				modal.finish(
					result.message, clean,
					result.plan?.conflicts.map(conflict => conflict.path) ?? [],
				);
				if (result.status === "error") this.friendlyNotice(result.message, "Filen Cloud Sync failed", { manual: true });
				else if (result.status === "aborted") this.friendlyNotice(result.message, "Filen Cloud Sync aborted", { manual: true });
			} else if (result.status === "error") {
				// Auto runs: surface a Notice only on the ok→error transition
				// (rate-limited, not every failing run); status bar always updates.
				if (previousStatus !== "error") this.friendlyNotice(result.message, "Filen Cloud Sync failed");
			} else if (!options.manual && result.plan) {
				// v0.8.0 feature 2: opt-in background-change notice — ONE line
				// composed from the plan counts; empty/error runs stay silent.
				const backgroundMessage = backgroundChangeNotice({
					enabled: this.settings.notifyOnBackgroundChanges,
					manual: false,
					status: result.status,
					counts: result.plan.counts,
				});
				if (backgroundMessage) new Notice(`Filen Cloud Sync: ${backgroundMessage}`);
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
			this.offlineTracker.noteRunFinished({ status: "error", message });
			modal?.finish(`failed: ${message}`, false);
			if (options.manual || previousStatus !== "error") new Notice(`Filen Cloud Sync failed: ${message}`);
			this.lastSyncResult = { status: "error", message };
			this.lastSyncFinishedAt = Date.now();
			this.updateStatusBar("error");
			this.refreshDashboards(options.manual);
		}
	}

	private updateStatusBar(state: "idle" | "running" | "error"): void {
		this.statusBarState = state;
		if (!this.statusBarItem) return;
		this.statusBarItem.removeClass("filen-cloud-sync-error");
		// v0.8.1 feature 2: offline shows below paused, above idle/error.
		const offline = this.offlineTracker.isOffline();
		// v0.7.1 feature B: the paused state wins over idle/error (a run can't
		// be in flight while paused — every trigger path is blocked).
		if (this.settings.syncPaused && state !== "running") {
			this.statusBarItem.setText(statusBarText(state, {
				paused: true, offline, lastSyncFinishedAt: this.lastSyncFinishedAt,
			}));
			this.statusBarItem.setAttribute("aria-label", `Filen Cloud Sync: ${SYNC_PAUSED_MESSAGE}`);
			return;
		}
		if (state === "running") {
			this.statusBarItem.setText(statusBarText(state, {
				paused: false, offline, lastSyncFinishedAt: this.lastSyncFinishedAt,
			}));
		} else if (state === "error") {
			this.statusBarItem.addClass("filen-cloud-sync-error");
			const detail = this.lastSyncResult ? ` — ${this.lastSyncResult.message}` : "";
			this.statusBarItem.setText(statusBarText(state, {
				paused: false, offline, lastSyncFinishedAt: this.lastSyncFinishedAt,
			}));
			this.statusBarItem.setAttribute("aria-label", `Filen Cloud Sync error${detail}`);
		} else {
			// v0.8.0 feature 4: idle shows the relative last-sync timestamp.
			this.statusBarItem.setText(statusBarText(state, {
				paused: false, offline, lastSyncFinishedAt: this.lastSyncFinishedAt,
			}));
			if (this.lastSyncResult) {
				this.statusBarItem.setAttribute("aria-label", `Filen Cloud Sync: ${this.lastSyncResult.message}`);
			}
		}
	}
}
