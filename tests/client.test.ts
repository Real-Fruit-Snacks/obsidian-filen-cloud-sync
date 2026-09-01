/**
 * Client tests (the design docs): request-shape construction for /v3/login and
 * /v3/upload/done against a mocked HttpFn. node:crypto is only a test oracle.
 */

import { createHash, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FilenClient } from "../src/filen/client";
import { decMeta, deriveAuthV3, encMeta, encryptChunk, generateFileKey } from "../src/filen/crypto";
import type { HttpFn, HttpRequest, StoredCredentials } from "../src/filen/types";
import { utf8ToBytes } from "../src/util";

interface RecordedRequest {
	request: HttpRequest;
	body?: Record<string, unknown>;
}

function sha512hex(s: string): string {
	return createHash("sha512").update(s, "utf8").digest("hex");
}

function makeRecorder(handler: (req: RecordedRequest) => unknown): {
	http: HttpFn;
	recorded: RecordedRequest[];
} {
	const recorded: RecordedRequest[] = [];
	const http: HttpFn = async request => {
		const rec: RecordedRequest = { request };
		if (typeof request.body === "string") {
			try {
				rec.body = JSON.parse(request.body) as Record<string, unknown>;
			} catch { /* binary body */ }
		}
		recorded.push(rec);
		const data = handler(rec);
		return {
			status: 200,
			headers: {},
			json: { status: true, data },
			text: JSON.stringify({ status: true, data }),
			arrayBuffer: new ArrayBuffer(0),
		};
	};
	return { http, recorded };
}

