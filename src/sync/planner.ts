/**
 * PURE three-way reconciliation planner (the design docs decision table).
 * No obsidian imports, no IO, no async — fully unit-testable.
 *
 * (local, remote, base, options) → SyncPlan
 */

import type { FileMetadata } from "../filen/types";
import { baseNameOf, conflictPathFor, isConfigPath, normalizeVaultPath, parentChains, wholeSeconds } from "../util";
import {
	BaseRecord,
	ConflictPolicy,
	emptyPlan,
	LocalFile,
	LocalTree,
	PlannerOptions,
	RemoteFile,
	RemoteTree,
	SyncOp,
	SyncPlan,
} from "./types";

/** localChanged per the design docs: size or whole-second mtime differs from base. */
export function localChanged(local: LocalFile, base: BaseRecord | undefined): boolean {
	if (!base) return true;
	return local.size !== base.localSize
		|| wholeSeconds(local.mtime) !== wholeSeconds(base.localMtime);
}

/** remoteChanged per the design docs: re-upload mints a new uuid. */
export function remoteChanged(remote: RemoteFile, base: BaseRecord | undefined): boolean {
	if (!base) return true;
	return remote.uuid !== base.remoteUuid;
}

/** Equality short-circuit: same size and same whole-second mtime. */
function equalByStat(local: LocalFile, remote: RemoteFile): boolean {
	return local.size === remote.size
		&& wholeSeconds(local.mtime) === wholeSeconds(remote.lastModified);
}

/** Hash-confirm path: sizes equal, mtimes differ, remote hash known. */
function equalByHash(local: LocalFile, remote: RemoteFile, opts: PlannerOptions): boolean {
	if (local.size !== remote.size) return false;
	if (!remote.hash || remote.hash.length === 0) return false;
	const localHash = opts.localHashes?.get(local.path);
	return localHash !== undefined && localHash === remote.hash;
}

interface FileDecision {
	ops: SyncOp[];
	conflict?: { path: string; policy: "keep_both" | "keep_newer"; winner: "local" | "remote" };
	/** counted towards the mass-change guard. */
	deletes: number;
	modifies: number;
}

function conflictOps(
	path: string,
	local: LocalFile,
	remote: RemoteFile,
	policy: "keep_both" | "keep_newer",
): FileDecision {
	// Winner: higher whole-second mtime; tie → local keeps the original name.
	const winner: "local" | "remote" =
		wholeSeconds(local.mtime) >= wholeSeconds(remote.lastModified) ? "local" : "remote";
	const loserMtime = winner === "local" ? remote.lastModified : local.mtime;
	const conflict = { path, policy, winner };

	if (policy === "keep_both") {
		const conflictPath = conflictPathFor(path, wholeSeconds(loserMtime) * 1000);
		if (winner === "local") {
			// Local keeps the original name; remote version lands as conflict copy.
			return {
				ops: [
					{ kind: "upload", path, conflict: { path, policy, winner, loserMtime } },
					{ kind: "download", path: conflictPath, remote, conflict: { path, policy, winner, loserMtime } },
				],
				conflict,
				deletes: 0,
				modifies: 2,
			};
		}
		// Remote keeps the original name; local version renamed + re-uploaded.
		return {
			ops: [
				{ kind: "renameLocal", path, toPath: conflictPath, conflict: { path, policy, winner, loserMtime } },
				{ kind: "download", path, remote, conflict: { path, policy, winner, loserMtime } },
				{ kind: "upload", path: conflictPath, conflict: { path, policy, winner, loserMtime } },
			],
			conflict,
			deletes: 0,
			modifies: 3,
		};
	}

	// keep_newer: loser → trash. The remote loser is trashed by the upload op
	// itself AFTER the winner lands (the design docs conflict policy).
	if (winner === "local") {
		return {
			ops: [
				{
					kind: "upload", path,
					trashRemoteUuidAfter: remote.uuid,
					conflict: { path, policy, winner, loserMtime },
				},
			],
			conflict,
			deletes: 1,
			modifies: 1,
		};
	}
	return {
		ops: [
			{ kind: "trashLocal", path, conflict: { path, policy, winner, loserMtime } },
			{ kind: "download", path, remote, conflict: { path, policy, winner, loserMtime } },
		],
		conflict,
		deletes: 1,
		modifies: 1,
	};
}

