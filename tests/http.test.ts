/**
 * http.ts (obsidianHttp wrapper): json must be LAZY — Obsidian's
 * RequestUrlResponse.json parses the body on access, which throws on binary
 * (encrypted chunk) downloads. Regression test for the live-download bug.
 */

import { afterEach, describe, expect, it } from "vitest";
import { obsidianHttp } from "../src/http";
import { setRequestUrlImpl } from "./mocks/obsidian";

describe("obsidianHttp", () => {
	afterEach(() => {
		setRequestUrlImpl(async () => {
			throw new Error("requestUrl mock not configured");
		});
	});

	it("does NOT eagerly parse json — binary egest downloads survive", async () => {
		const payload = new Uint8Array([0x4a, 0x7a, 0x35, 0x4f]).buffer; // "Jz5O…" chunk bytes
		setRequestUrlImpl(async () => ({
			status: 200,
			headers: {},
			get json(): unknown {
				throw new SyntaxError("Unexpected token 'J'"); // what real requestUrl does on binary
			},
			text: "Jz5O",
			arrayBuffer: payload,
		}));
		const resp = await obsidianHttp({ url: "https://egest.filen.io/r/b/u/0", method: "GET", throw: false });
		expect(resp.status).toBe(200);
		expect(new Uint8Array(resp.arrayBuffer)).toEqual(new Uint8Array([0x4a, 0x7a, 0x35, 0x4f]));
	});

	it("json is still available (lazily) for JSON endpoints", async () => {
		setRequestUrlImpl(async () => ({
			status: 200,
			headers: {},
			get json(): unknown {
				return { status: true, data: { uuid: "u1" } };
			},
			text: "{\"status\":true}",
			arrayBuffer: new ArrayBuffer(0),
		}));
		const resp = await obsidianHttp({ url: "https://gateway.filen.io/v3/x", method: "POST", throw: false });
		expect((resp.json as { data: { uuid: string } }).data.uuid).toBe("u1");
	});
});
