/**
 * Engine two-run test (keep_both conflict): when the LOCAL side wins, the
 * remote loser is downloaded as "name (conflict …).ext" WITHOUT a base
 * record — so run 2 must treat the conflict copy as a new local file and
 * upload it, never trash it. Runs against a fake in-memory vault + a
 * stateful mock Filen client (obsidian is aliased to tests/mocks).
 */

import { describe, expect, it } from "vitest";
import type { App, Vault } from "obsidian";
import type { FilenClient } from "../src/filen/client";
import { sha512Hex } from "../src/filen/crypto";
import type { StoredCredentials } from "../src/filen/types";
import { ConflictPromptRequest, ConflictResolver, SyncEngine } from "../src/sync/engine";
import { SyncLog } from "../src/sync/log";
import { emptyState, loadState, saveState } from "../src/sync/state";
import type { FilenSyncSettings } from "../src/settings";
import { conflictPathFor, utf8ToBytes } from "../src/util";

const T0 = 1_700_000_000_000;
const ROOT = "root-uuid";

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

class FakeVault {
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
			// Folders are explicit (mkdir) OR implied by files beneath them,
			// matching a real filesystem.
			const prefix = folder + "/";
			const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
			const impliedFolders = new Set<string>(this.folderSet);
			for (const p of this.contents.keys()) {
				if (!p.startsWith(prefix)) continue;
				const rest = p.slice(prefix.length);
				const slash = rest.indexOf("/");
				if (slash > 0) impliedFolders.add(prefix + rest.slice(0, slash));
			}
			return {
				files: [...this.contents.keys()].filter(direct),
				folders: [...impliedFolders].filter(direct),
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

interface RemoteEntry {
	uuid: string;
	name: string;
	parent: string;
	size: number;
	lastModified: number;
	data: ArrayBuffer;
}

function makeMockClient() {
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
		uploadFile: async (parent: string, name: string, data: ArrayBuffer, lastModified: number) => {
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
		downloadFile: async (location: { uuid: string }) => {
			const entry = [...remoteFiles.values()].find(f => f.uuid === location.uuid)
				?? versions.get(location.uuid);
			if (!entry) throw new Error(`unknown remote uuid ${location.uuid}`);
			return { data: entry.data.slice(0), verified: true };
		},
		fileTrash: async (uuid: string) => {
			for (const [key, entry] of remoteFiles) {
				if (entry.uuid === uuid) remoteFiles.delete(key);
			}
		},
		fileRename: async (uuid: string, newName: string) => {
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
			const uuid = `dir-${++uuidCounter}`;
			const parentPath = folderPathOf(parent);
			folderInfo.set(uuid, {
				path: parentPath === "" ? name : `${parentPath}/${name}`,
				parent,
			});
			return uuid;
		},
		dirTrash: async () => undefined,
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
	};
}

/* ---------------- harness ---------------- */

function makeEngine(conflictResolver?: ConflictResolver) {
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
		remoteFiles, renameCalls, moveCalls, eventsControl,
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
		remoteFiles, renameCalls, moveCalls, eventsControl, notices, log, settings,
	};
}

/* ---------------- test ---------------- */

describe("keep_both conflict, local winner — two runs", () => {
	it("run 1 downloads the remote loser as a conflict copy; run 2 uploads it (never trashes it)", async () => {
		const { engine, vault, app, seedRemote, notices } = makeEngine();

		// Base state: note.md previously synced at T0 with remote uuid u-old.
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["note.md"] = {
			localMtime: T0, localSize: 3, remoteUuid: "u-old", remoteMtime: T0, remoteSize: 3,
		};
		saveState(app, state);

		// Both sides changed since: local is NEWER (winner), remote older (loser).
		vault.addFile("note.md", "local version", T0 + 5000);
		seedRemote("note.md", "remote version", T0 + 3000);

		const conflictPath = conflictPathFor("note.md", T0 + 3000);

		/* ---- run 1 ---- */
		const run1 = await engine.run({ manual: true });
		expect(run1.status).toBe("ok");
		expect(run1.plan?.conflicts).toHaveLength(1);
		expect(run1.plan?.conflicts[0]?.winner).toBe("local");

		// Local winner keeps the original name; remote loser landed as a copy.
		expect(vault.textOf("note.md")).toBe("local version");
		expect(vault.hasFile(conflictPath)).toBe(true);
		expect(vault.textOf(conflictPath)).toBe("remote version");

		/* ---- run 2 ---- */
		const run2 = await engine.run({ manual: true });
		expect(run2.status).toBe("ok");
		const ops = run2.plan?.ops ?? [];

		// The conflict copy survived and is planned for UPLOAD (new local file),
		// never for deletion on either side.
		expect(vault.hasFile(conflictPath)).toBe(true);
		expect(ops.some(op => op.kind === "upload" && op.path === conflictPath)).toBe(true);
		expect(ops.some(op => op.kind === "trashLocal" && op.path === conflictPath)).toBe(false);
		expect(ops.some(op => op.kind === "trashRemote" && op.path === conflictPath)).toBe(false);

		// No error notices surfaced in either run.
		expect(notices.filter(n => /fail|error/i.test(n))).toHaveLength(0);
	});
});

/* ---------------- rename detection (feature D) ---------------- */

describe("rename detection — engine", () => {
	it("renames remotely instead of delete+upload; renameRemote executes before deletes; base moves", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, renameCalls, moveCalls } = makeEngine();

		// Two previously-synced files; one renamed locally, one deleted locally.
		seedRemote("old.md", "same content", T0);
		seedRemote("trash-me.md", "other stuff", T0);
		const oldUuid = (remoteFiles.get("old.md") as RemoteEntry).uuid;
		const trashUuid = (remoteFiles.get("trash-me.md") as RemoteEntry).uuid;
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["old.md"] = {
			localMtime: T0, localSize: 12, remoteUuid: oldUuid, remoteMtime: T0, remoteSize: 12,
		};
		state.files["trash-me.md"] = {
			localMtime: T0, localSize: 11, remoteUuid: trashUuid, remoteMtime: T0, remoteSize: 11,
		};
		saveState(app, state);
		vault.addFile("new.md", "same content", T0);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		const ops = run.plan?.ops ?? [];

		// Planned as a rename, never as delete+upload.
		expect(ops.some(op => op.kind === "renameRemote" && op.path === "old.md" && op.toPath === "new.md")).toBe(true);
		expect(ops.some(op => op.kind === "upload" && op.path === "new.md")).toBe(false);
		expect(ops.some(op => op.kind === "trashRemote" && op.path === "old.md")).toBe(false);

		// Phase ordering: the rename op sorts before the unrelated delete.
		const renameIdx = ops.findIndex(op => op.kind === "renameRemote");
		const deleteIdx = ops.findIndex(op => op.kind === "trashRemote");
		expect(renameIdx).toBeGreaterThanOrEqual(0);
		expect(deleteIdx).toBeGreaterThan(renameIdx);

		// Executed server-side: same uuid, new name. Same parent dir → NO move call.
		expect(renameCalls).toEqual([{ uuid: oldUuid, newName: "new.md" }]);
		expect(moveCalls).toEqual([]);
		expect(remoteFiles.has("old.md")).toBe(false);
		expect(remoteFiles.has("new.md")).toBe(true);
		expect((remoteFiles.get("new.md") as RemoteEntry).uuid).toBe(oldUuid);

		// Base record moved old.md → new.md (same remote uuid).
		const base = loadState(app).files;
		expect(base["old.md"]).toBeUndefined();
		expect(base["new.md"]?.remoteUuid).toBe(oldUuid);
		expect(base["trash-me.md"]).toBeUndefined();

		// Run 2: everything up to date — the rename did not confuse the base.
		const run2 = await engine.run({ manual: true });
		expect(run2.status).toBe("empty");
	});

