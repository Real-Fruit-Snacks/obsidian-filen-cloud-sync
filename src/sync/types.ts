/**
 * Sync engine types (the design docs/§4). Pure — no obsidian imports so the planner
 * and these types run under vitest in plain Node.
 */

import type { FileMetadata } from "../filen/types";

export interface LocalFile {
	path: string; // NFC-normalized vault-relative
	mtime: number; // ms
	size: number; // bytes
}

export interface LocalTree {
	files: Map<string, LocalFile>;
	/** All local folders (incl. empty ones), NFC-normalized, "" excluded. */
	folders: Set<string>;
	/** Paths skipped during scan, with reason (for logging/notice). */
	skipped: Array<{ path: string; reason: string }>;
	/**
	 * Files that EXIST in the vault but were excluded from the scan (ignore
	 * pattern, dotfile toggle, size limit, reserved name, case-collision
	 * loser, …). The planner must suppress ALL ops for these paths —
	 * "ignored" must never be read as "deleted" — and must not prune their
	 * parent folders. Their base records stay untouched.
	 */
	excluded: Set<string>;
	/** Case-insensitive collision groups (winner first). */
	collisions: string[][];
}

export interface RemoteFile {
	path: string; // NFC-normalized vault-relative
	uuid: string;
	parent: string;
	size: number;
	lastModified: number; // ms, from decrypted metadata
	chunks: number;
	bucket: string;
	region: string;
	key: string; // per-file encryption key (from decrypted metadata)
	hash?: string; // sha512 hex of plaintext
	mime?: string; // from decrypted metadata (needed for remote renames)
	creation?: number; // ms, from decrypted metadata (kept on remote renames)
}

export interface RemoteTree {
	files: Map<string, RemoteFile>;
	/** folder path → uuid ("" = sync root). */
	folders: Map<string, string>;
}

export interface BaseRecord {
	localMtime: number;
	localSize: number;
	remoteUuid: string;
	remoteMtime: number;
	remoteSize: number;
}

export interface SyncStateFile {
	schemaVersion: number;
	remoteRootUuid: string;
	lastSuccessSyncMillis: number;
	files: Record<string, BaseRecord>;
	/**
	 * v0.4.0 feature D: cached remote tree for events-based fast polling.
	 * OPTIONAL — schemaVersion stays 1; old state files simply lack the
	 * field (first run after the upgrade does a full scan and builds it).
	 */
	remoteTreeCache?: RemoteTreeCache | null;
}

/**
 * Persisted remote tree snapshot. Reused only when the events probe reports
 * zero changes since `eventWatermark` AND the snapshot is younger than the
 * 30-minute TTL; remote-folder pruning is skipped while a cached tree is in
 * use (cheap insurance against a stale-cache prune).
 */
export interface RemoteTreeCache {
	/** ms epoch when the tree was fetched via a full dir/tree scan. */
	fetchedAt: number;
	/** ms watermark sent to /v3/user/events on the next probe. */
	eventWatermark: number;
	files: Record<string, RemoteFile>;
	/** folder path → uuid ("" = sync root). */
	folders: Record<string, string>;
}

export type ConflictPolicy = "keep_both" | "keep_newer";

export type SyncOpKind =
	| "upload"          // local → remote (create or overwrite w/ new uuid)
	| "download"        // remote → local
	| "trashLocal"      // local delete propagation (vault trash)
	| "trashRemote"     // remote delete propagation (filen trash)
	| "renameLocal"     // conflict loser rename (keep_both)
	| "renameRemote"    // hash-confirmed local rename → server-side rename/move
	| "mkdirLocal"
	| "mkdirRemote"
	| "trashLocalDir"
	| "trashRemoteDir"
	| "refreshBase"     // equality short-circuit / hash-confirm
	| "dropBase";       // history-only record cleanup

export interface SyncOp {
	kind: SyncOpKind;
	path: string;
	/** renameLocal/renameRemote: destination path. */
	toPath?: string;
	remote?: RemoteFile;
	/**
	 * renameRemote: target uuid + per-file key + full updated metadata JSON
	 * (name already replaced; every other field carried over untouched).
	 */
	rename?: {
		uuid: string;
		fileKey: string;
		metadata: FileMetadata;
	};
	/** keep_newer conflicts: trash this remote uuid AFTER the upload succeeds. */
	trashRemoteUuidAfter?: string;
	/** conflict metadata (for logging/notices + ask-mode op grouping). */
	conflict?: {
		/** Original conflicted path (also on conflict-copy ops). */
		path: string;
		policy: ConflictPolicy;
		winner: "local" | "remote";
		loserMtime: number;
	};
}

export interface SyncPlan {
	ops: SyncOp[];
	seedMode: "upload-all" | "download-all" | "both-nonempty" | null;
	conflicts: Array<{ path: string; policy: ConflictPolicy; winner: "local" | "remote" }>;
	aborted: boolean;
	abortReason?: string;
	counts: {
		uploads: number;
		downloads: number;
		trashLocal: number;
		trashRemote: number;
		mkdirLocal: number;
		mkdirRemote: number;
		renames: number;
		prunes: number;
		conflicts: number;
	};
}

export interface PlannerOptions {
	conflictPolicy: ConflictPolicy;
	massChangeAbortPercent: number;
	/** manual "Sync now (ignore mass-change guard)". */
	ignoreMassChangeGuard?: boolean;
	/**
	 * Pre-computed local SHA-512 hashes for paths the engine hashed before
	 * planning (hash-confirm path: size equal, mtime differs, remote has hash).
	 */
	localHashes?: Map<string, string>;
	/**
	 * Vault-relative ignored folder prefixes (NFC, no slashes). The planner
	 * skips ALL op generation AND base cleanup at/under them — "ignored" is
	 * never read as "deleted" and un-ignoring resumes from intact base records.
	 */
	ignoredFolders?: string[];
	/**
	 * Vault config dir (e.g. ".obsidian"). Config paths ALWAYS resolve
	 * conflicts as keep-newer (loser → trash) regardless of the global
	 * conflictPolicy, and never produce conflict-copy renames (v0.4.0 A).
	 */
	configDir?: string;
	/**
	 * Out-of-scope config paths (sync disabled or not allowlisted): treat
	 * exactly like ignored-folder prefixes — NO ops and NO base cleanup, so
	 * toggling config sync off never trashes previously synced config files
	 * here or on other devices (v0.4.0 review M3).
	 */
	protectPath?: (path: string) => boolean;
	/**
	 * v0.4.0 feature D: set when the remote tree came from the events cache
	 * rather than a fresh dir/tree — remote-folder pruning (trashRemoteDir)
	 * is skipped entirely as cheap insurance against a stale-cache prune.
	 * File-level logic is unchanged (3-way base + trash-only bound the risk).
	 */
	skipRemoteFolderPrune?: boolean;
}

export function emptyPlan(): SyncPlan {
	return {
		ops: [],
		seedMode: null,
		conflicts: [],
		aborted: false,
		counts: {
			uploads: 0, downloads: 0, trashLocal: 0, trashRemote: 0,
			mkdirLocal: 0, mkdirRemote: 0, renames: 0, prunes: 0, conflicts: 0,
		},
	};
}
