/**
 * Pure utility helpers: encoding, paths, ignore matching, time, randomness.
 * MUST NOT import from 'obsidian' or any Node builtin so that crypto.ts and
 * planner.ts (and this file) can be unit-tested in plain Node with vitest.
 */

// Type-only import: erased at compile time, so the Node-purity rule holds.
import type { ButtonComponent } from "obsidian";

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export function utf8ToBytes(s: string): Uint8Array {
	return textEncoder.encode(s);
}

export function bytesToUtf8(b: Uint8Array): string {
	return textDecoder.decode(b);
}

/**
 * Strict UTF-8 decode: returns null when the bytes are NOT valid UTF-8
 * (binary detection for the conflict-merge view — binaries fall back to the
 * auto conflict policy silently).
 */
export function tryDecodeUtf8(data: ArrayBuffer): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		return null;
	}
}

/* ---------------- hex ---------------- */

const HEX_CHARS = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i] as number;
		out += HEX_CHARS[b >>> 4] as string;
		out += HEX_CHARS[b & 0x0f] as string;
	}
	return out;
}

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.length % 2 === 0 ? hex : "0" + hex;
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
	}
	return out;
}

export function arrayBufferToHexPure(buf: ArrayBuffer): string {
	return bytesToHex(new Uint8Array(buf));
}

/* ---------------- base64 ---------------- */

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
	let out = "";
	const len = bytes.length;
	let i = 0;
	for (; i + 2 < len; i += 3) {
		const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
		out += (B64_ALPHABET[(n >>> 18) & 63] as string)
			+ (B64_ALPHABET[(n >>> 12) & 63] as string)
			+ (B64_ALPHABET[(n >>> 6) & 63] as string)
			+ (B64_ALPHABET[n & 63] as string);
	}
	const rem = len - i;
	if (rem === 1) {
		const n = (bytes[i] as number) << 16;
		out += (B64_ALPHABET[(n >>> 18) & 63] as string)
			+ (B64_ALPHABET[(n >>> 12) & 63] as string)
			+ "==";
	} else if (rem === 2) {
		const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
		out += (B64_ALPHABET[(n >>> 18) & 63] as string)
			+ (B64_ALPHABET[(n >>> 12) & 63] as string)
			+ (B64_ALPHABET[(n >>> 6) & 63] as string)
			+ "=";
	}
	return out;
}

const B64_LOOKUP: Record<string, number> = (() => {
	const map: Record<string, number> = {};
	for (let i = 0; i < B64_ALPHABET.length; i++) map[B64_ALPHABET[i] as string] = i;
	return map;
})();