	it("rename into a different folder fires fileMove exactly once (parent change)", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, renameCalls, moveCalls } = makeEngine();
		seedRemote("old.md", "same content", T0);
		const oldUuid = (remoteFiles.get("old.md") as RemoteEntry).uuid;
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["old.md"] = {
			localMtime: T0, localSize: 12, remoteUuid: oldUuid, remoteMtime: T0, remoteSize: 12,
		};
		saveState(app, state);
		vault.addFile("sub/new.md", "same content", T0);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(renameCalls).toEqual([{ uuid: oldUuid, newName: "new.md" }]);
		// Parent changed (root → sub/): exactly one move, to the folder the
		// engine created for the chain (mock dirCreate hands out dir-<n>).
		expect(moveCalls).toEqual([{ uuid: oldUuid, to: "dir-2" }]);
		const base = loadState(app).files;
		expect(base["old.md"]).toBeUndefined();
		expect(base["sub/new.md"]?.remoteUuid).toBe(oldUuid);
	});

	it("cancel flag stops the run cleanly and reports canceled", async () => {
		const { engine, vault, app, seedRemote } = makeEngine();
		seedRemote("a.md", "aaa", T0);
		seedRemote("b.md", "bbb", T0);
		seedRemote("c.md", "ccc", T0);
		vault.addFile("keep.md", "local", T0);
		const run = await engine.run({ manual: true, isCancelled: () => true });
		expect(run.status).toBe("aborted");
		expect(run.message).toContain("canceled");
		// State persisted (no crash); nothing downloaded because the cancel
		// flag was set before the first op.
		expect(vault.hasFile("a.md")).toBe(false);
	});
});

