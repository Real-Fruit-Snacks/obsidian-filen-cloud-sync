/**
 * v0.6.0 feature B (setup transfer URI): round-trip, garbage rejection,
 * only-allowed-keys and no-secrets-by-construction guarantees.
 */

import { describe, expect, it } from "vitest";
import {
	buildSetupUri,
	parseSetupUri,
	SETUP_URI_PREFIX,
	type SetupTransferSource,
} from "../src/sync/setupTransfer";
import { SHARED_PREF_KEYS } from "../src/sync/sharedPrefs";
import { base64ToBytes, bytesToUtf8, utf8ToBytes, bytesToBase64 } from "../src/util";

function makeSettings(overrides: Partial<SetupTransferSource> = {}): SetupTransferSource {
	return {
		email: "user@example.com",
		remoteFolder: "Obsidian/My Vault",
		conflictPolicy: "keep_both",
		conflictResolution: "ask",
		excludeDotFiles: false,
		ignorePatterns: "private/**\n*.tmp",
		ignoredFolders: ["archive", "misc/drafts"],
		configSyncAllowlist: ["appearance.json", "snippets"],
		...overrides,
	};
}

/** Decode the payload of a setup URI back to the raw JSON body. */
function decodeBody(uri: string): Record<string, unknown> {
	expect(uri.startsWith(SETUP_URI_PREFIX)).toBe(true);
	const payload = uri.slice(SETUP_URI_PREFIX.length);
	const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
	return JSON.parse(bytesToUtf8(base64ToBytes(b64))) as Record<string, unknown>;
}

function uriForBody(body: unknown): string {
	const b64 = bytesToBase64(utf8ToBytes(JSON.stringify(body)))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return SETUP_URI_PREFIX + b64;
}

