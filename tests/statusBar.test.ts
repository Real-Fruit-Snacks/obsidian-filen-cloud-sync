/**
 * v0.8.0 feature 4: status-bar text composition — idle carries the relative
 * last-sync timestamp; paused/running/error stay unchanged.
 */

import { describe, expect, it } from "vitest";
import { nextAutoSyncText, statusBarText } from "../src/util";

const NOW = 1_800_000_000_000;

describe("statusBarText (v0.8.0 feature 4)", () => {
	it("idle with a finished sync shows the relative timestamp", () => {
		expect(statusBarText("idle", { paused: false, lastSyncFinishedAt: NOW - 3 * 60_000, now: NOW }))
			.toBe("Filen: idle · 3 minutes ago");
		expect(statusBarText("idle", { paused: false, lastSyncFinishedAt: NOW - 10_000, now: NOW }))
			.toBe("Filen: idle · just now");
	});

	it("idle without any sync yet is plain idle", () => {
		expect(statusBarText("idle", { paused: false, lastSyncFinishedAt: null, now: NOW }))
			.toBe("Filen: idle");
	});

	it("paused wins over idle (no timestamp appended)", () => {
		expect(statusBarText("idle", { paused: true, lastSyncFinishedAt: NOW - 60_000, now: NOW }))
			.toBe("Filen: paused");
	});

	it("running stays running even while paused", () => {
		expect(statusBarText("running", { paused: true, lastSyncFinishedAt: NOW - 60_000, now: NOW }))
			.toBe("Filen: syncing…");
	});

	it("error stays error (no timestamp appended)", () => {
		expect(statusBarText("error", { paused: false, lastSyncFinishedAt: NOW - 60_000, now: NOW }))
			.toBe("Filen: error");
	});

	/* ---- v0.8.1 feature 2: offline ---- */

	it("offline wins over idle and error", () => {
		expect(statusBarText("idle", {
			paused: false, offline: true, lastSyncFinishedAt: NOW - 60_000, now: NOW,
		})).toBe("Filen: offline");
		expect(statusBarText("error", {
			paused: false, offline: true, lastSyncFinishedAt: NOW - 60_000, now: NOW,
		})).toBe("Filen: offline");
	});

	it("paused still wins over offline; running wins over both", () => {
		expect(statusBarText("idle", {
			paused: true, offline: true, lastSyncFinishedAt: NOW - 60_000, now: NOW,
		})).toBe("Filen: paused");
		expect(statusBarText("running", {
			paused: false, offline: true, lastSyncFinishedAt: NOW - 60_000, now: NOW,
		})).toBe("Filen: syncing…");
	});
});

describe("nextAutoSyncText (v0.8.1 feature 8)", () => {
	const base = {
		connected: true,
		paused: false,
		autoSyncInterval: true,
		syncIntervalMinutes: 10,
		lastSyncFinishedAt: NOW - 3 * 60_000,
		now: NOW,
	};

	it("computes the remaining minutes from the interval + last run", () => {
		expect(nextAutoSyncText(base)).toBe("Next auto sync in ~7 min");
	});

	it("rounds up and never goes below 1 minute", () => {
		expect(nextAutoSyncText({ ...base, lastSyncFinishedAt: NOW - 9 * 60_000 - 30_000 }))
			.toBe("Next auto sync in ~1 min");
		expect(nextAutoSyncText({ ...base, lastSyncFinishedAt: NOW - 30 * 60_000 })) // overdue
			.toBe("Next auto sync in ~1 min");
	});

	it("no run this session → on the next interval", () => {
		expect(nextAutoSyncText({ ...base, lastSyncFinishedAt: null }))
			.toBe("Next auto sync on the next interval");
	});

	it("hidden when disconnected, paused, or interval sync is off", () => {
		expect(nextAutoSyncText({ ...base, connected: false })).toBeNull();
		expect(nextAutoSyncText({ ...base, paused: true })).toBeNull();
		expect(nextAutoSyncText({ ...base, autoSyncInterval: false })).toBeNull();
		expect(nextAutoSyncText({ ...base, syncIntervalMinutes: 0 })).toBeNull();
	});
});
