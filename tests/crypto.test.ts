/**
 * Crypto tests (the design docs/§6.2). node:crypto is used ONLY as an independent
 * test oracle — it never appears in shipped runtime code.
 */

import { createHash, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CHUNK_SIZE,
	decMeta,
	decryptChunk,
	deriveAuthV2,
	deriveAuthV3,
	encMeta,
	encryptChunk,
	generateFileKey,
	nameHashV2,
	sha512Hex,
} from "../src/filen/crypto";
import { base64ToBytes, utf8ToBytes } from "../src/util";

const SHA512_EMPTY =
	"cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce"
	+ "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e";
const SHA512_ABC =
	"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2"
	+ "192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";

describe("sha512Hex", () => {
	it("matches known vectors", async () => {
		expect(await sha512Hex(new Uint8Array(0))).toBe(SHA512_EMPTY);
		expect(await sha512Hex(utf8ToBytes("abc"))).toBe(SHA512_ABC);
	});
});

describe("encMeta/decMeta", () => {
	it("round-trips with a non-hex key (002 format)", async () => {
		const key = "some-arbitrary-master-key-not-hex";
		const enc = await encMeta("hello filen", key, 2);
		expect(enc.startsWith("002")).toBe(true);
		// 12-char IV sits at chars 3..15
		expect(enc.length).toBeGreaterThan(15);
		expect(await decMeta(enc, [key])).toBe("hello filen");
	});

	it("round-trips with a 64-hex key (003 format)", async () => {
		const key = "a".repeat(64);
		const enc = await encMeta(JSON.stringify({ name: "note.md", size: 42 }), key, 3);
		expect(enc.startsWith("003")).toBe(true);
		// IV is 24 hex chars at 3..27
		expect(/^[0-9a-f]{24}$/.test(enc.slice(3, 27))).toBe(true);
		expect(await decMeta(enc, [key])).toBe(JSON.stringify({ name: "note.md", size: 42 }));
	});

	it("version 2 with a 64-hex key still produces \"002\" (PBKDF2-derived)", async () => {
		// authVersion-2 master keys are themselves 64-hex — the envelope must
		// be chosen by the VERSION, never by sniffing the key format.
		const key = "a".repeat(64);
		const enc = await encMeta("hello 002-hex-key", key, 2);
		expect(enc.startsWith("002")).toBe(true);
		expect(await decMeta(enc, [key])).toBe("hello 002-hex-key");
	});

	it("version 3 with a non-64-hex key downgrades to \"002\" (SDK rule)", async () => {
		const key = "thirty-two-char-file-key-xxxxxxx";
		const enc = await encMeta("file name.md", key, 3);
		expect(enc.startsWith("002")).toBe(true);
		expect(await decMeta(enc, [key])).toBe("file name.md");
	});

	it("decrypts a \"002\" ciphertext made with a 64-hex key (cross-implementation fixture)", async () => {
		// Generated ONCE with the CORRECT (official SDK) algorithm:
		// PBKDF2-SHA512(key, key, 1, 32B) + AES-256-GCM, iv "Ab3dEf7hIjKl".
		// Key-format sniffing (raw hex bytes for 64-hex keys) cannot decrypt
		// this — it is exactly what official clients produce for
		// authVersion-2 accounts, whose master keys are 64-hex.
		const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		const fixture =
			"002Ab3dEf7hIjKlnCIKV66MBjA6sECK35waecgXsThaLMb1xy/MozeiHJrJv4DDHOXG3nhs0emHpb7P4ZpDMyFe";
		// oracle: fixture really was produced via PBKDF2 derivation
		const derived = pbkdf2Sync(key, key, 1, 32, "sha512");
		const subtleKey = await crypto.subtle.importKey("raw", derived, { name: "AES-GCM" }, false, ["decrypt"]);
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: utf8ToBytes("Ab3dEf7hIjKl") },
			subtleKey, base64ToBytes(fixture.slice(15)),
		);
		const expected = new TextDecoder().decode(plain);
		expect(expected).toBe("{\"name\":\"fixture note.md\",\"size\":1234}");
		// the actual assertion: decMeta must reproduce the plaintext
		expect(await decMeta(fixture, [key])).toBe(expected);
	});

	it("tries keys END→START", async () => {
		const k1 = "b".repeat(64);
		const k2 = "c".repeat(64);
		const enc = await encMeta("secret", k1, 3);
		// k1 is at the START; decMeta must still find it (tries from the end)
		expect(await decMeta(enc, [k1, k2])).toBe("secret");
		const enc2 = await encMeta("secret2", k2, 3);
		expect(await decMeta(enc2, [k1, k2])).toBe("secret2");
	});

	it("fails with a wrong key", async () => {
		const enc = await encMeta("secret", "d".repeat(64), 3);
		await expect(decMeta(enc, ["e".repeat(64)])).rejects.toThrow(/could not decrypt/);
	});

	it("throws on legacy OpenSSL metadata", async () => {
		await expect(decMeta("U2FsdGVkX1+abc", ["f".repeat(64)])).rejects.toThrow(/legacy file/);
	});

	it("is decryptable by an independent WebCrypto implementation (002 wire format)", async () => {
		const key = "non-hex-key-for-interop-check";
		const plaintext = "interop 002 ✓";
		const enc = await encMeta(plaintext, key, 2);
		// Independently re-derive and decrypt
		const keyMat = pbkdf2Sync(key, key, 1, 32, "sha512");
		const iv = utf8ToBytes(enc.slice(3, 15));
		const ct = base64ToBytes(enc.slice(15));
		const subtleKey = await crypto.subtle.importKey("raw", keyMat, { name: "AES-GCM" }, false, ["decrypt"]);
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, subtleKey, ct);
		expect(new TextDecoder().decode(plain)).toBe(plaintext);
	});
});

