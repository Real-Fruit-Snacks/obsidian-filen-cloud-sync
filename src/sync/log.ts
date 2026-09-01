/**
 * Ring-buffer sync log (200 entries, persisted per device).
 */

import type { App } from "obsidian";
import { debugLog } from "../debug";
import { formatLogTime } from "../util";
import { loadLog, LOG_CAPACITY, LogEntry, saveLog } from "./state";

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
		return this.entries
			.map(e => `${formatLogTime(e.ts)}  ${e.level.toUpperCase().padEnd(8)} ${e.message}`)
			.join("\n");
	}
}
