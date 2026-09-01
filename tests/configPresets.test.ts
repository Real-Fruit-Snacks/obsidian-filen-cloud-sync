/**
 * Config-sync preset helpers (v0.5.1): toggles edit the same allowlist;
 * the textarea manages only non-preset (custom) entries.
 */

import { describe, expect, it } from "vitest";
import {
	CONFIG_PRESETS,
	customAllowlistEntries,
	isPresetEnabled,
	mergeAllowlist,
	togglePreset,
} from "../src/util";

describe("config presets", () => {
	it("every preset path is unique and non-empty", () => {
		const paths = CONFIG_PRESETS.map(p => p.path);
		expect(new Set(paths).size).toBe(paths.length);
		for (const p of paths) expect(p.length).toBeGreaterThan(0);
	});

	it("togglePreset adds, removes, dedupes, and normalizes", () => {
		let list: string[] = [];
		list = togglePreset(list, "themes", true);
		expect(list).toEqual(["themes"]);
		list = togglePreset(list, "themes", true); // no duplicate
		expect(list).toEqual(["themes"]);
		list = togglePreset(list, "plugins", true);
		expect(list).toEqual(["themes", "plugins"]);
		list = togglePreset(list, "themes", false);
		expect(list).toEqual(["plugins"]);
	});

	it("togglePreset normalizes slashes/NFC-ish input", () => {
		const list = togglePreset([" /themes/ ", "snippets"], "themes", false);
		expect(list).toEqual(["snippets"]);
	});

	it("isPresetEnabled detects presence", () => {
		expect(isPresetEnabled(["themes", "snippets"], "themes")).toBe(true);
		expect(isPresetEnabled(["themes"], "plugins")).toBe(false);
	});

	it("customAllowlistEntries returns only non-preset entries", () => {
		expect(customAllowlistEntries(["appearance.json", "themes", "app.json", "my-folder"]))
			.toEqual(["app.json", "my-folder"]);
		expect(customAllowlistEntries([])).toEqual([]);
	});

	it("mergeAllowlist preserves preset states and replaces custom entries", () => {
		const current = ["themes", "snippets", "old-custom"];
		const merged = mergeAllowlist(current, ["app.json", "app.json", ""]);
		// presets kept as-is, custom replaced with the new list, deduped
		expect(merged).toEqual(["themes", "snippets", "app.json"]);
	});

	it("mergeAllowlist cannot smuggle a preset path into custom entries", () => {
		const merged = mergeAllowlist([], ["themes", "app.json"]);
		// "themes" is preset-managed — a custom line with that name is dropped,
		// not silently enabled
		expect(merged).toEqual(["app.json"]);
	});
});
