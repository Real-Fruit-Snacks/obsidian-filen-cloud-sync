/**
 * v0.8.1 feature 6 (log viewer): the PURE filter + render helpers behind the
 * viewer — level dropdown ("All levels" / "Warnings + conflicts" / "Errors
 * only"), case-insensitive substring search on the message, and the
 * plain-text render shared by SyncLog.render() and Copy (filtered).
 */

import { describe, expect, it } from "vitest";
import {
	filterLogEntries,
	logLevelChip,
	renderLogEntries,
} from "../src/sync/log";
import type { LogEntry } from "../src/sync/state";

function entry(level: LogEntry["level"], message: string, ts = 1_700_000_000_000): LogEntry {
	return { ts, level, message };
}

const ENTRIES: LogEntry[] = [
	entry("info", "sync started"),
	entry("warn", "slow network on upload notes/a.md"),
	entry("conflict", "conflict on notes/b.md (keep both)"),
	entry("error", "upload failed for notes/c.md: failed to fetch"),
	entry("info", "sync finished: 1 uploaded"),
];

describe("filterLogEntries (v0.8.1 feature 6)", () => {
	it("all levels + empty query returns everything (order preserved)", () => {
		expect(filterLogEntries(ENTRIES, "all", "")).toEqual(ENTRIES);
		expect(filterLogEntries(ENTRIES, "all", "   ")).toEqual(ENTRIES); // whitespace-only = empty
	});

	it("warnings filter keeps warn + conflict + error, drops info", () => {
		const result = filterLogEntries(ENTRIES, "warnings", "");
		expect(result.map(e => e.level)).toEqual(["warn", "conflict", "error"]);
	});

	it("errors filter keeps only errors", () => {
		const result = filterLogEntries(ENTRIES, "errors", "");
		expect(result.map(e => e.level)).toEqual(["error"]);
	});

	it("search is a case-insensitive substring on the message", () => {
		expect(filterLogEntries(ENTRIES, "all", "NOTES/A.MD")).toEqual([ENTRIES[1]]);
		expect(filterLogEntries(ENTRIES, "all", "sync")).toEqual([ENTRIES[0], ENTRIES[4]]);
	});

	it("level + query combine (AND)", () => {
		const result = filterLogEntries(ENTRIES, "warnings", "notes");
		expect(result.map(e => e.level)).toEqual(["warn", "conflict", "error"]);
		expect(filterLogEntries(ENTRIES, "errors", "sync")).toEqual([]);
	});

	it("never mutates the input", () => {
		const copy = [...ENTRIES];
		filterLogEntries(ENTRIES, "errors", "upload");
		expect(ENTRIES).toEqual(copy);
	});
});

describe("renderLogEntries / logLevelChip (v0.8.1 feature 6)", () => {
	it("renders the same line shape as the raw log", () => {
		const text = renderLogEntries([entry("warn", "hello", 1_700_000_000_000)]);
		expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  WARN     hello$/);
	});

	it("empty list renders an empty string", () => {
		expect(renderLogEntries([])).toBe("");
	});

	it("chip labels are INFO/WARN/CONF/ERR", () => {
		expect(logLevelChip("info")).toBe("INFO");
		expect(logLevelChip("warn")).toBe("WARN");
		expect(logLevelChip("conflict")).toBe("CONF");
		expect(logLevelChip("error")).toBe("ERR");
	});
});