describe("auth flow request shapes", () => {
	it("POSTs /v3/login with derived password, twoFactorCode and authVersion", async () => {
		const email = "user@example.com";
		const password = "test-password";
		const salt = "saltysalt";
		const masterKey = pbkdf2Sync(password, salt, 200000, 64, "sha512")
			.toString("hex").slice(0, 64);

		const { http, recorded } = makeRecorder(rec => {
			const url = rec.request.url;
			if (url.endsWith("/v3/auth/info")) {
				return { email, authVersion: 2, salt, id: "1" };
			}
			if (url.endsWith("/v3/login")) {
				return { apiKey: "api-key-123", masterKeys: null, publicKey: null, privateKey: null };
			}
			if (url.endsWith("/v3/user/masterKeys")) {
				// respond with the key list encrypted for the derived master key
				throw new Error("handled below");
			}
			if (url.endsWith("/v3/user/baseFolder")) return { uuid: "root-uuid-1" };
			throw new Error(`unexpected ${url}`);
		});

		// masterKeys endpoint needs async encryption — wrap manually
		let masterKeysBody: Record<string, unknown> | undefined;
		const client = new FilenClient(async request => {
			if (request.url.endsWith("/v3/user/masterKeys")) {
				masterKeysBody = JSON.parse(request.body as string) as Record<string, unknown>;
				const data = { keys: await encMeta(masterKey, masterKey, 2) };
				return {
					status: 200, headers: {}, json: { status: true, data },
					text: JSON.stringify({ status: true, data }), arrayBuffer: new ArrayBuffer(0),
				};
			}
			return http(request);
		});

		const credentials = await client.connect(email, password);

		const authInfo = recorded.find(r => r.request.url.endsWith("/v3/auth/info"));
		expect(authInfo?.body).toEqual({ email });

		// /v3/user/masterKeys body field name is `masterKeys` (NOT `metadata`)
		expect(masterKeysBody).toBeDefined();
		expect(masterKeysBody).not.toHaveProperty("metadata");
		expect(typeof masterKeysBody?.masterKeys).toBe("string");
		// sent value decrypts with the derived master key ("002" envelope)
		expect(masterKeysBody?.masterKeys as string).toMatch(/^002/);
		expect(await decMeta(masterKeysBody?.masterKeys as string, [masterKey])).toBe(masterKey);

		const login = recorded.find(r => r.request.url.endsWith("/v3/login"));
		expect(login).toBeDefined();
		expect(login?.body?.email).toBe(email);
		expect(login?.body?.authVersion).toBe(2);
		expect(login?.body?.twoFactorCode).toBe("XXXXXX");
		const derivedPassword = login?.body?.password as string;
		expect(derivedPassword).toMatch(/^[0-9a-f]{128}$/);
		// oracle: derived password must equal sha512hex(second dk half)
		const dkHex = pbkdf2Sync(password, salt, 200000, 64, "sha512").toString("hex");
		expect(derivedPassword).toBe(sha512hex(dkHex.slice(64, 128)));

		// Checksum header = sha512hex(JSON.stringify(body))
		for (const rec of recorded) {
			if (typeof rec.request.body === "string") {
				expect(rec.request.headers?.["Checksum"]).toBe(sha512hex(rec.request.body));
			}
		}
		// Authorization header present on authenticated calls;
		// /v3/user/baseFolder is a GET-only route (SDK-verified)
		const baseFolder = recorded.find(r => r.request.url.endsWith("/v3/user/baseFolder"));
		expect(baseFolder?.request.method).toBe("GET");
		expect(baseFolder?.request.body).toBeUndefined();
		expect(baseFolder?.request.headers?.["Authorization"]).toBe("Bearer api-key-123");

		expect(credentials.apiKey).toBe("api-key-123");
		expect(credentials.masterKeys).toEqual([masterKey]);
		expect(credentials.rootUuid).toBe("root-uuid-1");
	});

	it("sends the provided 2FA code instead of XXXXXX", async () => {
		const salt = "pepper";
		const { http, recorded } = makeRecorder(rec => {
			const url = rec.request.url;
			if (url.endsWith("/v3/auth/info")) return { email: "e", authVersion: 2, salt, id: "1" };
			if (url.endsWith("/v3/login")) {
				return { apiKey: "k", masterKeys: null, publicKey: null, privateKey: null };
			}
			throw new Error(`unexpected ${url}`);
		});
		const masterKey = pbkdf2Sync("pw", salt, 200000, 64, "sha512").toString("hex").slice(0, 64);
		const client = new FilenClient(async request => {
			if (request.url.endsWith("/v3/user/masterKeys")) {
				const data = { keys: await encMeta(masterKey, masterKey, 2) };
				return {
					status: 200, headers: {}, json: { status: true, data },
					text: "", arrayBuffer: new ArrayBuffer(0),
				};
			}
			if (request.url.endsWith("/v3/user/baseFolder")) {
				return {
					status: 200, headers: {}, json: { status: true, data: { uuid: "r" } },
					text: "", arrayBuffer: new ArrayBuffer(0),
				};
			}
			return http(request);
		});
		await client.connect("e", "pw", "123456");
		const login = recorded.find(r => r.request.url.endsWith("/v3/login"));
		expect(login?.body?.twoFactorCode).toBe("123456");
	});

	it("v3 with no account DEK: generates 32 random bytes hex and POSTs it encrypted", async () => {
		const salt = "cd".repeat(128); // v3 salts are 256 hex chars
		const password = "v3-password";
		const dekRequests: RecordedRequest[] = [];
		const { http, recorded } = makeRecorder(rec => {
			const url = rec.request.url;
			if (url.endsWith("/v3/auth/info")) return { email: "e", authVersion: 3, salt, id: "1" };
			if (url.endsWith("/v3/login")) {
				return { apiKey: "k3", masterKeys: null, publicKey: null, privateKey: null };
			}
			if (url.endsWith("/v3/user/dek")) {
				if (rec.body && typeof rec.body.dek === "string") {
					// setDEK call — record and acknowledge
					dekRequests.push(rec);
					return {};
				}
				return { dek: "" }; // no DEK on the account yet
			}
			if (url.endsWith("/v3/user/baseFolder")) return { uuid: "root3" };
			throw new Error(`unexpected ${url}`);
		});
		const client = new FilenClient(async request => {
			if (request.url.endsWith("/v3/user/keyPair/info")) {
				// keyPair/info is a GET-only route (SDK-verified)
				expect(request.method).toBe("GET");
				// status:false envelope → immediate FilenApiError (no retry backoff)
				return {
					status: 404, headers: {},
					json: { status: false, message: "not found", code: "not_found" },
					text: "", arrayBuffer: new ArrayBuffer(0),
				};
			}
			return http(request);
		});
		const credentials = await client.connect("e", password);

		// the DEK *fetch* is a GET with no body (the set below is the only POST)
		const dekFetch = recorded.find(r => r.request.url.endsWith("/v3/user/dek") && !r.body);
		expect(dekFetch?.request.method).toBe("GET");

		expect(dekRequests).toHaveLength(1);
		const dekEnc = dekRequests[0]?.body?.dek as string;
		expect(typeof dekEnc).toBe("string");
		// v3 masterKey is 64-hex → "003" envelope
		expect(dekEnc.startsWith("003")).toBe(true);
		// the posted DEK decrypts with the derived v3 master key
		const derived = deriveAuthV3(password, salt);
		const dek = await decMeta(dekEnc, [derived.masterKey]);
		expect(dek).toMatch(/^[0-9a-f]{64}$/);
		// and becomes THE metadata key
		expect(credentials.masterKeys).toEqual([dek]);
		expect(credentials.authVersion).toBe(3);
	});

	it("v3 with an existing account DEK: decrypts and uses it, never sets a new one", async () => {
		const salt = "ef".repeat(128);
		const password = "v3-password-2";
		const dek = "9".repeat(64);
		let dekSets = 0;
		const { http } = makeRecorder(rec => {
			const url = rec.request.url;
			if (url.endsWith("/v3/auth/info")) return { email: "e", authVersion: 3, salt, id: "1" };
			if (url.endsWith("/v3/login")) {
				return { apiKey: "k3", masterKeys: null, publicKey: null, privateKey: null };
			}
			if (url.endsWith("/v3/user/dek")) {
				if (rec.body && typeof rec.body.dek === "string") {
					dekSets++;
					return {};
				}
				// DEK encrypted with the derived v3 masterKey (async — handled below)
				throw new Error("handled below");
			}
			if (url.endsWith("/v3/user/baseFolder")) return { uuid: "root3" };
			throw new Error(`unexpected ${url}`);
		});
		const masterKey = deriveAuthV3(password, salt).masterKey;
		const dekEnc = await encMeta(dek, masterKey, 3);
		const client = new FilenClient(async request => {
			if (request.url.endsWith("/v3/user/keyPair/info")) {
				return {
					status: 404, headers: {},
					json: { status: false, message: "not found", code: "not_found" },
					text: "", arrayBuffer: new ArrayBuffer(0),
				};
			}
			if (request.url.endsWith("/v3/user/dek") && request.method === "GET") {
				const data = { dek: dekEnc };
				return {
					status: 200, headers: {}, json: { status: true, data },
					text: JSON.stringify({ status: true, data }), arrayBuffer: new ArrayBuffer(0),
				};
			}
			return http(request);
		});
		const credentials = await client.connect("e", password);
		expect(dekSets).toBe(0);
		expect(credentials.masterKeys).toEqual([dek]);
	});
});

