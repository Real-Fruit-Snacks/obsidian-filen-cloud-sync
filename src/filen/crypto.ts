/**
 * Filen client-side crypto — byte-exact reimplementation per
 * the Filen API (verified against @filen/sdk) §2/§3. WebCrypto + @noble/hashes (argon2) only.
 * MUST NOT import from 'obsidian' or Node builtins (vitest runs this in Node).
 */

import { argon2id } from "@noble/hashes/argon2.js";
import {
	base64ToBytes,
	bytesToBase64,
	bytesToHex,
	bytesToUtf8,
	FILEN_KEY_CHARSET,
	hexToBytes,
	randomBytes,
	randomString,
	utf8ToBytes,
} from "../util";

export const METADATA_VERSION_002 = "002";
export const METADATA_VERSION_003 = "003";
export const CHUNK_SIZE = 1024 * 1024; // 1 MiB exactly
export const FILE_ENCRYPTION_VERSION = 2;

export class FilenCryptoError extends Error {}

/* ---------------- basic hashes ---------------- */

export async function sha512Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
	const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
	const digest = await crypto.subtle.digest("SHA-512", buf as BufferSource);
	return bytesToHex(new Uint8Array(digest));
}

export async function sha1Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
	const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
	const digest = await crypto.subtle.digest("SHA-1", buf as BufferSource);
	return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(keyBytes: Uint8Array, data: Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
	return bytesToHex(new Uint8Array(sig));
}

export async function hkdfSha256(
	ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
		key, length * 8,
	);
	return new Uint8Array(bits);
}

export async function pbkdf2Sha512(
	password: Uint8Array, salt: Uint8Array, iterations: number, dkLen: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", password as BufferSource, "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-512", salt: salt as BufferSource, iterations },
		key, dkLen * 8,
	);
	return new Uint8Array(bits);
}

/* ---------------- auth derivation (research §2 step 2) ---------------- */

export interface DerivedAuth {
	masterKey: string;
	password: string;
}

/** authVersion 2: PBKDF2-SHA512(pw, utf8(salt), 200000, 64B) hex, split halves. */
export async function deriveAuthV2(password: string, salt: string): Promise<DerivedAuth> {
	const dk = await pbkdf2Sha512(utf8ToBytes(password), utf8ToBytes(salt), 200000, 64);
	const dkHex = bytesToHex(dk);
	const masterKey = dkHex.slice(0, 64);
	const derivedPassword = await sha512Hex(utf8ToBytes(dkHex.slice(64, 128)));
	return { masterKey, password: derivedPassword };
}

/** authVersion 3: Argon2id(pw, hexBytes(salt), t=3, m=65536KiB, p=4, 64B) hex. */
export function deriveAuthV3(password: string, saltHex: string): DerivedAuth {
	const dk = argon2id(utf8ToBytes(password), hexToBytes(saltHex), {
		t: 3,
		m: 65536,
		p: 4,
		version: 0x13,
		dkLen: 64,
	});
	const dkHex = bytesToHex(dk);
	return { masterKey: dkHex.slice(0, 64), password: dkHex.slice(64, 128) };
}

/* ---------------- metadata encryption (research §3a) ---------------- */

function isHexKey64(key: string): boolean {
	return /^[0-9a-fA-F]{64}$/.test(key);
}

/** "002" key material: PBKDF2-SHA512(password=key, salt=key, 1 iter, 32 raw bytes). */
async function deriveMetaKey002(key: string): Promise<Uint8Array> {
	return pbkdf2Sha512(utf8ToBytes(key), utf8ToBytes(key), 1, 32);
}

/**
 * Key material for the given ENVELOPE version — never sniffed from the key
 * format (official SDK rule, verified against @filen/sdk dist):
 * "002" → PBKDF2 derivation REGARDLESS of key format (authVersion-2 master
 * keys are themselves 64-hex and still go through PBKDF2);
 * "003" → raw bytes of a 64-hex key.
 */
async function metaKeyMaterialForVersion(
	version: string, key: string,
): Promise<Uint8Array> {
	if (version === METADATA_VERSION_002) return deriveMetaKey002(key);
	// "003": only a 64-hex key can possibly decrypt; anything else fails GCM.
	if (!isHexKey64(key)) throw new FilenCryptoError("v3 metadata requires a 64-hex key");
	return hexToBytes(key);
}

async function importAesGcmKey(keyBytes: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * encMeta with an EXPLICIT metadata version (2 → "002", 3 → "003"), sourced
 * from the account's authVersion by callers. Mirroring the official SDK:
 * version 3 requires a 64-hex key — with any other key it downgrades to
 * "002" (e.g. per-file keys are 32-char strings even on v3 accounts).
 * "002" + 12 random A-Za-z0-9-_ iv chars + b64(ct‖tag);
 * "003" + hex(12 random iv bytes) + b64(ct‖tag).
 * WebCrypto appends the 16-byte GCM tag automatically.
 */
export async function encMeta(plain: string, key: string, version: 2 | 3): Promise<string> {
	let effective = version;
	if (effective === 3 && !isHexKey64(key)) effective = 2;
	const bytes = await metaKeyMaterialForVersion(
		effective === 3 ? METADATA_VERSION_003 : METADATA_VERSION_002, key,
	);
	const aesKey = await importAesGcmKey(bytes);
	if (effective === 3) {
		const iv = randomBytes(12);
		const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, utf8ToBytes(plain) as BufferSource);
		return METADATA_VERSION_003 + bytesToHex(iv) + bytesToBase64(new Uint8Array(ct));
	}
	const iv = randomString(12, FILEN_KEY_CHARSET);
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: utf8ToBytes(iv) as BufferSource }, aesKey, utf8ToBytes(plain) as BufferSource,
	);
	return METADATA_VERSION_002 + iv + bytesToBase64(new Uint8Array(ct));
}

