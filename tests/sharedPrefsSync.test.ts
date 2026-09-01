/**
 * Integration tests for the shared-settings glue (v0.5.0): enable flow,
 * post-run remote-newer check, debounced upload, loop guard, toggle-off
 * silence — against a stateful in-memory mock Filen client.
 */

import { describe, expect, it } from "vitest";
import type { FilenClient } from "../src/filen/client";
import { sha512Hex } from "../src/filen/crypto";
import type { StoredCredentials } from "../src/filen/types";
import type { FilenSyncSettings } from "../src/settings";
import type { SyncLog } from "../src/sync/log";
import { scanRemote } from "../src/sync/remoteScan";
import { PREFS_FILE_NAME, parsePrefs, serializePrefs, SharedPrefs } from "../src/sync/sharedPrefs";
import { SharedPrefsSync } from "../src/sync/sharedPrefsSync";
import { utf8ToBytes } from "../src/util";

const ROOT = "root-uuid";
const T0 = 1_700_000_000_000;

/* ---------------- stateful mock Filen client ---------------- */

interface RemoteEntry {
	uuid: string;
	name: string;
	parent: string;
	size: number;
	lastModified: number;
	data: ArrayBuffer;
}

function makeMockClient() {
	const remoteFiles = new Map<string, RemoteEntry>(); // keyed by file NAME (root only needed)
	let uuidCounter = 0;
	let uploads = 0;
	let downloads = 0;

	const client = {
		setCredentials: () => undefined,
		dirTree: async () => ({
			folders: [[ROOT, "default", "base"]],
			files: [...remoteFiles.values()].map(f => [
				f.uuid, "bucket", "region", 1, f.parent, `enc:${f.uuid}`, 2, 0,
			]),
		}),
		decryptFolderName: async (enc: string) => enc,
		decryptFileMetadata: async (enc: string) => {
			const uuid = enc.slice(4);
			const entry = [...remoteFiles.values()].find(f => f.uuid === uuid);
			if (!entry) throw new Error(`unknown remote uuid ${uuid}`);
			return {
				name: entry.name,
				size: entry.size,
				mime: "application/json",
				key: "file-key",
				lastModified: entry.lastModified,
				hash: await sha512Hex(entry.data),
			};
		},
		uploadFile: async (parent: string, name: string, data: ArrayBuffer, lastModified: number) => {
			uploads++;
			const uuid = `remote-uuid-${++uuidCounter}`;
			remoteFiles.set(name, {
				uuid, name, parent, size: data.byteLength, lastModified, data: data.slice(0),
			});
			return { uuid, chunks: 1, size: data.byteLength, hash: "", bucket: "bucket", region: "region", lastModified };
		},
		downloadFile: async (location: { uuid: string }) => {
			downloads++;
			const entry = [...remoteFiles.values()].find(f => f.uuid === location.uuid);
			if (!entry) throw new Error(`unknown remote uuid ${location.uuid}`);
			return { data: entry.data.slice(0), verified: true };
		},
	};

	return {
		client: client as unknown as FilenClient,
		remoteFiles,
		get uploads() { return uploads; },
		get downloads() { return downloads; },
	};
}

/* ---------------- harness ---------------- */

function makeSettings(): FilenSyncSettings {
	return {
		email: "user@example.com",
		remoteFolder: "Obsidian/vault",
		autoSyncInterval: true,
		syncIntervalMinutes: 10,
		autoSyncOnStart: true,
		syncOnSave: true,
		conflictPolicy: "keep_both",
		conflictResolution: "auto",
		fastRemotePolling: false,
		syncConfigDir: false,
		configSyncAllowlist: ["appearance.json"],
		excludeDotFiles: true,
		ignorePatterns: "",
		ignoredFolders: [],
		skipLargeFiles: true,
		skipSizeLargerThanMB: 50,
		massChangeGuard: true,
		massChangeAbortPercent: 50,
		memoryOnlyCredentials: false,
		debugLog: false,
		shareSettings: true,
		deviceName: "this-device",
		sharedPrefsAppliedAt: 0,
	};
}