/* ---------------- config dir sync (v0.4.0 feature A) ---------------- */

describe("config dir sync — engine adapter IO", () => {
	it("uploads an allowlisted config file via the adapter; remote change downloads via adapter with mtime", async () => {
		const { engine, vault, app, remoteFiles, settings } = makeEngine();
		settings.syncConfigDir = true;
		const path = ".obsidian/appearance.json";

		// Config file exists ONLY through the adapter (Vault-API invisible).
		vault.addFile(path, "{\"accent\":\"blue\"}", T0);
		expect(vault.getFileByPath(path)).toBeNull(); // proves adapter-only visibility

		/* ---- run 1: upload through adapter.readBinary ---- */
		const run1 = await engine.run({ manual: true });
		expect(run1.status).toBe("ok");
		expect(run1.plan?.counts.uploads).toBe(1);
		expect(remoteFiles.has(path)).toBe(true);
		const base1 = loadState(app).files[path];
		expect(base1?.localMtime).toBe(T0);
		expect(base1?.localSize).toBe(17);

		/* ---- remote side changes → download through adapter.writeBinary ---- */
		const remoteEntry = remoteFiles.get(path) as RemoteEntry;
		const changed = utf8ToBytes("{\"accent\":\"red\"}");
		remoteFiles.set(path, {
			...remoteEntry,
			uuid: "remote-uuid-changed",
			lastModified: T0 + 5000,
			size: changed.length,
			data: changed.buffer.slice(0) as ArrayBuffer,
		});
		const run2 = await engine.run({ manual: true });
		expect(run2.status).toBe("ok");
		expect(run2.plan?.counts.downloads).toBe(1);
		expect(vault.textOf(path)).toBe("{\"accent\":\"red\"}");
		// Remote mtime preserved through the adapter write {mtime} option.
		const stat = await vault.adapter.stat(path);
		expect(stat?.mtime).toBe(T0 + 5000);

		/* ---- run 3: everything up to date ---- */
		const run3 = await engine.run({ manual: true });
		expect(run3.status).toBe("empty");
	});

	it("syncConfigDir off → config files never enter the plan", async () => {
		const { engine, vault } = makeEngine();
		vault.addFile(".obsidian/appearance.json", "{}", T0);
		vault.addFile("note.md", "hello", T0);
		const run = await engine.run({ manual: true });
		expect(run.plan?.ops.every(op => !op.path.startsWith(".obsidian"))).toBe(true);
		expect(run.plan?.counts.uploads).toBe(1); // only note.md
	});
});

/* ---------------- events-based fast polling (v0.4.0 feature D) ---------------- */