/**
 * v0.4.0 feature E: a decision made in the interactive conflict-merge view.
 * "keep_both" = the default policy behavior (whatever the auto policy would
 * have done); closing the view maps to it — never data-lossy.
 */
export type MergeDecision = "keep_local" | "keep_remote" | "keep_both" | "concat";

/**
 * Map an interactive merge decision to its op set (v0.4.0 feature E):
 * - keep_local: upload local over remote; the remote loser is trashed by the
 *   upload op itself AFTER the winner lands (same guard as keep_newer).
 * - keep_remote: trash the local copy (vault/system trash, recoverable) and
 *   download the remote version.
 * - keep_both: the configured auto-policy behavior — identical to what the
 *   planner produces without asking.
 * - concat: the engine writes local + "\n\n---\n\n" + remote into the local
 *   file with mtime=now BEFORE this op runs; a plain upload then propagates
 *   the merged content as a new version. The remote file is never trashed —
 *   its superseded content stays in Filen's version history.
 */
export function mergeDecisionOps(
	decision: MergeDecision,
	path: string,
	local: LocalFile,
	remote: RemoteFile,
	policy: ConflictPolicy,
): SyncOp[] {
	switch (decision) {
		case "keep_local":
			return [{
				kind: "upload",
				path,
				trashRemoteUuidAfter: remote.uuid,
				conflict: { path, policy: "keep_newer", winner: "local", loserMtime: remote.lastModified },
			}];
		case "keep_remote":
			return [
				{
					kind: "trashLocal", path,
					conflict: { path, policy: "keep_newer", winner: "remote", loserMtime: local.mtime },
				},
				{
					kind: "download", path, remote,
					conflict: { path, policy: "keep_newer", winner: "remote", loserMtime: local.mtime },
				},
			];
		case "keep_both":
			return conflictOps(path, local, remote, policy).ops;
		case "concat":
			return [{
				kind: "upload",
				path,
				conflict: { path, policy: "keep_newer", winner: "local", loserMtime: remote.lastModified },
			}];
	}
}

/**
 * Conflict policy for a path (v0.4.0 feature A): config paths are ALWAYS
 * keep-newer (loser → trash, never a conflict copy), no matter the global
 * setting or the both-nonempty seed default.
 */
function conflictPolicyFor(
	path: string,
	opts: PlannerOptions,
	bothNonemptySeed: boolean,
): "keep_both" | "keep_newer" {
	if (isConfigPath(path, opts.configDir)) return "keep_newer";
	return bothNonemptySeed ? "keep_both" : opts.conflictPolicy;
}

