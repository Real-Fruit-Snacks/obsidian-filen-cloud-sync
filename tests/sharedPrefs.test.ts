/**
 * Pure tests for the shared-settings primitives (v0.5.0): serialize/parse
 * round-trip, garbage rejection, changed-keys apply semantics, and the
 * guarantee that ONLY the six shared keys are ever written.
 */

import { describe, expect, it } from "vitest";
import {
	applyPrefs,
	PREFS_FILE_NAME,
	PREFS_VERSION,
	parsePrefs,
	prefsFromSettings,
	serializePrefs,
	SHARED_PREF_KEYS,
	SharedPrefs,
} from "../src/sync/sharedPrefs";

function samplePrefs(): SharedPrefs {
	return {
		conflictPolicy: "keep_newer",
		conflictResolution: "ask",
		excludeDotFiles: false,
		ignorePatterns: "private/**\n*.tmp",
		ignoredFolders: ["archive", "scratch/inbox"],
		configSyncAllowlist: ["appearance.json", "snippets"],
	};
}

describe("serializePrefs / parsePrefs", () => {
	it("round-trips prefs, device and updatedAt", () => {
		const prefs = samplePrefs();
		const text = serializePrefs(prefs, "laptop", 1_700_000_123_456);
		const parsed = parsePrefs(text);
		expect(parsed).not.toBeNull();
		expect(parsed?.version).toBe(PREFS_VERSION);
		expect(parsed?.updatedAt).toBe(1_700_000_123_456);
		expect(parsed?.device).toBe("laptop");
		expect(parsed?.prefs).toEqual(prefs);
	});

	it("round-trip produces a deep copy (mutation isolation)", () => {
		const prefs = samplePrefs();
		const parsed = parsePrefs(serializePrefs(prefs, "d", 1));
		parsed?.prefs.ignoredFolders.push("mutated");
		expect(prefs.ignoredFolders).not.toContain("mutated");
	});

	it("rejects non-JSON garbage", () => {
		expect(parsePrefs("")).toBeNull();
		expect(parsePrefs("not json")).toBeNull();
		expect(parsePrefs("{broken")).toBeNull();
	});

	it("rejects non-object bodies", () => {
		expect(parsePrefs("null")).toBeNull();
		expect(parsePrefs("[]")).toBeNull();
		expect(parsePrefs("42")).toBeNull();
		expect(parsePrefs("\"string\"")).toBeNull();
	});

	it("rejects wrong/missing version", () => {
		const good = JSON.parse(serializePrefs(samplePrefs(), "d", 5)) as Record<string, unknown>;
		expect(parsePrefs(JSON.stringify({ ...good, version: 2 }))).toBeNull();
		expect(parsePrefs(JSON.stringify({ ...good, version: "1" }))).toBeNull();
		const { version: _omit, ...noVersion } = good;
		expect(parsePrefs(JSON.stringify(noVersion))).toBeNull();
	});

	it("rejects bad updatedAt / device", () => {
		const good = JSON.parse(serializePrefs(samplePrefs(), "d", 5)) as Record<string, unknown>;
		expect(parsePrefs(JSON.stringify({ ...good, updatedAt: "now" }))).toBeNull();
		expect(parsePrefs(JSON.stringify({ ...good, updatedAt: Number.NaN }))).toBeNull();
		expect(parsePrefs(JSON.stringify({ ...good, device: 7 }))).toBeNull();
	});

	it("rejects missing or mistyped prefs fields", () => {
		const prefs = samplePrefs() as unknown as Record<string, unknown>;
		const wrap = (p: unknown) => JSON.stringify({ version: 1, updatedAt: 5, device: "d", prefs: p });
		expect(parsePrefs(wrap(null))).toBeNull();
		expect(parsePrefs(wrap({}))).toBeNull();
		expect(parsePrefs(wrap({ ...prefs, conflictPolicy: "delete_everything" }))).toBeNull();
		expect(parsePrefs(wrap({ ...prefs, conflictResolution: "yolo" }))).toBeNull();
		expect(parsePrefs(wrap({ ...prefs, excludeDotFiles: "yes" }))).toBeNull();
		expect(parsePrefs(wrap({ ...prefs, ignorePatterns: ["a"] }))).toBeNull();
		expect(parsePrefs(wrap({ ...prefs, ignoredFolders: "archive" }))).toBeNull();
		expect(parsePrefs(wrap({ ...prefs, ignoredFolders: ["ok", 3] }))).toBeNull();
		expect(parsePrefs(wrap({ ...prefs, configSyncAllowlist: undefined }))).toBeNull();
		// Missing a single shared key → reject.
		const { ignorePatterns: _omit, ...missing } = prefs;
		expect(parsePrefs(wrap(missing))).toBeNull();
	});

	it("tolerates extra keys (forward compatibility)", () => {
		const good = JSON.parse(serializePrefs(samplePrefs(), "d", 5)) as Record<string, unknown>;
		good.futureField = { nested: true };
		expect(parsePrefs(JSON.stringify(good))).not.toBeNull();
	});
});