describe("events-based fast polling", () => {
	/** Settle both sides on one synced file and return its base state. */
	const setupSyncedFile = (
		vault: ReturnType<typeof makeEngine>["vault"],
		seedRemote: ReturnType<typeof makeEngine>["seedRemote"],
		remoteFiles: ReturnType<typeof makeEngine>["remoteFiles"],
		app: ReturnType<typeof makeEngine>["app"],
	): void => {
		vault.addFile("note.md", "hello", T0);
		seedRemote("note.md", "hello", T0);
		const uuid = (remoteFiles.get("note.md") as RemoteEntry).uuid;
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["note.md"] = {
			localMtime: T0, localSize: 5, remoteUuid: uuid, remoteMtime: T0, remoteSize: 5,
		};
		saveState(app, state);
	};

	it("zero events + fresh cache → cache hit skips dirTree entirely", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		eventsControl.setEvents([]);
		setupSyncedFile(vault, seedRemote, remoteFiles, app);

		// Run 1 (manual): always a full fetch — builds the cache.
		const run1 = await engine.run({ manual: true });
		expect(run1.status).toBe("empty");
		expect(eventsControl.dirTreeCalls).toBe(1);
		expect(eventsControl.eventsCalls).toBe(0); // manual runs skip the probe
		const cache = loadState(app).remoteTreeCache;
		expect(cache).toBeTruthy();
		expect(cache?.files["note.md"]).toBeTruthy();
		expect(cache?.eventWatermark).toBeGreaterThan(0);

		// Run 2 (auto): zero events + fresh cache → NO dirTree call.
		const run2 = await engine.run({ manual: false });
		expect(run2.status).toBe("empty");
		expect(eventsControl.eventsCalls).toBe(1);
		expect(eventsControl.lastEventsTimestamp).toBe(cache?.eventWatermark);
		expect(eventsControl.dirTreeCalls).toBe(1); // unchanged — cache hit
	});

	it("probe failure NEVER trusts silence → full dirTree fetch", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		eventsControl.setEvents([]);
		setupSyncedFile(vault, seedRemote, remoteFiles, app);
		await engine.run({ manual: true }); // builds cache
		expect(eventsControl.dirTreeCalls).toBe(1);

		eventsControl.failEvents(new Error("network down"));
		const run2 = await engine.run({ manual: false });
		expect(run2.status).toBe("empty");
		expect(eventsControl.dirTreeCalls).toBe(2); // forced full fetch
	});

	it("manual runs ALWAYS fetch the full tree, even with a fresh cache", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		eventsControl.setEvents([]);
		setupSyncedFile(vault, seedRemote, remoteFiles, app);
		await engine.run({ manual: true });
		expect(eventsControl.dirTreeCalls).toBe(1);

		const run2 = await engine.run({ manual: true });
		expect(run2.status).toBe("empty");
		expect(eventsControl.dirTreeCalls).toBe(2); // freshness guarantee
		expect(eventsControl.eventsCalls).toBe(0);
	});

	it("stale cache (> 30 min) is refetched even with zero events", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		eventsControl.setEvents([]);
		setupSyncedFile(vault, seedRemote, remoteFiles, app);
		await engine.run({ manual: true });
		expect(eventsControl.dirTreeCalls).toBe(1);

		// Age the cache past the 30-minute TTL.
		const state = loadState(app);
		if (state.remoteTreeCache) {
			state.remoteTreeCache.fetchedAt = Date.now() - 31 * 60 * 1000;
		}
		saveState(app, state);

		const run2 = await engine.run({ manual: false });
		expect(run2.status).toBe("empty");
		expect(eventsControl.eventsCalls).toBe(1); // probe still ran
		expect(eventsControl.dirTreeCalls).toBe(2); // but the tree was refetched
	});

	it("events present → full fetch, watermark = max event timestamp (seconds → ms)", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		setupSyncedFile(vault, seedRemote, remoteFiles, app);
		await engine.run({ manual: true });
		eventsControl.setEvents([
			{ id: 1, type: "fileUploaded", timestamp: 1_700_000_100 }, // seconds
			{ id: 2, type: "fileTrash", timestamp: 1_700_000_200 },
		]);
		const run2 = await engine.run({ manual: false });
		expect(run2.status).toBe("empty");
		expect(eventsControl.dirTreeCalls).toBe(2);
		expect(loadState(app).remoteTreeCache?.eventWatermark).toBe(1_700_000_200 * 1000);
	});

	it("remote-folder pruning is skipped when the tree came from cache", async () => {
		const { engine, app, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		eventsControl.setEvents([]);

		// Craft: base tracks folder/note.md, both sides lost the file, but the
		// (cached) remote still has the now-empty "folder" dir. A fresh tree
		// would prune it; the cached tree must NOT.
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["folder/note.md"] = {
			localMtime: T0, localSize: 3, remoteUuid: "u-gone", remoteMtime: T0, remoteSize: 3,
		};
		state.remoteTreeCache = {
			fetchedAt: Date.now(),
			eventWatermark: Date.now(),
			files: {},
			folders: { "": ROOT, "folder": "folder-uuid-1" },
		};
		saveState(app, state);

		const run = await engine.run({ manual: false });
		expect(eventsControl.dirTreeCalls).toBe(0); // cache hit
		const ops = run.plan?.ops ?? [];
		expect(ops.some(op => op.kind === "dropBase" && op.path === "folder/note.md")).toBe(true);
		expect(ops.some(op => op.kind === "trashRemoteDir")).toBe(false); // prune skipped
	});

	it("the same scenario on a FRESH tree does prune the remote folder (control)", async () => {
		const { engine, app, seedRemoteFolder, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		seedRemoteFolder("folder"); // empty remote folder, base evidence below
		eventsControl.setEvents([{ id: 1, type: "fileTrash", timestamp: 1_700_000_300 }]);

		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["folder/note.md"] = {
			localMtime: T0, localSize: 3, remoteUuid: "u-gone", remoteMtime: T0, remoteSize: 3,
		};
		saveState(app, state);

		const run = await engine.run({ manual: false });
		expect(eventsControl.dirTreeCalls).toBe(1); // events → full fetch
		const ops = run.plan?.ops ?? [];
		expect(ops.some(op => op.kind === "trashRemoteDir" && op.path === "folder")).toBe(true);
	});

	it("fastRemotePolling off → no probe, always full fetch", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = false;
		setupSyncedFile(vault, seedRemote, remoteFiles, app);
		await engine.run({ manual: false });
		await engine.run({ manual: false });
		expect(eventsControl.eventsCalls).toBe(0);
		expect(eventsControl.dirTreeCalls).toBe(2);
	});
});