describe("upload request shapes", () => {
	const masterKey = "f".repeat(64);
	const credentials: StoredCredentials = {
		apiKey: "api-key",
		masterKeys: [masterKey],
		authVersion: 2,
		rootUuid: "root",
		syncRootUuid: "root",
		email: "user@example.com",
	};

	it("0-byte file → /v3/upload/empty, no chunk uploads", async () => {
		const { http, recorded } = makeRecorder(rec => {
			if (rec.request.url.endsWith("/v3/upload/empty")) return {};
			throw new Error(`unexpected ${rec.request.url}`);
		});
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		const result = await client.uploadFile("parent-uuid", "empty.md", new ArrayBuffer(0), 1700000000000);
		expect(result.chunks).toBe(0);

		const emptyReq = recorded.find(r => r.request.url.endsWith("/v3/upload/empty"));
		expect(emptyReq).toBeDefined();
		const body = emptyReq?.body as Record<string, unknown>;
		expect(body.parent).toBe("parent-uuid");
		expect(body.version).toBe(2);
		expect(typeof body.uuid).toBe("string");
		// metadata decrypts with the master key
		const meta = JSON.parse(await decMeta(body.metadata as string, [masterKey])) as Record<string, unknown>;
		expect(meta.name).toBe("empty.md");
		expect(meta.size).toBe(0);
		expect(meta.hash).toBe(sha512hex(""));
		// name/size/mime decrypt with the FILE key from metadata
		const fileKey = meta.key as string;
		expect(fileKey).toHaveLength(32);
		expect(await decMeta(body.name as string, [fileKey])).toBe("empty.md");
		expect(await decMeta(body.size as string, [fileKey])).toBe("0");
	});

	it("non-empty file → chunk upload + /v3/upload/done with exact fields", async () => {
		const content = utf8ToBytes("hello filen upload");
		const { http, recorded } = makeRecorder(rec => {
			if (rec.request.url.includes("ingest.filen.io")) return { bucket: "bucket-1", region: "de-1" };
			if (rec.request.url.endsWith("/v3/upload/done")) return { chunks: 1, size: content.length };
			throw new Error(`unexpected ${rec.request.url}`);
		});
		const client = new FilenClient(http);
		client.setCredentials(credentials);

		const mtime = 1700000123000;
		const result = await client.uploadFile("parent-uuid", "note.md", content.buffer as ArrayBuffer, mtime);
		expect(result.chunks).toBe(1);
		expect(result.bucket).toBe("bucket-1");
		expect(result.region).toBe("de-1");
		expect(result.hash).toBe(sha512hex("hello filen upload"));

		// chunk upload: query params + Checksum of JSON.stringify(queryParamsObj)
		// — official SDK re-parses the query string, so ALL values are STRINGS.
		const chunkReq = recorded.find(r => r.request.url.includes("ingest.filen.io"));
		expect(chunkReq).toBeDefined();
		const url = new URL(chunkReq?.request.url as string);
		expect(url.pathname).toBe("/v3/upload");
		const queryObj = {
			uuid: url.searchParams.get("uuid"),
			index: url.searchParams.get("index"),
			parent: url.searchParams.get("parent"),
			uploadKey: url.searchParams.get("uploadKey"),
			hash: url.searchParams.get("hash"),
		};
		expect(queryObj.index).toBe("0");
		expect(queryObj.parent).toBe("parent-uuid");
		expect(queryObj.uploadKey).toHaveLength(32);
		expect(chunkReq?.request.headers?.["Checksum"]).toBe(
			sha512hex(JSON.stringify(queryObj)),
		);
		// the ingest server rejects unauthenticated uploads ("Invalid API key") —
		// official SDK buildHeaders falls back to the account apiKey
		expect(chunkReq?.request.headers?.["Authorization"]).toBe("Bearer api-key");
		// encrypted chunk = iv(12) + ct + tag(16)
		const encChunk = new Uint8Array(chunkReq?.request.body as ArrayBuffer);
		expect(encChunk.length).toBe(content.length + 28);
		expect(url.searchParams.get("hash")).toHaveLength(128);

		// /v3/upload/done body
		const doneReq = recorded.find(r => r.request.url.endsWith("/v3/upload/done"));
		const body = doneReq?.body as Record<string, unknown>;
		expect(body.uuid).toBe(queryObj.uuid);
		expect(body.uploadKey).toBe(queryObj.uploadKey);
		expect(body.chunks).toBe(1);
		expect(body.version).toBe(2);
		expect(typeof body.rm).toBe("string");
		expect(body.rm).toHaveLength(32);
		expect(typeof body.nameHashed).toBe("string");

		const meta = JSON.parse(await decMeta(body.metadata as string, [masterKey])) as Record<string, unknown>;
		expect(meta.name).toBe("note.md");
		expect(meta.size).toBe(content.length);
		expect(meta.lastModified).toBe(mtime);
		expect(meta.hash).toBe(sha512hex("hello filen upload"));
		const fileKey = meta.key as string;
		expect(await decMeta(body.name as string, [fileKey])).toBe("note.md");
		expect(await decMeta(body.size as string, [fileKey])).toBe(String(content.length));
		expect(await decMeta(body.mime as string, [fileKey])).toBe("text/markdown");

		// nameHashed matches v2 algorithm on the lowercased name
		const inner = createHash("sha512").update("note.md", "utf8").digest("hex");
		expect(body.nameHashed).toBe(createHash("sha1").update(inner, "utf8").digest("hex"));
	});

	it("overwrite uses a NEW uuid per upload", async () => {
		const { http } = makeRecorder(rec => {
			if (rec.request.url.includes("ingest.filen.io")) return { bucket: "b", region: "r" };
			if (rec.request.url.endsWith("/v3/upload/done")) return { chunks: 1, size: 1 };
			throw new Error(`unexpected ${rec.request.url}`);
		});
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		const data = utf8ToBytes("x").buffer as ArrayBuffer;
		const first = await client.uploadFile("p", "n.md", data, 1);
		const second = await client.uploadFile("p", "n.md", data, 2);
		expect(first.uuid).not.toBe(second.uuid);
	});
});

