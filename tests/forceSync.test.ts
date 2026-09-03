/**
 * v0.8.0 feature 3: engine.forceUploadFile — explicit one-file upload that
 * works in any sync direction, gated by a confirm callback when the remote
 * copy changed since the last sync, blocked while paused.
 */

import { describe, expect, it } from "vitest";
import { SYNC_PAUSED_MESSAGE } from "../src/sync/engine";
import { emptyState, loadState, saveState } from "../src/sync/state";
import { makeEngine, ROOT, T0 } from "./harness";

const CONFIRM = async (): Promise<boolean> => true;
const CANCEL = async (): Promise<boolean> => false;

describe("forceUploadFile (v0.8.0 feature 3)", () => {
	it("uploads a new file, updates the base record and persists state", async () => {
		const { engine, vault, app, remoteFiles } = makeEngine();
		vault.addFile("note.md", "hello", T0);

		await engine.forceUploadFile("note.md", CONFIRM);

		const remote = remoteFiles.get("note.md");
		expect(remote).toBeDefined();
		expect(vault.textOf("note.md")).toBe("hello");
		// Base record updated AND persisted (a fresh loadState sees it).
		const persisted = loadState(app).files["note.md"];
		expect(persisted?.remoteUuid).toBe(remote?.uuid);
		expect(persisted?.localSize).toBe(5);
	});

	it("remote changed vs base + confirm → overwrites (new uuid), base updated", async () => {
		const { engine, vault, app, seedRemote, remoteFiles } = makeEngine();
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["note.md"] = {
			localMtime: T0, localSize: 3, remoteUuid: "u-old", remoteMtime: T0, remoteSize: 3,
		};
		saveState(app, state);
		vault.addFile("note.md", "local version", T0 + 5000);
		seedRemote("note.md", "someone else's edit", T0 + 3000); // uuid ≠ u-old
		const beforeUuid = (remoteFiles.get("note.md") as { uuid: string }).uuid;

		await engine.forceUploadFile("note.md", CONFIRM);

		const remote = remoteFiles.get("note.md");
		expect(new TextDecoder().decode(remote?.data)).toBe("local version");
		expect(remote?.uuid).not.toBe(beforeUuid);
		expect(loadState(app).files["note.md"]?.remoteUuid).toBe(remote?.uuid);
	});

	it("remote changed vs base + cancel → aborts, no upload, remote untouched", async () => {
		const { engine, vault, app, seedRemote, remoteFiles, mutations } = makeEngine();
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["note.md"] = {
			localMtime: T0, localSize: 3, remoteUuid: "u-old", remoteMtime: T0, remoteSize: 3,
		};
		saveState(app, state);
		vault.addFile("note.md", "local version", T0 + 5000);
		seedRemote("note.md", "someone else's edit", T0 + 3000);
		const beforeUuid = (remoteFiles.get("note.md") as { uuid: string }).uuid;
		mutations.length = 0;

		await engine.forceUploadFile("note.md", CANCEL);

		expect(mutations).not.toContain("uploadFile");
		expect((remoteFiles.get("note.md") as { uuid: string }).uuid).toBe(beforeUuid);
		// Base record untouched.
		expect(loadState(app).files["note.md"]?.remoteUuid).toBe("u-old");
	});

	it("no base record → uploads without asking (confirm never consulted)", async () => {
		const { engine, vault, seedRemote, remoteFiles } = makeEngine();
		vault.addFile("note.md", "local version", T0 + 5000);
		seedRemote("note.md", "old remote", T0);
		let asked = false;

		await engine.forceUploadFile("note.md", async () => {
			asked = true;
			return false; // would abort if consulted — must NOT be consulted
		});

		expect(asked).toBe(false);
		expect(new TextDecoder().decode(remoteFiles.get("note.md")?.data)).toBe("local version");
	});

	it("paused → paused notice, no upload", async () => {
		const { engine, vault, settings, notices, mutations } = makeEngine();
		settings.syncPaused = true;
		vault.addFile("note.md", "hello", T0);
		mutations.length = 0;

		await engine.forceUploadFile("note.md", CONFIRM);

		expect(notices).toContain(SYNC_PAUSED_MESSAGE);
		expect(mutations).not.toContain("uploadFile");
	});

	it("missing file → error notice, no upload", async () => {
		const { engine, notices, mutations } = makeEngine();
		mutations.length = 0;

		await engine.forceUploadFile("ghost.md", CONFIRM);

		expect(mutations).not.toContain("uploadFile");
		expect(notices.some(n => n.includes("not found") && n.includes("ghost.md"))).toBe(true);
	});

	it("works under pull mode (explicit user intent beats the direction)", async () => {
		const { engine, vault, settings, remoteFiles } = makeEngine();
		settings.syncDirection = "pull";
		vault.addFile("note.md", "hello", T0);

		await engine.forceUploadFile("note.md", CONFIRM);

		expect(remoteFiles.get("note.md")).toBeDefined();
	});

	it("surfaces a success notice with the path", async () => {
		const { engine, vault, notices } = makeEngine();
		vault.addFile("dir/note.md", "hello", T0);

		await engine.forceUploadFile("dir/note.md", CONFIRM);

		expect(notices.some(n => n === "Uploaded dir/note.md")).toBe(true);
	});
});