/* ---------------- conflict merge "ask" mode (v0.4.0 feature E) ---------------- */

describe("conflict merge ask mode", () => {
	/** Both sides changed note.md since base; local is newer. Returns the old remote uuid. */
	const setupConflict = (
		vault: ReturnType<typeof makeEngine>["vault"],
		seedRemote: ReturnType<typeof makeEngine>["seedRemote"],
		remoteFiles: ReturnType<typeof makeEngine>["remoteFiles"],
		app: ReturnType<typeof makeEngine>["app"],
	): string => {
		vault.addFile("note.md", "local version", T0 + 5000);
		seedRemote("note.md", "remote version", T0 + 3000);
		const uuid = (remoteFiles.get("note.md") as RemoteEntry).uuid;
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["note.md"] = {
			localMtime: T0, localSize: 3, remoteUuid: "u-old", remoteMtime: T0, remoteSize: 3,
		};
		saveState(app, state);
		return uuid;
	};

	const textOfRemote = (remoteFiles: Map<string, RemoteEntry>, path: string): string =>
		new TextDecoder().decode((remoteFiles.get(path) as RemoteEntry).data);

	it("keep local → upload with remote loser trashed after; no conflict copy", async () => {
		const prompts: ConflictPromptRequest[] = [];
		const resolver: ConflictResolver = async req => {
			prompts.push(req);
			return "keep_local";
		};
		const { engine, vault, app, seedRemote, remoteFiles, settings } = makeEngine(resolver);
		settings.conflictResolution = "ask";
		const oldUuid = setupConflict(vault, seedRemote, remoteFiles, app);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.path).toBe("note.md");
		expect(prompts[0]?.localText).toBe("local version");
		expect(prompts[0]?.remoteText).toBe("remote version");
		expect(prompts[0]?.localMtime).toBe(T0 + 5000);
		expect(prompts[0]?.remoteMtime).toBe(T0 + 3000);

		const ops = run.plan?.ops ?? [];
		const uploads = ops.filter(op => op.kind === "upload" && op.path === "note.md");
		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.trashRemoteUuidAfter).toBe(oldUuid);
		expect(ops.some(op => op.kind === "download")).toBe(false);
		expect(ops.some(op => op.path.includes(" (conflict "))).toBe(false);

		expect(vault.textOf("note.md")).toBe("local version");
		expect(textOfRemote(remoteFiles, "note.md")).toBe("local version");
	});

	it("keep remote → local loser trashed + downloaded; no conflict copy", async () => {
		const resolver: ConflictResolver = async () => "keep_remote";
		const { engine, vault, app, seedRemote, remoteFiles, settings } = makeEngine(resolver);
		settings.conflictResolution = "ask";
		setupConflict(vault, seedRemote, remoteFiles, app);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		const ops = run.plan?.ops ?? [];
		expect(ops.some(op => op.kind === "trashLocal" && op.path === "note.md")).toBe(true);
		expect(ops.some(op => op.kind === "download" && op.path === "note.md")).toBe(true);
		expect(ops.some(op => op.kind === "upload")).toBe(false);
		expect(ops.some(op => op.path.includes(" (conflict "))).toBe(false);

		expect(vault.textOf("note.md")).toBe("remote version");
		expect(textOfRemote(remoteFiles, "note.md")).toBe("remote version");
	});

	it("keep both → exactly the default policy behavior (conflict copy)", async () => {
		const resolver: ConflictResolver = async () => "keep_both";
		const { engine, vault, app, seedRemote, remoteFiles, settings } = makeEngine(resolver);
		settings.conflictResolution = "ask";
		setupConflict(vault, seedRemote, remoteFiles, app);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		const conflictPath = conflictPathFor("note.md", T0 + 3000);
		expect(vault.textOf("note.md")).toBe("local version");
		expect(vault.textOf(conflictPath)).toBe("remote version"); // policy behavior
		expect(textOfRemote(remoteFiles, "note.md")).toBe("local version");
	});

	it("concat → merged local file uploads as a new version; remote never trashed", async () => {
		const resolver: ConflictResolver = async () => "concat";
		const { engine, vault, app, seedRemote, remoteFiles, settings } = makeEngine(resolver);
		settings.conflictResolution = "ask";
		setupConflict(vault, seedRemote, remoteFiles, app);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		const ops = run.plan?.ops ?? [];
		const uploads = ops.filter(op => op.kind === "upload" && op.path === "note.md");
		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.trashRemoteUuidAfter).toBeUndefined(); // remote untouched
		expect(ops.some(op => op.kind === "download")).toBe(false);

		const merged = "local version\n\n---\n\nremote version";
		expect(vault.textOf("note.md")).toBe(merged);
		expect(textOfRemote(remoteFiles, "note.md")).toBe(merged);
	});

	it("binary conflict → resolver NOT called, auto policy applies silently", async () => {
		let called = 0;
		const resolver: ConflictResolver = async () => {
			called++;
			return "keep_local";
		};
		const { engine, vault, app, seedRemoteBinary, settings } = makeEngine(resolver);
		settings.conflictResolution = "ask";
		vault.addBinaryFile("blob.bin", new Uint8Array([0xff, 0xfe, 0x41, 0x00]), T0 + 5000);
		seedRemoteBinary("blob.bin", new Uint8Array([0xff, 0xfe, 0x42, 0x01]), T0 + 3000);
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["blob.bin"] = {
			localMtime: T0, localSize: 3, remoteUuid: "u-old", remoteMtime: T0, remoteSize: 3,
		};
		saveState(app, state);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(called).toBe(0); // binary → silent auto fallback
		// keep_both auto policy: remote version lands as a conflict copy.
		expect(vault.hasFile(conflictPathFor("blob.bin", T0 + 3000))).toBe(true);
	});

	it("auto mode never invokes the resolver", async () => {
		let called = 0;
		const resolver: ConflictResolver = async () => {
			called++;
			return "keep_local";
		};
		const { engine, vault, app, seedRemote, remoteFiles, settings } = makeEngine(resolver);
		settings.conflictResolution = "auto";
		setupConflict(vault, seedRemote, remoteFiles, app);
		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(called).toBe(0);
	});

	it("closing the merge view maps to keep both", async () => {
		const { ConflictMergeModal } = await import("../src/ui/conflictMerge");
		let decision: string | null = null;
		const modal = new ConflictMergeModal(
			new (await import("obsidian")).App(),
			{
				path: "note.md",
				localText: "local",
				remoteText: "remote",
				localMtime: T0,
				localSize: 5,
				remoteMtime: T0,
				remoteSize: 6,
			},
			d => {
				decision = d;
			},
		);
		// onClose without a button choice = keep both (never data-lossy).
		(modal as unknown as { contentEl: { empty: () => void } }).contentEl = { empty: () => undefined };
		modal.onClose();
		expect(decision).toBe("keep_both");
	});
});