describe("dirTree request contract", () => {
	it("sends the persisted UUID deviceId and skipCache: 1 (never the empty-tree cache contract)", async () => {
		const { http, recorded } = makeRecorder(rec => {
			if (rec.request.url.endsWith("/v3/dir/tree")) return { files: [], folders: [] };
			throw new Error(`unexpected ${rec.request.url}`);
		});
		const client = new FilenClient(http);
		client.setCredentials({
			apiKey: "k", masterKeys: ["a".repeat(64)], authVersion: 2,
			rootUuid: "r", syncRootUuid: "s", email: "e",
		});
		await client.dirTree("root-uuid", "2f4c6f30-9c8b-4c8e-9b1a-7a0d3f1e2c4b");
		const req = recorded.find(r => r.request.url.endsWith("/v3/dir/tree"));
		expect(req?.request.method).toBe("POST");
		expect(req?.body?.uuid).toBe("root-uuid");
		expect(req?.body?.deviceId).toBe("2f4c6f30-9c8b-4c8e-9b1a-7a0d3f1e2c4b");
		// skipCache must be 1: with 0 the server may return EMPTY files/folders
		// meaning "unchanged, reuse your cache" — we keep no remote-tree cache,
		// and reading that as an empty tree would plan mass local deletions.
		expect(req?.body?.skipCache).toBe(1);
	});
});

