/**
 * v0.6.0 feature D: explorer "changed since last sync" indicators — tests
 * cover the PURE set logic (DirtyPathTracker: mark/clear/list). The DOM
 * layer (ExplorerDecorations) is intentionally thin and defensive; vitest
 * has no Obsidian explorer DOM, so only its no-DOM safety is exercised.
 */

import { describe, expect, it } from "vitest";
import { DirtyPathTracker, ExplorerDecorations } from "../src/ui/explorerDecorations";

describe("DirtyPathTracker — pure set logic (v0.6.0 feature D)", () => {
	it("mark adds paths; list returns them sorted", () => {
		const tracker = new DirtyPathTracker();
		expect(tracker.list()).toEqual([]);
		expect(tracker.size).toBe(0);

		tracker.mark("b/note.md");
		tracker.mark("a.md");
		tracker.mark("c/deep/file.md");

		expect(tracker.list()).toEqual(["a.md", "b/note.md", "c/deep/file.md"]);
		expect(tracker.size).toBe(3);
		expect(tracker.has("b/note.md")).toBe(true);
		expect(tracker.has("missing.md")).toBe(false);
	});

	it("marking the same path twice keeps a single entry", () => {
		const tracker = new DirtyPathTracker();
		tracker.mark("note.md");
		tracker.mark("note.md");
		expect(tracker.list()).toEqual(["note.md"]);
		expect(tracker.size).toBe(1);
	});

	it("clear empties the set", () => {
		const tracker = new DirtyPathTracker();
		tracker.mark("a.md");
		tracker.mark("b.md");
		tracker.clear();
		expect(tracker.list()).toEqual([]);
		expect(tracker.size).toBe(0);
		expect(tracker.has("a.md")).toBe(false);
	});

	it("mark and has normalize paths (NFC, slashes, NBSP)", () => {
		const tracker = new DirtyPathTracker();
		// NFD é + duplicate slashes + non-breaking space → normalized form.
		tracker.mark("folder//cafe\u0301\u00A0note.md");
		expect(tracker.has("folder/café note.md")).toBe(true);
		expect(tracker.list()).toEqual(["folder/café note.md"]);
	});

	it("empty/root paths are never tracked", () => {
		const tracker = new DirtyPathTracker();
		tracker.mark("");
		tracker.mark("/");
		tracker.mark("//");
		expect(tracker.size).toBe(0);
		expect(tracker.list()).toEqual([]);
	});
});

describe("ExplorerDecorations — DOM-less safety (v0.6.0 feature D)", () => {
	it("start/mark/clear/dispose are silent no-ops without an explorer DOM", () => {
		const decorations = new ExplorerDecorations();
		// No document/MutationObserver in this environment — every call must
		// be a defensive no-op (never throw).
		expect(() => {
			decorations.start();
			decorations.mark("note.md");
			decorations.mark("folder/other.md");
			decorations.clear();
			decorations.mark("again.md");
			decorations.dispose();
		}).not.toThrow();
	});

	it("tracks dirty paths through the controller facade", () => {
		const decorations = new ExplorerDecorations();
		decorations.start();
		decorations.mark("b.md");
		decorations.mark("a.md");
		expect(decorations.list()).toEqual(["a.md", "b.md"]);
		expect(decorations.size).toBe(2);
		decorations.clear();
		expect(decorations.list()).toEqual([]);
		decorations.dispose();
	});
});
