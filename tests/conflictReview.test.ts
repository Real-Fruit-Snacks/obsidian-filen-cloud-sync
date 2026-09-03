/**
 * v0.8.0 feature 1: the shared conflict-copy pattern matcher — matches real
 * conflictPathFor output (any timestamp), rejects lookalikes, and derives the
 * original path by stripping the suffix.
 */

import { describe, expect, it } from "vitest";
import { conflictCopyOriginalPath, conflictPathFor, isConflictCopyName } from "../src/util";

describe("conflict-copy pattern matcher (v0.8.0 feature 1)", () => {
	it("matches real conflict names produced by conflictPathFor", () => {
		// 2024-06-01 12:34 UTC
		const path = conflictPathFor("dir/note.md", Date.UTC(2024, 5, 1, 12, 34, 56));
		expect(path).toBe("dir/note (conflict 2024-06-01 1234).md");
		expect(isConflictCopyName(path)).toBe(true);
		expect(isConflictCopyName("note (conflict 2024-06-01 1234).md")).toBe(true);
		expect(isConflictCopyName("archive.tar (conflict 1999-12-31 2359).gz")).toBe(true);
		// No extension at all.
		expect(isConflictCopyName("LICENSE (conflict 2024-06-01 1234)")).toBe(true);
	});

	it("rejects lookalikes", () => {
		expect(isConflictCopyName("note (conflict).md")).toBe(false);
		expect(isConflictCopyName("conflicting.md")).toBe(false);
		expect(isConflictCopyName("note (conflict x).md")).toBe(false);
		expect(isConflictCopyName("note (conflict 2024-06-01).md")).toBe(false); // missing HHmm
		expect(isConflictCopyName("note (conflict 2024-06-01 1234) draft.md")).toBe(false); // not before ext
		expect(isConflictCopyName("note.md")).toBe(false);
	});

	it("derives the original path by stripping the conflict suffix", () => {
		expect(conflictCopyOriginalPath("dir/note (conflict 2024-06-01 1234).md")).toBe("dir/note.md");
		expect(conflictCopyOriginalPath("note (conflict 2024-06-01 1234).md")).toBe("note.md");
		expect(conflictCopyOriginalPath("a/b/c (conflict 2030-01-02 0304).canvas")).toBe("a/b/c.canvas");
		expect(conflictCopyOriginalPath("note.md")).toBeNull();
		expect(conflictCopyOriginalPath("note (conflict x).md")).toBeNull();
	});

	it("round-trips with conflictPathFor", () => {
		expect(conflictCopyOriginalPath(conflictPathFor("dir/note.md", Date.UTC(2024, 5, 1, 12, 34, 56))))
			.toBe("dir/note.md");
	});
});