export function base64ToBytes(b64: string): Uint8Array {
	let clean = "";
	for (const ch of b64) {
		if (ch === "=" || ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue;
		clean += ch;
	}
	const outLen = Math.floor((clean.length * 3) / 4);
	const out = new Uint8Array(outLen);
	let acc = 0;
	let accBits = 0;
	let idx = 0;
	for (const ch of clean) {
		const v = B64_LOOKUP[ch];
		if (v === undefined) throw new Error("invalid base64 character");
		acc = (acc << 6) | v;
		accBits += 6;
		if (accBits >= 8) {
			accBits -= 8;
			out[idx++] = (acc >>> accBits) & 0xff;
		}
	}
	return out.subarray(0, idx);
}

export function arrayBufferToBase64Pure(buf: ArrayBuffer): string {
	return bytesToBase64(new Uint8Array(buf));
}

/* ---------------- randomness ---------------- */

export const FILEN_KEY_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function randomBytes(len: number): Uint8Array {
	const out = new Uint8Array(len);
	crypto.getRandomValues(out);
	return out;
}

export function randomString(len: number, charset: string = FILEN_KEY_CHARSET): string {
	const rnd = randomBytes(len);
	let out = "";
	for (let i = 0; i < len; i++) {
		out += charset[(rnd[i] as number) % charset.length] as string;
	}
	return out;
}

export function uuidv4(): string {
	const b = randomBytes(16);
	b[6] = ((b[6] as number) & 0x0f) | 0x40;
	b[8] = ((b[8] as number) & 0x3f) | 0x80;
	const h = bytesToHex(b);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ---------------- paths ---------------- */

/** NFC + slash collapsing, mirroring obsidian's normalizePath (pure version). */
export function normalizeVaultPath(path: string): string {
	let out = path.replace(/\u00A0/g, " ");
	out = out.replace(/\\/g, "/");
	out = out.replace(/\/{2,}/g, "/");
	out = out.replace(/^\/+|\/+$/g, "");
	return out.normalize("NFC");
}

export function nfc(s: string): string {
	return s.normalize("NFC");
}

/**
 * True when `path` is the vault config dir itself or lives beneath it
 * (NFC-normalized on both sides). Config paths are invisible to the Vault
 * API — every read/write/delete for them must go through vault.adapter.
 */
export function isConfigPath(path: string, configDir: string | undefined): boolean {
	if (!configDir) return false;
	const cfg = normalizeVaultPath(configDir);
	if (cfg.length === 0) return false;
	const normalized = normalizeVaultPath(path);
	return normalized === cfg || normalized.startsWith(cfg + "/");
}

/**
 * HARD exclusion (v0.4.0 feature A): workspace.json and every workspace*
 * file (workspace-mobile.json, workspace.json.bak, …) is NEVER synced —
 * guard enforced in code even when the user allowlists them.
 */
export function isWorkspaceFileName(name: string): boolean {
	return name.toLowerCase().startsWith("workspace");
}

export function parentPathOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

export function baseNameOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

/** Split "dir/name.ext" into stem+ext for conflict renaming. */
export function splitExtension(name: string): { stem: string; ext: string } {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return { stem: name, ext: "" };
	return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

export function joinPath(...parts: string[]): string {
	return normalizeVaultPath(parts.filter(p => p.length > 0).join("/"));
}

/** All parent chains of a path, shallowest first ("" excluded). */
export function parentChains(path: string): string[] {
	const parts = normalizeVaultPath(path).split("/");
	const out: string[] = [];
	let cur = "";
	for (let i = 0; i < parts.length - 1; i++) {
		cur = cur.length === 0 ? (parts[i] as string) : cur + "/" + (parts[i] as string);
		out.push(cur);
	}
	return out;
}

export function wholeSeconds(millis: number): number {
	return Math.floor(millis / 1000);
}

/** Deterministic conflict suffix timestamp. UTC so every device converges. */
export function formatConflictTimestamp(millis: number): string {
	const d = new Date(millis);
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

/** Build "name (conflict YYYY-MM-DD HHmm).ext" from a full path. */
export function conflictPathFor(path: string, loserMtimeMillis: number): string {
	const parent = parentPathOf(path);
	const base = baseNameOf(path);
	const { stem, ext } = splitExtension(base);
	const renamed = `${stem} (conflict ${formatConflictTimestamp(loserMtimeMillis)})${ext}`;
	return parent.length === 0 ? renamed : parent + "/" + renamed;
}

export function isConflictCopyName(path: string): boolean {
	return baseNameOf(path).includes(" (conflict ");
}

/* ---------------- reserved names ---------------- */

const RESERVED_FILE_NAMES = new Set([
	".ds_store", "thumbs.db", "desktop.ini",
]);

const WINDOWS_DEVICE_NAMES = new Set([
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export function isReservedName(name: string): boolean {
	const lower = name.toLowerCase();
	if (RESERVED_FILE_NAMES.has(lower)) return true;
	const { stem } = splitExtension(lower);
	return WINDOWS_DEVICE_NAMES.has(stem);
}

/* ---------------- ignore matching (gitignore-lite) ---------------- */

interface IgnoreRule {
	regex: RegExp;
	negated: boolean;
	dirOnly: boolean;
}

function globToRegExpSource(glob: string): string {
	let out = "";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i] as string;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// "**" crosses directory boundaries; "**/" also matches zero dirs
				if (glob[i + 2] === "/") {
					out += "(?:[^/]+/)*";
					i += 3;
				} else {
					out += ".*";
					i += 2;
				}
			} else {
				out += "[^/]*";
				i += 1;
			}
		} else if (ch === "?") {
			out += "[^/]";
			i += 1;
		} else if ("\\^$.|+()[]{}".includes(ch)) {
			out += "\\" + ch;
			i += 1;
		} else {
			out += ch;
			i += 1;
		}
	}
	return out;
}

/**
 * Parse gitignore-lite pattern lines into rules.
 * Supported: comments (#), negation (!), dir-only (trailing /), anchoring
 * (leading / or any interior /), *, ?, **. Later rules override earlier ones.
 */
export function parseIgnorePatterns(text: string): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const rawLine of text.split("\n")) {
		let line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		let negated = false;
		if (line.startsWith("!")) {
			negated = true;
			line = line.slice(1).trim();
			if (line.length === 0) continue;
		}
		let dirOnly = false;
		if (line.endsWith("/")) {
			dirOnly = true;
			line = line.slice(0, -1);
		}
		if (line.length === 0) continue;
		let anchored = false;
		if (line.startsWith("/")) {
			anchored = true;
			line = line.slice(1);
		} else if (line.includes("/")) {
			anchored = true;
		}
		if (line.length === 0) continue;
		const body = globToRegExpSource(line);
		const prefix = anchored ? "^" : "(^|/)";
		// Match the pattern itself, and (for directories) everything beneath it.
		const regex = new RegExp(`${prefix}${body}($|/)`);
		rules.push({ regex, negated, dirOnly });
	}
	return rules;
}

