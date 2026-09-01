/**
 * Local vault scan → LocalTree (the design docs).
 * Excludes: configDir, dotfiles (setting), .trash, *.filen-tmp, ignore
 * patterns (+ .filenignore), reserved names, oversized files.
 * Detects case-insensitive collisions (first wins, rest skipped + warned).
 *
 * v0.4.0 feature A: with syncConfigDir on, the blanket configDir exclusion
 * yields to exactly the allowlisted paths (scanned via vault.adapter — they
 * are invisible to the Vault API). workspace.json/workspace* stay HARD
 * excluded even when allowlisted.
 */

import type { Vault } from "obsidian";
import {
	detectCaseCollisions,
	baseNameOf,
	isReservedName,
	isWorkspaceFileName,
	matchesIgnore,
	normalizeVaultPath,
	parseIgnorePatterns,
} from "../util";
import { PREFS_FILE_NAME } from "./sharedPrefs";
import type { LocalFile, LocalTree } from "./types";

export interface LocalScanOptions {
	excludeDotFiles: boolean;
	ignorePatterns: string;
	skipLargeFiles: boolean;
	skipSizeLargerThanMB: number;
	/** Vault-relative ignored folder prefixes (NFC, no slashes) — feature A. */
	ignoredFolders: string[];
	/** v0.4.0 feature A: opt-in selective .obsidian config sync. */
	syncConfigDir?: boolean;
	/** Paths relative to configDir (files, or folders synced recursively). */
	configSyncAllowlist?: string[];
}

const TMP_SUFFIX = ".filen-tmp";

/** True when `normalized` (under cfg) is covered by an allowlist entry. */
export function allowlistAllows(normalized: string, cfg: string, allowlist: string[] | undefined): boolean {
	const relative = normalized === cfg ? "" : normalized.slice(cfg.length + 1);
	for (const rawEntry of allowlist ?? []) {
		const entry = normalizeVaultPath(rawEntry);
		if (entry.length === 0) continue;
		if (relative === entry || relative.startsWith(entry + "/")) return true;
	}
	return false;
}

export function shouldExcludePath(
	path: string,
	isDir: boolean,
	configDir: string,
	opts: LocalScanOptions,
	ignoreRulesText: string,
): string | null {
	const normalized = normalizeVaultPath(path);
	// v0.5.0: the shared-preferences file lives in the sync root and is managed
	// ONLY via explicit client calls — never synced as vault content, even when
	// excludeDotFiles is off (hard reserved exclusion, like *.filen-tmp).
	if (normalized === PREFS_FILE_NAME) return "sync preferences file";
	const cfg = normalizeVaultPath(configDir);
	const underConfig = normalized === cfg || normalized.startsWith(cfg + "/");
	if (underConfig) {
		// HARD guard: workspace.json/workspace* never sync, allowlist or not.
		if (isWorkspaceFileName(baseNameOf(normalized))) return "workspace files never sync";
		if (!opts.syncConfigDir || !allowlistAllows(normalized, cfg, opts.configSyncAllowlist)) {
			return "config dir";
		}
		// Allowlisted config path: fall through to the remaining rules — but
		// skip the dotfile check below (every config path has a dot-segment).
	}
	for (const folder of opts.ignoredFolders ?? []) {
		const prefix = normalizeVaultPath(folder);
		if (prefix.length > 0 && (normalized === prefix || normalized.startsWith(prefix + "/"))) {
			return "ignored folder";
		}
	}
	const segments = normalized.split("/");
	for (const segment of segments) {
		if (segment === ".trash") return "trash folder";
		// Allowlisted config paths are exempt from the dotfile rule — the
		// config dir itself is a dot-segment, so the rule would kill them all.
		if (!underConfig && segment.startsWith(".")) {
			if (opts.excludeDotFiles) return "dotfile";
		}
	}
	if (!isDir && normalized.endsWith(TMP_SUFFIX)) return "stray tmp file";
	const base = segments[segments.length - 1] as string;
	if (isReservedName(base)) return "reserved name";
	if (matchesIgnore(parseIgnorePatterns(ignoreRulesText), normalized, isDir)) {
		return "ignore pattern";
	}
	return null;
}

