/**
 * Sync engine: executes a SyncPlan in fixed phases (the design docs), with the
 * single-flight lock, incremental base persistence (every 25 ops), atomic
 * .filen-tmp downloads, folder-chain ensures and failure circuit-breaker.
 */

import { Platform } from "obsidian";
import type { App, Vault } from "obsidian";
import type { FilenClient } from "../filen/client";
import { sha512Hex } from "../filen/crypto";
import type { StoredCredentials, UserEvent } from "../filen/types";
import {
	baseNameOf,
	formatBytes,
	isConfigPath,
	mapPool,
	normalizeVaultPath,
	pluralize,
	tryDecodeUtf8,
	utf8ToBytes,
	wholeSeconds,
} from "../util";
import type { FilenSyncSettings } from "../settings";
import { allowlistAllows, scanLocalVault } from "./localScan";
import { SyncLog } from "./log";
import { MergeDecision, mergeDecisionOps, planSync } from "./planner";
import { scanRemote } from "./remoteScan";
import {
	baseRecordsAsMap,
	loadDeviceId,
	loadState,
	mapIntoState,
	remoteTreeFromCache,
	remoteTreeToCache,
	saveState,
	STATE_SCHEMA_VERSION,
} from "./state";
import { BaseRecord, LocalTree, RemoteTree, RemoteTreeCache, SyncOp, SyncPlan, SyncStateFile } from "./types";

export interface SyncProgress {
	phase: string;
	done: number;
	total: number;
	current?: string;
	/**
	 * v0.6.0 feature C: sub-op detail for chunked transfers, e.g.
	 * "3/7 chunks" — rendered under the counter in the progress modal.
	 */
	detail?: string;
}

export interface SyncRunOptions {
	manual?: boolean;
	ignoreMassChangeGuard?: boolean;
	/**
	 * v0.6.0 feature A: plan preview only. Identical scan → plan path, but NO
	 * ask-mode conflict resolution, NO execution, NO base/state ops mutations
	 * or persistence, NO per-op notices. The mass-change guard does NOT abort
	 * — the result flags `guardWouldAbort` instead. Returns status "dry-run".
	 */
	dryRun?: boolean;
	/** Progress callback for the manual-run progress modal (feature E). */
	onProgress?: (progress: SyncProgress) => void;
	/** Checked before every op — returning true cancels the run cleanly. */
	isCancelled?: () => boolean;
}

export interface SyncRunResult {
	status: "ok" | "aborted" | "error" | "skipped" | "empty" | "dry-run";
	message: string;
	plan?: SyncPlan;
	/**
	 * v0.6.0 feature A (dry runs only): the mass-change guard WOULD have
	 * aborted this plan in a real run — shown as a warning in the preview.
	 */
	guardWouldAbort?: boolean;
	/** Ops that failed (logged) during an otherwise completed run. */
	opFailures?: number;
	/** Paths skipped/excluded by the last local scan (dashboard, v0.4.0 F). */
	skippedCount?: number;
	/**
	 * v0.5.0: the remote tree used by a completed run — main.ts's shared-prefs
	 * post-run check reads it (no extra API call). Success paths only.
	 */
	remoteTree?: RemoteTree;
}

const PERSIST_EVERY_OPS = 25;
const MAX_CONSECUTIVE_FAILURES = 5;
const TMP_SUFFIX = ".filen-tmp";
/** v0.4.0 feature D: cached remote trees are trusted for at most 30 min. */
export const REMOTE_TREE_CACHE_TTL_MS = 30 * 60 * 1000;
/** v0.4.0 feature E: the merge view only opens for files ≤ 1 MiB. */
export const MERGE_MAX_BYTES = 1024 * 1024;

/**
 * Everything the interactive conflict resolver (v0.4.0 feature E) needs to
 * render the merge view. Only text-decodable files ≤ MERGE_MAX_BYTES ever
 * reach this — binaries/oversize fall back to the auto policy silently.
 */
export interface ConflictPromptRequest {
	path: string;
	localText: string;
	remoteText: string;
	localMtime: number;
	localSize: number;
	remoteMtime: number;
	remoteSize: number;
}

/** Ask-mode resolver: pauses a conflict op until the user picks a decision. */
export type ConflictResolver = (request: ConflictPromptRequest) => Promise<MergeDecision>;