/** True if `path` (vault-relative, no leading slash) matches the ignore rules. */
export function matchesIgnore(rules: IgnoreRule[] | string, path: string, isDir = false): boolean {
	const parsed = typeof rules === "string" ? parseIgnorePatterns(rules) : rules;
	const normalized = normalizeVaultPath(path);
	let ignored = false;
	for (const rule of parsed) {
		// The trailing "($|/)" in each rule's regex makes directory rules match
		// everything beneath the directory as well.
		if (!rule.regex.test(normalized)) continue;
		ignored = !rule.negated;
	}
	return ignored;
}

/**
 * Detect case-insensitive path collisions. Returns groups (2+) of paths that
 * differ only by case. The lexicographically-first path in each group is the
 * designated winner (index 0).
 */
export function detectCaseCollisions(paths: string[]): string[][] {
	const byLower = new Map<string, string[]>();
	for (const p of paths) {
		const key = p.toLowerCase();
		const arr = byLower.get(key);
		if (arr) arr.push(p);
		else byLower.set(key, [p]);
	}
	const collisions: string[][] = [];
	for (const group of byLower.values()) {
		if (group.length > 1) {
			group.sort();
			collisions.push(group);
		}
	}
	return collisions;
}

/* ---------------- mime ---------------- */

const MIME_BY_EXT: Record<string, string> = {
	md: "text/markdown",
	txt: "text/plain",
	json: "application/json",
	csv: "text/csv",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	mp4: "video/mp4",
	webm: "video/webm",
	zip: "application/zip",
	excalidraw: "application/json",
	canvas: "application/json",
};

export function mimeFromName(name: string): string {
	const { ext } = splitExtension(name);
	const lower = ext.slice(1).toLowerCase();
	return MIME_BY_EXT[lower] ?? "application/octet-stream";
}

/* ---------------- async pool ---------------- */

/**
 * Pure fixed-size worker pool: runs fn(item, index) over items with at most
 * `concurrency` tasks in flight. Results are INDEX-ADDRESSED, so the output
 * order matches the input order no matter how tasks complete. Any rejection
 * fails the whole map (remaining in-flight tasks settle, then it throws).
 */
export async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T, index);
		}
	};
	const workers: Promise<void>[] = [];
	for (let i = 0; i < Math.min(Math.max(concurrency, 1), items.length); i++) {
		workers.push(worker());
	}
	await Promise.all(workers);
	return results;
}