/** Decision table for a single path (the design docs). */
export function planFile(
	path: string,
	local: LocalFile | undefined,
	remote: RemoteFile | undefined,
	base: BaseRecord | undefined,
	opts: PlannerOptions,
	seedMode: SyncPlan["seedMode"],
): FileDecision {
	const none: FileDecision = { ops: [], deletes: 0, modifies: 0 };

	if (seedMode === "upload-all") {
		return local
			? { ops: [{ kind: "upload", path }], deletes: 0, modifies: 0 }
			: none;
	}
	if (seedMode === "download-all") {
		return remote
			? { ops: [{ kind: "download", path, remote }], deletes: 0, modifies: 0 }
			: none;
	}

	/* ---- v0.7.0 mirror modes (push / pull) ---- */
	// The source side wins EVERYWHERE: foreign edits on the other side are
	// reverted (re-upload / re-download), deletions propagate from the
	// source, and no conflict records are ever produced (the winner is
	// deterministic). The equality short-circuit (stat-equal or SHA-512
	// hash match) applies BEFORE the mode tables, exactly as in two-way.
	const direction = opts.syncDirection ?? "twoWay";

	if (direction === "push") {
		if (local && remote) {
			if (base && !localChanged(local, base) && !remoteChanged(remote, base)) {
				return none; // both sides match the base record
			}
			if (equalByStat(local, remote) || equalByHash(local, remote, opts)) {
				return { ops: [{ kind: "refreshBase", path, remote }], deletes: 0, modifies: 0 };
			}
			// Local wins: localChanged, remoteChanged (revert of a foreign
			// cloud edit) and both-changed all resolve as a plain upload.
			return { ops: [{ kind: "upload", path }], deletes: 0, modifies: base ? 1 : 0 };
		}
		if (local && !remote) {
			// New local file, or the remote copy was deleted — the mirror
			// re-uploads either way.
			return { ops: [{ kind: "upload", path }], deletes: 0, modifies: 0 };
		}
		if (!local && remote) {
			// Deleted locally (or never local) → the deletion propagates.
			return { ops: [{ kind: "trashRemote", path, remote }], deletes: 1, modifies: 0 };
		}
		// history-only record
		if (base) return { ops: [{ kind: "dropBase", path }], deletes: 0, modifies: 0 };
		return none;
	}

	if (direction === "pull") {
		if (local && remote) {
			if (base && !localChanged(local, base) && !remoteChanged(remote, base)) {
				return none; // both sides match the base record
			}
			if (equalByStat(local, remote) || equalByHash(local, remote, opts)) {
				return { ops: [{ kind: "refreshBase", path, remote }], deletes: 0, modifies: 0 };
			}
			// Remote wins: remoteChanged, localChanged (revert of a foreign
			// local edit) and both-changed all resolve as a plain download.
			return { ops: [{ kind: "download", path, remote }], deletes: 0, modifies: base ? 1 : 0 };
		}
		if (!local && remote) {
			// New remote file, or the local copy was deleted — the mirror
			// re-downloads either way.
			return { ops: [{ kind: "download", path, remote }], deletes: 0, modifies: 0 };
		}
		if (local && !remote) {
			// Deleted remotely (or never remote) → the deletion propagates.
			return { ops: [{ kind: "trashLocal", path }], deletes: 1, modifies: 0 };
		}
		// history-only record
		if (base) return { ops: [{ kind: "dropBase", path }], deletes: 0, modifies: 0 };
		return none;
	}

	if (local && remote) {
		if (base && !localChanged(local, base) && !remoteChanged(remote, base)) {
			return none; // both sides match the base record
		}
		// Equality short-circuit — self-heals a stale/missing base record.
		if (equalByStat(local, remote) || equalByHash(local, remote, opts)) {
			return { ops: [{ kind: "refreshBase", path, remote }], deletes: 0, modifies: 0 };
		}
		if (!base) {
			// Both new (first sync with both sides non-empty) → conflict-created.
			const policy = conflictPolicyFor(path, opts, seedMode === "both-nonempty");
			return conflictOps(path, local, remote, policy);
		}
		const lc = localChanged(local, base);
		const rc = remoteChanged(remote, base);
		if (lc && rc) return conflictOps(path, local, remote, conflictPolicyFor(path, opts, false));
		if (lc) return { ops: [{ kind: "upload", path }], deletes: 0, modifies: 1 };
		if (rc) return { ops: [{ kind: "download", path, remote }], deletes: 0, modifies: 1 };
		return none;
	}

	if (local && !remote) {
		if (!base) return { ops: [{ kind: "upload", path }], deletes: 0, modifies: 0 };
		if (localChanged(local, base)) {
			// modify-beats-delete: local edit resurrects the file remotely.
			return { ops: [{ kind: "upload", path }], deletes: 0, modifies: 0 };
		}
		return { ops: [{ kind: "trashLocal", path }], deletes: 1, modifies: 0 };
	}

	if (!local && remote) {
		if (!base) return { ops: [{ kind: "download", path, remote }], deletes: 0, modifies: 0 };
		if (remoteChanged(remote, base)) {
			// modify-beats-delete: remote edit resurrects the file locally.
			return { ops: [{ kind: "download", path, remote }], deletes: 0, modifies: 0 };
		}
		return { ops: [{ kind: "trashRemote", path, remote }], deletes: 1, modifies: 0 };
	}

	// history-only record
	if (base) return { ops: [{ kind: "dropBase", path }], deletes: 0, modifies: 0 };
	return none;
}

