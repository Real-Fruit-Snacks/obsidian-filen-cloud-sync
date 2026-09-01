/**
 * v0.6.0 feature C (engine side): upload/download ops emit SyncProgress
 * events with `current: op.path` and `detail: "<done>/<total> chunks"` as
 * chunks complete. The harness mock client is single-chunk, so each
 * transfer op emits exactly one chunk-detail event ("1/1 chunks") before
 * the op-completion event.
 */

import { describe, expect, it } from "vitest";
import type { SyncProgress } from "../src/sync/engine";
import { makeEngine, T0 } from "./harness";

describe("per-file chunk progress — engine (v0.6.0 feature C)", () => {
	it("upload op emits progress with current=path and detail '1/1 chunks'", async () => {
		const { engine, vault } = makeEngine();
		vault.addFile("note.md", "hello", T0);

		const events: SyncProgress[] = [];
		const run = await engine.run({ manual: true, onProgress: p => events.push({ ...p }) });
		expect(run.status).toBe("ok");

		const chunkEvents = events.filter(e => e.detail !== undefined);
		expect(chunkEvents.length).toBe(1);
		expect(chunkEvents[0]).toMatchObject({
			phase: "Uploading",
			current: "note.md",
			detail: "1/1 chunks",
		});
	});

	it("download op emits progress with current=path and detail '1/1 chunks'", async () => {
		const { engine, seedRemote } = makeEngine();
		seedRemote("cloud.md", "from the cloud", T0);

		const events: SyncProgress[] = [];
		const run = await engine.run({ manual: true, onProgress: p => events.push({ ...p }) });
		expect(run.status).toBe("ok");

		const chunkEvents = events.filter(e => e.detail !== undefined);
		expect(chunkEvents.length).toBe(1);
		expect(chunkEvents[0]).toMatchObject({
			phase: "Downloading",
			current: "cloud.md",
			detail: "1/1 chunks",
		});
	});

	it("chunk events do not advance the op counter (done/total unchanged)", async () => {
		const { engine, vault } = makeEngine();
		vault.addFile("a.md", "aaa", T0);
		vault.addFile("b.md", "bbb", T0);

		const events: SyncProgress[] = [];
		const run = await engine.run({ manual: true, onProgress: p => events.push({ ...p }) });
		expect(run.status).toBe("ok");

		// Two ops → two chunk events; each fires while done is still 0 (the
		// op-completion event increments the counter afterwards).
		const chunkEvents = events.filter(e => e.detail !== undefined);
		expect(chunkEvents.length).toBe(2);
		for (const event of chunkEvents) {
			expect(event.total).toBe(2);
			expect(event.done).toBe(0);
		}
		// Op-completion events carry no chunk detail.
		const completionEvents = events.filter(e => e.detail === undefined && e.phase !== "Done");
		expect(completionEvents.some(e => e.done === 2)).toBe(true);
	});

	it("no onProgress option → chunk callbacks are harmless no-ops", async () => {
		const { engine, vault, remoteFiles } = makeEngine();
		vault.addFile("note.md", "hello", T0);
		const run = await engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(remoteFiles.has("note.md")).toBe(true);
	});
});
