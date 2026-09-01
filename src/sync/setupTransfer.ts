/**
 * PURE setup-transfer URI primitives (the design docs v0.6.0 feature B). No obsidian
 * imports, no IO — fully unit-testable.
 *
 * A setup URI copies SETTINGS — never credentials — from one device to
 * another: `filen-cloud-sync://setup/<base64url(JSON)>` with body
 * `{v:1, email?, remoteFolder, prefs}` where prefs holds exactly the six
 * SharedPrefs keys. Passwords, API keys and master keys can never ride
 * along BY CONSTRUCTION: only the fields above are serialized.
 */

import { parseSharedPrefs, prefsFromSettings, SharedPrefs } from "./sharedPrefs";
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from "../util";

export const SETUP_URI_PREFIX = "filen-cloud-sync://setup/";
export const SETUP_URI_VERSION = 1;

/** Everything a setup URI carries. FilenSyncSettings satisfies this. */
export interface SetupTransferSource extends SharedPrefs {
	email: string;
	remoteFolder: string;
}

export interface ParsedSetupUri {
	version: number;
	/** Absent when the exporting device had no email configured. */
	email?: string;
	remoteFolder: string;
	prefs: SharedPrefs;
}

/** RFC 4648 base64url, padding stripped (URI-safe). */
function base64UrlEncode(text: string): string {
	return bytesToBase64(utf8ToBytes(text))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Strict base64url decode; null on any invalid character or bad UTF-8. */
function base64UrlDecode(text: string): string | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
	try {
		return bytesToUtf8(base64ToBytes(text.replace(/-/g, "+").replace(/_/g, "/")));
	} catch {
		return null;
	}
}

/** Build the setup URI for the current settings (secrets never included). */
export function buildSetupUri(settings: SetupTransferSource): string {
	const body: { v: number; email?: string; remoteFolder: string; prefs: SharedPrefs } = {
		v: SETUP_URI_VERSION,
		remoteFolder: settings.remoteFolder,
		prefs: prefsFromSettings(settings),
	};
	const email = settings.email.trim();
	if (email.length > 0) body.email = email;
	return SETUP_URI_PREFIX + base64UrlEncode(JSON.stringify(body));
}

/**
 * Parse + validate a setup URI. Returns null on ANY garbage: wrong prefix,
 * invalid base64url, bad JSON, wrong version, missing/mistyped fields.
 * Extra keys are tolerated but never carried over.
 */
export function parseSetupUri(uri: string): ParsedSetupUri | null {
	const trimmed = uri.trim();
	if (!trimmed.startsWith(SETUP_URI_PREFIX)) return null;
	const payload = base64UrlDecode(trimmed.slice(SETUP_URI_PREFIX.length));
	if (payload === null) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const body = raw as Record<string, unknown>;
	if (body.v !== SETUP_URI_VERSION) return null;
	if (typeof body.remoteFolder !== "string" || body.remoteFolder.trim().length === 0) return null;
	if (body.email !== undefined && typeof body.email !== "string") return null;
	const prefs = parseSharedPrefs(body.prefs);
	if (!prefs) return null;
	const parsed: ParsedSetupUri = {
		version: SETUP_URI_VERSION,
		remoteFolder: body.remoteFolder,
		prefs,
	};
	if (typeof body.email === "string" && body.email.trim().length > 0) {
		parsed.email = body.email.trim();
	}
	return parsed;
}