function pathAtOrUnder(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(parent + "/");
}

/** Normalize the ignored-folder setting into NFC prefixes ("" dropped). */
function ignoredPrefixes(opts: PlannerOptions): string[] {
	const out: string[] = [];
	for (const folder of opts.ignoredFolders ?? []) {
		const normalized = normalizeVaultPath(folder);
		if (normalized.length > 0) out.push(normalized);
	}
	return out;
}

function isIgnored(path: string, ignored: string[]): boolean {
	return ignored.some(prefix => pathAtOrUnder(prefix, path));
}

export interface DetectedRename {
	fromPath: string;
	toPath: string;
	uuid: string;
	fileKey: string;
	metadata: FileMetadata;
}

/**
 * Conservative hash-matched rename detection (the design docs v0.3.0 feature D).
 * Sources: base-tracked remote files whose local path vanished and whose
 * remote side is unchanged vs base (same uuid). Targets: local-only paths
 * (no base record, nothing remote). A pair matches only on size AND SHA-512
 * (engine pre-hashes size-matched local candidates into opts.localHashes;
 * remotes without metadata.hash can never match). AMBIGUITY = SKIP: a
 * source with 2+ matching targets, or a target matched by 2+ sources, falls
 * back to plain delete + upload.
 */
export function detectRenames(
	local: LocalTree,
	remote: RemoteTree,
	base: Map<string, BaseRecord>,
	opts: PlannerOptions,
	ignored: string[] = [],
): DetectedRename[] {
	const hashes = opts.localHashes;
	if (!hashes || hashes.size === 0) return [];

	const sources: Array<{ path: string; remote: RemoteFile }> = [];
	for (const [path, record] of base) {
		if (local.files.has(path) || local.excluded.has(path)) continue;
		if ((isIgnored(path, ignored) || opts.protectPath?.(path))) continue;
		const remoteFile = remote.files.get(path);
		if (!remoteFile || remoteFile.uuid !== record.remoteUuid) continue;
		if (!remoteFile.hash || remoteFile.hash.length === 0) continue;
		sources.push({ path, remote: remoteFile });
	}
	if (sources.length === 0) return [];

	const targets: LocalFile[] = [];
	for (const [path, localFile] of local.files) {
		if (base.has(path) || remote.files.has(path)) continue;
		if ((isIgnored(path, ignored) || opts.protectPath?.(path))) continue;
		targets.push(localFile);
	}
	if (targets.length === 0) return [];

	// First pass: candidate targets per source (size + hash match).
	const candidatesBySource = new Map<string, LocalFile[]>();
	const sourceCountByTarget = new Map<string, number>();
	for (const source of sources) {
		const candidates = targets.filter(t =>
			t.size === source.remote.size && hashes.get(t.path) === source.remote.hash);
		candidatesBySource.set(source.path, candidates);
		if (candidates.length === 1) {
			const targetPath = (candidates[0] as LocalFile).path;
			sourceCountByTarget.set(targetPath, (sourceCountByTarget.get(targetPath) ?? 0) + 1);
		}
	}

	const out: DetectedRename[] = [];
	for (const source of sources) {
		const candidates = candidatesBySource.get(source.path) ?? [];
		if (candidates.length !== 1) continue; // none, or ambiguous → skip
		const target = candidates[0] as LocalFile;
		if ((sourceCountByTarget.get(target.path) ?? 0) !== 1) continue; // contested target → skip
		out.push({
			fromPath: source.path,
			toPath: target.path,
			uuid: source.remote.uuid,
			fileKey: source.remote.key,
			metadata: {
				name: baseNameOf(target.path),
				size: source.remote.size,
				mime: source.remote.mime ?? "application/octet-stream",
				key: source.remote.key,
				lastModified: source.remote.lastModified,
				...(source.remote.creation !== undefined ? { creation: source.remote.creation } : {}),
				...(source.remote.hash ? { hash: source.remote.hash } : {}),
			},
		});
	}
	return out;
}

