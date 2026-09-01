/**
 * Minimal pure-TypeScript Filen client (the Filen API (verified against @filen/sdk)
 * "IMPLEMENTATION CHECKLIST"). No obsidian imports: the thin HttpFn interface
 * is injected by main.ts (wrapping requestUrl) so tests can mock it.
 */

import { debugLog, safeUrl } from "../debug";
import {
	checksumOf,
	CHUNK_SIZE,
	decMeta,
	decryptChunk,
	deriveAuthV2,
	deriveAuthV3,
	deriveHmacKey,
	encMeta,
	encryptChunk,
	FILE_ENCRYPTION_VERSION,
	FilenCryptoError,
	generateFileKey,
	generateUploadKey,
	nameHashV2,
	nameHashV3,
	sha512Hex,
} from "./crypto";
import {
	AuthInfoResponse,
	BaseFolderResponse,
	DekResponse,
	DirCreateResponse,
	DirTreeResponse,
	FilenEnvelope,
	FileMetadata,
	FileVersionsResponse,
	FolderMetadata,
	HttpFn,
	KeyPairInfoResponse,
	LoginResponse,
	MasterKeysResponse,
	StoredCredentials,
	UploadChunkResponse,
	UploadDoneResponse,
	UserAccountResponse,
	UserEventsResponse,
} from "./types";
import {
	baseNameOf,
	bytesToHex,
	mapPool,
	mimeFromName,
	randomBytes,
	randomString,
	sleepMillis,
	uuidv4,
} from "../util";

export const GATEWAY_HOST = "https://gateway.filen.io";
export const INGEST_HOST = "https://ingest.filen.io";
export const EGEST_HOST = "https://egest.filen.io";

export class FilenApiError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
		public readonly httpStatus?: number,
	) {
		super(message);
		this.name = "FilenApiError";
	}
}

export interface UploadResult {
	uuid: string;
	chunks: number;
	size: number;
	hash: string;
	bucket: string;
	region: string;
	lastModified: number;
}