/* ---------------- v0.4.0 review fixes (B1-adjacent engine fixes) ---------------- */

describe("v0.4.0 review fixes", () => {
	it("M2: renaming a synced config file renames remotely via adapter stat (no Vault-API crash)", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, renameCalls, settings } = makeEngine();
		settings.syncConfigDir = true;
		const oldPath = ".obsidian/snippets/a.css";
		const newPath = ".obsidian/snippets/b.css";
		seedRemote(oldPath, "body{}", T0);
		const oldUuid = (remoteFiles.get(oldPath) as RemoteEntry).uuid;
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files[oldPath] = {
			localMtime: T0, localSize: 6, remoteUuid: oldUuid, remoteMtime: T0, remoteSize: 6,
		};
		saveState(app, state);
		vault.addFile(newPath, "body{}", T0); // adapter-only visibility (config)

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(renameCalls).toEqual([{ uuid: oldUuid, newName: "b.css" }]);
		const base = loadState(app).files;
		expect(base[oldPath]).toBeUndefined();
		expect(base[newPath]?.remoteUuid).toBe(oldUuid);
	});

	it("M3: disabling config sync protects synced config files (no ops, base kept, remote untouched)", async () => {
		const { engine, vault, app, remoteFiles, settings } = makeEngine();
		settings.syncConfigDir = true;
		const path = ".obsidian/appearance.json";
		vault.addFile(path, "{}", T0);
		const run1 = await engine.run({ manual: true });
		expect(run1.plan?.counts.uploads).toBe(1);

		settings.syncConfigDir = false; // user turns the feature off
		const run2 = await engine.run({ manual: true });
		expect(run2.status).toBe("empty");
		expect(run2.plan?.ops.every(op => !op.path.startsWith(".obsidian"))).toBe(true);
		expect(loadState(app).files[path]).toBeDefined(); // base preserved
		expect(remoteFiles.has(path)).toBe(true); // remote copy NOT trashed

		// Re-enabling resumes from the intact base (no conflict duplicates).
		settings.syncConfigDir = true;
		const run3 = await engine.run({ manual: true });
		expect(run3.status).toBe("empty");
		expect(run3.plan?.conflicts).toHaveLength(0);
	});

	it("m3: failed events probe anchors the watermark at fetch start", async () => {
		const { engine, vault, app, seedRemote, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		seedRemote("a.md", "aaa", T0);
		vault.addFile("b.md", "bbb", T0);
		eventsControl.failEvents(new Error("boom"));
		const t0 = Date.now() - 1;
		const run = await engine.run({ manual: false });
		expect(run.status).toBe("ok");
		const cache = loadState(app).remoteTreeCache;
		expect(cache).toBeTruthy();
		expect(cache?.eventWatermark).toBeGreaterThanOrEqual(t0);
		expect(cache?.eventWatermark).toBeLessThanOrEqual(Date.now());
	});

	it("m4: memory-only mode never persists the tree cache but still uses it in-session", async () => {
		const { engine, vault, app, seedRemote, eventsControl, settings } = makeEngine();
		settings.fastRemotePolling = true;
		settings.memoryOnlyCredentials = true;
		seedRemote("a.md", "aaa", T0);
		vault.addFile("a.md", "aaa", T0);
		const run1 = await engine.run({ manual: true }); // manual = full fetch, builds cache
		expect(run1.status).toBe("empty"); // identical a.md both sides → nothing to do
		expect(eventsControl.dirTreeCalls).toBe(1);
		// Persisted state must NOT carry the cache (it holds per-file keys).
		expect(loadState(app).remoteTreeCache ?? null).toBeNull();
		// But the in-session shadow serves the next auto run: no refetch.
		eventsControl.setEvents([]);
		const run2 = await engine.run({ manual: false });
		expect(run2.status).toBe("empty");
		expect(eventsControl.dirTreeCalls).toBe(1);
		expect(loadState(app).remoteTreeCache ?? null).toBeNull();
	});

	it("m5: skippedCount reports excluded paths without double counting", async () => {
		const { engine, vault } = makeEngine();
		vault.addFile("visible.md", "hi", T0);
		vault.addFile(".hidden.md", "secret", T0); // excluded via dotfile rule
		const run = await engine.run({ manual: true });
		expect(run.skippedCount).toBe(1);
	});
});