export function planSync(
	local: LocalTree,
	remote: RemoteTree,
	base: Map<string, BaseRecord>,
	opts: PlannerOptions,
): SyncPlan {
	const plan = emptyPlan();
	const direction = opts.syncDirection ?? "twoWay";

	const baseEmpty = base.size === 0;
	const localEmpty = local.files.size === 0;
	const remoteEmpty = remote.files.size === 0;

	/* ---- empty-source hard guard (v0.7.0, data-loss prevention) ---- */
	// A mirror run whose SOURCE side is empty would wipe the non-empty
	// target. This aborts regardless of base state, and the manual
	// "Sync now (ignore mass-change guard)" command does NOT bypass it
	// (that flag only affects the mass-change guard below).
	if (direction === "push" && localEmpty && !remoteEmpty) {
		plan.aborted = true;
		plan.abortReason =
			"push source is empty — mirroring would wipe the remote; this is almost "
			+ "certainly wrong (seed the vault or switch to two-way/pull)";
		return plan;
	}
	if (direction === "pull" && remoteEmpty && !localEmpty) {
		plan.aborted = true;
		plan.abortReason =
			"pull source is empty — mirroring would wipe the local vault; this is almost "
			+ "certainly wrong (seed the remote or switch to two-way/push)";
		return plan;
	}

	/* ---- seed mode (guard 1) ---- */
	if (baseEmpty && localEmpty && !remoteEmpty) plan.seedMode = "download-all";
	else if (baseEmpty && !localEmpty && remoteEmpty) plan.seedMode = "upload-all";
	else if (baseEmpty && !localEmpty && !remoteEmpty) plan.seedMode = "both-nonempty";

	/* ---- ignored folders (feature A): skip EVERYTHING at/under them ---- */
	// No op generation and NO base record cleanup for ignored prefixes, so
	// un-ignoring later resumes cleanly from intact base records.
	const ignored = ignoredPrefixes(opts);

	/* ---- rename detection (feature D, conservative hash-matched) ---- */
	// v0.7.0: pull suppresses renameRemote entirely — a mirror cloud → local
	// never writes remote (a local rename resolves as trashLocal + download).
	const renames = plan.seedMode || direction === "pull"
		? []
		: detectRenames(local, remote, base, opts, ignored);
	const renamedPaths = new Set<string>();
	for (const rename of renames) {
		renamedPaths.add(rename.fromPath);
		renamedPaths.add(rename.toPath);
		plan.ops.push({
			kind: "renameRemote",
			path: rename.fromPath,
			toPath: rename.toPath,
			remote: remote.files.get(rename.fromPath),
			rename: { uuid: rename.uuid, fileKey: rename.fileKey, metadata: rename.metadata },
		});
	}

	/* ---- per-file decisions ---- */
	const allPaths = new Set<string>();
	for (const p of local.files.keys()) allPaths.add(p);
	for (const p of remote.files.keys()) allPaths.add(p);
	for (const p of base.keys()) allPaths.add(p);

	let deletes = 0;
	let modifies = 0;
	for (const path of allPaths) {
		// v0.5.0+: internal sync files at the vault root (shared preferences,
		// current and legacy names, stray tmp files) are managed ONLY via
		// explicit client calls — never planned (no download/upload/trash),
		// whatever the scan data says.
		if (!path.includes("/") && path.startsWith(".filen-")) continue;
		// Excluded-but-present locally (ignore pattern, dotfile toggle, size
		// limit, …): "ignored" must never be read as "deleted" — suppress ALL
		// ops and leave the base record untouched.
		if (local.excluded.has(path)) continue;
		// Ignored folder prefix: no ops, no base cleanup (base preserved).
		if ((isIgnored(path, ignored) || opts.protectPath?.(path))) continue;
		// Rename source/target paths are fully handled by the renameRemote op —
		// never also plan a delete for the source or an upload for the target.
		if (renamedPaths.has(path)) continue;
		const decision = planFile(
			path,
			local.files.get(path),
			remote.files.get(path),
			base.get(path),
			opts,
			plan.seedMode,
		);
		plan.ops.push(...decision.ops);
		deletes += decision.deletes;
		modifies += decision.modifies;
		if (decision.conflict) plan.conflicts.push(decision.conflict);
	}

	/* ---- folders ---- */
	// Actual current dir sets (dirs + parent chains of files).
	const localActual = new Set<string>(local.folders);
	for (const f of local.files.keys()) for (const p of parentChains(f)) localActual.add(p);
	const remoteActual = new Set<string>();
	for (const d of remote.folders.keys()) if (d !== "") remoteActual.add(d);
	for (const f of remote.files.keys()) for (const p of parentChains(f)) remoteActual.add(p);

	// Base evidence: a dir previously contained synced files.
	const baseDirs = new Set<string>();
	for (const p of base.keys()) {
		for (const parent of parentChains(p)) baseDirs.add(parent);
	}

	// Planned post-sync existence (for prune safety): downloads create local
	// dirs, uploads create remote dirs. Excluded-but-present local files keep
	// existing in the vault — count them (and their parent dirs) as planned
	// local so their remote folders are never pruned.
	const plannedLocal = new Set<string>(localActual);
	const plannedRemote = new Set<string>(remoteActual);
	for (const p of local.excluded) {
		plannedLocal.add(p);
		for (const parent of parentChains(p)) plannedLocal.add(parent);
	}
	for (const op of plan.ops) {
		if (op.kind === "download") for (const p of parentChains(op.path)) plannedLocal.add(p);
		if (op.kind === "upload") for (const p of parentChains(op.path)) plannedRemote.add(p);
		if (op.kind === "renameLocal" && op.toPath) {
			for (const p of parentChains(op.toPath)) plannedLocal.add(p);
		}
		if (op.kind === "renameRemote" && op.toPath) {
			// The rename target's parent chain must exist remotely post-sync.
			for (const p of parentChains(op.toPath)) plannedRemote.add(p);
		}
	}
	const plannedLocalArr = [...plannedLocal];
	const plannedRemoteArr = [...plannedRemote];

	// Prunes FIRST (deepest-first): only dirs with base evidence whose
	// counterpart side has fully vanished after the planned file ops
	// (modify-beats-delete for dirs too).
	const prunedRemote = new Set<string>();
	// v0.4.0 feature D: a cached remote tree (events fast-poll) is not
	// tree-fresh → skip remote-folder pruning entirely; file-level logic is
	// unaffected. A full dir/tree re-enables pruning.
	// v0.7.0: pull never prunes remote folders (the cloud is the source).
	if (!opts.skipRemoteFolderPrune && direction !== "pull") {
		const remoteDirsDeepestFirst = [...remoteActual].sort((a, b) => b.length - a.length);
		for (const d of remoteDirsDeepestFirst) {
			if ((isIgnored(d, ignored) || opts.protectPath?.(d))) continue; // ignored prefix: leave remote dirs alone
			if (!remote.folders.has(d)) continue; // only actual remote dirs can be trashed
			if (!baseDirs.has(d)) continue; // brand-new remote dir → mkdirLocal instead
			if (plannedLocalArr.some(p => pathAtOrUnder(d, p))) continue;
			prunedRemote.add(d);
			plan.ops.push({ kind: "trashRemoteDir", path: d });
		}
	}
	const prunedLocal = new Set<string>();
	// v0.7.0: push never prunes local folders (the vault is the source).
	if (direction !== "push") {
		const localDirsDeepestFirst = [...localActual].sort((a, b) => b.length - a.length);
		for (const d of localDirsDeepestFirst) {
			if ((isIgnored(d, ignored) || opts.protectPath?.(d))) continue; // ignored prefix: leave local dirs alone
			if (!baseDirs.has(d)) continue;
			if (plannedRemoteArr.some(p => pathAtOrUnder(d, p))) continue;
			// every local file under d must be getting trashed for this to be safe
			if ([...local.files.keys()].some(f => pathAtOrUnder(d, f)
				&& !plan.ops.some(op => op.kind === "trashLocal" && op.path === f))) continue;
			prunedLocal.add(d);
			plan.ops.push({ kind: "trashLocalDir", path: d });
		}
	}

	// mkdir ops (safe, ensure-exists both sides) — skip pruned dirs.
	// v0.7.0: mkdir only towards the mirror target (push → remote,
	// pull → local); a mirror never creates folders on its source side.
	if (direction !== "pull") {
		for (const d of localActual) {
			if ((isIgnored(d, ignored) || opts.protectPath?.(d))) continue;
			if (!remoteActual.has(d) && !prunedLocal.has(d)) {
				plan.ops.push({ kind: "mkdirRemote", path: d });
			}
		}
	}
	// Folders that exist locally because they hold excluded files — no
	// mkdirLocal needed for those.
	const excludedLocalDirs = new Set<string>();
	for (const p of local.excluded) {
		for (const parent of parentChains(p)) excludedLocalDirs.add(parent);
	}
	if (direction !== "push") {
		for (const d of remoteActual) {
			if ((isIgnored(d, ignored) || opts.protectPath?.(d))) continue;
			if (!localActual.has(d) && !prunedRemote.has(d) && !excludedLocalDirs.has(d)) {
				plan.ops.push({ kind: "mkdirLocal", path: d });
			}
		}
	}

	/* ---- mass-change abort (guard 2) ---- */
	const totalFiles = new Set([...local.files.keys(), ...remote.files.keys()]).size;
	if (
		!plan.seedMode
		&& !opts.ignoreMassChangeGuard
		&& totalFiles > 0
		&& opts.massChangeAbortPercent < 100
		&& (deletes + modifies) > (opts.massChangeAbortPercent / 100) * totalFiles
	) {
		plan.aborted = true;
		plan.abortReason =
			`mass-change guard: ${deletes + modifies} deletes/modifies exceeds `
			+ `${opts.massChangeAbortPercent}% of ${totalFiles} files — aborted; `
			+ `run "Sync now (ignore mass-change guard)" to proceed`;
		return plan;
	}

	/* ---- phase ordering (the design docs execution phases) ---- */
	const phaseOf = (op: SyncOp): number => {
		switch (op.kind) {
			case "renameRemote": return 0; // server-side renames FIRST, before all deletes
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
	};
	// Deepest-first for dir ops, stable otherwise.
	plan.ops.sort((a, b) => {
		const pa = phaseOf(a);
		const pb = phaseOf(b);
		if (pa !== pb) return pa - pb;
		if ((pa === 8 || pa === 9) && a.path !== b.path) return b.path.length - a.path.length;
		return 0;
	});

	for (const op of plan.ops) {
		switch (op.kind) {
			case "upload": plan.counts.uploads++; break;
			case "download": plan.counts.downloads++; break;
			case "trashLocal": plan.counts.trashLocal++; break;
			case "trashRemote": plan.counts.trashRemote++; break;
			case "mkdirLocal": plan.counts.mkdirLocal++; break;
			case "mkdirRemote": plan.counts.mkdirRemote++; break;
			case "renameRemote": plan.counts.renames++; break;
			case "trashLocalDir":
			case "trashRemoteDir": plan.counts.prunes++; break;
			default: break;
		}
	}
	plan.counts.conflicts = plan.conflicts.length;

	return plan;
}
