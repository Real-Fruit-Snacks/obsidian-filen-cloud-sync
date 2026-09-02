/**
 * Settings model tests (v0.7.0): the sync-direction default, merge-safety
 * with old data.json, persistence round-trip, and the guarantee that the
 * per-device direction is NOT a shared-settings key.
 */

import { describe, expect, it } from "vitest";
import { defaultSettings, FilenSyncSettings } from "../src/settings";
import { SHARED_PREF_KEYS } from "../src/sync/sharedPrefs";

describe("syncDirection setting (v0.7.0)", () => {
	it("defaults to twoWay", () => {
		expect(defaultSettings("vault").syncDirection).toBe("twoWay");
	});

	it("merge-safe with an old data.json that lacks the key (stays twoWay)", () => {
		// main.ts loads: Object.assign({}, defaultSettings(name), loadData()).
		const oldDataJson = JSON.stringify({
			email: "user@example.com",
			conflictPolicy: "keep_newer",
		});
		const merged: FilenSyncSettings = Object.assign(
			{},
			defaultSettings("vault"),
			JSON.parse(oldDataJson) as Partial<FilenSyncSettings>,
		);
		expect(merged.syncDirection).toBe("twoWay");
		expect(merged.conflictPolicy).toBe("keep_newer"); // unrelated keys still merge
	});

	it("a persisted push/pull selection survives the data.json round-trip (dropdown persists)", () => {
		const settings = defaultSettings("vault");
		settings.syncDirection = "push";
		const reloaded: FilenSyncSettings = Object.assign(
			{},
			defaultSettings("vault"),
			JSON.parse(JSON.stringify(settings)) as Partial<FilenSyncSettings>,
		);
		expect(reloaded.syncDirection).toBe("push");
		settings.syncDirection = "pull";
		const reloadedPull: FilenSyncSettings = Object.assign(
			{},
			defaultSettings("vault"),
			JSON.parse(JSON.stringify(settings)) as Partial<FilenSyncSettings>,
		);
		expect(reloadedPull.syncDirection).toBe("pull");
	});

	it("is NOT a shared-settings key (per-device by nature)", () => {
		expect(SHARED_PREF_KEYS).not.toContain("syncDirection");
	});
});
