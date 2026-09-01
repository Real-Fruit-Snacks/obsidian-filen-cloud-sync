/**
 * Debug logger (src/debug.ts): gated console output, secret-free by contract.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { debugLog, isDebugLogging, safeUrl, setDebugLogging } from "../src/debug";

describe("debug logger", () => {
	afterEach(() => {
		setDebugLogging(false);
		vi.restoreAllMocks();
	});

	it("is silent when disabled", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => { /* noop */ });
		debugLog("http", "must not appear");
		expect(spy).not.toHaveBeenCalled();
	});

	it("writes a prefixed line with tag when enabled", () => {
		setDebugLogging(true);
		const spy = vi.spyOn(console, "log").mockImplementation(() => { /* noop */ });
		debugLog("http", "POST /v3/login → HTTP 200");
		expect(spy).toHaveBeenCalledOnce();
		const first = String(spy.mock.calls[0]?.[0]);
		expect(first).toContain("[filen-cloud-sync]");
		expect(first).toContain("[http]");
		expect(first).toContain("POST /v3/login → HTTP 200");
		expect(isDebugLogging()).toBe(true);
	});

	it("passes optional data as a second argument", () => {
		setDebugLogging(true);
		const spy = vi.spyOn(console, "log").mockImplementation(() => { /* noop */ });
		debugLog("http", "failed", { code: "invalid_endpoint" });
		expect(spy.mock.calls[0]?.[1]).toEqual({ code: "invalid_endpoint" });
	});

	it("toggle flips behavior at runtime", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => { /* noop */ });
		debugLog("sync", "off");
		setDebugLogging(true);
		debugLog("sync", "on");
		setDebugLogging(false);
		debugLog("sync", "off again");
		expect(spy).toHaveBeenCalledOnce();
	});
});

describe("safeUrl", () => {
	it("strips query strings (uploadKey/hash must never be logged)", () => {
		expect(safeUrl("https://ingest.filen.io/v3/upload?uuid=a&uploadKey=SECRET&hash=b"))
			.toBe("https://ingest.filen.io/v3/upload");
	});

	it("leaves query-less URLs untouched", () => {
		expect(safeUrl("https://gateway.filen.io/v3/login"))
			.toBe("https://gateway.filen.io/v3/login");
	});
});
