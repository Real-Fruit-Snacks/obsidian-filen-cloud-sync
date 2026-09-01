/**
 * PURE shared-settings (opt-in) primitives (the design docs v0.5.0). No obsidian
 * imports, no IO — fully unit-testable.
 *
 * A CURATED subset of settings (SharedPrefs) syncs across devices via an
 * encrypted JSON file `.filen-sync-preferences.json` placed directly in the
 * sync-root folder. Everything else (credentials, remote folder, intervals,
 * size limits, device/debug options) stays per-device.
 *
 * Convergence: last writer wins. `updatedAt` INSIDE the file is authoritative
 * (never file mtime) — a device applies a remote file only when its
 * updatedAt is newer than the locally persisted `sharedPrefsAppliedAt`.
 */

import type { ConflictPolicy } from "./types";

/** Root-level, exact name — hard-excluded from every sync operation. */
export const PREFS_FILE_NAME = ".filen-sync-preferences.json";

/** File-format version; parsePrefs rejects anything else. */
export const PREFS_VERSION = 1;

/** The exact six keys that sync. NOTHING else ever leaves the device. */
export interface SharedPrefs {
	conflictPolicy: ConflictPolicy;
	conflictResolution: "auto" | "ask";
	excludeDotFiles: boolean;
	ignorePatterns: string;
	ignoredFolders: string[];
	configSyncAllowlist: string[];
}

/** On-disk JSON body of the preferences file. */
export interface PrefsFile {
	version: number;
	updatedAt: number; // ms epoch — authoritative ordering field
	device: string; // writer's deviceName (display/log only)
	prefs: SharedPrefs;
}

/** Canonical key order — also the order applyPrefs reports changes in. */
export const SHARED_PREF_KEYS = [
	"conflictPolicy",
	"conflictResolution",
	"excludeDotFiles",
	"ignorePatterns",
	"ignoredFolders",
	"configSyncAllowlist",
] as const;

export type SharedPrefKey = typeof SHARED_PREF_KEYS[number];

/** Extract the shared subset from a full settings object (structural). */
export function prefsFromSettings(settings: SharedPrefs): SharedPrefs {
	return {
		conflictPolicy: settings.conflictPolicy,
		conflictResolution: settings.conflictResolution,
		excludeDotFiles: settings.excludeDotFiles,
		ignorePatterns: settings.ignorePatterns,
		ignoredFolders: [...settings.ignoredFolders],
		configSyncAllowlist: [...settings.configSyncAllowlist],
	};
}

/** Serialize the preferences file body (pretty-printed for debuggability). */
export function serializePrefs(prefs: SharedPrefs, device: string, updatedAt: number): string {
	const body: PrefsFile = { version: PREFS_VERSION, updatedAt, device, prefs: prefsFromSettings(prefs) };
	return JSON.stringify(body, null, 2);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/**
 * Validate a raw SharedPrefs-shaped value. Returns a defensive copy holding
 * ONLY the six shared keys, or null on any missing/mistyped field. Extra
 * keys are tolerated (forward compatibility) but never carried over.
 */
export function parseSharedPrefs(value: unknown): SharedPrefs | null {
	if (typeof value !== "object" || value === null) return null;
	const prefs = value as Record<string, unknown>;
	if (prefs.conflictPolicy !== "keep_both" && prefs.conflictPolicy !== "keep_newer") return null;
	if (prefs.conflictResolution !== "auto" && prefs.conflictResolution !== "ask") return null;
	if (typeof prefs.excludeDotFiles !== "boolean") return null;
	if (typeof prefs.ignorePatterns !== "string") return null;
	if (!isStringArray(prefs.ignoredFolders)) return null;
	if (!isStringArray(prefs.configSyncAllowlist)) return null;
	return {
		conflictPolicy: prefs.conflictPolicy,
		conflictResolution: prefs.conflictResolution,
		excludeDotFiles: prefs.excludeDotFiles,
		ignorePatterns: prefs.ignorePatterns,
		ignoredFolders: [...prefs.ignoredFolders],
		configSyncAllowlist: [...prefs.configSyncAllowlist],
	};
}

/**
 * Parse + validate a preferences file body. Returns null on ANY garbage:
 * bad JSON, wrong version, missing/mistyped fields. Extra keys are tolerated
 * (forward compatibility), the six shared keys must all be present and
 * well-typed.
 */
export function parsePrefs(text: string): PrefsFile | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const body = raw as Record<string, unknown>;
	if (body.version !== PREFS_VERSION) return null;
	if (typeof body.updatedAt !== "number" || !Number.isFinite(body.updatedAt)) return null;
	if (typeof body.device !== "string") return null;
	const prefs = parseSharedPrefs(body.prefs);
	if (!prefs) return null;
	return {
		version: PREFS_VERSION,
		updatedAt: body.updatedAt,
		device: body.device,
		prefs,
	};
}

function sameStringArray(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Write the six shared keys into `settings`. Returns the keys whose values
 * actually changed (canonical order) — ONLY these six keys are ever touched.
 */
export function applyPrefs(settings: SharedPrefs, prefs: SharedPrefs): SharedPrefKey[] {
	const changed: SharedPrefKey[] = [];
	if (settings.conflictPolicy !== prefs.conflictPolicy) {
		settings.conflictPolicy = prefs.conflictPolicy;
		changed.push("conflictPolicy");
	}
	if (settings.conflictResolution !== prefs.conflictResolution) {
		settings.conflictResolution = prefs.conflictResolution;
		changed.push("conflictResolution");
	}
	if (settings.excludeDotFiles !== prefs.excludeDotFiles) {
		settings.excludeDotFiles = prefs.excludeDotFiles;
		changed.push("excludeDotFiles");
	}
	if (settings.ignorePatterns !== prefs.ignorePatterns) {
		settings.ignorePatterns = prefs.ignorePatterns;
		changed.push("ignorePatterns");
	}
	if (!sameStringArray(settings.ignoredFolders, prefs.ignoredFolders)) {
		settings.ignoredFolders = [...prefs.ignoredFolders];
		changed.push("ignoredFolders");
	}
	if (!sameStringArray(settings.configSyncAllowlist, prefs.configSyncAllowlist)) {
		settings.configSyncAllowlist = [...prefs.configSyncAllowlist];
		changed.push("configSyncAllowlist");
	}
	return changed;
}