/* ---------------- v0.5.0: shared-preferences file never synced ---------------- */

describe("shared-preferences file exclusion — engine (v0.5.0)", () => {
	it("remote prefs file is never downloaded or planned; run exposes the remote tree", async () => {
		const { engine, vault, seedRemote } = makeEngine();
		seedRemote(".filen-cloud-sync-preferences.json", "{\"version\":1}", T0);
		vault.addFile("note.md", "hello", T0);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");

		// Never downloaded as vault content…
		expect(vault.hasFile(".filen-cloud-sync-preferences.json")).toBe(false);
		// …never planned in ANY op…
		const ops = run.plan?.ops ?? [];
		expect(ops.some(op => op.path === ".filen-cloud-sync-preferences.json"
			|| op.toPath === ".filen-cloud-sync-preferences.json")).toBe(false);
		// …but still visible in the run's remote tree (main.ts's post-run
		// shared-prefs check reads it from here — no extra API call).
		expect(run.remoteTree?.files.has(".filen-cloud-sync-preferences.json")).toBe(true);
		// Real files sync normally around it.
		expect(ops.some(op => op.kind === "upload" && op.path === "note.md")).toBe(true);
	});

	it("local prefs file is never uploaded, even with dotfiles allowed", async () => {
		const { engine, vault, remoteFiles, settings } = makeEngine();
		settings.excludeDotFiles = false;
		vault.addFile(".filen-cloud-sync-preferences.json", "{\"version\":1}", T0);
		vault.addFile("note.md", "hello", T0);

		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		const ops = run.plan?.ops ?? [];
		expect(ops.some(op => op.path === ".filen-cloud-sync-preferences.json")).toBe(false);
		expect(remoteFiles.has(".filen-cloud-sync-preferences.json")).toBe(false);
		expect(remoteFiles.has("note.md")).toBe(true);
	});
});

