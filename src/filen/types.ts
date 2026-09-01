/**
 * Filen API request/response types (see the Filen API (verified against @filen/sdk) §2/§4).
 * Pure types + interfaces only; no runtime dependencies.
 */

/** Envelope wrapping every gateway response. */
export interface FilenEnvelope<T> {
	status: boolean;
	data?: T;
	code?: string;
	message?: string;
}

export interface AuthInfoResponse {
	email: string;
	authVersion: number;
	salt: string;
	id: string;
}

export interface LoginResponse {
	apiKey: string;
	masterKeys: string | null;
	publicKey: string | null;
	privateKey: string | null;
	dek?: string | null;
}

export interface MasterKeysResponse {
	keys: string;
}

export interface DekResponse {
	dek: string;
}

export interface BaseFolderResponse {
	uuid: string;
}

/** GET /v3/user/account (v0.4.0 self-test + quota display). */
export interface UserAccountResponse {
	email: string;
	storage: number; // bytes used
	maxStorage: number; // quota in bytes
	isPremium?: boolean;
}

/**
 * /v3/user/events entry (v0.4.0 feature D). Only the COUNT and the max
 * timestamp are ever used — event payloads stay encrypted/undecrypted.
 */
export interface UserEvent {
	id: number | string;
	type: string;
	/** Event time; the API uses seconds in some fields, ms in others — the
	 * caller normalizes to ms before comparing. */
	timestamp: number;
	info?: unknown;
}

export interface UserEventsResponse {
	events: UserEvent[];
}

export interface KeyPairInfoResponse {
	publicKey: string;
	privateKey: string;
}

/** /v3/dir/tree file tuple, positional (order confirmed in research doc). */
export type DirTreeFileTuple = [
	uuid: string,
	bucket: string,
	region: string,
	chunks: number,
	parent: string,
	metadataEnc: string,
	version: number,
	timestamp: number,
];

/** /v3/dir/tree folder tuple. Root folder has parent "base". */
export type DirTreeFolderTuple = [
	uuid: string,
	nameEnc: string,
	parent: string, // uuid | "base"
];

export interface DirTreeResponse {
	files: DirTreeFileTuple[];
	folders: DirTreeFolderTuple[];
}

export interface DirCreateResponse {
	uuid: string;
}

export interface UploadChunkResponse {
	bucket: string;
	region: string;
}

export interface UploadDoneResponse {
	chunks: number;
	size: number;
}

export interface FileVersionsResponse {
	versions: Array<{
		uuid: string;
		bucket: string;
		region: string;
		chunks: number;
		metadata: string;
		rm: string;
		timestamp: number;
		version: number;
	}>;
}

/** Decrypted contents of a file's metadata JSON (master-key encrypted). */
export interface FileMetadata {
	name: string;
	size: number;
	mime: string;
	key: string;
	lastModified: number;
	creation?: number;
	hash?: string;
}

/** Decrypted contents of a folder's metadata JSON. */
export interface FolderMetadata {
	name: string;
}

/** Credentials persisted per device. Password is NEVER stored. */
export interface StoredCredentials {
	apiKey: string;
	masterKeys: string[];
	authVersion: number;
	rootUuid: string;
	/** Resolved vault-sync root folder uuid (settings.remoteFolder chain). */
	syncRootUuid: string;
	email: string;
	/** v3 only: hex HMAC key derived from private key for name hashing. */
	hmacKey?: string;
}

/** Thin HTTP interface isolating obsidian's requestUrl (mockable in tests). */
export interface HttpRequest {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
}

export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;
