/**
 * Util tests (the design docs): ignore matcher, case-collision detection, NFC.
 */

import { describe, expect, it } from "vitest";
import {
	base64ToBytes,
	bytesToBase64,
	conflictPathFor,
	detectCaseCollisions,
	diffLines,
	formatBytes,
	formatQuota,
	mapPool,
	matchesIgnore,
	normalizeVaultPath,
	parseIgnorePatterns,
	tryDecodeUtf8,
	utf8ToBytes,
} from "../src/util";

describe("base64 helpers", () => {
	it("round-trip arbitrary bytes", () => {
		const data = new Uint8Array(256);
		for (let i = 0; i < 256; i++) data[i] = i;
		expect(base64ToBytes(bytesToBase64(data))).toEqual(data);
	});

	it("matches the platform btoa for short inputs", () => {
		const s = "hello filen ✓";
		const bytes = new TextEncoder().encode(s);
		let bin = "";
		for (const b of bytes) bin += String.fromCharCode(b);
		expect(bytesToBase64(bytes)).toBe(btoa(bin));
	});

	it("round-trips lengths 0..3 (padding paths)", () => {
		for (let len = 0; len <= 3; len++) {
			const data = new Uint8Array(len);
			for (let i = 0; i < len; i++) data[i] = 65 + i;
			expect(base64ToBytes(bytesToBase64(data))).toEqual(data);
		}
	});
});

describe("ignore matcher (gitignore-lite)", () => {
	const rules = parseIgnorePatterns(`
# comment
*.tmp
build/
private/**
/rooted.md
!keep.tmp
fo?der/*.md
`);

	it("matches simple globs in any directory", () => {
		expect(matchesIgnore(rules, "a.tmp")).toBe(true);
		expect(matchesIgnore(rules, "deep/nested/b.tmp")).toBe(true);
	});

	it("dir-only rules cover contents", () => {
		expect(matchesIgnore(rules, "build/out.js")).toBe(true);
		expect(matchesIgnore(rules, "build", true)).toBe(true);
		expect(matchesIgnore(rules, "src/build", true)).toBe(true);
	});

	it("** crosses directories", () => {
		expect(matchesIgnore(rules, "private/x/y/z.md")).toBe(true);
		expect(matchesIgnore(rules, "public/private/x.md")).toBe(false); // anchored by '/'
	});

	it("anchored patterns only match from the root", () => {
		expect(matchesIgnore(rules, "rooted.md")).toBe(true);
		expect(matchesIgnore(rules, "sub/rooted.md")).toBe(false);
	});

	it("negation re-includes (last match wins)", () => {
		expect(matchesIgnore(rules, "keep.tmp")).toBe(false);
		expect(matchesIgnore(rules, "other.tmp")).toBe(true);
	});

	it("? matches a single non-slash char", () => {
		expect(matchesIgnore(rules, "foider/note.md")).toBe(true);
		expect(matchesIgnore(rules, "fo/der/note.md")).toBe(false);
	});

	it("empty pattern list matches nothing", () => {
		expect(matchesIgnore("", "anything.md")).toBe(false);
	});
});

describe("case-collision detection", () => {
	it("finds groups differing only by case, winner first", () => {
		const collisions = detectCaseCollisions(["Note.md", "note.md", "other.md", "NOTE.md"]);
		expect(collisions).toHaveLength(1);
		expect(collisions[0]).toEqual(["NOTE.md", "Note.md", "note.md"]); // sorted
	});

	it("returns empty when no collisions", () => {
		expect(detectCaseCollisions(["a.md", "b.md"])).toEqual([]);
	});
});

describe("NFC normalization", () => {
	it("folds NFD to NFC", () => {
		const nfd = "cafe\u0301.md"; // e + combining acute accent
		const nfc = "caf\u00e9.md";
		expect(normalizeVaultPath(nfd)).toBe(nfc);
		expect(normalizeVaultPath(nfc)).toBe(nfc);
	});

	it("collapses slashes, backslashes and trims", () => {
		expect(normalizeVaultPath("/a//b\\c/")).toBe("a/b/c");
	});

	it("replaces NBSP with a regular space", () => {
		expect(normalizeVaultPath("a b.md")).toBe("a b.md");
	});
});

describe("conflictPathFor", () => {
	it("builds deterministic conflict names", () => {
		// 2024-06-01 12:34 UTC
		const ms = Date.UTC(2024, 5, 1, 12, 34, 56);
		expect(conflictPathFor("dir/note.md", ms)).toBe("dir/note (conflict 2024-06-01 1234).md");
		expect(conflictPathFor("note.md", ms)).toBe("note (conflict 2024-06-01 1234).md");
		expect(conflictPathFor("archive.tar.gz", ms)).toBe("archive.tar (conflict 2024-06-01 1234).gz");
	});
});