describe("chunk encryption", () => {
	it("round-trips a 0-byte chunk", async () => {
		const fileKey = generateFileKey();
		const enc = await encryptChunk(fileKey, new Uint8Array(0));
		expect(enc.length).toBe(12 + 16); // iv + tag only
		const dec = await decryptChunk(fileKey, enc);
		expect(dec.length).toBe(0);
	});

	it("round-trips multi-chunk payloads (2.5 MiB)", { timeout: 30000 }, async () => {
		const fileKey = generateFileKey();
		const size = Math.floor(CHUNK_SIZE * 2.5);
		const data = new Uint8Array(size);
		for (let i = 0; i < size; i++) data[i] = i % 251;
		const chunks: Uint8Array[] = [];
		for (let off = 0; off < size; off += CHUNK_SIZE) {
			chunks.push(data.subarray(off, Math.min(off + CHUNK_SIZE, size)));
		}
		expect(chunks.length).toBe(3);
		const decrypted: Uint8Array[] = [];
		for (const chunk of chunks) {
			const enc = await encryptChunk(fileKey, chunk);
			expect(enc.length).toBe(chunk.length + 28); // 12 iv + 16 tag overhead
			decrypted.push(await decryptChunk(fileKey, enc));
		}
		const out = new Uint8Array(size);
		let off = 0;
		for (const part of decrypted) {
			out.set(part, off);
			off += part.length;
		}
		expect(Buffer.from(out).equals(Buffer.from(data))).toBe(true);
	});

	it("fails with a wrong key", async () => {
		const enc = await encryptChunk(generateFileKey(), utf8ToBytes("payload"));
		await expect(decryptChunk(generateFileKey(), enc)).rejects.toThrow(/decryption failed/);
	});

	it("each chunk uses a fresh IV (same plaintext → different ciphertext)", async () => {
		const fileKey = generateFileKey();
		const chunk = utf8ToBytes("repeat me");
		const a = await encryptChunk(fileKey, chunk);
		const b = await encryptChunk(fileKey, chunk);
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});
});

describe("nameHashV2", () => {
	it("matches the research-doc algorithm via node:crypto oracle", async () => {
		const names = ["note.md", "Note.MD", "Réunion café.md", "a/b/c.png"];
		for (const name of names) {
			const inner = createHash("sha512").update(name.toLowerCase(), "utf8").digest("hex");
			const expected = createHash("sha1").update(inner, "utf8").digest("hex");
			expect(await nameHashV2(name)).toBe(expected);
		}
	});

	it("is case-insensitive", async () => {
		expect(await nameHashV2("Note.MD")).toBe(await nameHashV2("note.md"));
	});
});

describe("auth derivation", () => {
	it("v2: PBKDF2-SHA512 split halves match independent oracle", async () => {
		const password = "correct horse battery staple";
		const salt = "0123456789abcdef";
		const derived = await deriveAuthV2(password, salt);
		const dkHex = pbkdf2Sync(password, salt, 200000, 64, "sha512").toString("hex");
		expect(derived.masterKey).toBe(dkHex.slice(0, 64));
		const expectedPassword = createHash("sha512")
			.update(dkHex.slice(64, 128), "utf8")
			.digest("hex");
		expect(derived.password).toBe(expectedPassword);
	});

	it("v3: Argon2id produces a 64-byte key split in halves (smoke)", () => {
		const saltHex = "ab".repeat(128); // v3 salts are 256 hex chars
		const derived = deriveAuthV3("hunter2", saltHex);
		expect(derived.masterKey).toMatch(/^[0-9a-f]{64}$/);
		expect(derived.password).toMatch(/^[0-9a-f]{64}$/);
		// deterministic
		expect(deriveAuthV3("hunter2", saltHex).masterKey).toBe(derived.masterKey);
		// different password → different key
		expect(deriveAuthV3("hunter3", saltHex).masterKey).not.toBe(derived.masterKey);
	});
});