function makeHarness(options?: { credentials?: StoredCredentials | null; debounceMs?: number }) {
	const mock = makeMockClient();
	const settings = makeSettings();
	const notices: string[] = [];
	const logs: string[] = [];
	let saveCount = 0;
	const credentials: StoredCredentials | null = options?.credentials !== undefined
		? options.credentials
		: {
			apiKey: "api-key",
			masterKeys: ["master-key"],
			authVersion: 2,
			rootUuid: ROOT,
			syncRootUuid: ROOT,
			email: "user@example.com",
		};
	const log = {
		info: (message: string) => logs.push(`INFO ${message}`),
		warn: (message: string) => logs.push(`WARN ${message}`),
		error: (message: string) => logs.push(`ERROR ${message}`),
		conflict: (message: string) => logs.push(`CONFLICT ${message}`),
	} as unknown as SyncLog;
	const sync = new SharedPrefsSync({
		client: mock.client,
		getSettings: () => settings,
		saveSettings: async () => {
			saveCount++;
		},
		getCredentials: () => credentials,
		deviceId: () => "device-id",
		log,
		notify: message => notices.push(message),
		debounceMs: options?.debounceMs ?? 10,
	});
	return {
		sync, settings, notices, logs, mock,
		get saveCount() { return saveCount; },
	};
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function writeRemotePrefs(
	mock: ReturnType<typeof makeMockClient>,
	prefs: SharedPrefs,
	device: string,
	updatedAt: number,
): void {
	const body = serializePrefs(prefs, device, updatedAt);
	const bytes = utf8ToBytes(body);
	mock.remoteFiles.set(PREFS_FILE_NAME, {
		uuid: "prefs-uuid",
		name: PREFS_FILE_NAME,
		parent: ROOT,
		size: bytes.byteLength,
		lastModified: updatedAt, // the plugin always writes mtime == updatedAt
		data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
	});
}

function remotePrefsFile(mock: ReturnType<typeof makeMockClient>) {
	const entry = mock.remoteFiles.get(PREFS_FILE_NAME);
	if (!entry) return null;
	return parsePrefs(new TextDecoder().decode(entry.data));
}

const remoteTreeOf = (mock: ReturnType<typeof makeMockClient>) =>
	scanRemote(mock.client, ROOT, "device-id").then(scan => scan.tree);

/* ---------------- enable flow ---------------- */

describe("enable (toggle off→on)", () => {
	it("no remote file → uploads the local prefs as the seed (no Notice)", async () => {
		const harness = makeHarness();
		const { sync, settings, notices, mock } = harness;
		settings.ignorePatterns = "private/**";
		const before = Date.now();
		expect(await sync.enable()).toBe(true);

		const file = remotePrefsFile(mock);
		expect(file).not.toBeNull();
		expect(file?.device).toBe("this-device");
		expect(file?.prefs.ignorePatterns).toBe("private/**");
		expect(file?.updatedAt).toBeGreaterThanOrEqual(before);
		// Seed recorded as last-applied so the post-run check never re-downloads it.
		expect(settings.sharedPrefsAppliedAt).toBe(file?.updatedAt);
		expect(mock.uploads).toBe(1);
		expect(harness.saveCount).toBeGreaterThanOrEqual(1);
		expect(notices).toEqual([]); // own upload → no Notice
	});

	it("valid remote file → applies it and records applied-at (+ Notice)", async () => {
		const { sync, settings, notices, mock } = makeHarness();
		writeRemotePrefs(mock, {
			conflictPolicy: "keep_newer",
			conflictResolution: "ask",
			excludeDotFiles: false,
			ignorePatterns: "*.tmp",
			ignoredFolders: ["archive"],
			configSyncAllowlist: ["hotkeys.json"],
		}, "other-device", T0 + 5000);

		expect(await sync.enable()).toBe(true);
		expect(settings.conflictPolicy).toBe("keep_newer");
		expect(settings.conflictResolution).toBe("ask");
		expect(settings.excludeDotFiles).toBe(false);
		expect(settings.ignorePatterns).toBe("*.tmp");
		expect(settings.ignoredFolders).toEqual(["archive"]);
		expect(settings.configSyncAllowlist).toEqual(["hotkeys.json"]);
		expect(settings.sharedPrefsAppliedAt).toBe(T0 + 5000);
		expect(mock.uploads).toBe(0); // remote wins — nothing uploaded
		expect(notices.some(n => n.includes("written by other-device"))).toBe(true);
		// Per-device keys untouched.
		expect(settings.email).toBe("user@example.com");
		expect(settings.syncIntervalMinutes).toBe(10);
	});

	it("corrupt remote file → treated as missing, local prefs seeded", async () => {
		const { sync, mock } = makeHarness();
		const bytes = utf8ToBytes("{ not valid prefs");
		mock.remoteFiles.set(PREFS_FILE_NAME, {
			uuid: "prefs-uuid", name: PREFS_FILE_NAME, parent: ROOT,
			size: bytes.byteLength, lastModified: T0,
			data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
		});
		expect(await sync.enable()).toBe(true);
		expect(mock.uploads).toBe(1); // seeded
		expect(remotePrefsFile(mock)?.version).toBe(1);
	});

	it("not connected → false + Notice, no traffic", async () => {
		const { sync, notices, mock } = makeHarness({ credentials: null });
		expect(await sync.enable()).toBe(false);
		expect(mock.uploads).toBe(0);
		expect(notices.some(n => n.includes("connect your Filen account"))).toBe(true);
	});
});

/* ---------------- post-run check ---------------- */

describe("afterRun (post-sync-run remote-newer check)", () => {
	it("remote-newer prefs → download + apply + persist applied-at + Notice", async () => {
		const { sync, settings, notices, mock } = makeHarness();
		settings.sharedPrefsAppliedAt = T0;
		writeRemotePrefs(mock, {
			conflictPolicy: "keep_newer",
			conflictResolution: "auto",
			excludeDotFiles: true,
			ignorePatterns: "",
			ignoredFolders: [],
			configSyncAllowlist: ["appearance.json"],
		}, "desktop", T0 + 60_000);

		await sync.afterRun(await remoteTreeOf(mock));
		expect(settings.conflictPolicy).toBe("keep_newer");
		expect(settings.sharedPrefsAppliedAt).toBe(T0 + 60_000);
		expect(mock.downloads).toBe(1);
		expect(notices.some(n => n.includes("written by desktop"))).toBe(true);
	});

	it("own upload (updatedAt == appliedAt) → no download, no apply, no Notice", async () => {
		const { sync, settings, notices, mock } = makeHarness();
		expect(await sync.enable()).toBe(true); // seeds the file
		const downloadsBefore = mock.downloads;
		await sync.afterRun(await remoteTreeOf(mock));
		expect(mock.downloads).toBe(downloadsBefore); // mtime pre-filter skips it
		expect(notices).toEqual([]);
		expect(settings.conflictPolicy).toBe("keep_both");
	});

	it("older remote prefs → nothing happens", async () => {
		const { sync, settings, mock } = makeHarness();
		settings.sharedPrefsAppliedAt = T0 + 100_000;
		writeRemotePrefs(mock, {
			conflictPolicy: "keep_newer",
			conflictResolution: "ask",
			excludeDotFiles: false,
			ignorePatterns: "x",
			ignoredFolders: ["a"],
			configSyncAllowlist: [],
		}, "stale-device", T0);
		await sync.afterRun(await remoteTreeOf(mock));
		expect(settings.conflictPolicy).toBe("keep_both");
		expect(mock.downloads).toBe(0);
	});

	it("missing remote file while sharing → self-heal re-upload", async () => {
		const { sync, mock } = makeHarness();
		await sync.afterRun(await remoteTreeOf(mock));
		expect(mock.uploads).toBe(1);
		expect(remotePrefsFile(mock)).not.toBeNull();
	});

	it("sharing off → no traffic at all", async () => {
		const { sync, settings, mock } = makeHarness();
		settings.shareSettings = false;
		writeRemotePrefs(mock, {
			conflictPolicy: "keep_newer",
			conflictResolution: "ask",
			excludeDotFiles: false,
			ignorePatterns: "x",
			ignoredFolders: ["a"],
			configSyncAllowlist: [],
		}, "other", T0 + 1);
		await sync.afterRun(await remoteTreeOf(mock));
		expect(settings.conflictPolicy).toBe("keep_both");
		expect(mock.downloads).toBe(0);
		expect(mock.uploads).toBe(0);
	});
});

/* ---------------- upload on local change ---------------- */

describe("onSharedKeyChanged (debounced upload)", () => {
	it("uploads after the debounce with a fresh updatedAt; rapid changes collapse", async () => {
		const { sync, settings, mock } = makeHarness();
		expect(await sync.enable()).toBe(true); // seed
		expect(mock.uploads).toBe(1);
		const seedUpdatedAt = remotePrefsFile(mock)?.updatedAt ?? 0;

		await sleep(5); // make sure the fresh updatedAt differs
		settings.conflictPolicy = "keep_newer";
		sync.onSharedKeyChanged();
		settings.ignorePatterns = "drafts/**";
		sync.onSharedKeyChanged(); // must reset the timer — still ONE upload
		expect(mock.uploads).toBe(1); // not yet (debounced)
		await sleep(50);

		expect(mock.uploads).toBe(2);
		const file = remotePrefsFile(mock);
		expect(file?.updatedAt).toBeGreaterThan(seedUpdatedAt);
		expect(file?.prefs.conflictPolicy).toBe("keep_newer");
		expect(file?.prefs.ignorePatterns).toBe("drafts/**");
		expect(settings.sharedPrefsAppliedAt).toBe(file?.updatedAt);
	});

	it("no-ops while sharing is off", async () => {
		const { sync, settings, mock } = makeHarness();
		settings.shareSettings = false;
		sync.onSharedKeyChanged();
		await sleep(30);
		expect(mock.uploads).toBe(0);
	});

	it("disable() cancels a pending upload (toggle off mid-debounce)", async () => {
		const { sync, settings, mock } = makeHarness();
		expect(await sync.enable()).toBe(true);
		settings.conflictPolicy = "keep_newer";
		sync.onSharedKeyChanged();
		// Toggle off before the timer fires.
		settings.shareSettings = false;
		sync.disable();
		await sleep(50);
		expect(mock.uploads).toBe(1); // only the enable-seed
	});
});

/* ---------------- loop guard ---------------- */

describe("loop prevention", () => {
	it("onSharedKeyChanged during a remote apply never re-uploads", async () => {
		const mock = makeMockClient();
		const settings = makeSettings();
		settings.sharedPrefsAppliedAt = T0;
		writeRemotePrefs(mock, {
			conflictPolicy: "keep_newer",
			conflictResolution: "ask",
			excludeDotFiles: false,
			ignorePatterns: "x",
			ignoredFolders: ["a"],
			configSyncAllowlist: [],
		}, "other-device", T0 + 5000);

		let releaseSave: (() => void) | null = null;
		const log = { info: () => undefined, warn: () => undefined, error: () => undefined, conflict: () => undefined } as unknown as SyncLog;
		const sync = new SharedPrefsSync({
			client: mock.client,
			getSettings: () => settings,
			saveSettings: () => new Promise<void>(resolve => {
				releaseSave = resolve;
			}),
			getCredentials: () => ({
				apiKey: "k", masterKeys: ["m"], authVersion: 2,
				rootUuid: ROOT, syncRootUuid: ROOT, email: "e",
			}),
			deviceId: () => "device-id",
			log,
			notify: () => undefined,
			debounceMs: 10,
		});

		const applyPromise = sync.afterRun(await remoteTreeOf(mock));
		await sleep(0); // let the download + apply reach the saveSettings await
		expect(sync.isApplying).toBe(true);
		// A shared-key change landing mid-apply (e.g. a UI refresh echo) must be dropped.
		sync.onSharedKeyChanged();
		(releaseSave as unknown as () => void)();
		await applyPromise;
		await sleep(50);
		expect(sync.isApplying).toBe(false);
		expect(mock.uploads).toBe(0); // loop guard held
	});
});