describe("rename/move request shapes (feature D)", () => {
	const masterKey = "0123456789abcdef".repeat(4); // 64 hex chars
	const fileKey = "file-key-32-chars-abcdefg-_-1234"; // 32 chars
	const credentials: StoredCredentials = {
		apiKey: "api-key",
		masterKeys: [masterKey],
		authVersion: 2,
		rootUuid: "root",
		syncRootUuid: "root",
		email: "user@example.com",
	};

	function connectedClient(): { client: FilenClient; recorded: RecordedRequest[] } {
		const { http, recorded } = makeRecorder(() => ({}));
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		return { client, recorded };
	}

	it("fileRename: name enc with FILE key + nameHashed + full metadata enc with MASTER key", async () => {
		const { client, recorded } = connectedClient();
		const metadata = {
			name: "new-name.md",
			size: 123,
			mime: "text/markdown",
			key: fileKey,
			lastModified: 1_700_000_000_000,
			creation: 1_699_000_000_000,
			hash: "hash-hex",
		};
		await client.fileRename("uuid-1", "new-name.md", fileKey, metadata);

		expect(recorded).toHaveLength(1);
		const rec = recorded[0] as RecordedRequest;
		expect(rec.request.url).toBe("https://gateway.filen.io/v3/file/rename");
		expect(rec.request.method).toBe("POST");
		const body = rec.body as Record<string, unknown>;
		expect(body.uuid).toBe("uuid-1");
		// name decrypts with the FILE key
		expect(await decMeta(body.name as string, [fileKey])).toBe("new-name.md");
		// nameHashed = sha1hex(sha512hex(lowercase(name)))
		const lower = "new-name.md".toLowerCase();
		const expected = createHash("sha1")
			.update(createHash("sha512").update(lower, "utf8").digest("hex"), "utf8")
			.digest("hex");
		expect(body.nameHashed).toBe(expected);
		// metadata decrypts with the MASTER key and keeps every other field
		const plain = JSON.parse(await decMeta(body.metadata as string, [masterKey])) as Record<string, unknown>;
		expect(plain).toEqual(metadata);
	});

	it("fileMove: POST /v3/file/move {uuid, to}", async () => {
		const { client, recorded } = connectedClient();
		await client.fileMove("uuid-2", "new-parent-uuid");
		expect(recorded).toHaveLength(1);
		const rec = recorded[0] as RecordedRequest;
		expect(rec.request.url).toBe("https://gateway.filen.io/v3/file/move");
		expect(rec.body).toEqual({ uuid: "uuid-2", to: "new-parent-uuid" });
	});

	it("fileVersions: POST /v3/file/versions {uuid}", async () => {
		const { client, recorded } = connectedClient();
		await client.fileVersions("uuid-3");
		expect(recorded).toHaveLength(1);
		const rec = recorded[0] as RecordedRequest;
		expect(rec.request.url).toBe("https://gateway.filen.io/v3/file/versions");
		expect(rec.body).toEqual({ uuid: "uuid-3" });
	});
});

