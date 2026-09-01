/**
 * User-facing text helpers (v0.5.2): pluralize, relativeTime, friendlyError.
 */

import { describe, expect, it } from "vitest";
import { friendlyError, pluralize, relativeTime } from "../src/util";

describe("pluralize", () => {
	it("singular for 1, plural for 0 and >1", () => {
		expect(pluralize(1, "chunk")).toBe("1 chunk");
		expect(pluralize(0, "chunk")).toBe("0 chunks");
		expect(pluralize(3, "chunk")).toBe("3 chunks");
		expect(pluralize(2, "conflict", "conflicts")).toBe("2 conflicts");
	});
});

describe("relativeTime", () => {
	const now = 1_700_000_000_000;
	it("buckets correctly", () => {
		expect(relativeTime(now - 10_000, now)).toBe("just now");
		expect(relativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
		expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
		expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
		// Older than a day → absolute date (locale-dependent format)
		expect(relativeTime(now - 25 * 3_600_000, now)).not.toContain("ago");
	});
});

describe("friendlyError", () => {
	it("maps session expiry", () => {
		const f = friendlyError("POST /v3/dir/tree: Invalid API key.");
		expect(f.title).toBe("Your Filen session expired");
		expect(f.hint).toContain("reconnect");
	});

	it("maps network failures", () => {
		const f = friendlyError("GET https://egest.filen.io/x network error: failed to fetch");
		expect(f.title).toBe("Can't reach Filen");
		expect(f.hint).toContain("internet connection");
	});

	it("maps decryption failures", () => {
		const f = friendlyError("could not decrypt metadata with any of 1 key(s)");
		expect(f.title).toBe("Couldn't decrypt data from Filen");
		expect(f.hint).toBeDefined();
	});

	it("maps rate limiting and 5xx", () => {
		expect(friendlyError("HTTP 429 too many requests").title).toContain("rate-limiting");
		expect(friendlyError("HTTP 502 bad gateway").title).toContain("server trouble");
	});

	it("passes unknown messages through as first line", () => {
		const f = friendlyError("some bespoke failure\nwith details");
		expect(f.title).toBe("some bespoke failure");
		expect(f.hint).toBeUndefined();
	});
});
