/**
 * Ring-buffer sync log (200 entries, persisted per device) + the PURE
 * filter/render helpers behind the v0.8.1 log viewer (unit-tested in plain
 * Node — no obsidian APIs involved).
 */

import type { App } from "obsidian";
import { debugLog } from "../debug";
import { formatLogTime } from "../util";
import { loadLog, LOG_CAPACITY, LogEntry, saveLog } from "./state";

/* ---------------- v0.8.1: log viewer filter (pure) ---------------- */

/**
 * Level filter for the log viewer: "all" | "warnings" (warnings, conflicts
 * AND errors — "Warnings + conflicts" means warn-and-above) | "errors".
 */
export type LogLevelFilter = "all" | "warnings" | "errors";

/**
 * Substring (case-insensitive, on the message) + level filter over log
 * entries. Order is preserved; the input array is never mutated.
 */
export function filterLogEntries(
	entries: readonly LogEntry[],
	level: LogLevelFilter,
	query: string,
): LogEntry[] {
	const q = query.trim().toLowerCase();
	return entries.filter(entry => {
		if (level === "errors" && entry.level !== "error") return false;
		if (level === "warnings" && entry.level === "info") return false;
		if (q.length > 0 && !entry.message.toLowerCase().includes(q)) return false;
		return true;
	});
}

/**
 * Plain-text rendering of log entries — the SAME line shape SyncLog.render()
 * produces. The viewer copies the FILTERED view through this; render() stays
 * the raw full log for clipboard/debugging.
 */
export function renderLogEntries(entries: readonly LogEntry[]): string {
	return entries
		.map(e => `${formatLogTime(e.ts)}  ${e.level.toUpperCase().padEnd(8)} ${e.message}`)
		.join("\n");
}

/** Short chip label per level for the viewer rows (INFO/WARN/CONF/ERR). */
export function logLevelChip(level: LogEntry["level"]): string {
	switch (level) {
		case "warn": return "WARN";
		case "error": return "ERR";
		case "conflict": return "CONF";
		default: return "INFO";
	}
}

export class SyncLog {
	private entries: LogEntry[] = [];
	private dirty = false;

	constructor(
		private readonly app: App,
		private readonly debugEnabled: () => boolean = () => false,
	) {
		this.entries = loadLog(app);
	}

	add(level: LogEntry["level"], message: string): void {
		// Verbose info entries are only recorded in debug mode; warnings,
		// errors and conflicts are always recorded in the persisted ring
		// buffer. In debug mode everything is also mirrored to the console.
		if (level === "info" && !this.debugEnabled()) return;
		if (this.debugEnabled()) debugLog("sync", `${level.toUpperCase()} ${message}`);
		this.entries.push({ ts: Date.now(), level, message });
		if (this.entries.length > LOG_CAPACITY) {
			this.entries = this.entries.slice(-LOG_CAPACITY);
		}
		this.dirty = true;
	}

	info(message: string): void {
		this.add("info", message);
	}

	warn(message: string): void {
		this.add("warn", message);
	}

	error(message: string): void {
		this.add("error", message);
	}

	conflict(message: string): void {
		this.add("conflict", message);
	}

	getEntries(): LogEntry[] {
		return [...this.entries];
	}

	clear(): void {
		this.entries = [];
		this.dirty = true;
		this.persist();
	}

	persist(): void {
		if (!this.dirty) return;
		saveLog(this.app, this.entries);
		this.dirty = false;
	}

	render(): string {
		return renderLogEntries(this.entries);
	}
}
