/**
 * Self-test stage logic (v0.4.0 feature B) against a stateful mock Filen
 * client: happy path runs all five stages, a stage failure aborts the rest
 * with the exact error, and cleanup is best-effort even on failure.
 */

import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { FilenClient } from "../src/filen/client";
import type { DirTreeFileTuple, DirTreeFolderTuple } from "../src/filen/types";
import { runSelfTest } from "../src/ui/selfTest";
import { SyncLog } from "../src/sync/log";

const ROOT = "root-uuid";
const DEVICE = "2f4c6f30-9c8b-4c8e-9b1a-7a0d3f1e2c4b";

interface MockOptions {
	failStage?: "account" | "roundtrip" | "cleanup";
	cleanupThrows?: boolean;
}

function makeMockClient(opts: MockOptions = {}) {
	const folders: DirTreeFolderTuple[] = [[ROOT, "default", "base"]];
	const files: DirTreeFileTuple[] = [];
	const uploads = new Map<string, { name: string; parent: string; data: ArrayBuffer }>();
	const trashed: string[] = [];
	let counter = 0;

	const client = {
		userAccount: async () => {
			if (opts.failStage === "account") throw new Error("invalid API key");
			return { email: "user@example.com", storage: 1234, maxStorage: 10 * 1024 ** 3 };
		},
		dirCreate: async (name: string, parent: string) => {
			const uuid = `folder-${++counter}`;
			folders.push([uuid, `enc-name:${name}`, parent]);
			return uuid;
		},
		uploadFile: async (parent: string, name: string, data: ArrayBuffer) => {
			const uuid = `file-${++counter}`;
			uploads.set(uuid, { name, parent, data: data.slice(0) });
			files.push([uuid, "bucket", "region", 1, parent, `enc-meta:${uuid}`, 2, 0]);
			return {
				uuid, chunks: 1, size: data.byteLength, hash: "",
				bucket: "bucket", region: "region", lastModified: 1700000000000,
			};
		},
		dirTree: async () => ({ files: [...files], folders: [...folders] }),
		decryptFolderName: async (enc: string) => enc.slice("enc-name:".length),
		decryptFileMetadata: async (enc: string) => {
			const uuid = enc.slice("enc-meta:".length);
			const upload = uploads.get(uuid);
			if (!upload) throw new Error(`unknown uuid ${uuid}`);
			return {
				name: upload.name,
				size: upload.data.byteLength,
				mime: "application/octet-stream",
				key: "file-key",
				lastModified: 1700000000000,
			};
		},
		downloadFile: async (location: { uuid: string }) => {
			if (opts.failStage === "roundtrip") throw new Error("egest exploded");
			const upload = uploads.get(location.uuid);
			if (!upload) throw new Error(`unknown uuid ${location.uuid}`);
			return { data: upload.data.slice(0), verified: true };
		},
		dirTrash: async (uuid: string) => {
			if (opts.cleanupThrows) throw new Error("trash exploded");
			trashed.push(uuid);
			if (opts.failStage === "cleanup") return; // server "forgot" to trash
			for (let i = folders.length - 1; i >= 0; i--) {
				if (folders[i]?.[0] === uuid) folders.splice(i, 1);
			}
			for (let i = files.length - 1; i >= 0; i--) {
				if (files[i]?.[4] === uuid) files.splice(i, 1);
			}
		},
	};

	return { client: client as unknown as FilenClient, trashed, uploads };
}

function makeLog(): SyncLog {
	const storage = new Map<string, string | null>();
	const app = {
		loadLocalStorage: (key: string) => storage.get(key) ?? null,
		saveLocalStorage: (key: string, value: string | null) => {
			storage.set(key, value);
		},
	} as unknown as App;
	return new SyncLog(app, () => true); // debug on: info entries recorded
}

describe("self-test (v0.4.0 feature B)", () => {
	it("happy path: all five stages pass, folder created AND trashed", async () => {
		const { client, trashed } = makeMockClient();
		const events: string[] = [];
		const report = await runSelfTest(client, {
			rootUuid: ROOT,
			deviceId: DEVICE,
			log: makeLog(),
			onStage: (index, stage) => events.push(`${index}:${stage.status}`),
		});
		expect(report.passed).toBe(true);
		expect(report.error).toBeUndefined();
		expect(report.stages).toHaveLength(5);
		for (const stage of report.stages) {
			expect(stage.status).toBe("ok");
			expect(stage.durationMs).toBeGreaterThanOrEqual(0);
		}
		expect(report.stages[0]?.detail).toContain("user@example.com");
		expect(report.stages[1]?.detail).toMatch(/^filen-cloud-sync-selftest-/);
		// onStage fired running→ok transitions in order
		expect(events).toContain("0:running");
		expect(events).toContain("0:ok");
		expect(events).toContain("4:ok");
		// exactly one test folder created and trashed
		expect(trashed).toHaveLength(1);
		expect(trashed[0]).toMatch(/^folder-/);
	});

	it("account failure aborts everything with the exact error, nothing created", async () => {
		const { client, trashed } = makeMockClient({ failStage: "account" });
		const report = await runSelfTest(client, { rootUuid: ROOT, deviceId: DEVICE, log: makeLog() });
		expect(report.passed).toBe(false);
		expect(report.error).toBe("Account & quota: invalid API key");
		expect(report.stages[0]?.status).toBe("failed");
		expect(report.stages[0]?.error).toBe("invalid API key");
		expect(report.stages.slice(1).every(s => s.status === "skipped")).toBe(true);
		expect(trashed).toHaveLength(0);
	});

	it("round-trip failure aborts with the exact error AND still trashes the folder", async () => {
		const { client, trashed } = makeMockClient({ failStage: "roundtrip" });
		const report = await runSelfTest(client, { rootUuid: ROOT, deviceId: DEVICE, log: makeLog() });
		expect(report.passed).toBe(false);
		expect(report.error).toBe("Upload/download round-trip: egest exploded");
		expect(report.stages[0]?.status).toBe("ok");
		expect(report.stages[1]?.status).toBe("ok");
		expect(report.stages[2]?.status).toBe("failed");
		expect(report.stages[3]?.status).toBe("skipped");
		expect(report.stages[4]?.status).toBe("skipped");
		// best-effort cleanup ran even though stage 5 never executed
		expect(trashed).toHaveLength(1);
	});

	it("cleanup verification failure reports the exact error", async () => {
		const { client } = makeMockClient({ failStage: "cleanup" });
		const report = await runSelfTest(client, { rootUuid: ROOT, deviceId: DEVICE, log: makeLog() });
		expect(report.passed).toBe(false);
		expect(report.error).toBe("Cleanup: test folder still visible after trash");
	});

	it("best-effort cleanup errors are swallowed (warned), failure still reported", async () => {
		const { client } = makeMockClient({ failStage: "roundtrip", cleanupThrows: true });
		const report = await runSelfTest(client, { rootUuid: ROOT, deviceId: DEVICE, log: makeLog() });
		expect(report.passed).toBe(false);
		expect(report.error).toBe("Upload/download round-trip: egest exploded");
	});

	it("never touches the vault: uploads are exactly one 32 KiB random file", async () => {
		const { client, uploads } = makeMockClient();
		await runSelfTest(client, { rootUuid: ROOT, deviceId: DEVICE, log: makeLog() });
		expect(uploads.size).toBe(1);
		const upload = [...uploads.values()][0];
		expect(upload?.data.byteLength).toBe(32 * 1024);
		expect(upload?.name).toMatch(/^selftest-.*\.bin$/);
	});
});
