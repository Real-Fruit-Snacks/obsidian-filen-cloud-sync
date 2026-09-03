/**
 * v0.8.0 feature 4: status-bar text composition — idle carries the relative
 * last-sync timestamp; paused/running/error stay unchanged.
 */

import { describe, expect, it } from "vitest";
import { statusBarText } from "../src/util";

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
});