describe("mapPool (v0.4.0 feature C)", () => {
	it("preserves index-addressed order even when tasks finish out of order", async () => {
		const items = [0, 1, 2, 3, 4, 5];
		const results = await mapPool(items, 3, async n => {
			await new Promise(resolve => setTimeout(resolve, (items.length - n) * 3));
			return n * 10;
		});
		expect(results).toEqual([0, 10, 20, 30, 40, 50]);
	});

	it("never exceeds the concurrency ceiling", async () => {
		let inflight = 0;
		let maxInflight = 0;
		const items = Array.from({ length: 10 }, (_, i) => i);
		await mapPool(items, 3, async () => {
			inflight++;
			maxInflight = Math.max(maxInflight, inflight);
			await new Promise(resolve => setTimeout(resolve, 5));
			inflight--;
		});
		expect(maxInflight).toBe(3);
	});

	it("a rejection fails the whole map", async () => {
		await expect(mapPool([1, 2, 3], 2, async n => {
			if (n === 2) throw new Error("boom");
			return n;
		})).rejects.toThrow("boom");
	});

	it("handles an empty input and concurrency larger than the input", async () => {
		expect(await mapPool([], 3, async () => 1)).toEqual([]);
		expect(await mapPool([1], 99, async n => n * 2)).toEqual([2]);
	});
});

/* ---------------- line diff (v0.4.0 feature E) ---------------- */

describe("diffLines (Myers)", () => {
	it("identical inputs → all same", () => {
		const diff = diffLines("a\nb\nc", "a\nb\nc");
		expect(diff.every(op => op.type === "same")).toBe(true);
		expect(diff.map(op => op.line)).toEqual(["a", "b", "c"]);
	});

	it("insert → add ops only, in place", () => {
		const diff = diffLines("a\nc", "a\nb\nc");
		expect(diff).toEqual([
			{ type: "same", line: "a" },
			{ type: "add", line: "b" },
			{ type: "same", line: "c" },
		]);
	});

	it("delete → remove ops only, in place", () => {
		const diff = diffLines("a\nb\nc", "a\nc");
		expect(diff).toEqual([
			{ type: "same", line: "a" },
			{ type: "remove", line: "b" },
			{ type: "same", line: "c" },
		]);
	});

	it("replace → remove + add pair around the unchanged context", () => {
		const diff = diffLines("a\nb\nc", "a\nx\nc");
		expect(diff).toEqual([
			{ type: "same", line: "a" },
			{ type: "remove", line: "b" },
			{ type: "add", line: "x" },
			{ type: "same", line: "c" },
		]);
	});

	it("empty sides: empty vs non-empty and both empty", () => {
		expect(diffLines("", "")).toEqual([]);
		expect(diffLines("", "a\nb")).toEqual([
			{ type: "add", line: "a" },
			{ type: "add", line: "b" },
		]);
		expect(diffLines("a\nb", "")).toEqual([
			{ type: "remove", line: "a" },
			{ type: "remove", line: "b" },
		]);
	});

	it("completely different files → remove-all then add-all", () => {
		const diff = diffLines("a\nb", "x\ny");
		expect(diff).toEqual([
			{ type: "remove", line: "a" },
			{ type: "remove", line: "b" },
			{ type: "add", line: "x" },
			{ type: "add", line: "y" },
		]);
	});

	it("reconstructs both sides from the op stream (round-trip)", () => {
		const cases: Array<[string, string]> = [
			["one\ntwo\nthree", "one\n2\nthree\nfour"],
			["a\nb\nc\nd", "d\nc\nb\na"],
			["same\nsame\nold\nsame", "same\nsame\nnew\nsame"],
			["trailing\ncontext\nlines", "trailing\ncontext\nlines\nplus"],
		];
		for (const [a, b] of cases) {
			const diff = diffLines(a, b);
			const rebuiltA = diff.filter(op => op.type !== "add").map(op => op.line).join("\n");
			const rebuiltB = diff.filter(op => op.type !== "remove").map(op => op.line).join("\n");
			expect(rebuiltA).toBe(a);
			expect(rebuiltB).toBe(b);
		}
	});
});

/* ---------------- strict UTF-8 (v0.4.0 feature E) ---------------- */

describe("tryDecodeUtf8", () => {
	it("decodes valid UTF-8 (incl. multibyte)", () => {
		expect(tryDecodeUtf8(utf8ToBytes("héllo — wörld ✓").buffer as ArrayBuffer)).toBe("héllo — wörld ✓");
	});

	it("returns null for invalid bytes (binary detection)", () => {
		expect(tryDecodeUtf8(new Uint8Array([0xff, 0xfe, 0x41, 0x00]).buffer as ArrayBuffer)).toBeNull();
		// Truncated multibyte sequence
		expect(tryDecodeUtf8(new Uint8Array([0xc3]).buffer as ArrayBuffer)).toBeNull();
	});
});

/* ---------------- byte/quota formatting (v0.4.0 feature F) ---------------- */

describe("formatBytes / formatQuota", () => {
	it("formats bytes human-readably", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KiB");
		expect(formatBytes(50 * 1024 * 1024)).toBe("50.0 MiB");
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GiB");
	});

	it("quota text + clamped ratio", () => {
		const quota = formatQuota(512 * 1024 * 1024, 1024 * 1024 * 1024);
		expect(quota.text).toBe("512 MiB of 1.0 GiB used");
		expect(quota.ratio).toBeCloseTo(0.5);
		expect(formatQuota(2000, 1000).ratio).toBe(1); // clamped
		expect(formatQuota(10, 0).ratio).toBe(0); // degenerate maxStorage
	});
});
