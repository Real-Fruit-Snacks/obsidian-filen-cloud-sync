/**
 * Gated console debug logger, enabled by the "Debug log" setting.
 *
 * SECURITY RULES (hard):
 * - NEVER log secrets: no passwords, derived passwords, apiKey, masterKeys,
 *   DEK, file keys, uploadKeys, Authorization headers, or request bodies
 *   (bodies contain encrypted-but-sensitive material).
 * - HTTP logs are method + path + status + envelope code/message + duration.
 *   Query strings are stripped (they carry uploadKey/hash).
 * - Vault file paths ARE logged (the user opted into debug mode) — the
 *   setting description warns not to share logs publicly.
 *
 * Pure module: no imports from "obsidian" (safe for Node-side unit tests).
 */

let enabled = false;

export function setDebugLogging(value: boolean): void {
	enabled = value;
}

export function isDebugLogging(): boolean {
	return enabled;
}

/** Strip query string (carries uploadKey/hash on ingest URLs). */
export function safeUrl(url: string): string {
	const q = url.indexOf("?");
	return q === -1 ? url : url.slice(0, q);
}

export function debugLog(tag: string, message: string, data?: unknown): void {
	if (!enabled) return;
	const stamp = new Date().toISOString();
	// Single gated console call for the whole plugin (opt-in debug log only).
	console.log(`[filen-cloud-sync] ${stamp} [${tag}] ${message}`, ...(data !== undefined ? [data] : []));
}