/* ---------------- v0.6.8 live-bug fixes ---------------- */

describe("v0.6.8 — internal .filen-* files never sync (live wedge bug)", () => {
	// The exact production failure: a legacy `.filen-sync-preferences.json`
	// (pre-rename shared-prefs file) sat on the remote drive AND on local disk.
	// The vault index can't see dotfiles → atomicWrite took the new-file path →
	// rename onto an existing file failed → "Destination file already exists"
	// every run, forever. Now: no ops are planned for root .filen-* at all.
	it("legacy prefs file on both sides → zero ops, no errors (dotfiles on)", async () => {
		const { engine, vault, app, seedRemote } = makeEngine();
		seedRemote(".filen-sync-preferences.json", "{\"legacy\":true}", T0 + 5000);
		vault.addFile(".filen-sync-preferences.json", "{\"legacy\":true}", T0);
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		saveState(app, state);
		const run = await engine.run({ manual: true });
		expect(run.status).toBe("empty");
		expect(run.plan?.ops ?? []).toHaveLength(0);
		expect((run.plan?.ops ?? []).some(op => op.path.includes(".filen-"))).toBe(false);
	});

	it("same wedge scenario with excludeDotFiles OFF → still zero ops", async () => {
		const { engine, vault, app, seedRemote, settings } = makeEngine();
		settings.excludeDotFiles = false;
		seedRemote(".filen-sync-preferences.json", "{\"legacy\":true}", T0 + 5000);
		vault.addFile(".filen-sync-preferences.json", "{\"legacy\":true}", T0);
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		saveState(app, state);
		const run = await engine.run({ manual: true });
		expect((run.plan?.ops ?? []).some(op => op.path.includes(".filen-"))).toBe(false);
		expect(run.status === "empty" || run.status === "ok").toBe(true);
	});

	it("the CURRENT prefs file is likewise never planned", async () => {
		const { engine, vault, app, seedRemote } = makeEngine();
		seedRemote(".filen-cloud-sync-preferences.json", "{\"v\":1}", T0);
		vault.addFile("note.md", "hello", T0);
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		saveState(app, state);
		const run = await engine.run({ manual: true });
		expect(run.plan?.ops.some(op => op.path === ".filen-cloud-sync-preferences.json")).toBe(false);
		expect(run.plan?.ops.some(op => op.kind === "upload" && op.path === "note.md")).toBe(true);
	});

	it("our own plugin folder never syncs via the plugins preset", async () => {
		const { engine, vault, app, settings } = makeEngine();
		settings.syncConfigDir = true;
		settings.configSyncAllowlist = ["plugins"];
		vault.addFile(".obsidian/plugins/filen-cloud-sync/data.json", "{}", T0);
		vault.addFile(".obsidian/plugins/other-plugin/data.json", "{}", T0);
		vault.addFile(".obsidian/plugins/filen-sync/data.json", "{}", T0); // legacy id
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		saveState(app, state);
		const run = await engine.run({ manual: true });
		const paths = (run.plan?.ops ?? []).map(op => op.path);
		expect(paths.some(p => p.includes("plugins/filen-cloud-sync"))).toBe(false);
		expect(paths.some(p => p.includes("plugins/filen-sync/"))).toBe(false);
		expect(paths.some(p => p.includes("plugins/other-plugin"))).toBe(true);
	});
});