describe("setup transfer URI", () => {
	it("round-trips all fields (email present)", () => {
		const settings = makeSettings();
		const parsed = parseSetupUri(buildSetupUri(settings));
		expect(parsed).not.toBeNull();
		expect(parsed?.version).toBe(1);
		expect(parsed?.email).toBe(settings.email);
		expect(parsed?.remoteFolder).toBe(settings.remoteFolder);
		expect(parsed?.prefs).toEqual({
			conflictPolicy: settings.conflictPolicy,
			conflictResolution: settings.conflictResolution,
			excludeDotFiles: settings.excludeDotFiles,
			ignorePatterns: settings.ignorePatterns,
			ignoredFolders: settings.ignoredFolders,
			configSyncAllowlist: settings.configSyncAllowlist,
		});
	});

	it("omits a blank email and round-trips without it", () => {
		const uri = buildSetupUri(makeSettings({ email: "  " }));
		expect(decodeBody(uri).email).toBeUndefined();
		const parsed = parseSetupUri(uri);
		expect(parsed?.email).toBeUndefined();
		expect(parsed?.remoteFolder).toBe("Obsidian/My Vault");
	});

	it("uses the URL-safe base64 alphabet and survives unicode folder names", () => {
		const uri = buildSetupUri(makeSettings({
			remoteFolder: "Obsidian/Tresor ünïcode/日本語",
			ignorePatterns: "a+b/c?d=e",
		}));
		const payload = uri.slice(SETUP_URI_PREFIX.length);
		expect(payload).toMatch(/^[A-Za-z0-9_-]+$/); // no +, /, = or escapes
		const parsed = parseSetupUri(uri);
		expect(parsed?.remoteFolder).toBe("Obsidian/Tresor ünïcode/日本語");
		expect(parsed?.prefs.ignorePatterns).toBe("a+b/c?d=e");
	});

	it("tolerates surrounding whitespace when parsing", () => {
		const uri = buildSetupUri(makeSettings());
		expect(parseSetupUri(`  ${uri}\n`)).not.toBeNull();
	});

	it("rejects garbage, wrong prefix and truncated payloads", () => {
		expect(parseSetupUri("")).toBeNull();
		expect(parseSetupUri("hello world")).toBeNull();
		expect(parseSetupUri("https://example.com/setup/abc")).toBeNull();
		expect(parseSetupUri("filen-sync://other/abc")).toBeNull();
		expect(parseSetupUri("filen-sync://setup/")).toBeNull();
		expect(parseSetupUri("filen-sync://setup/!!!not-base64!!!")).toBeNull();
		expect(parseSetupUri("filen-sync://setup/a=b")).toBeNull(); // padding/invalid chars
		// Valid base64url, but not JSON.
		expect(parseSetupUri(uriForBody("just a string".slice(0)))).toBeNull();
		const notJson = SETUP_URI_PREFIX + "bm90LWpzb24"; // "not-json"
		expect(parseSetupUri(notJson)).toBeNull();
	});

	it("rejects the wrong version and malformed shapes", () => {
		const good = makeSettings();
		const base = {
			v: 1,
			email: good.email,
			remoteFolder: good.remoteFolder,
			prefs: {
				conflictPolicy: "keep_both",
				conflictResolution: "auto",
				excludeDotFiles: true,
				ignorePatterns: "",
				ignoredFolders: [],
				configSyncAllowlist: [],
			},
		};
		expect(parseSetupUri(uriForBody({ ...base, v: 2 }))).toBeNull();
		expect(parseSetupUri(uriForBody({ ...base, v: "1" }))).toBeNull();
		expect(parseSetupUri(uriForBody({ ...base, remoteFolder: "" }))).toBeNull();
		expect(parseSetupUri(uriForBody({ ...base, remoteFolder: 42 }))).toBeNull();
		expect(parseSetupUri(uriForBody({ ...base, email: 42 }))).toBeNull();
		expect(parseSetupUri(uriForBody({ ...base, prefs: null }))).toBeNull();
		expect(parseSetupUri(uriForBody({ ...base, prefs: { conflictPolicy: "keep_both" } }))).toBeNull();
		expect(parseSetupUri(uriForBody({ ...base, prefs: { ...base.prefs, conflictPolicy: "wipe" } }))).toBeNull();
		expect(parseSetupUri(uriForBody([1, 2, 3]))).toBeNull();
		// Sanity: the unmodified body parses fine.
		expect(parseSetupUri(uriForBody(base))).not.toBeNull();
	});

	it("carries ONLY the allowed keys — extras are dropped, never applied", () => {
		const parsed = parseSetupUri(buildSetupUri(makeSettings()));
		expect(Object.keys(parsed?.prefs ?? {}).sort()).toEqual([...SHARED_PREF_KEYS].sort());
		// Extra keys smuggled into the body or prefs are tolerated but dropped.
		const smuggled = decodeBody(buildSetupUri(makeSettings()));
		smuggled.apiKey = "secret-api-key";
		(smuggled.prefs as Record<string, unknown>).password = "hunter2";
		const reparsed = parseSetupUri(uriForBody(smuggled));
		expect(reparsed).not.toBeNull();
		expect(Object.keys(reparsed ?? {})).not.toContain("apiKey");
		expect(Object.keys(reparsed?.prefs ?? {})).not.toContain("password");
		expect(Object.keys(reparsed?.prefs ?? {}).sort()).toEqual([...SHARED_PREF_KEYS].sort());
	});

	it("never includes secrets in the URI string, by construction", () => {
		// A settings object polluted with secret-looking fields: the builder
		// reads ONLY email/remoteFolder/the six prefs keys.
		const polluted = {
			...makeSettings(),
			password: "hunter2",
			apiKey: "secret-api-key",
			masterKeys: ["master-key-material"],
			twoFactorSecret: "JBSWY3DPEHPK3PXP",
		} as SetupTransferSource & Record<string, unknown>;
		const uri = buildSetupUri(polluted);
		for (const secret of ["hunter2", "secret-api-key", "master-key-material", "JBSWY3DPEHPK3PXP"]) {
			expect(uri).not.toContain(secret);
		}
		// The decoded body contains exactly v, email, remoteFolder, prefs.
		expect(Object.keys(decodeBody(uri)).sort()).toEqual(["email", "prefs", "remoteFolder", "v"]);
	});
});