/* ---------------- time fmt ---------------- */


const windowRef: Window | null = typeof window !== "undefined" ? window : null;

/**
 * Popout-window-compatible timers: window.setTimeout/clearTimeout on
 * Obsidian; globalThis timers under Node (vitest). Member-call form keeps
 * the obsidianmd prefer-window-timers rule satisfied without Node breaking.
 */
export function setTimeoutCompat(cb: () => void, ms: number): number {
	const host = windowRef ?? (globalThis as typeof globalThis & Window);
	return host.setTimeout(cb, ms);
}

export function clearTimeoutCompat(id: number | null): void {
	if (id === null) return;
	const host = windowRef ?? (globalThis as typeof globalThis & Window);
	host.clearTimeout(id);
}

/**
 * setWarning() is deprecated in favor of setDestructive() (Obsidian 1.13+).
 * Feature-detect so the whole supported range works.
 */
export function setDestructiveCompat(button: ButtonComponent): ButtonComponent {
	const modern = (button as unknown as { setDestructive?: () => ButtonComponent }).setDestructive;
	if (typeof modern === "function") return modern.call(button);
	return button.setWarning();
}

export function formatLogTime(millis: number): string {
	const d = new Date(millis);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function sleepMillis(ms: number): Promise<void> {
	return new Promise(resolve => setTimeoutCompat(resolve, ms));
}

/* ---------------- byte/quota formatting ---------------- */

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit] as string}`;
}

/** Human-readable quota summary + fill ratio (0..1, clamped) for the dashboard. */
export function formatQuota(storage: number, maxStorage: number): { text: string; ratio: number } {
	const text = `${formatBytes(storage)} of ${formatBytes(maxStorage)} used`;
	if (!Number.isFinite(storage) || !Number.isFinite(maxStorage) || maxStorage <= 0) {
		return { text, ratio: 0 };
	}
	return { text, ratio: Math.min(Math.max(storage / maxStorage, 0), 1) };
}

/* ---------------- line diff (v0.4.0 feature E) ---------------- */

export interface DiffLine {
	type: "same" | "add" | "remove";
	line: string;
}

/**
 * Self-contained Myers LCS line diff (no deps). "add" = line present only in
 * `b` (remote), "remove" = line present only in `a` (local). Purely VISUAL —
 * there is no base content in a two-way sync conflict, so no auto-merge is
 * attempted; this only drives the side-by-side highlighting.
 *
 * Common prefix/suffix lines are trimmed first; a pathological middle (more
 * than MAX_DIFF_LINES lines on the two sides combined) falls back to a plain
 * remove-all/add-all block instead of the O((N+M)·D) backtrack.
 */
const MAX_DIFF_LINES = 4000;

export function diffLines(a: string, b: string): DiffLine[] {
	const aLines = a.length === 0 ? [] : a.split("\n");
	const bLines = b.length === 0 ? [] : b.split("\n");

	// Trim common prefix/suffix.
	let start = 0;
	while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start++;
	let aEnd = aLines.length;
	let bEnd = bLines.length;
	while (aEnd > start && bEnd > start && aLines[aEnd - 1] === bLines[bEnd - 1]) {
		aEnd--;
		bEnd--;
	}

	const out: DiffLine[] = [];
	for (let i = 0; i < start; i++) out.push({ type: "same", line: aLines[i] as string });

	const aMid = aLines.slice(start, aEnd);
	const bMid = bLines.slice(start, bEnd);
	if (aMid.length + bMid.length > MAX_DIFF_LINES) {
		for (const line of aMid) out.push({ type: "remove", line });
		for (const line of bMid) out.push({ type: "add", line });
	} else {
		out.push(...myersDiff(aMid, bMid));
	}

	for (let i = aEnd; i < aLines.length; i++) out.push({ type: "same", line: aLines[i] as string });
	return out;
}

/**
 * Classic Myers O((N+M)·D) shortest edit script with full V-array trace,
 * then backtracked into same/add/remove ops (removes emitted before the adds
 * they pair with, matching every other diff tool's "changed block" shape).
 */
function myersDiff(a: string[], b: string[]): DiffLine[] {
	const n = a.length;
	const m = b.length;
	if (n === 0) return b.map(line => ({ type: "add" as const, line }));
	if (m === 0) return a.map(line => ({ type: "remove" as const, line }));

	const max = n + m;
	const offset = max; // V index shift so k ∈ [-max, max] stays non-negative
	const trace: Int32Array[] = [];
	let v = new Int32Array(2 * max + 1);
	let foundD = -1;
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			// Down (insert into b) when k == -d or when the snake from k+1
			// reached further than the one from k-1.
			let x: number;
			if (k === -d || (k !== d && (v[k - 1 + offset] as number) < (v[k + 1 + offset] as number))) {
				x = v[k + 1 + offset] as number;
			} else {
				x = (v[k - 1 + offset] as number) + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[k + offset] = x;
			if (x >= n && y >= m) {
				foundD = d;
				break;
			}
		}
		if (foundD >= 0) break;
	}

	// Backtrack from (n, m) through the recorded V arrays. trace[d] holds the
	// V array as it was BEFORE edit step d (pushed at the top of iteration d),
	// so backtracking step d consults trace[d].
	const ops: DiffLine[] = [];
	let x = n;
	let y = m;
	for (let d = foundD; d > 0; d--) {
		const prev = trace[d] as Int32Array;
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && (prev[k - 1 + offset] as number) < (prev[k + 1 + offset] as number))) {
			prevK = k + 1; // came from a down move → b line added
		} else {
			prevK = k - 1; // came from a right move → a line removed
		}
		const prevX = prev[prevK + offset] as number;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ type: "same", line: a[x - 1] as string });
			x--;
			y--;
		}
		if (x === prevX) {
			ops.push({ type: "add", line: b[y - 1] as string });
			y--;
		} else {
			ops.push({ type: "remove", line: a[x - 1] as string });
			x--;
		}
	}
	// Leftover at distance 0: leading snake, then pure removes/adds.
	while (x > 0 && y > 0) {
		ops.push({ type: "same", line: a[x - 1] as string });
		x--;
		y--;
	}
	while (x > 0) {
		ops.push({ type: "remove", line: a[x - 1] as string });
		x--;
	}
	while (y > 0) {
		ops.push({ type: "add", line: b[y - 1] as string });
		y--;
	}
	ops.reverse();
	return ops;
}


/* -------------------------------------------------------------------------
 * Config-sync presets (v0.5.1): friendly toggles for the well-known config
 * items, backed by the same configSyncAllowlist: string[] — presets add/
 * remove their entry; the textarea manages the remaining custom entries.
 * ------------------------------------------------------------------------- */

export interface ConfigPreset {
	/** Path relative to the config dir (folder paths sync recursively). */
	path: string;
	label: string;
	desc: string;
	/** Show the desc in warning styling (sensitive content). */
	warning?: boolean;
}

export const CONFIG_PRESETS: ConfigPreset[] = [
	{
		path: "appearance.json",
		label: "Appearance & theme selection",
		desc: "Active theme, accent color, dark/light mode, font size.",
	},
	{
		path: "themes",
		label: "Theme files",
		desc: "The installed themes themselves — needed for the theme selection to load on other devices.",
	},
	{
		path: "hotkeys.json",
		label: "Hotkeys",
		desc: "Your custom keyboard shortcuts.",
	},
	{
		path: "snippets",
		label: "CSS snippets",
		desc: "Custom CSS files (folder, synced recursively).",
	},
	{
		path: "community-plugins.json",
		label: "Community plugins list",
		desc: "Which community plugins are enabled.",
	},
	{
		path: "core-plugins.json",
		label: "Core plugins list",
		desc: "Which core plugins are enabled.",
	},
	{
		path: "plugins",
		label: "Community plugin files",
		desc: "Plugin code AND settings. Includes other plugins' data.json, which may contain API keys — and per-device settings that can conflict.",
		warning: true,
	},
];

const PRESET_PATHS = new Set(CONFIG_PRESETS.map(p => p.path));

export function isPresetEnabled(allowlist: string[], path: string): boolean {
	return allowlist.some(e => normalizeVaultPath(e) === path);
}

export function togglePreset(allowlist: string[], path: string, on: boolean): string[] {
	const normalized = allowlist.map(e => normalizeVaultPath(e.trim())).filter(e => e.length > 0);
	const has = normalized.includes(path);
	if (on && !has) return [...normalized, path];
	if (!on && has) return normalized.filter(e => e !== path);
	return normalized;
}

/** Allowlist entries NOT covered by a preset (shown in the custom textarea). */
export function customAllowlistEntries(allowlist: string[]): string[] {
	return allowlist
		.map(e => normalizeVaultPath(e.trim()))
		.filter(e => e.length > 0 && !PRESET_PATHS.has(e));
}

/** Replace custom entries, preserve current preset states, dedupe. */
export function mergeAllowlist(current: string[], customLines: string[]): string[] {
	const keptPresets = current
		.map(e => normalizeVaultPath(e.trim()))
		.filter(e => e.length > 0 && PRESET_PATHS.has(e));
	const custom = customLines
		.map(e => normalizeVaultPath(e.trim()))
		.filter(e => e.length > 0 && !PRESET_PATHS.has(e));
	return [...new Set([...keptPresets, ...custom])];
}


/* -------------------------------------------------------------------------
 * User-facing text polish (v0.5.2): pluralization, relative timestamps, and
 * the friendly-error translator that turns raw errors into plain language +
 * a next step. Notices get friendly text; the sync log keeps the raw detail.
 * ------------------------------------------------------------------------- */

export function pluralize(count: number, singular: string, plural?: string): string {
	return count === 1 ? `${count} ${singular}` : `${count} ${plural ?? `${singular}s`}`;
}

/** "just now" / "5 minutes ago" / "3 hours ago" / absolute date for older. */
export function relativeTime(millis: number, now: number = Date.now()): string {
	const diff = now - millis;
	if (diff < 45_000) return "just now";
	const minutes = Math.round(diff / 60_000);
	if (minutes < 60) return pluralize(minutes, "minute") + " ago";
	const hours = Math.round(minutes / 60);
	if (hours < 24) return pluralize(hours, "hour") + " ago";
	return new Date(millis).toLocaleString();
}

export interface FriendlyError {
	title: string;
	hint?: string;
}

/**
 * Translate a raw error/log message into plain language. Matches known
 * patterns from the Filen client and network layer; anything unknown passes
 * through as its first line (unchanged).
 */
export function friendlyError(raw: string): FriendlyError {
	const msg = raw.toLowerCase();
	if (msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("401")) {
		return {
			title: "Your Filen session expired",
			hint: "Disconnect and reconnect in settings to sign in again.",
		};
	}
	if (
		msg.includes("failed to fetch") || msg.includes("network") || msg.includes("timeout")
		|| msg.includes("timed out") || msg.includes("econn") || msg.includes("socket") || msg.includes("dns")
	) {
		return {
			title: "Can't reach Filen",
			hint: "Check your internet connection — sync retries automatically.",
		};
	}
	if (msg.includes("decrypt")) {
		return {
			title: "Couldn't decrypt data from Filen",
			hint: "Usually means it was written with different keys (e.g. another account). The debug log has details.",
		};
	}
	if (msg.includes("429") || msg.includes("rate limit")) {
		return {
			title: "Filen is rate-limiting requests",
			hint: "Sync backs off and retries on its own.",
		};
	}
	if (/\b5\d\d\b/.test(msg) || msg.includes("server error")) {
		return {
			title: "Filen is having server trouble",
			hint: "Try again in a few minutes.",
		};
	}
	return { title: raw.split("\n")[0] ?? raw };
}
