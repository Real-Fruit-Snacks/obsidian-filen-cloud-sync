/**
 * Per-device persisted state via app.loadLocalStorage/saveLocalStorage
 * (NEVER data.json — that travels with vault syncs). Credentials prefer
 * app.secretStorage when present (feature-detected, @since 1.11.4).
 */

import type { App } from "obsidian";
import type { StoredCredentials } from "../filen/types";
import { uuidv4 } from "../util";
import type { BaseRecord, RemoteTree, RemoteTreeCache, SyncStateFile } from "./types";

const STATE_KEY = "filen-sync/state";
const CREDENTIALS_KEY = "filen-sync/credentials";
const LOG_KEY = "filen-sync/log";
const DEVICE_ID_KEY = "filen-sync/device-id";
const SECRET_ID = "filen-sync-credentials";

export const STATE_SCHEMA_VERSION = 1;

/**
 * Stable per-device UUID sent as `deviceId` with /v3/dir/tree (Filen requires
 * a UUID; the official clients persist one per sync pair). Generated once,
 * reused forever, cleared together with the rest of the local sync state.
 */
export function loadDeviceId(app: App): string {
	const existing: unknown = app.loadLocalStorage(DEVICE_ID_KEY);
	if (typeof existing === "string" && existing.length === 36) return existing;
	const fresh = uuidv4();
	app.saveLocalStorage(DEVICE_ID_KEY, fresh);
	return fresh;
}

export function clearDeviceId(app: App): void {
	app.saveLocalStorage(DEVICE_ID_KEY, null);
}

interface SecretStorageLike {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
	deleteSecret?(id: string): void;
}

function secretStorageOf(app: App): SecretStorageLike | null {
	const candidate = (app as unknown as { secretStorage?: SecretStorageLike }).secretStorage;
	if (candidate && typeof candidate.setSecret === "function" && typeof candidate.getSecret === "function") {
		return candidate;
	}
	return null;
}

/* ---------------- credentials ---------------- */

export function loadCredentials(app: App): StoredCredentials | null {
	const secrets = secretStorageOf(app);
	try {
		if (secrets) {
			const raw = secrets.getSecret(SECRET_ID);
			if (raw) return JSON.parse(raw) as StoredCredentials;
		}
		const fallback: unknown = app.loadLocalStorage(CREDENTIALS_KEY);
		if (typeof fallback === "string" && fallback.length > 0) {
			return JSON.parse(fallback) as StoredCredentials;
		}
	} catch {
		return null;
	}
	return null;
}

export function saveCredentials(app: App, credentials: StoredCredentials): void {
	const secrets = secretStorageOf(app);
	if (secrets) {
		secrets.setSecret(SECRET_ID, JSON.stringify(credentials));
		// clear any legacy localStorage copy
		app.saveLocalStorage(CREDENTIALS_KEY, null);
	} else {
		app.saveLocalStorage(CREDENTIALS_KEY, JSON.stringify(credentials));
	}
}

export function clearCredentials(app: App): void {
	const secrets = secretStorageOf(app);
	if (secrets) {
		if (typeof secrets.deleteSecret === "function") secrets.deleteSecret(SECRET_ID);
		else secrets.setSecret(SECRET_ID, "");
	}
	app.saveLocalStorage(CREDENTIALS_KEY, null);
}

/* ---------------- sync state ---------------- */

export function emptyState(remoteRootUuid = ""): SyncStateFile {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		remoteRootUuid,
		lastSuccessSyncMillis: 0,
		files: {},
	};
}

export function loadState(app: App): SyncStateFile {
	try {
		const raw: unknown = app.loadLocalStorage(STATE_KEY);
		if (typeof raw !== "string" || raw.length === 0) return emptyState();
		const parsed = JSON.parse(raw) as SyncStateFile;
		if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) return emptyState();
		if (typeof parsed.files !== "object" || parsed.files === null) parsed.files = {};
		// v0.4.0 feature D: optional cached remote tree — validate lightly and
		// drop malformed snapshots (a missing cache just forces a full scan).
		const cache: unknown = parsed.remoteTreeCache;
		if (cache !== undefined && cache !== null) {
			const c = cache as Partial<RemoteTreeCache>;
			const valid = typeof c === "object"
				&& typeof c.fetchedAt === "number"
				&& typeof c.eventWatermark === "number"
				&& typeof c.files === "object" && c.files !== null
				&& typeof c.folders === "object" && c.folders !== null;
			if (!valid) delete parsed.remoteTreeCache;
		}
		return parsed;
	} catch {
		return emptyState();
	}
}

export function saveState(app: App, state: SyncStateFile): void {
	app.saveLocalStorage(STATE_KEY, JSON.stringify(state));
}

export function clearState(app: App): void {
	app.saveLocalStorage(STATE_KEY, null);
}

export function baseRecordsAsMap(state: SyncStateFile): Map<string, BaseRecord> {
	return new Map(Object.entries(state.files));
}

export function mapIntoState(state: SyncStateFile, map: Map<string, BaseRecord>): void {
	const files: Record<string, BaseRecord> = {};
	for (const [path, record] of map) files[path] = record;
	state.files = files;
}

/* ---------------- remote tree cache (v0.4.0 feature D) ---------------- */

/** Snapshot a freshly scanned remote tree into the persistable cache shape. */
export function remoteTreeToCache(tree: RemoteTree, fetchedAt: number, eventWatermark: number): RemoteTreeCache {
	const files: RemoteTreeCache["files"] = {};
	for (const [path, file] of tree.files) files[path] = file;
	const folders: RemoteTreeCache["folders"] = {};
	for (const [path, uuid] of tree.folders) folders[path] = uuid;
	return { fetchedAt, eventWatermark, files, folders };
}

/** Rehydrate a cached snapshot back into a RemoteTree. */
export function remoteTreeFromCache(cache: RemoteTreeCache): RemoteTree {
	return {
		files: new Map(Object.entries(cache.files)),
		folders: new Map(Object.entries(cache.folders)),
	};
}

/* ---------------- log ring buffer ---------------- */

export interface LogEntry {
	ts: number;
	level: "info" | "warn" | "error" | "conflict";
	message: string;
}

export const LOG_CAPACITY = 200;

export function loadLog(app: App): LogEntry[] {
	try {
		const raw: unknown = app.loadLocalStorage(LOG_KEY);
		if (typeof raw !== "string" || raw.length === 0) return [];
		const parsed = JSON.parse(raw) as LogEntry[];
		return Array.isArray(parsed) ? parsed.slice(-LOG_CAPACITY) : [];
	} catch {
		return [];
	}
}

export function saveLog(app: App, entries: LogEntry[]): void {
	app.saveLocalStorage(LOG_KEY, JSON.stringify(entries.slice(-LOG_CAPACITY)));
}

export function clearLog(app: App): void {
	app.saveLocalStorage(LOG_KEY, null);
}