/** Filen event timestamps are seconds in some API fields, ms in others. */
function eventTimestampMs(timestamp: number): number {
	return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

export class SyncEngine {
	private syncRunning = false;
	private syncPending = false;
	private opsSincePersist = 0;
	private consecutiveFailures = 0;
	private opFailures = 0;
	private cancelRequested = false;
	private activeOptions: SyncRunOptions | null = null;
	private progressDone = 0;
	private progressTotal = 0;
	/** per-run remote folder path → uuid cache ("" = sync root). */
	private remoteFolderCache = new Map<string, string>();
	private state: SyncStateFile | null = null;
	private base = new Map<string, BaseRecord>();
	/** Session-only shadow of the remote-tree cache for memory-only credential
	 *  mode (never written to disk in that mode — review m4). */
	private memoryTreeCache: RemoteTreeCache | null = null;

	constructor(
		private readonly app: App,
		private readonly client: FilenClient,
		private readonly getSettings: () => FilenSyncSettings,
		private readonly getCredentials: () => StoredCredentials | null,
		private readonly log: SyncLog,
		private readonly notify: (message: string) => void,
		/** v0.4.0 feature E: interactive conflict resolver (ask mode only). */
		private readonly conflictResolver: ConflictResolver | null = null,
	) {}

	get isRunning(): boolean {
		return this.syncRunning;
	}

	private get vault(): Vault {
		return this.app.vault;
	}

	/**
	 * v0.4.0 feature A: config paths are invisible to the Vault API — all IO
	 * for them branches to vault.adapter (readBinary/writeBinary/mkdir/
	 * trashSystem→trashLocal) instead of TFile-based ops.
	 */
	private isConfig(path: string): boolean {
		return isConfigPath(path, this.vault.configDir);
	}

	/**
	 * Out-of-scope config paths (sync disabled or not allowlisted) must be
	 * treated as "ignored ≠ deleted" by the planner — otherwise disabling
	 * config sync trashes every previously synced config file remotely, and
	 * other devices then trash their local copies (review M3).
	 */
	private protectConfigPath(path: string): boolean {
		if (!this.isConfig(path)) return false;
		const settings = this.getSettings();
		if (!settings.syncConfigDir) return true;
		return !allowlistAllows(
			normalizeVaultPath(path),
			normalizeVaultPath(this.vault.configDir),
			settings.configSyncAllowlist,
		);
	}

	/** Read file bytes for hash pre-passes; null when the file vanished. */
	private async readLocalBinary(path: string): Promise<ArrayBuffer | null> {
		if (this.isConfig(path)) {
			return await this.vault.adapter.readBinary(path);
		}
		const file = this.vault.getFileByPath(path);
		if (!file) return null;
		return await this.vault.readBinary(file);
	}

	/* ---------------- main entry ---------------- */

	async run(options: SyncRunOptions = {}): Promise<SyncRunResult> {
		if (this.syncRunning) {
			this.syncPending = true;
			return { status: "skipped", message: "sync already running — queued" };
		}
		this.syncRunning = true;
		try {
			let result: SyncRunResult;
			do {
				this.syncPending = false;
				result = await this.runOnce(options);
			} while (this.syncPending);
			return result;
		} finally {
			this.syncRunning = false;
		}
	}

	private async runOnce(options: SyncRunOptions): Promise<SyncRunResult> {
		this.activeOptions = options;
		this.cancelRequested = false;
		this.opFailures = 0;
		this.progressDone = 0;
		this.progressTotal = 0;
		try {
			return await this.runOnceInner(options);
		} finally {
			this.activeOptions = null;
		}
	}

	private emitProgress(phase: string, current?: string, detail?: string): void {
		this.activeOptions?.onProgress?.({
			phase,
			done: this.progressDone,
			total: this.progressTotal,
			current,
			detail,
		});
	}

	/**
	 * v0.6.0 feature C: chunk-level progress inside one upload/download op —
	 * op counters (done/total) stay untouched, only `current` + `detail`
	 * move with each completed chunk.
	 */
	private emitChunkProgress(op: SyncOp, phase: string): (done: number, total: number) => void {
		return (done, total) => this.emitProgress(phase, op.path, `${done}/${total} chunks`);
	}

	/** Cancel flag polled before each op (feature E "Cancel sync"). */
	private runCancelled(): boolean {
		if (!this.cancelRequested && this.activeOptions?.isCancelled?.()) {
			this.cancelRequested = true;
		}
		return this.cancelRequested;
	}

	private async runOnceInner(options: SyncRunOptions): Promise<SyncRunResult> {
		const credentials = this.getCredentials();
		if (!credentials) {
			return { status: "error", message: "not connected — connect your Filen account in settings" };
		}
		this.client.setCredentials(credentials);
		this.emitProgress("Scanning");

		this.state = loadState(this.app);
		// Memory-only mode: the persisted state never carries the tree cache
		// (it holds per-file keys), so restore the session shadow instead.
		if (this.getSettings().memoryOnlyCredentials && this.memoryTreeCache) {
			this.state.remoteTreeCache = this.memoryTreeCache;
		}
		if (this.state.schemaVersion !== STATE_SCHEMA_VERSION) {
			return { status: "error", message: "unsupported sync state schema — reset local sync state" };
		}
		// Fingerprint check: remote root must not have changed under us.
		if (this.state.remoteRootUuid.length > 0
			&& this.state.remoteRootUuid !== credentials.syncRootUuid) {
			const message = "remote sync folder changed — please disconnect and reconnect in settings";
			this.log.error(message);
			this.notify(message);
			return { status: "error", message };
		}
		this.state.remoteRootUuid = credentials.syncRootUuid;
		this.base = baseRecordsAsMap(this.state);
		this.opsSincePersist = 0;
		this.consecutiveFailures = 0;

		const settings = this.getSettings();

		// Scan both sides.
		const local = await scanLocalVault(this.vault, settings);
		// excluded is the authoritative count — every skipped path also lands
		// in excluded, so summing both double-counts (review m5).
		const skippedCount = local.excluded.size;
		if (local.collisions.length > 0) {
			const message = `case-collision: syncing ${local.collisions.map(g => g[0]).join(", ")}; `
				+ "skipped the other casing variant(s)";
			this.log.warn(message);
			this.notify(message);
		}
		/* ---- remote scan: events probe + cached tree (v0.4.0 feature D) ---- */
		// Manual runs ALWAYS fetch a full dir/tree (freshness guarantee); a
		// failed probe NEVER trusts silence — it forces a full fetch too.
		let remote: RemoteTree;
		let remoteFromCache = false;
		const treeCache = this.state.remoteTreeCache ?? null;
		const fastPoll = settings.fastRemotePolling && !options.manual;
		let probeEvents: UserEvent[] | null = null;
		if (fastPoll) {
			try {
				probeEvents = (await this.client.userEvents(treeCache?.eventWatermark ?? 0)).events;
			} catch (e) {
				this.log.warn(`events probe failed: ${errMsg(e)} — running a full remote scan instead`);
				probeEvents = null;
			}
		}
		if (
			fastPoll
			&& probeEvents !== null
			&& probeEvents.length === 0
			&& treeCache
			&& Date.now() - treeCache.fetchedAt < REMOTE_TREE_CACHE_TTL_MS
		) {
			remote = remoteTreeFromCache(treeCache);
			remoteFromCache = true;
			const ageMinutes = Math.round((Date.now() - treeCache.fetchedAt) / 60000);
			this.log.info(
				`remote scan: no events since watermark — using cached tree `
				+ `(${remote.files.size} files / ${remote.folders.size} folders, ${ageMinutes} min old; `
				+ "remote-folder pruning skipped)",
			);
		} else {
			// Watermark is anchored at fetch START — a remote event landing
			// between the tree snapshot and Date.now() would otherwise be
			// skipped until TTL expiry (review m3).
			const fetchStartedAt = Date.now();
			try {
				const scan = await scanRemote(this.client, credentials.syncRootUuid, loadDeviceId(this.app));
				remote = scan.tree;
				for (const skipped of scan.skipped) {
					this.log.warn(`remote skipped ${skipped.path}: ${skipped.reason}`);
				}
			} catch (e) {
				const message = `remote scan failed: ${errMsg(e)}`;
				this.log.error(message);
				if (options.manual) this.notify(message);
				return { status: "error", message };
			}
			// Rebuild the cache. Watermark: max event timestamp seen, or the
			// fetch start when the probe failed / the feed was empty.
			const watermark = probeEvents && probeEvents.length > 0
				? Math.max(...probeEvents.map(event => eventTimestampMs(event.timestamp)))
				: fetchStartedAt;
			this.state.remoteTreeCache = remoteTreeToCache(remote, Date.now(), watermark);
			this.memoryTreeCache = this.state.remoteTreeCache;
			if (fastPoll) {
				const probe = probeEvents === null ? "probe failed" : `${probeEvents.length} event(s)`;
				this.log.info(`remote scan: full dir tree fetched (${probe}; cache rebuilt)`);
			}
		}
		this.remoteFolderCache = new Map(remote.folders);
		this.log.info(
			`trees: local ${local.files.size} files / ${local.folders.size} folders `
			+ `(${local.excluded.size} excluded), remote ${remote.files.size} files / ${remote.folders.size} folders`,
		);

		// Hash-confirm pre-pass: size equal, whole-second mtime differs, remote
		// hash known → hash the local file so the planner can skip the transfer.
		const localHashes = new Map<string, string>();
		for (const [path, remoteFile] of remote.files) {
			const localFile = local.files.get(path);
			if (!localFile || !remoteFile.hash) continue;
			if (localFile.size !== remoteFile.size) continue;
			if (wholeSeconds(localFile.mtime) === wholeSeconds(remoteFile.lastModified)) continue;
			try {
				const buf = await this.readLocalBinary(path);
				if (!buf) continue;
				localHashes.set(path, await sha512Hex(buf));
			} catch (e) {
				this.log.warn(`hash-confirm read failed for ${path}: ${errMsg(e)}`);
			}
		}

		// Rename-detection pre-pass (feature D): hash local-only files whose
		// size matches a base-tracked remote whose local path vanished — the
		// planner confirms renames by content hash, ambiguity falls back to
		// plain delete + upload.
		const vanishedSizes = new Set<number>();
		for (const [path, record] of this.base) {
			if (local.files.has(path) || local.excluded.has(path)) continue;
			const remoteFile = remote.files.get(path);
			if (!remoteFile || remoteFile.uuid !== record.remoteUuid) continue;
			if (!remoteFile.hash || remoteFile.hash.length === 0) continue;
			vanishedSizes.add(remoteFile.size);
		}
		if (vanishedSizes.size > 0) {
			for (const [path, localFile] of local.files) {
				if (this.base.has(path) || remote.files.has(path)) continue;
				if (localHashes.has(path) || !vanishedSizes.has(localFile.size)) continue;
				try {
					const buf = await this.readLocalBinary(path);
					if (!buf) continue;
					localHashes.set(path, await sha512Hex(buf));
				} catch (e) {
					this.log.warn(`rename-detection hash failed for ${path}: ${errMsg(e)}`);
				}
			}
		}

		this.emitProgress("Planning");
		const plannerOptions = {
			conflictPolicy: settings.conflictPolicy,
			massChangeAbortPercent: settings.massChangeAbortPercent,
			ignoreMassChangeGuard: options.ignoreMassChangeGuard || !settings.massChangeGuard,
			localHashes,
			ignoredFolders: settings.ignoredFolders,
			configDir: this.vault.configDir,
			protectPath: (path: string) => this.protectConfigPath(path),
			skipRemoteFolderPrune: remoteFromCache,
		};
		let plan = planSync(local, remote, this.base, plannerOptions);
		let guardWouldAbort = false;
		if (options.dryRun && plan.aborted) {
			// Dry run: the guard must NOT abort — flag that it WOULD trip and
			// re-plan with the guard off so the preview lists the full op set.
			// (plan.aborted is set ONLY by the mass-change guard; planSync is
			// pure and never touches the base map.)
			guardWouldAbort = true;
			this.log.warn(`dry run: ${plan.abortReason ?? "mass-change guard would abort this run"}`);
			plan = planSync(local, remote, this.base, { ...plannerOptions, ignoreMassChangeGuard: true });
		}
		this.progressTotal = plan.ops.length;
		this.emitProgress("Applying plan");

		if (plan.aborted) {
			const message = plan.abortReason ?? "mass-change guard aborted the run";
			this.log.warn(message);
			this.notify(message);
			return { status: "aborted", message, plan, skippedCount };
		}

		{
			const c = plan.counts;
			this.log.info(
				`plan: ${c.uploads}↑ ${c.downloads}↓ ${c.trashLocal + c.trashRemote} deletes, `
				+ `${c.mkdirLocal + c.mkdirRemote} folders, ${c.conflicts} conflicts`,
			);
		}

		// v0.6.0 feature A (dry run): stop after planning — NO ask-mode
		// resolution, NO execution, NO base/state persistence, NO per-op
		// notices. The caller previews the plan in the DryRunModal instead.
		if (options.dryRun) {
			const c = plan.counts;
			const total = c.uploads + c.downloads + c.trashLocal + c.trashRemote
				+ c.mkdirLocal + c.mkdirRemote + c.renames + c.prunes;
			const summary = total === 0
				? "everything up to date"
				: `would sync: ${c.uploads}↑ ${c.downloads}↓ ${c.trashLocal + c.trashRemote} deleted, `
					+ `${c.renames} renamed, ${c.mkdirLocal + c.mkdirRemote} folders, ${c.conflicts} conflicts`;
			this.log.info(`dry run: ${summary}`);
			return { status: "dry-run", message: summary, plan, guardWouldAbort, skippedCount };
		}

		if (plan.seedMode) {
			this.log.info(`seed mode: ${plan.seedMode}`);
		}
		for (const conflict of plan.conflicts) {
			// Forced keep-newer (config paths) is deterministic housekeeping —
			// the newest copy simply wins. Log it as info, not conflict-level:
			// only keep_both (a copy was created) deserves the user's attention.
			if (conflict.policy === "keep_newer") {
				this.log.info(
					`updated from the newer copy: ${conflict.path} (winner: ${conflict.winner})`,
				);
				continue;
			}
			const message = `conflict: ${conflict.path} (${conflict.policy}, winner: ${conflict.winner})`;
			this.log.conflict(message);
			this.notify(message);
		}

		// v0.4.0 feature E ("ask" mode): pause on each text conflict and let
		// the user pick the resolution; the conflict's planned ops are then
		// replaced with the decision's op set. Binaries/oversize/decode
		// failures keep the auto-policy ops untouched.
		if (settings.conflictResolution === "ask" && this.conflictResolver && plan.conflicts.length > 0) {
			await this.resolveConflictsInteractively(plan, local, remote);
			// Decisions replaced conflict ops — recount so summaries stay honest.
			plan.counts.uploads = plan.ops.filter(op => op.kind === "upload").length;
			plan.counts.downloads = plan.ops.filter(op => op.kind === "download").length;
			plan.counts.trashLocal = plan.ops.filter(op => op.kind === "trashLocal").length;
			plan.counts.trashRemote = plan.ops.filter(op => op.kind === "trashRemote").length;
			this.progressTotal = plan.ops.length; // recount for the progress modal too
		}

		// Execute.
		try {
			await this.executePlan(plan);
		} catch (e) {
			const message = `sync aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive failures: ${errMsg(e)}`;
			this.log.error(message);
			this.notify(message);
			this.persistState();
			return { status: "error", message, plan, opFailures: this.opFailures, skippedCount };
		}

		// Cancel requested mid-run: stop cleanly, keep partial progress — the
		// next run resumes from the persisted incremental base.
		if (this.cancelRequested) {
			const message = "canceled by user — partial progress kept; next sync resumes";
			this.log.warn(`sync ${message}`);
			this.persistState();
			this.log.persist();
			this.progressDone = this.progressTotal;
			this.emitProgress("Canceled");
			return { status: "aborted", message, plan, opFailures: this.opFailures, skippedCount };
		}

		this.state.lastSuccessSyncMillis = Date.now();
		this.persistState();
		this.log.persist();

		const c = plan.counts;
		const total = c.uploads + c.downloads + c.trashLocal + c.trashRemote
			+ c.mkdirLocal + c.mkdirRemote + c.renames + c.prunes;
		const summary = total === 0
			? "everything up to date"
			: `done: ${c.uploads}↑ ${c.downloads}↓ ${c.trashLocal + c.trashRemote} deleted, `
				+ `${c.renames} renamed, ${c.mkdirLocal + c.mkdirRemote} folders, ${c.conflicts} conflicts`;
		this.progressDone = this.progressTotal;
		this.emitProgress("Done");
		this.log.info(`sync ${summary}`);
		return {
			status: total === 0 ? "empty" : "ok",
			message: summary,
			plan,
			opFailures: this.opFailures,
			skippedCount,
			remoteTree: remote,
		};
	}

	/* ---------------- interactive conflict resolution (v0.4.0 E) ---------------- */

	/**
	 * Ask-mode: for each conflict, sequentially open the merge view and
	 * replace the conflict's planned ops with the decision's op set. Silent
	 * fallback to the auto policy when the file pair can't be shown (binary,
	 * > 1 MiB, vanished locally, undownloadable). The remote content is
	 * downloaded ONCE here for display; "keep_remote" downloads it again in
	 * the download phase — acceptable for a user-driven rare path.
	 */
	private async resolveConflictsInteractively(
		plan: SyncPlan,
		local: LocalTree,
		remote: RemoteTree,
	): Promise<void> {
		if (!this.conflictResolver) return;
		const settings = this.getSettings();
		for (const conflict of plan.conflicts) {
			if (this.runCancelled()) return;
			// Config conflicts are always keep-newer (feature A) — a merge UI
			// whose "Keep both" button would lie is worse than auto policy.
			if (this.isConfig(conflict.path)) continue;
			const localFile = local.files.get(conflict.path);
			const remoteFile = remote.files.get(conflict.path);
			if (!localFile || !remoteFile) continue;
			if (localFile.size > MERGE_MAX_BYTES || remoteFile.size > MERGE_MAX_BYTES) {
				this.log.info(`conflict ${conflict.path}: too large for the merge view — auto policy applies`);
				continue;
			}
			let localData: ArrayBuffer | null = null;
			let remoteData: ArrayBuffer | null = null;
			try {
				localData = await this.readLocalBinary(conflict.path);
				if (localData) {
					remoteData = (await this.client.downloadFile(
						{
							uuid: remoteFile.uuid,
							bucket: remoteFile.bucket,
							region: remoteFile.region,
							chunks: remoteFile.chunks,
						},
						remoteFile.key,
						remoteFile.hash,
					)).data;
				}
			} catch (e) {
				this.log.warn(`conflict ${conflict.path}: could not load both sides (${errMsg(e)}) — auto policy applies`);
				continue;
			}
			if (!localData || !remoteData) continue; // vanished locally → auto policy
			const localText = tryDecodeUtf8(localData);
			const remoteText = tryDecodeUtf8(remoteData);
			if (localText === null || remoteText === null) {
				this.log.info(`conflict ${conflict.path}: not text-decodable — auto policy applies`);
				continue;
			}

			const decision = await this.conflictResolver({
				path: conflict.path,
				localText,
				remoteText,
				localMtime: localFile.mtime,
				localSize: localFile.size,
				remoteMtime: remoteFile.lastModified,
				remoteSize: remoteFile.size,
			});
			this.log.info(`conflict ${conflict.path}: user chose ${decision}`);

			if (decision === "concat") {
				// local + "\n\n---\n\n" + remote, mtime=now → uploads as a new
				// version; the remote side is never trashed.
				const merged = utf8ToBytes(`${localText}\n\n---\n\n${remoteText}`);
				const buffer = merged.buffer.slice(
					merged.byteOffset, merged.byteOffset + merged.byteLength,
				) as ArrayBuffer;
				await this.atomicWrite(conflict.path, buffer, Date.now());
				localFile.mtime = Date.now();
				localFile.size = buffer.byteLength;
			}

			// Config paths always keep keep-newer semantics (v0.4.0 feature A).
			const policy = this.isConfig(conflict.path) ? "keep_newer" : settings.conflictPolicy;
			const decisionOps = mergeDecisionOps(decision, conflict.path, localFile, remoteFile, policy);
			plan.ops = plan.ops.filter(op => op.conflict?.path !== conflict.path);
			plan.ops.push(...decisionOps);
		}
	}

	/* ---------------- plan execution ---------------- */

	private async executePlan(plan: SyncPlan): Promise<void> {
		const phases: Array<{ phase: number; run: (ops: SyncOp[]) => Promise<void> }> = [
			// renameRemote FIRST, before all deletes (mirrors the official engine).
			{ phase: 0, run: ops => this.runSequential(ops, op => this.opRenameRemote(op)) },
			{ phase: 1, run: ops => this.runSequential(ops, op => this.opTrashLocal(op)) },
			{ phase: 2, run: ops => this.runSequential(ops, op => this.opTrashRemote(op)) },
			{ phase: 3, run: ops => this.runSequential(ops, op => this.opMkdirRemote(op)) },
			{ phase: 4, run: ops => this.runSequential(ops, op => this.opMkdirLocal(op)) },
			{ phase: 5, run: ops => this.runSequential(ops, op => this.opRenameLocal(op)) },
			{ phase: 6, run: ops => this.runPool(ops, op => this.opUpload(op)) },
			{ phase: 7, run: ops => this.runPool(ops, op => this.opDownload(op)) },
			{ phase: 8, run: ops => this.runSequential(ops, op => this.opTrashRemoteDir(op)) },
			{ phase: 9, run: ops => this.runSequential(ops, op => this.opTrashLocalDir(op)) },
			{ phase: 10, run: ops => this.runSequential(ops, op => this.opRefreshBase(op)) },
			{ phase: 11, run: ops => this.runSequential(ops, op => this.opDropBase(op)) },
		];
		for (const { phase, run } of phases) {
			if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				throw new Error("circuit breaker open");
			}
			const ops = plan.ops.filter(op => phaseOfKind(op.kind) === phase);
			await run(ops);
		}
	}

	private async runSequential(ops: SyncOp[], fn: (op: SyncOp) => Promise<void>): Promise<void> {
		for (const op of ops) {
			if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
			if (this.runCancelled()) return;
			await this.guarded(op, fn);
		}
	}

	private async runPool(ops: SyncOp[], fn: (op: SyncOp) => Promise<void>): Promise<void> {
		const concurrency = Platform.isMobileApp ? 3 : 5;
		await mapPool(ops, concurrency, async op => {
			// Late-queue ops are skipped once the circuit breaker opens or the
			// run is cancelled (checked again by `guarded`'s callers).
			if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
			if (this.runCancelled()) return;
			await this.guarded(op, fn);
		});
	}

	private async guarded(op: SyncOp, fn: (op: SyncOp) => Promise<void>): Promise<void> {
		try {
			await fn(op);
			this.consecutiveFailures = 0;
			this.opsSincePersist++;
			if (this.opsSincePersist >= PERSIST_EVERY_OPS) this.persistState();
		} catch (e) {
			this.consecutiveFailures++;
			this.opFailures++;
			this.log.error(`${op.kind} ${op.path} failed: ${errMsg(e)}`);
		}
		this.progressDone++;
		this.emitProgress(phaseLabel(op.kind), describeOp(op));
	}

	private persistState(): void {
		if (!this.state) return;
		mapIntoState(this.state, this.base);
		// Memory-only credential mode: the remote-tree cache holds per-file
		// content keys — never persist it in that mode (review m4). The
		// in-memory copy still serves fast polling within the session.
		if (this.getSettings().memoryOnlyCredentials && this.state.remoteTreeCache) {
			saveState(this.app, { ...this.state, remoteTreeCache: null });
		} else {
			saveState(this.app, this.state);
		}
		this.opsSincePersist = 0;
	}

	/* ---------------- individual ops ---------------- */

	private async opTrashLocal(op: SyncOp): Promise<void> {
		if (this.isConfig(op.path)) {
			// Config files are invisible to the Vault API: trash via adapter
			// (system trash first, vault .trash fallback) — never a hard delete.
			if (await this.vault.adapter.exists(op.path)) {
				try {
					const trashed = await this.vault.adapter.trashSystem(op.path);
					if (!trashed) await this.vault.adapter.trashLocal(op.path);
				} catch {
					await this.vault.adapter.trashLocal(op.path);
				}
			}
			this.base.delete(op.path);
			this.log.info(`Deleted ${op.path} on this device (moved to trash)`);
			return;
		}
		const file = this.vault.getFileByPath(op.path);
		if (file) {
			// FileManager.trashFile respects the user's deletion preference
			// (system trash vs vault trash) — plain Vault.trash does not.
			await this.app.fileManager.trashFile(file);
		}
		this.base.delete(op.path);
		this.log.info(`Deleted ${op.path} on this device (moved to trash)`);
	}

	private async opTrashRemote(op: SyncOp): Promise<void> {
		if (op.remote) await this.client.fileTrash(op.remote.uuid);
		this.base.delete(op.path);
		this.log.info(`Deleted ${op.path} on Filen (moved to trash)`);
	}

	private async opMkdirRemote(op: SyncOp): Promise<void> {
		await this.ensureRemoteFolder(op.path);
		this.log.info(`Created folder ${op.path} on Filen`);
	}

	private async opMkdirLocal(op: SyncOp): Promise<void> {
		await this.ensureLocalFolder(op.path);
		this.log.info(`Created folder ${op.path} on this device`);
	}

	private async opRenameLocal(op: SyncOp): Promise<void> {
		if (!op.toPath) return;
		const file = this.vault.getFileByPath(op.path);
		if (!file) throw new Error(`file vanished before rename: ${op.path}`);
		await this.ensureLocalFolder(parentDir(op.toPath));
		await this.vault.rename(file, op.toPath);
		// Base record follows the renamed loser; the original path's base is
		// rewritten by the subsequent download op.
		const record = this.base.get(op.path);
		if (record) {
			this.base.delete(op.path);
			this.base.set(op.toPath, { ...record });
		}
		this.log.info(`Kept both copies of ${op.path} — the other version is ${op.toPath}`);
	}

	/**
	 * Server-side rename/move of an unchanged remote file (feature D): update
	 * the file-key-encrypted name + master-key-encrypted metadata, then move
	 * to the new parent folder if the directory changed. The base record
	 * moves fromPath → toPath keeping the same remote uuid.
	 */
	private async opRenameRemote(op: SyncOp): Promise<void> {
		if (!op.toPath || !op.rename) throw new Error(`malformed renameRemote op for ${op.path}`);
		// Config files are invisible to the Vault API — stat them via adapter.
		let localMtime: number;
		let localSize: number;
		const file = this.vault.getFileByPath(op.toPath);
		if (file) {
			localMtime = file.stat.mtime;
			localSize = file.stat.size;
		} else if (this.isConfig(op.toPath)) {
			const st = await this.vault.adapter.stat(op.toPath);
			if (!st || st.type !== "file") {
				throw new Error(`renamed file vanished before remote rename: ${op.toPath}`);
			}
			localMtime = st.mtime;
			localSize = st.size;
		} else {
			throw new Error(`renamed file vanished before remote rename: ${op.toPath}`);
		}
		const newParentUuid = await this.ensureRemoteFolder(parentDir(op.toPath));
		await this.client.fileRename(
			op.rename.uuid, baseNameOf(op.toPath), op.rename.fileKey, op.rename.metadata,
		);
		if (parentDir(op.path) !== parentDir(op.toPath)) {
			await this.client.fileMove(op.rename.uuid, newParentUuid);
		}
		const record = this.base.get(op.path);
		this.base.delete(op.path);
		this.base.set(op.toPath, {
			localMtime,
			localSize,
			remoteUuid: op.rename.uuid,
			remoteMtime: record?.remoteMtime ?? op.rename.metadata.lastModified,
			remoteSize: record?.remoteSize ?? op.rename.metadata.size,
		});
		this.log.info(`Renamed ${op.path} to ${op.toPath} on Filen`);
	}

	private async opUpload(op: SyncOp): Promise<void> {
		let name: string;
		let data: ArrayBuffer;
		// Capture mtime/size BEFORE reading (guard 5): if the file changes
		// during upload, next cycle re-uploads.
		let mtimeBefore: number;
		let sizeBefore: number;
		if (this.isConfig(op.path)) {
			// Config files are invisible to the Vault API → adapter IO.
			const stat = await this.vault.adapter.stat(op.path);
			if (!stat) throw new Error(`file vanished before upload: ${op.path}`);
			mtimeBefore = stat.mtime;
			sizeBefore = stat.size;
			data = await this.vault.adapter.readBinary(op.path);
			name = baseNameOf(op.path);
		} else {
			const file = this.vault.getFileByPath(op.path);
			if (!file) throw new Error(`file vanished before upload: ${op.path}`);
			mtimeBefore = file.stat.mtime;
			sizeBefore = file.stat.size;
			data = await this.vault.readBinary(file);
			name = file.name;
		}
		const parentUuid = await this.ensureRemoteFolder(parentDir(op.path));
		const result = await this.client.uploadFile(
			parentUuid, name, data, mtimeBefore, undefined,
			this.emitChunkProgress(op, "Uploading"),
		);
		this.base.set(op.path, {
			localMtime: mtimeBefore,
			localSize: sizeBefore,
			remoteUuid: result.uuid,
			remoteMtime: result.lastModified,
			remoteSize: result.size,
		});
		this.log.info(`Uploaded ${op.path} (${formatBytes(result.size)}, ${pluralize(result.chunks, "chunk")})`);
		// keep_newer conflict: trash the remote loser only AFTER the winner landed.
		if (op.trashRemoteUuidAfter) {
			await this.client.fileTrash(op.trashRemoteUuidAfter);
			this.log.info(`Deleted the losing Filen copy of conflict ${op.path} (moved to trash)`);
		}
	}

	private async opDownload(op: SyncOp): Promise<void> {
		const remote = op.remote;
		if (!remote) throw new Error(`missing remote info for ${op.path}`);
		const { data, verified } = await this.client.downloadFile(
			{
				uuid: remote.uuid,
				bucket: remote.bucket,
				region: remote.region,
				chunks: remote.chunks,
			},
			remote.key,
			remote.hash,
			this.emitChunkProgress(op, "Downloading"),
		);
		if (!verified) {
			this.log.warn(`integrity check failed for ${op.path} — writing anyway (warn only)`);
		}
		await this.atomicWrite(op.path, data, remote.lastModified);
		// keep_both conflict loser copy (local won the original name): do NOT
		// record a base entry for the "name (conflict …).ext" download — the
		// next run must treat it as a NEW local file and upload it, not read
		// its absence remotely as a local deletion and trash it.
		const isConflictLoserCopy = op.conflict?.policy === "keep_both" && op.conflict.winner === "local";
		if (!isConflictLoserCopy) {
			this.base.set(op.path, {
				localMtime: remote.lastModified,
				localSize: data.byteLength,
				remoteUuid: remote.uuid,
				remoteMtime: remote.lastModified,
				remoteSize: remote.size,
			});
		}
		this.log.info(`Downloaded ${op.path} (${formatBytes(data.byteLength)})`);
	}

	/**
	 * Atomicity story (guard 3): NEW files go tmp-write → verify → rename (a
	 * crash leaves, at worst, a stray *.filen-tmp that startup housekeeping
	 * removes). EXISTING files are overwritten in place with a single
	 * vault.modifyBinary — writing a tmp copy first would just duplicate the
	 * same bytes, so the tmp dance is skipped for the overwrite case.
	 */
	private async atomicWrite(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
		if (this.isConfig(path)) {
			// Config path: adapter write with remote mtime preserved. No
			// Vault-API tmp+rename dance (config files never surface as TFiles).
			await this.ensureLocalFolder(parentDir(path));
			await this.vault.adapter.writeBinary(path, data, { mtime, ctime: mtime });
			return;
		}
		const adapter = this.vault.adapter;
		const existing = this.vault.getFileByPath(path);
		if (existing) {
			await this.vault.modifyBinary(existing, data, { mtime });
			return;
		}
		// The vault index misses dotfiles and other hidden files — a file can
		// exist on disk while getFileByPath returns null. Check the DISK,
		// otherwise the tmp+rename below fails forever ("destination exists").
		if (await adapter.exists(path)) {
			this.log.warn(`overwrote existing untracked file ${path}`);
			await this.ensureLocalFolder(parentDir(path));
			await adapter.writeBinary(path, data, { mtime, ctime: mtime });
			return;
		}
		const tmpPath = path + TMP_SUFFIX;
		await this.ensureLocalFolder(parentDir(path));
		await adapter.writeBinary(tmpPath, data);
		const tmpStat = await adapter.stat(tmpPath);
		if (!tmpStat || tmpStat.size !== data.byteLength) {
			await adapter.remove(tmpPath).catch(() => undefined);
			throw new Error(`tmp write verification failed for ${path}`);
		}
		await adapter.rename(tmpPath, path);
		// Re-apply remote mtime only if the rename dropped it.
		const finalStat = await adapter.stat(path);
		if (!finalStat || wholeSeconds(finalStat.mtime) !== wholeSeconds(mtime)) {
			await adapter.writeBinary(path, data, { mtime, ctime: mtime });
		}
	}

	private async opTrashRemoteDir(op: SyncOp): Promise<void> {
		const uuid = this.remoteFolderCache.get(op.path);
		if (uuid) {
			await this.client.dirTrash(uuid);
			this.remoteFolderCache.delete(op.path);
		}
		this.log.info(`Deleted folder ${op.path} on Filen (moved to trash)`);
	}

	private async opTrashLocalDir(op: SyncOp): Promise<void> {
		if (this.isConfig(op.path)) {
			if (await this.vault.adapter.exists(op.path)) {
				try {
					const trashed = await this.vault.adapter.trashSystem(op.path);
					if (!trashed) await this.vault.adapter.trashLocal(op.path);
				} catch {
					await this.vault.adapter.trashLocal(op.path);
				}
			}
			this.log.info(`Deleted folder ${op.path} on this device (moved to trash)`);
			return;
		}
		const folder = this.vault.getFolderByPath(op.path);
		if (folder) {
			await this.app.fileManager.trashFile(folder);
		}
		this.log.info(`Deleted folder ${op.path} on this device (moved to trash)`);
	}

	private async opRefreshBase(op: SyncOp): Promise<void> {
		const remote = op.remote;
		if (!remote) return;
		if (this.isConfig(op.path)) {
			const stat = await this.vault.adapter.stat(op.path);
			if (!stat) return;
			this.base.set(op.path, {
				localMtime: stat.mtime,
				localSize: stat.size,
				remoteUuid: remote.uuid,
				remoteMtime: remote.lastModified,
				remoteSize: remote.size,
			});
			return;
		}
		const file = this.vault.getFileByPath(op.path);
		if (!file) return;
		this.base.set(op.path, {
			localMtime: file.stat.mtime,
			localSize: file.stat.size,
			remoteUuid: remote.uuid,
			remoteMtime: remote.lastModified,
			remoteSize: remote.size,
		});
	}

	private async opDropBase(op: SyncOp): Promise<void> {
		this.base.delete(op.path);
	}

	/* ---------------- folder chains ---------------- */

	/** Resolve/create the remote folder chain, shallowest first. Cached per run. */
	private async ensureRemoteFolder(path: string): Promise<string> {
		if (path === "") {
			const credentials = this.getCredentials();
			if (!credentials) throw new Error("not connected");
			return credentials.syncRootUuid;
		}
		const cached = this.remoteFolderCache.get(path);
		if (cached) return cached;
		const parent = parentDir(path);
		const parentUuid = await this.ensureRemoteFolder(parent);
		const name = path.slice(parent.length === 0 ? 0 : parent.length + 1);
		const uuid = await this.client.dirCreate(name, parentUuid);
		this.remoteFolderCache.set(path, uuid);
		return uuid;
	}

	private async ensureLocalFolder(path: string): Promise<void> {
		if (path === "") return;
		if (this.isConfig(path)) {
			// Config subfolders (e.g. .obsidian/snippets) via adapter.mkdir.
			if (await this.vault.adapter.exists(path)) return;
			await this.ensureLocalFolder(parentDir(path));
			if (!(await this.vault.adapter.exists(path))) {
				try {
					await this.vault.adapter.mkdir(path);
				} catch (e) {
					if (await this.vault.adapter.exists(path)) return;
					throw e;
				}
			}
			return;
		}
		if (this.vault.getAbstractFileByPath(path)) return;
		await this.ensureLocalFolder(parentDir(path));
		if (!this.vault.getAbstractFileByPath(path)) {
			try {
				await this.vault.createFolder(path);
			} catch (e) {
				// Lost a race with another op — only ignore "already exists".
				if (this.vault.getAbstractFileByPath(path)) return;
				throw e;
			}
		}
	}

	/* ---------------- startup housekeeping ---------------- */

	/** Guard 7: remove stray *.filen-tmp files left by an interrupted run. */
	async cleanupStrayTmpFiles(): Promise<void> {
		for (const file of this.vault.getFiles()) {
			if (file.path.endsWith(TMP_SUFFIX)) {
				try {
					await this.vault.adapter.remove(file.path);
					this.log.info(`cleaned stray tmp file ${file.path}`);
				} catch (e) {
					this.log.warn(`could not clean stray tmp file ${file.path}: ${errMsg(e)}`);
				}
			}
		}
	}
}

function phaseOfKind(kind: SyncOp["kind"]): number {
	switch (kind) {
		case "renameRemote": return 0;
		case "trashLocal": return 1;
		case "trashRemote": return 2;
		case "mkdirRemote": return 3;
		case "mkdirLocal": return 4;
		case "renameLocal": return 5;
		case "upload": return 6;
		case "download": return 7;
		case "trashRemoteDir": return 8;
		case "trashLocalDir": return 9;
		case "refreshBase": return 10;
		case "dropBase": return 11;
	}
}

function parentDir(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** Human phase label for the progress modal, derived from the op just run. */
function phaseLabel(kind: SyncOp["kind"]): string {
	switch (kind) {
		case "upload": return "Uploading";
		case "download": return "Downloading";
		case "trashLocal":
		case "trashRemote":
		case "trashLocalDir":
		case "trashRemoteDir": return "Deleting";
		case "renameRemote": return "Renaming";
		case "renameLocal": return "Resolving conflicts";
		case "mkdirLocal":
		case "mkdirRemote": return "Creating folders";
		default: return "Finishing";
	}
}

function describeOp(op: SyncOp): string {
	if (op.toPath) return `${op.path} → ${op.toPath}`;
	return op.path;
}

export function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