export async function scanLocalVault(vault: Vault, opts: LocalScanOptions): Promise<LocalTree> {
	// Merge ignore patterns from settings + .filenignore in vault root.
	let ignoreText = opts.ignorePatterns;
	try {
		if (await vault.adapter.exists(".filenignore")) {
			const extra = await vault.adapter.read(".filenignore");
			ignoreText = `${ignoreText}\n${extra}`;
		}
	} catch {
		// unreadable .filenignore — proceed with settings patterns only
	}
	const rulesText = ignoreText;

	const skipped: Array<{ path: string; reason: string }> = [];
	const excluded = new Set<string>();
	const sizeLimitBytes = opts.skipLargeFiles
		? opts.skipSizeLargerThanMB * 1024 * 1024
		: Number.POSITIVE_INFINITY;

	const files = new Map<string, LocalFile>();
	const allPaths: string[] = [];
	const addScannedFile = (path: string, mtime: number, size: number): void => {
		const reason = shouldExcludePath(path, false, vault.configDir, opts, rulesText);
		if (reason) {
			skipped.push({ path, reason });
			excluded.add(path); // exists in the vault — ignored ≠ deleted
			return;
		}
		if (size > sizeLimitBytes) {
			skipped.push({ path, reason: `larger than ${opts.skipSizeLargerThanMB} MB` });
			excluded.add(path);
			return;
		}
		allPaths.push(path);
		files.set(path, { path, mtime, size });
	};
	for (const file of vault.getFiles()) {
		addScannedFile(normalizeVaultPath(file.path), file.stat.mtime, file.stat.size);
	}

	// Folders (incl. empty ones) so empty dirs sync.
	const folders = new Set<string>();
	const addScannedFolder = (path: string): void => {
		if (path.length === 0) return;
		if (shouldExcludePath(path, true, vault.configDir, opts, rulesText)) return;
		folders.add(path);
	};

	// v0.4.0 feature A: allowlisted config files/folders are invisible to the
	// Vault API → resolve them through vault.adapter (exists/stat/list).
	// A failed entry is skipped loudly, never treated as deleted.
	if (opts.syncConfigDir) {
		const cfg = normalizeVaultPath(vault.configDir);
		for (const rawEntry of opts.configSyncAllowlist ?? []) {
			const entry = normalizeVaultPath(rawEntry);
			if (entry.length === 0) continue;
			const entryPath = `${cfg}/${entry}`;
			try {
				const stat = await vault.adapter.stat(entryPath);
				if (!stat) continue; // entry not present on this device
				if (stat.type === "folder") {
					addScannedFolder(entryPath);
					// adapter.list is NON-recursive (obsidian.d.ts) — walk the
					// tree ourselves with a queue. (Test mocks must match the
					// non-recursive contract or this bug stays invisible.)
					const queue: string[] = [entryPath];
					while (queue.length > 0) {
						const dir = queue.shift() as string;
						const listing = await vault.adapter.list(dir);
						for (const folderPath of listing.folders) {
							const nested = normalizeVaultPath(folderPath);
							addScannedFolder(nested);
							queue.push(nested);
						}
						for (const filePath of listing.files) {
							const normalized = normalizeVaultPath(filePath);
							const fileStat = await vault.adapter.stat(normalized);
							if (!fileStat) continue;
							addScannedFile(normalized, fileStat.mtime, fileStat.size);
						}
					}
				} else {
					addScannedFile(entryPath, stat.mtime, stat.size);
				}
			} catch {
				skipped.push({ path: entryPath, reason: "config scan failed" });
				excluded.add(entryPath);
			}
		}
	}

	// Case-collision detection: first (lexicographic) wins; rest skipped.
	const collisions = detectCaseCollisions(allPaths);
	for (const group of collisions) {
		for (let i = 1; i < group.length; i++) {
			const loser = group[i] as string;
			files.delete(loser);
			skipped.push({ path: loser, reason: `case collision with ${group[0] as string}` });
			excluded.add(loser);
		}
	}

	for (const folder of vault.getAllFolders(false)) {
		addScannedFolder(normalizeVaultPath(folder.path));
	}

	return { files, folders, skipped, excluded, collisions };
}