/**
 * decMeta: key derivation is driven by the ENVELOPE PREFIX ONLY (never by
 * the key format): "002" → PBKDF2(key,key,1,32) for every key, "003" → raw
 * bytes of 64-hex keys. Try keys END→START until GCM verify succeeds.
 * Legacy "001"/OpenSSL ("U2FsdGVk") metadata → throw migration error.
 */
export async function decMeta(encrypted: string, keys: string[]): Promise<string> {
	if (encrypted.startsWith("U2FsdGVk") || encrypted.startsWith("001")) {
		throw new FilenCryptoError(
			"legacy file — open once in official Filen app to migrate",
		);
	}
	const version = encrypted.slice(0, 3);
	let iv: Uint8Array;
	let ct: Uint8Array;
	if (version === METADATA_VERSION_002) {
		iv = utf8ToBytes(encrypted.slice(3, 15));
		ct = base64ToBytes(encrypted.slice(15));
	} else if (version === METADATA_VERSION_003) {
		iv = hexToBytes(encrypted.slice(3, 27));
		ct = base64ToBytes(encrypted.slice(27));
	} else {
		throw new FilenCryptoError(`unknown metadata version: ${version}`);
	}

	let lastError: unknown = null;
	for (let i = keys.length - 1; i >= 0; i--) {
		const key = keys[i] as string;
		try {
			const bytes = await metaKeyMaterialForVersion(version, key);
			const aesKey = await crypto.subtle.importKey(
				"raw", bytes as BufferSource, { name: "AES-GCM" }, false, ["decrypt"],
			);
			const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, ct as BufferSource);
			return bytesToUtf8(new Uint8Array(plain));
		} catch (e) {
			lastError = e;
		}
	}
	void lastError;
	throw new FilenCryptoError(
		`could not decrypt metadata with any of ${keys.length} key(s)`,
	);
}

/* ---------------- name hashing (research §3c) ---------------- */

/** v2 nameHashed: sha1hex(sha512hex(lowercase(name))). */
export async function nameHashV2(name: string): Promise<string> {
	const inner = await sha512Hex(utf8ToBytes(name.toLowerCase()));
	return sha1Hex(utf8ToBytes(inner));
}

/** v3 nameHashed: HMAC-SHA256hex(hmacKey, lowercase(name)). Untested against live accounts. */
export async function nameHashV3(name: string, hmacKeyHex: string): Promise<string> {
	return hmacSha256Hex(hexToBytes(hmacKeyHex), utf8ToBytes(name.toLowerCase()));
}

/** v3 HMAC key: HKDF-SHA256(ikm=base64decode(privateKey), salt=∅, info="hmac-sha256-key", 32B). */
export async function deriveHmacKey(privateKeyBase64: string): Promise<string> {
	const ikm = base64ToBytes(privateKeyBase64);
	const out = await hkdfSha256(ikm, new Uint8Array(0), utf8ToBytes("hmac-sha256-key"), 32);
	return bytesToHex(out);
}

/* ---------------- file chunk encryption (research §3b) ---------------- */

/** New per-file key: 32 random chars from A-Za-z0-9-_ (utf8 = AES-256 key). */
export function generateFileKey(): string {
	return randomString(32, FILEN_KEY_CHARSET);
}

export function generateUploadKey(): string {
	return randomString(32, FILEN_KEY_CHARSET);
}

/**
 * Encrypt one chunk: wire bytes = iv(12 random A-Za-z0-9-_ chars) ‖ ct ‖ tag(16).
 */
export async function encryptChunk(fileKey: string, chunk: Uint8Array): Promise<Uint8Array> {
	const keyBytes = utf8ToBytes(fileKey);
	if (keyBytes.length !== 32) throw new FilenCryptoError("file key must be 32 chars");
	const aesKey = await importAesGcmKey(keyBytes);
	const iv = utf8ToBytes(randomString(12, FILEN_KEY_CHARSET));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, chunk as BufferSource);
	const out = new Uint8Array(12 + ct.byteLength);
	out.set(iv, 0);
	out.set(new Uint8Array(ct), 12);
	return out;
}

/** Decrypt one chunk: iv = bytes[0:12], ct‖tag = rest. */
export async function decryptChunk(fileKey: string, data: Uint8Array): Promise<Uint8Array> {
	const keyBytes = utf8ToBytes(fileKey);
	if (keyBytes.length !== 32) throw new FilenCryptoError("file key must be 32 chars");
	if (data.length < 12 + 16) throw new FilenCryptoError("chunk too short");
	const aesKey = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
	const iv = data.subarray(0, 12);
	const ct = data.subarray(12);
	try {
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, ct as BufferSource);
		return new Uint8Array(plain);
	} catch {
		throw new FilenCryptoError("chunk decryption failed (wrong key or corrupt data)");
	}
}

/* ---------------- checksum header ---------------- */

/** Checksum header: SHA-512 hex of JSON.stringify(body). */
export async function checksumOf(body: unknown): Promise<string> {
	return sha512Hex(utf8ToBytes(JSON.stringify(body)));
}
