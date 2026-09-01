/**
 * Local scan: size-limit toggle behavior (v0.2.0 — "Skip large files" toggle)
 * and selective folder ignore (v0.3.0 — feature A).
 */

import { describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { LocalScanOptions, scanLocalVault } from "../src/sync/localScan";

function fakeVault(files: Array<{ path: string; size: number }>, folders: string[] = []): Vault {
	return {
		configDir: ".obsidian",
		adapter: {
			exists: async () => false,
			read: async () => "",
		},
		getFiles: () => files.map(f => ({
			path: f.path,
			stat: { size: f.size, mtime: 1000, ctime: 1000 },
		})),
		getAllFolders: () => folders.map(path => ({ path })),
	} as unknown as Vault;
}

const baseOpts: LocalScanOptions = {
	excludeDotFiles: true,
	ignorePatterns: "",
	skipLargeFiles: true,
	skipSizeLargerThanMB: 1, // 1 MB
	ignoredFolders: [],
};

describe("localScan size limit", () => {
	it("excludes oversized files when the limit is enabled", async () => {
		const tree = await scanLocalVault(fakeVault([
			{ path: "small.md", size: 10 },
			{ path: "big.bin", size: 2 * 1024 * 1024 },
		]), baseOpts);
		expect(tree.files.has("small.md")).toBe(true);
		expect(tree.files.has("big.bin")).toBe(false);
		// excluded-but-present, so the planner never treats it as deleted
		expect(tree.excluded.has("big.bin")).toBe(true);
	});

	it("includes oversized files when the limit is disabled", async () => {
		const tree = await scanLocalVault(fakeVault([
			{ path: "small.md", size: 10 },
			{ path: "big.bin", size: 2 * 1024 * 1024 },
		]), { ...baseOpts, skipLargeFiles: false });
		expect(tree.files.has("big.bin")).toBe(true);
		expect(tree.excluded.has("big.bin")).toBe(false);
	});
});

describe("localScan ignored folders (feature A)", () => {
	it("excludes files AND folders at/under an ignored prefix (ignored ≠ deleted)", async () => {
		const tree = await scanLocalVault(fakeVault(
			[
				{ path: "notes/a.md", size: 10 },
				{ path: "private/secret.md", size: 10 },
				{ path: "private/deep/nested.md", size: 10 },
			],
			["notes", "private", "private/deep"],
		), { ...baseOpts, ignoredFolders: ["private"] });
		expect(tree.files.has("notes/a.md")).toBe(true);
		expect(tree.files.has("private/secret.md")).toBe(false);
		expect(tree.files.has("private/deep/nested.md")).toBe(false);
		// excluded-but-present so the planner never reads them as deleted
		expect(tree.excluded.has("private/secret.md")).toBe(true);
		expect(tree.excluded.has("private/deep/nested.md")).toBe(true);
		expect(tree.folders.has("notes")).toBe(true);
		expect(tree.folders.has("private")).toBe(false);
		expect(tree.folders.has("private/deep")).toBe(false);
		expect(tree.skipped.some(s => s.path === "private/secret.md" && s.reason === "ignored folder")).toBe(true);
	});

	it("does not exclude same-prefix siblings (private-stuff stays synced)", async () => {
		const tree = await scanLocalVault(fakeVault(
			[{ path: "private-stuff/a.md", size: 10 }],
			["private-stuff"],
		), { ...baseOpts, ignoredFolders: ["private"] });
		expect(tree.files.has("private-stuff/a.md")).toBe(true);
		expect(tree.folders.has("private-stuff")).toBe(true);
	});
});

describe("config dir sync (v0.4.0 feature A)", () => {
	interface ConfigEntry { path: string; size?: number; folder?: boolean }

	/** Vault whose .obsidian entries exist ONLY via the adapter (Vault-API invisible). */
	function configVault(configEntries: ConfigEntry[]): Vault {
		const files = new Map<string, { mtime: number; size: number }>();
		const folders = new Set<string>();
		for (const entry of configEntries) {
			if (entry.folder) folders.add(entry.path);
			else files.set(entry.path, { mtime: 2000, size: entry.size ?? 10 });
		}
		return {
			configDir: ".obsidian",
			adapter: {
				exists: async (path: string) => files.has(path) || folders.has(path),
				read: async () => "",
				stat: async (path: string) => {
					const file = files.get(path);
					if (file) return { type: "file", mtime: file.mtime, ctime: file.mtime, size: file.size };
					if (folders.has(path)) return { type: "folder", mtime: 2000, ctime: 2000, size: 0 };
					return null;
				},
				list: async (folder: string) => {
					// NON-recursive like the real DataAdapter.list — direct children only.
					const prefix = folder + "/";
					const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
					return {
						files: [...files.keys()].filter(direct),
						folders: [...folders].filter(direct),
					};
				},
			},
			getFiles: () => [], // config files are never Vault-API visible
			getAllFolders: () => [],
		} as unknown as Vault;
	}

	const configOpts: LocalScanOptions = {
		...baseOpts,
		syncConfigDir: true,
		configSyncAllowlist: ["appearance.json", "hotkeys.json", "snippets"],
	};

	it("syncConfigDir OFF → zero config paths scanned", async () => {
		const tree = await scanLocalVault(configVault([
			{ path: ".obsidian/appearance.json" },
			{ path: ".obsidian/snippets", folder: true },
			{ path: ".obsidian/snippets/a.css" },
		]), { ...configOpts, syncConfigDir: false });
		expect(tree.files.size).toBe(0);
		expect(tree.folders.size).toBe(0);
	});

	it("allowlisted files + folder recursion are scanned via the adapter", async () => {
		const tree = await scanLocalVault(configVault([
			{ path: ".obsidian/appearance.json", size: 42 },
			{ path: ".obsidian/hotkeys.json", size: 5 },
			{ path: ".obsidian/app.json", size: 9 }, // NOT allowlisted
			{ path: ".obsidian/snippets", folder: true },
			{ path: ".obsidian/snippets/a.css", size: 11 },
			{ path: ".obsidian/snippets/nested", folder: true },
			{ path: ".obsidian/snippets/nested/b.css", size: 12 },
		]), configOpts);
		expect(tree.files.has(".obsidian/appearance.json")).toBe(true);
		expect(tree.files.get(".obsidian/appearance.json")?.size).toBe(42);
		expect(tree.files.has(".obsidian/hotkeys.json")).toBe(true);
		expect(tree.files.has(".obsidian/snippets/a.css")).toBe(true);
		expect(tree.files.has(".obsidian/snippets/nested/b.css")).toBe(true);
		expect(tree.folders.has(".obsidian/snippets")).toBe(true);
		expect(tree.folders.has(".obsidian/snippets/nested")).toBe(true);
		// not allowlisted → invisible to the scan, but the config dir itself
		// must never leak in as a syncable folder
		expect(tree.files.has(".obsidian/app.json")).toBe(false);
		expect(tree.folders.has(".obsidian")).toBe(false);
	});

	it("workspace.json / workspace* are HARD excluded even when allowlisted", async () => {
		const tree = await scanLocalVault(configVault([
			{ path: ".obsidian/workspace.json" },
			{ path: ".obsidian/workspace-mobile.json" },
			{ path: ".obsidian/appearance.json" },
		]), {
			...configOpts,
			configSyncAllowlist: ["workspace.json", "workspace-mobile.json", "appearance.json"],
		});
		expect(tree.files.has(".obsidian/workspace.json")).toBe(false);
		expect(tree.files.has(".obsidian/workspace-mobile.json")).toBe(false);
		expect(tree.excluded.has(".obsidian/workspace.json")).toBe(true);
		expect(tree.excluded.has(".obsidian/workspace-mobile.json")).toBe(true);
		expect(tree.skipped.some(s => s.path === ".obsidian/workspace.json"
			&& s.reason.includes("workspace"))).toBe(true);
		expect(tree.files.has(".obsidian/appearance.json")).toBe(true);
	});

	it("missing allowlist entries are simply absent, never errors", async () => {
		const tree = await scanLocalVault(configVault([
			{ path: ".obsidian/appearance.json" },
		]), configOpts);
		expect(tree.files.has(".obsidian/appearance.json")).toBe(true);
		expect(tree.skipped.some(s => s.reason === "config scan failed")).toBe(false);
	});
});

/* ---------------- v0.5.0: shared-preferences file hard exclusion ---------------- */

describe("localScan shared-preferences exclusion (v0.5.0)", () => {
	it("excludes the root-level prefs file even with dotfiles ALLOWED", async () => {
		const tree = await scanLocalVault(fakeVault([
			{ path: ".filen-sync-preferences.json", size: 10 },
			{ path: ".other-dotfile", size: 10 },
			{ path: "note.md", size: 10 },
		]), { ...baseOpts, excludeDotFiles: false });
		// Hard reserved exclusion — never synced as vault content.
		expect(tree.files.has(".filen-sync-preferences.json")).toBe(false);
		expect(tree.excluded.has(".filen-sync-preferences.json")).toBe(true);
		expect(tree.skipped.some(s => s.path === ".filen-sync-preferences.json"
			&& s.reason === "sync preferences file")).toBe(true);
		// Regular dotfiles still follow the toggle.
		expect(tree.files.has(".other-dotfile")).toBe(true);
		expect(tree.files.has("note.md")).toBe(true);
	});

	it("excludes the prefs file with dotfiles excluded too", async () => {
		const tree = await scanLocalVault(fakeVault([
			{ path: ".filen-sync-preferences.json", size: 10 },
		]), baseOpts);
		expect(tree.files.has(".filen-sync-preferences.json")).toBe(false);
		expect(tree.excluded.has(".filen-sync-preferences.json")).toBe(true);
	});

	it("only the exact ROOT-level name is reserved — nested lookalikes sync", async () => {
		const tree = await scanLocalVault(fakeVault([
			{ path: "sub/.filen-sync-preferences.json", size: 10 },
		]), { ...baseOpts, excludeDotFiles: false });
		expect(tree.files.has("sub/.filen-sync-preferences.json")).toBe(true);
	});
});