describe("parallel chunk transfers (v0.4.0 feature C)", () => {
	const masterKey = "f".repeat(64);
	const credentials: StoredCredentials = {
		apiKey: "api-key",
		masterKeys: [masterKey],
		authVersion: 2,
		rootUuid: "root",
		syncRootUuid: "root",
		email: "user@example.com",
	};

	function jsonResp(data: unknown) {
		return {
			status: 200, headers: {},
			json: { status: true, data },
			text: JSON.stringify({ status: true, data }),
			arrayBuffer: new ArrayBuffer(0),
		};
	}

	it("upload: pool ceiling ≤ 3 and every chunk lands (order shuffled)", async () => {
		const bytes = new Uint8Array(7 * 1024 * 1024 - 10); // 7 chunks
		for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
		let inflight = 0;
		let maxInflight = 0;
		const indices: number[] = [];
		const http: HttpFn = async request => {
			if (request.url.includes("ingest.filen.io")) {
				inflight++;
				maxInflight = Math.max(maxInflight, inflight);
				const index = Number(new URL(request.url).searchParams.get("index"));
				indices.push(index);
				// Stagger delays so completion order differs from start order.
				await new Promise(resolve => setTimeout(resolve, index % 3 === 0 ? 20 : 5));
				inflight--;
				return jsonResp({ bucket: "bucket-1", region: "de-1" });
			}
			if (request.url.endsWith("/v3/upload/done")) return jsonResp({ chunks: 7, size: bytes.length });
			throw new Error(`unexpected ${request.url}`);
		};
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		const result = await client.uploadFile(
			"parent-uuid", "big.bin", bytes.buffer as ArrayBuffer, 1700000000000,
		);
		expect(result.chunks).toBe(7);
		expect(maxInflight).toBeGreaterThan(1); // actually parallel
		expect(maxInflight).toBeLessThanOrEqual(3);
		expect([...indices].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("upload: one failing chunk fails the whole file (no /v3/upload/done)", async () => {
		const bytes = new Uint8Array(5 * 1024 * 1024); // 5 chunks
		let doneCalled = false;
		const http: HttpFn = async request => {
			if (request.url.includes("ingest.filen.io")) {
				const index = Number(new URL(request.url).searchParams.get("index"));
				if (index === 2) {
					return {
						status: 200, headers: {},
						json: { status: false, message: "chunk boom" },
						text: JSON.stringify({ status: false, message: "chunk boom" }),
						arrayBuffer: new ArrayBuffer(0),
					};
				}
				return jsonResp({ bucket: "b", region: "r" });
			}
			if (request.url.endsWith("/v3/upload/done")) {
				doneCalled = true;
				return jsonResp({ chunks: 5, size: bytes.length });
			}
			throw new Error(`unexpected ${request.url}`);
		};
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		await expect(client.uploadFile(
			"parent-uuid", "big.bin", bytes.buffer as ArrayBuffer, 1700000000000,
		)).rejects.toThrow(/chunk boom/);
		expect(doneCalled).toBe(false);
	});

	it("upload: onChunkProgress fires exactly once per chunk, ending at (total, total)", async () => {
		const bytes = new Uint8Array(7 * 1024 * 1024 - 10); // 7 chunks
		for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
		const calls: Array<[number, number]> = [];
		const http: HttpFn = async request => {
			if (request.url.includes("ingest.filen.io")) {
				const index = Number(new URL(request.url).searchParams.get("index"));
				// Stagger delays so completion order differs from start order —
				// progress must still count completions 1..7 monotonically.
				await new Promise(resolve => setTimeout(resolve, index % 3 === 0 ? 20 : 5));
				return jsonResp({ bucket: "bucket-1", region: "de-1" });
			}
			if (request.url.endsWith("/v3/upload/done")) return jsonResp({ chunks: 7, size: bytes.length });
			throw new Error(`unexpected ${request.url}`);
		};
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		await client.uploadFile(
			"parent-uuid", "big.bin", bytes.buffer as ArrayBuffer, 1700000000000,
			undefined, (done, total) => calls.push([done, total]),
		);
		expect(calls.length).toBe(7);
		expect(calls.map(([done]) => done)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(calls.every(([, total]) => total === 7)).toBe(true);
		expect(calls[6]).toEqual([7, 7]);
	});

	it("upload: 0-byte file fires no chunk progress (no chunks)", async () => {
		const calls: Array<[number, number]> = [];
		const http: HttpFn = async request => {
			if (request.url.endsWith("/v3/upload/empty")) return jsonResp({});
			throw new Error(`unexpected ${request.url}`);
		};
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		await client.uploadFile(
			"parent-uuid", "empty.md", new ArrayBuffer(0), 1700000000000,
			undefined, (done, total) => calls.push([done, total]),
		);
		expect(calls).toEqual([]);
	});

	it("download: onChunkProgress fires exactly once per chunk, ending at (total, total)", async () => {
		const fileKey = generateFileKey();
		const chunkCount = 5;
		const encChunks: Uint8Array[] = [];
		for (let i = 0; i < chunkCount; i++) {
			encChunks.push(await encryptChunk(fileKey, new Uint8Array(64).fill(i)));
		}
		const calls: Array<[number, number]> = [];
		const http: HttpFn = async request => {
			const match = /egest\.filen\.io\/[^/]+\/[^/]+\/[^/]+\/(\d+)$/.exec(request.url);
			if (match) {
				const index = Number(match[1]);
				// Later chunks finish FIRST → completions still count 1..total.
				await new Promise(resolve => setTimeout(resolve, (chunkCount - index) * 3));
				const buf = encChunks[index] as Uint8Array;
				return {
					status: 200, headers: {}, json: null, text: "",
					arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
				};
			}
			throw new Error(`unexpected ${request.url}`);
		};
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		await client.downloadFile(
			{ uuid: "file-uuid", bucket: "b", region: "r", chunks: chunkCount },
			fileKey,
			undefined,
			(done, total) => calls.push([done, total]),
		);
		expect(calls.length).toBe(chunkCount);
		expect(calls.map(([done]) => done)).toEqual([1, 2, 3, 4, 5]);
		expect(calls.every(([, total]) => total === chunkCount)).toBe(true);
		expect(calls[chunkCount - 1]).toEqual([chunkCount, chunkCount]);
	});

	it("upload: a throwing progress callback never fails the transfer", async () => {
		const bytes = new Uint8Array(2 * 1024 * 1024); // 2 chunks
		const http: HttpFn = async request => {
			if (request.url.includes("ingest.filen.io")) return jsonResp({ bucket: "b", region: "r" });
			if (request.url.endsWith("/v3/upload/done")) return jsonResp({ chunks: 2, size: bytes.length });
			throw new Error(`unexpected ${request.url}`);
		};
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		const result = await client.uploadFile(
			"parent-uuid", "big.bin", bytes.buffer as ArrayBuffer, 1700000000000,
			undefined, () => { throw new Error("ui boom"); },
		);
		expect(result.chunks).toBe(2);
	});

	it("download: pool ceiling ≤ 3, index-addressed assembly (order shuffled)", async () => {
		const fileKey = generateFileKey();
		const chunkCount = 8;
		const plainChunks: Uint8Array[] = [];
		const encChunks: Uint8Array[] = [];
		for (let i = 0; i < chunkCount; i++) {
			const plain = new Uint8Array(1024);
			for (let j = 0; j < plain.length; j++) plain[j] = (i * 7 + j) & 0xff;
			plainChunks.push(plain);
			encChunks.push(await encryptChunk(fileKey, plain));
		}
		const expected = new Uint8Array(chunkCount * 1024);
		plainChunks.forEach((c, i) => expected.set(c, i * 1024));
		const expectedHash = createHash("sha512").update(expected).digest("hex");

		let inflight = 0;
		let maxInflight = 0;
		const http: HttpFn = async request => {
			const match = /egest\.filen\.io\/[^/]+\/[^/]+\/[^/]+\/(\d+)$/.exec(request.url);
			if (match) {
				inflight++;
				maxInflight = Math.max(maxInflight, inflight);
				const index = Number(match[1]);
				// Later chunks finish FIRST → assembly must still be index-addressed.
				await new Promise(resolve => setTimeout(resolve, (chunkCount - index) * 3));
				inflight--;
				const buf = encChunks[index] as Uint8Array;
				return {
					status: 200, headers: {}, json: null, text: "",
					arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
				};
			}
			throw new Error(`unexpected ${request.url}`);
		};
		const client = new FilenClient(http);
		client.setCredentials(credentials);
		const { data, verified } = await client.downloadFile(
			{ uuid: "file-uuid", bucket: "b", region: "r", chunks: chunkCount },
			fileKey,
			expectedHash,
		);
		expect(maxInflight).toBeGreaterThan(1);
		expect(maxInflight).toBeLessThanOrEqual(3);
		expect(new Uint8Array(data)).toEqual(expected);
		expect(verified).toBe(true);
	});
});

describe("userEvents (v0.4.0 feature D)", () => {
	it("POST /v3/user/events with {filter: \"all\", timestamp} and parses the events list", async () => {
		const { http, recorded } = makeRecorder(rec => {
			if (rec.request.url.endsWith("/v3/user/events")) {
				return {
					events: [
						{ id: 1, type: "fileUploaded", timestamp: 1_700_000_100, info: { uuid: "u1" } },
						{ id: 2, type: "fileTrash", timestamp: 1_700_000_200 },
					],
				};
			}
			throw new Error(`unexpected ${rec.request.url}`);
		});
		const client = new FilenClient(http);
		client.setCredentials({
			apiKey: "api-key", masterKeys: ["a".repeat(64)], authVersion: 2,
			rootUuid: "r", syncRootUuid: "s", email: "user@example.com",
		});
		const resp = await client.userEvents(1_700_000_000_000);
		expect(resp.events).toHaveLength(2);
		expect(resp.events[0]?.type).toBe("fileUploaded");
		expect(recorded).toHaveLength(1);
		const rec = recorded[0] as RecordedRequest;
		expect(rec.request.method).toBe("POST");
		expect(rec.request.url).toBe("https://gateway.filen.io/v3/user/events");
		// The events feed stores SECOND-precision timestamps (SDK-verified) —
		// sending ms would make the probe silently return zero events forever.
		expect(rec.body).toEqual({ filter: "all", timestamp: 1_700_000_000 });
		expect(rec.request.headers?.["Authorization"]).toBe("Bearer api-key");
	});
});

describe("userAccount (v0.4.0 features B/F)", () => {
	it("GET /v3/user/account with Authorization header and NO body", async () => {
		const { http, recorded } = makeRecorder(rec => {
			if (rec.request.url.endsWith("/v3/user/account")) {
				return { email: "user@example.com", storage: 42, maxStorage: 1024, isPremium: true };
			}
			throw new Error(`unexpected ${rec.request.url}`);
		});
		const client = new FilenClient(http);
		client.setCredentials({
			apiKey: "api-key", masterKeys: ["a".repeat(64)], authVersion: 2,
			rootUuid: "r", syncRootUuid: "s", email: "user@example.com",
		});
		const account = await client.userAccount();
		expect(account.email).toBe("user@example.com");
		expect(account.storage).toBe(42);
		expect(account.maxStorage).toBe(1024);
		expect(recorded).toHaveLength(1);
		const rec = recorded[0] as RecordedRequest;
		expect(rec.request.method).toBe("GET");
		expect(rec.request.url).toBe("https://gateway.filen.io/v3/user/account");
		expect(rec.request.body).toBeUndefined();
		expect(rec.request.headers?.["Authorization"]).toBe("Bearer api-key");
		expect(rec.request.headers?.["Checksum"]).toBeUndefined();
	});
});

describe("envelope handling (live bug: data-less success)", () => {
	const creds: StoredCredentials = {
		apiKey: "api-key",
		masterKeys: ["a".repeat(64)],
		authVersion: 2,
		rootUuid: "r",
		syncRootUuid: "s",
		email: "user@example.com",
	};

	it("data-less success envelopes (trash/move/rename endpoints) resolve, not throw", async () => {
		// Filen's action endpoints return {"status":true} with NO data field —
		// requiring one reports successful trash/move as failures (live bug).
		const { http, recorded } = makeRecorder(() => undefined);
		const client = new FilenClient(http);
		client.setCredentials(creds);
		await expect(client.fileTrash("uuid-1")).resolves.toBeUndefined();
		await expect(client.dirTrash("uuid-2")).resolves.toBeUndefined();
		expect(recorded).toHaveLength(2);
	});

	it("status:false envelopes still throw with the server message", async () => {
		const client = new FilenClient(async () => ({
			status: 200,
			headers: {},
			json: { status: false, code: "not_found", message: "File not found" },
			text: "",
			arrayBuffer: new ArrayBuffer(0),
		}));
		client.setCredentials(creds);
		await expect(client.fileTrash("uuid-x")).rejects.toThrow("File not found");
	});
});
