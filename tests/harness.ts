/**
 * Shared engine test harness: fake in-memory vault + stateful mock Filen
 * client (mirrors the harness in engine.test.ts, with mutating-call
 * counters for the dry-run purity assertions).
 */

import type { App } from "obsidian";
import type { FilenClient } from "../src/filen/client";
import { sha512Hex } from "../src/filen/crypto";
import type { StoredCredentials } from "../src/filen/types";
import { ConflictResolver, SyncEngine } from "../src/sync/engine";
import { SyncLog } from "../src/sync/log";
import type { FilenSyncSettings } from "../src/settings";
import { utf8ToBytes } from "../src/util";

export const T0 = 1_700_000_000_000;
export const ROOT = "root-uuid";

/* ---------------- fake vault ---------------- */

interface FakeFile {
	path: string;
	name: string;
	stat: { mtime: number; size: number; ctime: number };
}

function baseName(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

function parentOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

export class FakeVault {
	private contents = new Map<string, { data: ArrayBuffer; mtime: number; ctime: number }>();
	private folderSet = new Set<string>();
	readonly configDir = ".obsidian";

	readonly adapter = {
		exists: async (path: string) => this.contents.has(path) || this.folderSet.has(path),
		read: async () => "",
		readBinary: async (path: string) => {
			const entry = this.contents.get(path);
			if (!entry) throw new Error(`no such file: ${path}`);
			return entry.data.slice(0);
		},
		writeBinary: async (path: string, data: ArrayBuffer, opts?: { mtime?: number; ctime?: number }) => {
			const now = Date.now();
			this.contents.set(path, {
				data: data.slice(0),
				mtime: opts?.mtime ?? now,
				ctime: opts?.ctime ?? now,
			});
		},
		stat: async (path: string) => {
			const entry = this.contents.get(path);
			if (entry) return { type: "file", mtime: entry.mtime, ctime: entry.ctime, size: entry.data.byteLength };
			// Real DataAdapter.stat also reports folders — explicit (mkdir) or
			// implied by files beneath them.
			const prefix = path + "/";
			if (this.folderSet.has(path) || [...this.contents.keys()].some(p => p.startsWith(prefix))) {
				return { type: "folder", mtime: 0, ctime: 0, size: 0 };
			}
			return null;
		},
		list: async (folder: string) => {
			// NON-recursive like the real DataAdapter.list — direct children only.
			const prefix = folder + "/";
			const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
			return {
				files: [...this.contents.keys()].filter(direct),
				folders: [...this.folderSet].filter(direct),
			};
		},
		mkdir: async (path: string) => {
			this.folderSet.add(path);
		},
		trashSystem: async (path: string) => {
			this.contents.delete(path);
			this.folderSet.delete(path);
			return true;
		},
		trashLocal: async (path: string) => {
			this.contents.delete(path);
			this.folderSet.delete(path);
		},
		remove: async (path: string) => {
			this.contents.delete(path);
		},
		rename: async (from: string, to: string) => {
			const entry = this.contents.get(from);
			if (!entry) throw new Error(`no such file: ${from}`);
			this.contents.delete(from);
			this.contents.set(to, entry);
		},
	};

	addFile(path: string, text: string, mtime: number): void {
		const bytes = utf8ToBytes(text);
		this.contents.set(path, {
			data: bytes.buffer.slice(0) as ArrayBuffer,
			mtime,
			ctime: mtime,
		});
	}

	addBinaryFile(path: string, bytes: Uint8Array, mtime: number): void {
		this.contents.set(path, {
			data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
			mtime,
			ctime: mtime,
		});
	}

	textOf(path: string): string {
		const entry = this.contents.get(path);
		if (!entry) throw new Error(`no such file: ${path}`);
		return new TextDecoder().decode(entry.data);
	}

	hasFile(path: string): boolean {
		return this.contents.has(path);
	}

	getFiles(): FakeFile[] {
		// Config-dir files are NEVER visible to the Vault API (mirrors Obsidian).
		return [...this.contents.entries()]
			.filter(([path]) => !path.startsWith(`${this.configDir}/`))
			.map(([path, entry]) => ({
				path,
				name: baseName(path),
				stat: { mtime: entry.mtime, size: entry.data.byteLength, ctime: entry.ctime },
			}));
	}

	getAllFolders(): Array<{ path: string }> {
		return [...this.folderSet].map(path => ({ path }));
	}

	getFileByPath(path: string): FakeFile | null {
		if (path.startsWith(`${this.configDir}/`)) return null; // Vault-API invisible
		const entry = this.contents.get(path);
		if (!entry) return null;
		return {
			path,
			name: baseName(path),
			stat: { mtime: entry.mtime, size: entry.data.byteLength, ctime: entry.ctime },
		};
	}

	getFolderByPath(path: string): { path: string } | null {
		if (path === this.configDir || path.startsWith(`${this.configDir}/`)) return null;
		return this.folderSet.has(path) ? { path } : null;
	}

	getAbstractFileByPath(path: string): unknown | null {
		return this.getFileByPath(path) ?? this.getFolderByPath(path);
	}

	async readBinary(file: FakeFile): Promise<ArrayBuffer> {
		const entry = this.contents.get(file.path);
		if (!entry) throw new Error(`no such file: ${file.path}`);
		return entry.data.slice(0);
	}

	async modifyBinary(file: FakeFile, data: ArrayBuffer, opts?: { mtime?: number }): Promise<void> {
		const entry = this.contents.get(file.path);
		if (!entry) throw new Error(`no such file: ${file.path}`);
		this.contents.set(file.path, {
			data: data.slice(0),
			mtime: opts?.mtime ?? Date.now(),
			ctime: entry.ctime,
		});
	}

	async trash(file: { path: string }): Promise<void> {
		this.contents.delete(file.path);
		this.folderSet.delete(file.path);
	}

	async rename(file: { path: string }, newPath: string): Promise<void> {
		await this.adapter.rename(file.path, newPath);
	}

	async createFolder(path: string): Promise<void> {
		this.folderSet.add(path);
	}
}

/* ---------------- stateful mock Filen client ---------------- */

export interface RemoteEntry {
	uuid: string;
	name: string;
	parent: string;
	size: number;
	lastModified: number;
	data: ArrayBuffer;
}

export function makeMockClient() {
	const remoteFiles = new Map<string, RemoteEntry>(); // keyed by FULL path
	const versions = new Map<string, RemoteEntry>(); // overwritten versions, by uuid
	const renameCalls: Array<{ uuid: string; newName: string }> = [];
	const moveCalls: Array<{ uuid: string; to: string }> = [];
	// folder uuid → { path, parent uuid } (ROOT = the sync root, path "")
	const folderInfo = new Map<string, { path: string; parent: string }>();
	folderInfo.set(ROOT, { path: "", parent: "" });
	let uuidCounter = 0;
	// v0.4.0 feature D: events probe instrumentation.
	let dirTreeCalls = 0;
	let eventsCalls = 0;
	let lastEventsTimestamp: number | null = null;
	let eventsToReturn: Array<{ id: number; type: string; timestamp: number }> = [];
	let eventsError: Error | null = null;
	/** v0.6.0 feature A: names of MUTATING client calls (dry-run purity). */
	const mutations: string[] = [];

	const folderPathOf = (uuid: string): string => folderInfo.get(uuid)?.path ?? "";

	/** Register folder entries for each segment of a DIR path; → leaf uuid. */
	const ensureFolderChain = (path: string): string => {
		if (path === "") return ROOT;
		let curPath = "";
		let curUuid = ROOT;
		for (const segment of path.split("/")) {
			const nextPath = curPath === "" ? segment : `${curPath}/${segment}`;
			let nextUuid: string | undefined;
			for (const [uuid, info] of folderInfo) {
				if (info.path === nextPath) nextUuid = uuid;
			}
			if (!nextUuid) {
				nextUuid = `folder-${++uuidCounter}`;
				folderInfo.set(nextUuid, { path: nextPath, parent: curUuid });
			}
			curPath = nextPath;
			curUuid = nextUuid;
		}
		return curUuid;
	};

	const client = {
		setCredentials: () => undefined,
		userEvents: async (timestamp: number) => {
			eventsCalls++;
			lastEventsTimestamp = timestamp;
			if (eventsError) throw eventsError;
			return { events: eventsToReturn };
		},
		dirTree: async () => {
			dirTreeCalls++;
			return {
				folders: [...folderInfo.entries()].map(([uuid, info]) =>
					uuid === ROOT ? [ROOT, "default", "base"] : [uuid, `enc:${info.path}`, info.parent]),
				files: [...remoteFiles.values()].map(f => [
					f.uuid, "bucket", "region", 1, f.parent, `enc:${f.uuid}`, 2, 0,
				]),
			};
		},
		decryptFolderName: async (enc: string) => baseName(enc.slice(4)),
		decryptFileMetadata: async (enc: string) => {
			const uuid = enc.slice(4);
			const entry = [...remoteFiles.values()].find(f => f.uuid === uuid);
			if (!entry) throw new Error(`unknown remote uuid ${uuid}`);
			return {
				name: entry.name,
				size: entry.size,
				mime: "text/markdown",
				key: "file-key",
				lastModified: entry.lastModified,
				hash: await sha512Hex(entry.data),
			};
		},
		uploadFile: async (
			parent: string, name: string, data: ArrayBuffer, lastModified: number,
			_mime?: string, onChunkProgress?: (done: number, total: number) => void,
		) => {
			mutations.push("uploadFile");
			// v0.6.0 feature C: mock files are single-chunk — one callback.
			onChunkProgress?.(1, 1);
			const uuid = `remote-uuid-${++uuidCounter}`;
			const parentPath = folderPathOf(parent);
			const path = parentPath === "" ? name : `${parentPath}/${name}`;
			// Overwriting mints a version server-side: the old uuid stays downloadable.
			const previous = remoteFiles.get(path);
			if (previous) versions.set(previous.uuid, previous);
			remoteFiles.set(path, {
				uuid, name, parent, size: data.byteLength, lastModified, data: data.slice(0),
			});
			return {
				uuid, chunks: 1, size: data.byteLength, hash: "",
				bucket: "bucket", region: "region", lastModified,
			};
		},
		downloadFile: async (
			location: { uuid: string },
			_fileKey?: string,
			_expectedHash?: string,
			onChunkProgress?: (done: number, total: number) => void,
		) => {
			const entry = [...remoteFiles.values()].find(f => f.uuid === location.uuid)
				?? versions.get(location.uuid);
			if (!entry) throw new Error(`unknown remote uuid ${location.uuid}`);
			// v0.6.0 feature C: mock files are single-chunk — one callback.
			onChunkProgress?.(1, 1);
			return { data: entry.data.slice(0), verified: true };
		},
		fileTrash: async (uuid: string) => {
			mutations.push("fileTrash");
			for (const [key, entry] of remoteFiles) {
				if (entry.uuid === uuid) remoteFiles.delete(key);
			}
		},
		fileRename: async (uuid: string, newName: string) => {
			mutations.push("fileRename");
			renameCalls.push({ uuid, newName });
			for (const [key, entry] of remoteFiles) {
				if (entry.uuid === uuid) {
					remoteFiles.delete(key);
					const parentPath = folderPathOf(entry.parent);
					const newKey = parentPath === "" ? newName : `${parentPath}/${newName}`;
					remoteFiles.set(newKey, { ...entry, name: newName });
					return;
				}
			}
			throw new Error(`rename: unknown uuid ${uuid}`);
		},
		fileMove: async (uuid: string, to: string) => {
			mutations.push("fileMove");
			moveCalls.push({ uuid, to });
			for (const [key, entry] of remoteFiles) {
				if (entry.uuid === uuid) {
					remoteFiles.delete(key);
					const parentPath = folderPathOf(to);
					const newKey = parentPath === "" ? entry.name : `${parentPath}/${entry.name}`;
					remoteFiles.set(newKey, { ...entry, parent: to });
					return;
				}
			}
		},
		dirCreate: async (name: string, parent: string) => {
			mutations.push("dirCreate");
			const uuid = `dir-${++uuidCounter}`;
			const parentPath = folderPathOf(parent);
			folderInfo.set(uuid, {
				path: parentPath === "" ? name : `${parentPath}/${name}`,
				parent,
			});
			return uuid;
		},
		dirTrash: async () => {
			mutations.push("dirTrash");
		},
	};

	const seedRemote = (path: string, text: string, lastModified: number): void => {
		const bytes = utf8ToBytes(text);
		const parent = ensureFolderChain(parentOf(path));
		remoteFiles.set(path, {
			uuid: `remote-uuid-${++uuidCounter}`,
			name: baseName(path), parent, size: bytes.length, lastModified,
			data: bytes.buffer.slice(0) as ArrayBuffer,
		});
	};

	const seedRemoteBinary = (path: string, bytes: Uint8Array, lastModified: number): void => {
		const parent = ensureFolderChain(parentOf(path));
		remoteFiles.set(path, {
			uuid: `remote-uuid-${++uuidCounter}`,
			name: baseName(path), parent, size: bytes.length, lastModified,
			data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
		});
	};

	const seedRemoteFolder = (path: string): void => {
		ensureFolderChain(path);
	};

	const eventsControl = {
		get dirTreeCalls() { return dirTreeCalls; },
		get eventsCalls() { return eventsCalls; },
		get lastEventsTimestamp() { return lastEventsTimestamp; },
		setEvents(events: Array<{ id: number; type: string; timestamp: number }>) {
			eventsToReturn = events;
			eventsError = null;
		},
		failEvents(error: Error) {
			eventsError = error;
		},
	};

	return {
		client: client as unknown as FilenClient,
		seedRemote,
		seedRemoteBinary,
		seedRemoteFolder,
		remoteFiles,
		renameCalls,
		moveCalls,
		eventsControl,
		mutations,
	};
}

/* ---------------- harness ---------------- */

export function makeEngine(conflictResolver?: ConflictResolver) {
	const vault = new FakeVault();
	const storage = new Map<string, string | null>();
	const app = {
		vault,
		loadLocalStorage: (key: string) => storage.get(key) ?? null,
		saveLocalStorage: (key: string, value: string | null) => {
			storage.set(key, value);
		},
	} as unknown as App;
	const {
		client, seedRemote, seedRemoteBinary, seedRemoteFolder,
		remoteFiles, renameCalls, moveCalls, eventsControl, mutations,
	} = makeMockClient();
	const credentials: StoredCredentials = {
		apiKey: "api-key",
		masterKeys: ["master-key"],
		authVersion: 2,
		rootUuid: ROOT,
		syncRootUuid: ROOT,
		email: "user@example.com",
	};
	const settings = {
		conflictPolicy: "keep_both",
		conflictResolution: "auto",
		fastRemotePolling: false,
		massChangeGuard: true,
		massChangeAbortPercent: 100,
		excludeDotFiles: true,
		ignorePatterns: "",
		skipLargeFiles: true,
		skipSizeLargerThanMB: 50,
		syncConfigDir: false,
		configSyncAllowlist: [
			"appearance.json",
			"hotkeys.json",
			"community-plugins.json",
			"core-plugins.json",
			"snippets",
		],
	} as FilenSyncSettings;
	const notices: string[] = [];
	const log = new SyncLog(app);
	const engine = new SyncEngine(
		app,
		client,
		() => settings,
		() => credentials,
		log,
		message => notices.push(message),
		conflictResolver ?? null,
	);
	return {
		engine, vault, app, seedRemote, seedRemoteBinary, seedRemoteFolder,
		remoteFiles, renameCalls, moveCalls, eventsControl, mutations, notices, log, settings,
	};
}