describe("prefsFromSettings", () => {
	it("extracts exactly the six shared keys as copies", () => {
		const settings = {
			...samplePrefs(),
			email: "user@example.com",
			remoteFolder: "Obsidian/vault",
			shareSettings: true,
		};
		const prefs = prefsFromSettings(settings);
		expect(Object.keys(prefs).sort()).toEqual([...SHARED_PREF_KEYS].sort());
		settings.ignoredFolders.push("mutated");
		expect(prefs.ignoredFolders).not.toContain("mutated");
	});
});

describe("applyPrefs", () => {
	it("returns an empty list when nothing changed", () => {
		const settings = samplePrefs();
		expect(applyPrefs(settings, samplePrefs())).toEqual([]);
	});

	it("returns the changed keys in canonical order", () => {
		const settings = samplePrefs();
		const incoming: SharedPrefs = {
			...samplePrefs(),
			configSyncAllowlist: ["appearance.json"],
			conflictPolicy: "keep_both",
			excludeDotFiles: true,
		};
		const changed = applyPrefs(settings, incoming);
		expect(changed).toEqual(["conflictPolicy", "excludeDotFiles", "configSyncAllowlist"]);
		expect(settings.conflictPolicy).toBe("keep_both");
		expect(settings.excludeDotFiles).toBe(true);
		expect(settings.configSyncAllowlist).toEqual(["appearance.json"]);
		// Untouched keys keep their values.
		expect(settings.ignorePatterns).toBe(samplePrefs().ignorePatterns);
	});

	it("detects array order differences and copies the incoming array", () => {
		const settings = samplePrefs();
		const incoming = { ...samplePrefs(), ignoredFolders: ["scratch/inbox", "archive"] };
		const changed = applyPrefs(settings, incoming);
		expect(changed).toEqual(["ignoredFolders"]);
		incoming.ignoredFolders.push("mutated");
		expect(settings.ignoredFolders).not.toContain("mutated");
	});

	it("writes ONLY the six shared keys — everything else stays per-device", () => {
		const settings = {
			...samplePrefs(),
			email: "user@example.com",
			remoteFolder: "Obsidian/vault",
			autoSyncInterval: false,
			syncIntervalMinutes: 42,
			deviceName: "this-device",
			sharedPrefsAppliedAt: 123,
		};
		const changed = applyPrefs(settings, {
			conflictPolicy: "keep_both",
			conflictResolution: "auto",
			excludeDotFiles: true,
			ignorePatterns: "",
			ignoredFolders: [],
			configSyncAllowlist: [],
		});
		expect(changed.sort()).toEqual([...SHARED_PREF_KEYS].sort());
		expect(settings.email).toBe("user@example.com");
		expect(settings.remoteFolder).toBe("Obsidian/vault");
		expect(settings.autoSyncInterval).toBe(false);
		expect(settings.syncIntervalMinutes).toBe(42);
		expect(settings.deviceName).toBe("this-device");
		expect(settings.sharedPrefsAppliedAt).toBe(123);
	});
});

describe("PREFS_FILE_NAME", () => {
	it("is the exact root-level reserved name", () => {
		expect(PREFS_FILE_NAME).toBe(".filen-sync-preferences.json");
	});
});
