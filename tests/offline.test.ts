/**
 * v0.8.1 feature 2 (offline awareness): the pure state machine.
 * navigator.onLine === false at run start → offline immediately; two
 * CONSECUTIVE network-class run failures → offline; any run that reached the
 * gateway → back online; "skipped"/"paused" results never change the state.
 */

import { describe, expect, it } from "vitest";
import {
	isNetworkError,
	NoticeThrottle,
	NOTICE_THROTTLE_WINDOW_MS,
	OfflineTracker,
	OFFLINE_AFTER_NETWORK_FAILURES,
} from "../src/util";

const NETWORK_MESSAGE = "request failed: failed to fetch";
const OTHER_MESSAGE = "decrypt failed: bad key";

describe("isNetworkError (v0.8.1)", () => {
	it("matches the friendlyError network patterns", () => {
		expect(isNetworkError("Failed to fetch")).toBe(true);
		expect(isNetworkError("Network request failed")).toBe(true);
		expect(isNetworkError("request timeout after 30000ms")).toBe(true);
		expect(isNetworkError("ECONNREFUSED")).toBe(true);
		expect(isNetworkError("socket hang up")).toBe(true);
		expect(isNetworkError("DNS lookup failed")).toBe(true);
	});

	it("rejects non-network errors", () => {
		expect(isNetworkError("invalid api key")).toBe(false);
		expect(isNetworkError("decrypt failed")).toBe(false);
		expect(isNetworkError("mass-change guard aborted")).toBe(false);
	});
});

describe("OfflineTracker (v0.8.1 feature 2)", () => {
	it("starts online", () => {
		expect(new OfflineTracker().isOffline()).toBe(false);
	});

	it("navigator offline at run start → offline immediately", () => {
		const tracker = new OfflineTracker();
		tracker.noteNavigatorOffline();
		expect(tracker.isOffline()).toBe(true);
	});

	it("2 consecutive network-fail runs → offline", () => {
		const tracker = new OfflineTracker();
		expect(OFFLINE_AFTER_NETWORK_FAILURES).toBe(2);
		tracker.noteRunFinished({ status: "error", message: NETWORK_MESSAGE });
		expect(tracker.isOffline()).toBe(false); // one failure is not enough
		tracker.noteRunFinished({ status: "error", message: NETWORK_MESSAGE });
		expect(tracker.isOffline()).toBe(true);
	});

	it("a non-network error between network failures breaks the streak", () => {
		const tracker = new OfflineTracker();
		tracker.noteRunFinished({ status: "error", message: NETWORK_MESSAGE });
		tracker.noteRunFinished({ status: "error", message: OTHER_MESSAGE });
		tracker.noteRunFinished({ status: "error", message: NETWORK_MESSAGE });
		expect(tracker.isOffline()).toBe(false);
		tracker.noteRunFinished({ status: "error", message: NETWORK_MESSAGE });
		expect(tracker.isOffline()).toBe(true);
	});

	it("a successful run clears offline (and resets the streak)", () => {
		const tracker = new OfflineTracker();
		tracker.noteNavigatorOffline();
		expect(tracker.isOffline()).toBe(true);
		tracker.noteRunFinished({ status: "ok", message: "synced 3 files" });
		expect(tracker.isOffline()).toBe(false);
		// Streak was reset: a single network failure does not re-enter offline.
		tracker.noteRunFinished({ status: "error", message: NETWORK_MESSAGE });
		expect(tracker.isOffline()).toBe(false);
	});

	it("empty/dry-run/aborted runs also prove connectivity", () => {
		for (const status of ["empty", "dry-run", "aborted"]) {
			const tracker = new OfflineTracker();
			tracker.noteNavigatorOffline();
			tracker.noteRunFinished({ status, message: "" });
			expect(tracker.isOffline()).toBe(false);
		}
	});

	it("skipped/paused results never change the state", () => {
		const tracker = new OfflineTracker();
		tracker.noteRunFinished({ status: "skipped", message: "sync already running — queued" });
		tracker.noteRunFinished({ status: "paused", message: "Syncing is paused" });
		expect(tracker.isOffline()).toBe(false);
		tracker.noteNavigatorOffline();
		tracker.noteRunFinished({ status: "skipped", message: "sync already running — queued" });
		expect(tracker.isOffline()).toBe(true);
	});

	it("noteRequestSuccess clears offline directly", () => {
		const tracker = new OfflineTracker();
		tracker.noteNavigatorOffline();
		tracker.noteRequestSuccess();
		expect(tracker.isOffline()).toBe(false);
	});
});

describe("NoticeThrottle (v0.8.1 feature 3)", () => {
	it("same message twice within 15 min → shown once", () => {
		let now = 1_000_000;
		const throttle = new NoticeThrottle(() => now);
		expect(throttle.shouldShow("Can't reach Filen")).toBe(true);
		expect(throttle.shouldShow("Can't reach Filen")).toBe(false);
		now += NOTICE_THROTTLE_WINDOW_MS - 1;
		expect(throttle.shouldShow("Can't reach Filen")).toBe(false);
	});

	it("different messages are throttled independently", () => {
		const throttle = new NoticeThrottle(() => 1_000_000);
		expect(throttle.shouldShow("message A")).toBe(true);
		expect(throttle.shouldShow("message B")).toBe(true);
		expect(throttle.shouldShow("message A")).toBe(false);
		expect(throttle.shouldShow("message B")).toBe(false);
	});

	it("repeats after the window", () => {
		let now = 1_000_000;
		const throttle = new NoticeThrottle(() => now);
		expect(throttle.shouldShow("Can't reach Filen")).toBe(true);
		now += NOTICE_THROTTLE_WINDOW_MS;
		expect(throttle.shouldShow("Can't reach Filen")).toBe(true);
	});

	it("the window defaults to 15 minutes", () => {
		expect(NOTICE_THROTTLE_WINDOW_MS).toBe(15 * 60 * 1000);
	});
});
