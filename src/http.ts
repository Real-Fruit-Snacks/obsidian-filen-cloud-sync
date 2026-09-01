/**
 * The ONLY module binding the Filen client to obsidian's requestUrl.
 * Kept separate from filen/client.ts so the client stays importable in
 * plain-Node vitest runs with a mocked HttpFn.
 */

import { requestUrl } from "obsidian";
import type { HttpFn } from "./filen/types";

export const obsidianHttp: HttpFn = async request => {
	const resp = await requestUrl({
		url: request.url,
		method: request.method,
		contentType: request.contentType,
		body: request.body,
		headers: request.headers,
		throw: request.throw ?? false,
	});
	return {
		status: resp.status,
		headers: resp.headers,
		// LAZY getters: Obsidian's RequestUrlResponse.json parses the body on
		// ACCESS — reading it eagerly here would throw a SyntaxError on every
		// binary (encrypted chunk) download. Only parse when a caller asks.
		get json(): unknown {
			return resp.json as unknown;
		},
		get text() {
			return resp.text;
		},
		arrayBuffer: resp.arrayBuffer,
	};
};