export interface RemoteFileLocation {
	uuid: string;
	bucket: string;
	region: string;
	chunks: number;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const MAX_ATTEMPTS = 3;
/**
 * Fixed pool for chunk transfers (upload AND download). Chunks are
 * index-addressed, so completion order doesn't matter; any chunk failure
 * fails the whole file through the existing per-op error path. No sliced
 * reads (Obsidian has no range-read API and Node fs is banned on mobile) —
 * whole-file memory stays, mitigated by the "skip large files" setting.
 */
const CHUNK_CONCURRENCY = 3;

/**
 * v0.6.0 feature C: per-chunk progress callback. UI callbacks must never
 * break a transfer, so a throwing listener is swallowed (debug-logged).
 */
function reportChunkProgress(
	callback: ((done: number, total: number) => void) | undefined,
	done: number,
	total: number,
): void {
	if (!callback) return;
	try {
		callback(done, total);
	} catch (e) {
		debugLog("transfer", `chunk progress callback threw: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export class FilenClient {
	private credentials: StoredCredentials | null = null;

	constructor(private readonly http: HttpFn) {}

	setCredentials(credentials: StoredCredentials): void {
		this.credentials = credentials;
	}

	getCredentials(): StoredCredentials | null {
		return this.credentials;
	}

	/** Primary master key (last in the list — used for writing metadata). */
	get masterKey(): string {
		if (!this.credentials || this.credentials.masterKeys.length === 0) {
			throw new FilenApiError("not connected");
		}
		return this.credentials.masterKeys[this.credentials.masterKeys.length - 1] as string;
	}

	get masterKeys(): string[] {
		if (!this.credentials) throw new FilenApiError("not connected");
		return this.credentials.masterKeys;
	}

	/**
	 * Metadata encryption version for NEW ciphertexts, sourced from the
	 * account's authVersion (2 → "002" PBKDF2 envelope, 3 → "003" raw-hex
	 * envelope; encMeta downgrades 3→2 for non-64-hex keys like file keys).
	 */
	private metadataVersion(): 2 | 3 {
		return this.credentials?.authVersion === 3 ? 3 : 2;
	}

	async nameHash(name: string): Promise<string> {
		if (!this.credentials) throw new FilenApiError("not connected");
		if (this.credentials.authVersion === 3 && this.credentials.hmacKey) {
			return nameHashV3(name, this.credentials.hmacKey);
		}
		return nameHashV2(name);
	}

	/* ---------------- connect / auth flow ---------------- */

	/**
	 * Full auth flow (the design docs): auth/info → derive → login → master keys →
	 * baseFolder. Password is used only in memory and never persisted.
	 */
	async connect(email: string, password: string, twoFactorCode?: string): Promise<StoredCredentials> {
		debugLog("auth", "connect: fetching auth info");
		const info = await this.gatewayPost<AuthInfoResponse>("/v3/auth/info", { email }, null);
		debugLog("auth", `auth info ok: authVersion=${info.authVersion}`);
		let masterKey: string;
		let derivedPassword: string;
		if (info.authVersion === 2) {
			const derived = await deriveAuthV2(password, info.salt);
			masterKey = derived.masterKey;
			derivedPassword = derived.password;
		} else if (info.authVersion === 3) {
			const derived = deriveAuthV3(password, info.salt);
			masterKey = derived.masterKey;
			derivedPassword = derived.password;
		} else {
			throw new FilenApiError(
				`unsupported authVersion ${info.authVersion} — please migrate your account via the official Filen app`,
			);
		}

		const login = await this.gatewayPost<LoginResponse>(
			"/v3/login",
			{
				email,
				password: derivedPassword,
				twoFactorCode: twoFactorCode && twoFactorCode.length > 0 ? twoFactorCode : "XXXXXX",
				authVersion: info.authVersion,
			},
			null,
		);
		debugLog("auth", "login ok");
		const apiKey = login.apiKey;

		let masterKeys: string[];
		let hmacKey: string | undefined;
		if (info.authVersion === 3) {
			// v3: login masterKey decrypts the account DEK, which is THE metadata key.
			// NOTE: GET route (verified against @filen/sdk dist: getDEK uses method GET).
			const dekResp = await this.gatewayGet<DekResponse>("/v3/user/dek", apiKey);
			let dek: string;
			if (dekResp.dek && dekResp.dek.length > 0) {
				dek = await decMeta(dekResp.dek, [masterKey]);
			} else {
				// No DEK on the account yet (fresh v3 account): generate
				// 32 random bytes hex, store it encrypted, and use it.
				dek = bytesToHex(randomBytes(32));
				const dekEnc = await encMeta(dek, masterKey, 3);
				await this.gatewayPost("/v3/user/dek", { dek: dekEnc }, apiKey);
			}
			masterKeys = [dek];
			try {
				const kp = await this.gatewayGet<KeyPairInfoResponse>("/v3/user/keyPair/info", apiKey);
				const privateKeyB64 = await decMeta(kp.privateKey, masterKeys);
				hmacKey = await deriveHmacKey(privateKeyB64);
			} catch {
				// v3 name-hash path stays untested/disabled without a key pair
			}
		} else {
			// v2: fetch (or initially set) the master key list.
			const meta = await encMeta(masterKey, masterKey, 2);
			const resp = await this.gatewayPost<MasterKeysResponse>(
				"/v3/user/masterKeys", { masterKeys: meta }, apiKey,
			);
			const joined = await decMeta(resp.keys, [masterKey]);
			masterKeys = joined.split("|").filter(k => k.length > 0);
		}

		debugLog("auth", `master key material ok (${masterKeys.length} key(s), authVersion ${info.authVersion})`);
		const baseFolder = await this.gatewayGet<BaseFolderResponse>("/v3/user/baseFolder", apiKey);
		debugLog("auth", "connect complete");

		const credentials: StoredCredentials = {
			apiKey,
			masterKeys,
			authVersion: info.authVersion,
			rootUuid: baseFolder.uuid,
			syncRootUuid: baseFolder.uuid, // refined by ensureSyncRoot()
			email,
		};
		if (hmacKey) credentials.hmacKey = hmacKey;
		this.credentials = credentials;
		return credentials;
	}

	/* ---------------- gateway plumbing ---------------- */

	private async gatewayPost<T>(path: string, body: unknown, apiKey: string | null): Promise<T> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Checksum": await checksumOf(body),
		};
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
		const t0 = Date.now();
		const resp = await this.requestWithRetry({
			url: `${GATEWAY_HOST}${path}`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify(body),
			headers,
			throw: false,
		});
		let envelope: FilenEnvelope<T>;
		try {
			envelope = (typeof resp.json === "object" && resp.json !== null)
				? resp.json as FilenEnvelope<T>
				: JSON.parse(resp.text) as FilenEnvelope<T>;
		} catch {
			debugLog("http", `POST ${path} → HTTP ${resp.status}, non-JSON response (${Date.now() - t0}ms)`);
			throw new FilenApiError(`invalid JSON from ${path} (HTTP ${resp.status})`);
		}
		debugLog("http", `POST ${path} → HTTP ${resp.status} (${Date.now() - t0}ms)`,
			envelope.status === true
				? undefined
				: { code: envelope.code, message: envelope.message });
		// Success envelopes from action endpoints (trash/move/rename) carry NO
		// data field — only status:false is an error (SDK-verified). Requiring
		// data would report successful actions as failures.
		if (envelope.status !== true) {
			throw new FilenApiError(
				`POST ${path}: ${envelope.message ?? "Filen request failed"}`,
				envelope.code,
				resp.status,
			);
		}
		return envelope.data as T;
	}

	/**
	 * GET variant for the few GET-only gateway routes (verified against
	 * @filen/sdk dist: /v3/user/dek, /v3/user/baseFolder, /v3/user/keyPair/info).
	 * Mirrors the SDK's get(): Authorization header only, no body, no Checksum.
	 */
	private async gatewayGet<T>(path: string, apiKey: string | null): Promise<T> {
		const headers: Record<string, string> = {};
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
		const t0 = Date.now();
		const resp = await this.requestWithRetry({
			url: `${GATEWAY_HOST}${path}`,
			method: "GET",
			headers,
			throw: false,
		});
		let envelope: FilenEnvelope<T>;
		try {
			envelope = (typeof resp.json === "object" && resp.json !== null)
				? resp.json as FilenEnvelope<T>
				: JSON.parse(resp.text) as FilenEnvelope<T>;
		} catch {
			debugLog("http", `GET ${path} → HTTP ${resp.status}, non-JSON response (${Date.now() - t0}ms)`);
			throw new FilenApiError(`invalid JSON from GET ${path} (HTTP ${resp.status})`);
		}
		debugLog("http", `GET ${path} → HTTP ${resp.status} (${Date.now() - t0}ms)`,
			envelope.status === true
				? undefined
				: { code: envelope.code, message: envelope.message });
		if (envelope.status !== true) {
			throw new FilenApiError(
				`GET ${path}: ${envelope.message ?? "Filen request failed"}`,
				envelope.code,
				resp.status,
			);
		}
		return envelope.data as T;
	}

	/** Authenticated gateway call using stored credentials. */
	async post<T>(path: string, body: unknown): Promise<T> {
		if (!this.credentials) throw new FilenApiError("not connected");
		return this.gatewayPost<T>(path, body, this.credentials.apiKey);
	}

	/** Exponential backoff (1s,2s,4s,8s) on network errors / 5xx; 4xx surfaces. */
	private async requestWithRetry(req: Parameters<HttpFn>[0]) {
		let lastError: unknown = null;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			try {
				const resp = await this.http(req);
				if (resp.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
					debugLog("http", `${req.method ?? "?"} ${safeUrl(req.url)} → HTTP ${resp.status}, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
					await sleepMillis(RETRY_DELAYS_MS[attempt] ?? 8000);
					continue;
				}
				return resp;
			} catch (e) {
				lastError = e;
				if (attempt < MAX_ATTEMPTS - 1) {
					debugLog("http", `${req.method ?? "?"} ${safeUrl(req.url)} network error, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${e instanceof Error ? e.message : String(e)}`);
					await sleepMillis(RETRY_DELAYS_MS[attempt] ?? 8000);
				}
			}
		}
		throw lastError instanceof Error ? lastError : new FilenApiError(String(lastError));
	}

	/**
	 * Account info + quota (v0.4.0 features B/F). GET route verified against
	 * @filen/sdk dist — Authorization header only, no body, no Checksum.
	 */
	async userAccount(): Promise<UserAccountResponse> {
		if (!this.credentials) throw new FilenApiError("not connected");
		return this.gatewayGet<UserAccountResponse>("/v3/user/account", this.credentials.apiKey);
	}

	/**
	 * Remote change probe (v0.4.0 feature D): events since `timestampMs`.
	 * Only the event count + max timestamp are consumed — NO decryption. The
	 * engine treats a failed probe as "unknown" and always falls back to a
	 * full dir/tree fetch (never trusts silence).
	 */
	async userEvents(timestampMs: number): Promise<UserEventsResponse> {
		return this.post<UserEventsResponse>("/v3/user/events", {
			filter: "all",
			// The events feed stores SECOND-precision timestamps (verified in
			// @filen/sdk user/index.js: lastTimestamp in seconds). Sending ms
			// would make the probe silently return zero events forever —
			// turning the remote-tree cache into a stale-cache trap.
			timestamp: Math.floor(timestampMs / 1000),
		});
	}

	/* ---------------- remote tree ---------------- */

	/**
	 * Full remote subtree. deviceId must be a UUID (server rejects anything
	 * else with invalid_params). skipCache: 1 is deliberate — with skipCache: 0
	 * the server may answer a known deviceId with EMPTY files/folders meaning
	 * "unchanged, reuse your cached tree"; we keep no remote-tree cache, and
	 * reading that as an empty tree would plan mass local deletions.
	 */
	async dirTree(uuid: string, deviceId: string): Promise<DirTreeResponse> {
		return this.post<DirTreeResponse>("/v3/dir/tree", {
			uuid,
			deviceId,
			skipCache: 1,
		});
	}

	async decryptFileMetadata(metadataEnc: string): Promise<FileMetadata> {
		const plain = await decMeta(metadataEnc, this.masterKeys);
		return JSON.parse(plain) as FileMetadata;
	}

	async decryptFolderName(nameEnc: string): Promise<string> {
		if (nameEnc === "default") return "default";
		const plain = await decMeta(nameEnc, this.masterKeys);
		return (JSON.parse(plain) as FolderMetadata).name;
	}

	/* ---------------- folders ---------------- */

	async dirCreate(name: string, parent: string): Promise<string> {
		const uuid = uuidv4();
		const nameEnc = await encMeta(
			JSON.stringify({ name } satisfies FolderMetadata), this.masterKey, this.metadataVersion(),
		);
		const nameHashed = await this.nameHash(name);
		const resp = await this.post<DirCreateResponse>("/v3/dir/create", {
			uuid,
			name: nameEnc,
			nameHashed,
			parent,
		});
		return resp.uuid ?? uuid;
	}

	async dirTrash(uuid: string): Promise<void> {
		await this.post("/v3/dir/trash", { uuid });
	}

	/**
	 * Resolve/create a folder chain (e.g. "Obsidian/MyVault") below rootUuid.
	 * Returns the leaf uuid. Uses one dir/tree fetch + dirCreate for gaps.
	 */
	async ensureFolderChain(rootUuid: string, chainPath: string, deviceId: string): Promise<string> {
		const segments = chainPath.split("/").map(s => s.trim()).filter(s => s.length > 0);
		if (segments.length === 0) return rootUuid;
		const tree = await this.dirTree(rootUuid, deviceId);
		// Build child lookup: parentUuid -> (lowerName -> uuid)
		const children = new Map<string, Map<string, string>>();
		children.set(rootUuid, new Map());
		children.set("base", new Map());
		(children.get("base") as Map<string, string>).set("__root__", rootUuid);
		for (const tuple of tree.folders) {
			const [uuid, nameEnc, parent] = tuple;
			let name: string;
			try {
				name = await this.decryptFolderName(nameEnc);
			} catch (e) {
				if (e instanceof FilenCryptoError) continue; // undecryptable: skip
				throw e;
			}
			let bucket = children.get(parent);
			if (!bucket) {
				bucket = new Map();
				children.set(parent, bucket);
			}
			bucket.set(name.toLowerCase(), uuid);
			if (!children.has(uuid)) children.set(uuid, new Map());
		}
		let current = rootUuid;
		for (const segment of segments) {
			const bucket = children.get(current);
			const existing = bucket?.get(segment.toLowerCase());
			if (existing) {
				current = existing;
			} else {
				current = await this.dirCreate(segment, current);
			}
		}
		return current;
	}

	/* ---------------- files ---------------- */

	async fileTrash(uuid: string): Promise<void> {
		await this.post("/v3/file/trash", { uuid });
	}

	async fileRestore(uuid: string): Promise<void> {
		await this.post("/v3/file/restore", { uuid });
	}

	async fileVersions(uuid: string): Promise<FileVersionsResponse> {
		return this.post<FileVersionsResponse>("/v3/file/versions", { uuid });
	}

	/**
	 * Server-side rename (research §4): name encrypted with the FILE key,
	 * nameHashed, and the FULL updated metadata JSON (name replaced, every
	 * other field untouched) encrypted with the MASTER key.
	 */
	async fileRename(uuid: string, newName: string, fileKey: string, metadata: FileMetadata): Promise<void> {
		const nameEnc = await encMeta(newName, fileKey, this.metadataVersion());
		const nameHashed = await this.nameHash(newName);
		const metadataEnc = await encMeta(
			JSON.stringify(metadata), this.masterKey, this.metadataVersion(),
		);
		await this.post("/v3/file/rename", {
			uuid,
			name: nameEnc,
			nameHashed,
			metadata: metadataEnc,
		});
	}

	/** Server-side move to a different parent folder (research §4). */
	async fileMove(uuid: string, to: string): Promise<void> {
		await this.post("/v3/file/move", { uuid, to });
	}

	/**
	 * Upload a file (new uuid — an overwrite mints a version server-side).
	 * 0-byte files go through /v3/upload/empty.
	 * `onChunkProgress(done, total)` fires after each chunk completes —
	 * pool-safe (chunks finish out of order; only completions are counted,
	 * total = chunk count). Callback errors never fail the transfer.
	 */
	async uploadFile(
		parentUuid: string,
		name: string,
		data: ArrayBuffer,
		lastModified: number,
		mime?: string,
		onChunkProgress?: (done: number, total: number) => void,
	): Promise<UploadResult> {
		const fileName = baseNameOf(name);
		const resolvedMime = mime ?? mimeFromName(fileName);
		const uuid = uuidv4();
		const fileKey = generateFileKey();
		const bytes = new Uint8Array(data);
		const plaintextHash = await sha512Hex(bytes);
		const size = bytes.byteLength;

		const metadata: FileMetadata = {
			name: fileName,
			size,
			mime: resolvedMime,
			key: fileKey,
			lastModified,
			creation: lastModified,
			hash: plaintextHash,
		};
		const metadataEnc = await encMeta(JSON.stringify(metadata), this.masterKey, this.metadataVersion());
		// File-key fields: encMeta downgrades to "002" (fileKey is 32 chars).
		const nameEnc = await encMeta(fileName, fileKey, this.metadataVersion());
		const nameHashed = await this.nameHash(fileName);
		const mimeEnc = await encMeta(resolvedMime, fileKey, this.metadataVersion());
		const sizeEnc = await encMeta(String(size), fileKey, this.metadataVersion());

		if (size === 0) {
			debugLog("transfer", `upload ${name}: 0 bytes (empty file)`);
			await this.post("/v3/upload/empty", {
				uuid,
				name: nameEnc,
				nameHashed,
				size: sizeEnc,
				parent: parentUuid,
				mime: mimeEnc,
				metadata: metadataEnc,
				version: FILE_ENCRYPTION_VERSION,
			});
			return { uuid, chunks: 0, size: 0, hash: plaintextHash, bucket: "", region: "", lastModified };
		}

		const uploadKey = generateUploadKey();
		const chunkCount = Math.ceil(size / CHUNK_SIZE);
		debugLog("transfer", `upload ${name}: ${size} bytes, ${chunkCount} chunk(s)`);
		// Chunks are index-addressed → safe to upload through a fixed pool.
		// `chunksDone` counts COMPLETIONS (order differs under the pool).
		let chunksDone = 0;
		const chunkResults = await mapPool(
			Array.from({ length: chunkCount }, (_, i) => i),
			CHUNK_CONCURRENCY,
			async index => {
				const chunk = bytes.subarray(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, size));
				const encChunk = await encryptChunk(fileKey, chunk);
				const result = await this.uploadChunk(uuid, index, parentUuid, uploadKey, encChunk);
				reportChunkProgress(onChunkProgress, ++chunksDone, chunkCount);
				return result;
			},
		);
		const bucket = chunkResults[0]?.bucket ?? "";
		const region = chunkResults[0]?.region ?? "";

		await this.post<UploadDoneResponse>("/v3/upload/done", {
			uuid,
			name: nameEnc,
			nameHashed,
			size: sizeEnc,
			chunks: chunkCount,
			mime: mimeEnc,
			rm: randomString(32),
			metadata: metadataEnc,
			version: FILE_ENCRYPTION_VERSION,
			uploadKey,
		});

		debugLog("transfer", `upload ${name} done (uuid ${uuid.slice(0, 8)}…, ${bucket}/${region})`);
		return { uuid, chunks: chunkCount, size, hash: plaintextHash, bucket, region, lastModified };
	}

	/**
	 * One encrypted chunk → ingest host. Query params + Checksum header of the
	 * JSON.stringify of the query params object (research §4).
	 */
	private async uploadChunk(
		uuid: string, index: number, parent: string, uploadKey: string, encChunk: Uint8Array,
	): Promise<UploadChunkResponse> {
		if (!this.credentials) throw new FilenApiError("not connected");
		const hash = await sha512Hex(encChunk);
		// Official SDK builds the query via URLSearchParams and re-parses it,
		// so the Checksum hashes ALL STRING values (index "0", not 0). It also
		// sends Authorization (buildHeaders falls back to the account apiKey) —
		// the ingest server rejects unauthenticated uploads with "Invalid API key".
		const queryParams = { uuid, index: String(index), parent, uploadKey, hash };
		const qs = `uuid=${encodeURIComponent(uuid)}&index=${index}`
			+ `&parent=${encodeURIComponent(parent)}&uploadKey=${encodeURIComponent(uploadKey)}&hash=${hash}`;
		const body = encChunk.buffer.slice(
			encChunk.byteOffset, encChunk.byteOffset + encChunk.byteLength,
		) as ArrayBuffer;
		const resp = await this.requestWithRetry({
			url: `${INGEST_HOST}/v3/upload?${qs}`,
			method: "POST",
			contentType: "application/octet-stream",
			body,
			headers: {
				"Content-Type": "application/octet-stream",
				"Accept": "application/json, text/plain, */*",
				"Authorization": `Bearer ${this.credentials.apiKey}`,
				"Checksum": await checksumOf(queryParams),
			},
			throw: false,
		});
		let envelope: FilenEnvelope<UploadChunkResponse>;
		try {
			envelope = (typeof resp.json === "object" && resp.json !== null)
				? resp.json as FilenEnvelope<UploadChunkResponse>
				: JSON.parse(resp.text) as FilenEnvelope<UploadChunkResponse>;
		} catch {
			throw new FilenApiError(`invalid JSON from ingest upload (HTTP ${resp.status})`);
		}
		if (!envelope.status || !envelope.data) {
			throw new FilenApiError(
				envelope.message ?? "chunk upload failed", envelope.code, resp.status,
			);
		}
		return envelope.data;
	}

	/** Download + decrypt all chunks, concat, verify SHA-512 (warn only).
	 * `onChunkProgress(done, total)` fires after each chunk completes —
	 * pool-safe, like uploadFile. */
	async downloadFile(
		location: RemoteFileLocation, fileKey: string, expectedHash?: string,
		onChunkProgress?: (done: number, total: number) => void,
	): Promise<{ data: ArrayBuffer; verified: boolean }> {
		// Index-addressed pool: parts[i] is always chunk i, whatever the
		// completion order; any chunk failure rejects the whole download.
		let chunksDone = 0;
		const parts = await mapPool(
			Array.from({ length: location.chunks }, (_, i) => i),
			CHUNK_CONCURRENCY,
			async index => {
				const enc = await this.downloadChunk(location.region, location.bucket, location.uuid, index);
				const part = await decryptChunk(fileKey, enc);
				reportChunkProgress(onChunkProgress, ++chunksDone, location.chunks);
				return part;
			},
		);
		let total = 0;
		for (const part of parts) total += part.byteLength;
		const out = new Uint8Array(total);
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.byteLength;
		}
		let verified = true;
		if (expectedHash && expectedHash.length > 0) {
			const actual = await sha512Hex(out);
			verified = actual === expectedHash; // warn only (per the design docs)
		}
		debugLog("transfer", `download uuid ${location.uuid.slice(0, 8)}… done: ${total} bytes, sha512 ${verified ? "ok" : "MISMATCH"}`);
		return { data: out.buffer, verified };
	}

	private async downloadChunk(region: string, bucket: string, uuid: string, index: number): Promise<Uint8Array> {
		const resp = await this.requestWithRetry({
			url: `${EGEST_HOST}/${region}/${bucket}/${uuid}/${index}`,
			method: "GET",
			throw: false,
		});
		if (resp.status !== 200) {
			throw new FilenApiError(`chunk download failed (HTTP ${resp.status})`, undefined, resp.status);
		}
		return new Uint8Array(resp.arrayBuffer);
	}
}
