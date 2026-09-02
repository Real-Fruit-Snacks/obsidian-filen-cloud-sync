/**
 * v0.7.0 sync directions — engine full runs per mode against the fake
 * vault + stateful mock Filen client (tests/harness):
 * - push mirrors local → cloud (uploads, reverts foreign cloud edits,
 *   trashes remote files deleted locally; never downloads; no conflicts)
 * - pull mirrors cloud → local (symmetric)
 * - the empty-source hard guard aborts both directions and is NOT bypassed
 *   by the ignore-mass-change-guard command.
 */

import { describe, expect, it } from "vitest";
import { emptyState, saveState } from "../src/sync/state";
import { makeEngine, ROOT, T0 } from "./harness";

/** Base record for a file synced at T0 with the given remote uuid. */
function syncedAt(remoteUuid: string, size: number) {
	return {
		localMtime: T0, localSize: size,
		remoteUuid, remoteMtime: T0, remoteSize: size,
	};
}

describe("push mode — engine full run mirrors local → cloud", () => {
	it("uploads edits, reverts foreign cloud edits, trashes remote-only files; no downloads, no conflicts", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "push";

		// Synced set at T0.
		h.vault.addFile("keep.md", "keep", T0);
		h.seedRemote("keep.md", "keep", T0);
		h.vault.addFile("edit.md", "original edit", T0);
		h.seedRemote("edit.md", "original edit", T0);
		h.vault.addFile("revert.md", "original revert", T0);
		h.seedRemote("revert.md", "original revert", T0);
		h.vault.addFile("both.md", "original both", T0);
		h.seedRemote("both.md", "original both", T0);
		h.seedRemote("gone.md", "deleted locally", T0);

		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["keep.md"] = syncedAt(h.remoteFiles.get("keep.md")!.uuid, 4);
		state.files["edit.md"] = syncedAt(h.remoteFiles.get("edit.md")!.uuid, 13);
		state.files["revert.md"] = syncedAt(h.remoteFiles.get("revert.md")!.uuid, 15);
		state.files["both.md"] = syncedAt(h.remoteFiles.get("both.md")!.uuid, 13);
		state.files["gone.md"] = syncedAt(h.remoteFiles.get("gone.md")!.uuid, 15);
		saveState(h.app, state);

		// Changes since the base:
		h.vault.addFile("edit.md", "local edit v2", T0 + 5000); // local edit
		h.seedRemote("revert.md", "foreign cloud edit", T0 + 3000); // foreign remote edit
		h.vault.addFile("both.md", "local both v2", T0 + 5000); // both changed…
		h.seedRemote("both.md", "remote both v2", T0 + 3000); // …on both sides
		// gone.md deleted locally (not re-added to the vault).
		h.seedRemote("foreign.md", "never local", T0); // remote-only, no base

		const run = await h.engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(run.plan?.conflicts).toHaveLength(0);
		expect(run.plan?.ops.some(op => op.kind === "download")).toBe(false);

		// The cloud now mirrors the vault.
		expect(h.remoteFiles.has("keep.md")).toBe(true);
		expect(new TextDecoder().decode(h.remoteFiles.get("edit.md")!.data)).toBe("local edit v2");
		// Foreign cloud edit reverted to the local copy.
		expect(new TextDecoder().decode(h.remoteFiles.get("revert.md")!.data)).toBe("original revert");
		// Both changed → local won, no conflict copy anywhere.
		expect(new TextDecoder().decode(h.remoteFiles.get("both.md")!.data)).toBe("local both v2");
		expect(h.remoteFiles.has("gone.md")).toBe(false); // local delete propagated
		expect(h.remoteFiles.has("foreign.md")).toBe(false); // remote-only trashed

		// Nothing was downloaded or written locally.
		expect(h.vault.textOf("keep.md")).toBe("keep");
		expect(h.vault.textOf("revert.md")).toBe("original revert");
		expect(h.vault.hasFile("foreign.md")).toBe(false);
		expect(h.vault.hasFile("gone.md")).toBe(false);

		// Only mirror-direction mutations happened.
		expect(h.mutations).toContain("uploadFile");
		expect(h.mutations).toContain("fileTrash");
		expect(h.mutations).not.toContain("fileRename");
		expect(h.mutations).not.toContain("dirTrash");
	});

	it("keeps renameRemote (server-side rename) in push mode", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "push";

		h.seedRemote("old.md", "same content", T0);
		const oldUuid = h.remoteFiles.get("old.md")!.uuid;
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["old.md"] = syncedAt(oldUuid, 12);
		saveState(h.app, state);
		h.vault.addFile("new.md", "same content", T0);

		const run = await h.engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(h.renameCalls).toEqual([{ uuid: oldUuid, newName: "new.md" }]);
		expect(h.remoteFiles.has("new.md")).toBe(true);
		expect(h.remoteFiles.has("old.md")).toBe(false);
	});
});

describe("pull mode — engine full run mirrors cloud → local", () => {
	it("downloads edits, reverts foreign local edits, trashes local-only files; no uploads, no conflicts", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "pull";

		// Synced set at T0.
		h.vault.addFile("keep.md", "keep", T0);
		h.seedRemote("keep.md", "keep", T0);
		h.vault.addFile("edit.md", "original edit", T0);
		h.seedRemote("edit.md", "original edit", T0);
		h.vault.addFile("revert.md", "original revert", T0);
		h.seedRemote("revert.md", "original revert", T0);
		h.vault.addFile("both.md", "original both", T0);
		h.seedRemote("both.md", "original both", T0);
		h.vault.addFile("gone.md", "deleted remotely", T0);

		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["keep.md"] = syncedAt(h.remoteFiles.get("keep.md")!.uuid, 4);
		state.files["edit.md"] = syncedAt(h.remoteFiles.get("edit.md")!.uuid, 13);
		state.files["revert.md"] = syncedAt(h.remoteFiles.get("revert.md")!.uuid, 15);
		state.files["both.md"] = syncedAt(h.remoteFiles.get("both.md")!.uuid, 13);
		state.files["gone.md"] = syncedAt(T0.toString(), 16);
		saveState(h.app, state);

		// Changes since the base:
		h.seedRemote("edit.md", "remote edit v2", T0 + 5000); // remote edit
		h.vault.addFile("revert.md", "foreign local edit", T0 + 3000); // foreign local edit
		h.vault.addFile("both.md", "local both v2", T0 + 5000); // both changed…
		h.seedRemote("both.md", "remote both v2", T0 + 3000); // …on both sides
		// gone.md deleted remotely (never seeded → base tracks a uuid that is gone).
		h.vault.addFile("foreign.md", "never remote", T0); // local-only, no base

		const run = await h.engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(run.plan?.conflicts).toHaveLength(0);
		expect(run.plan?.ops.some(op => op.kind === "upload")).toBe(false);
		expect(run.plan?.ops.some(op => op.kind === "trashRemote")).toBe(false);

		// The vault now mirrors the cloud.
		expect(h.vault.textOf("keep.md")).toBe("keep");
		expect(h.vault.textOf("edit.md")).toBe("remote edit v2");
		// Foreign local edit reverted to the remote copy.
		expect(h.vault.textOf("revert.md")).toBe("original revert");
		// Both changed → remote won, no conflict copy anywhere.
		expect(h.vault.textOf("both.md")).toBe("remote both v2");
		expect(h.vault.hasFile("gone.md")).toBe(false); // remote delete propagated
		expect(h.vault.hasFile("foreign.md")).toBe(false); // local-only trashed

		// The remote side was never written.
		expect(h.mutations).not.toContain("uploadFile");
		expect(h.mutations).not.toContain("fileTrash");
		expect(h.mutations).not.toContain("fileRename");
		expect(h.mutations).not.toContain("dirCreate");
		expect(new TextDecoder().decode(h.remoteFiles.get("edit.md")!.data)).toBe("remote edit v2");
	});

	it("suppresses renameRemote — a local rename resolves as trashLocal + download", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "pull";

		h.seedRemote("old.md", "same content", T0);
		const oldUuid = h.remoteFiles.get("old.md")!.uuid;
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["old.md"] = syncedAt(oldUuid, 12);
		saveState(h.app, state);
		h.vault.addFile("new.md", "same content", T0);

		const run = await h.engine.run({ manual: true });
		expect(run.status).toBe("ok");
		// The remote side was never renamed or otherwise written…
		expect(h.renameCalls).toHaveLength(0);
		expect(h.mutations).toHaveLength(0);
		// …and the local rename was reverted to mirror the cloud.
		expect(h.vault.hasFile("new.md")).toBe(false);
		expect(h.vault.textOf("old.md")).toBe("same content");
	});
});

describe("empty-source hard guard — engine (v0.7.0)", () => {
	it("push with an empty vault + non-empty remote aborts, even via the ignore-guard command", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "push";
		h.seedRemote("a.md", "remote content", T0);
		// Base state exists — the guard applies regardless.
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["a.md"] = syncedAt(h.remoteFiles.get("a.md")!.uuid, 15);
		saveState(h.app, state);

		const run = await h.engine.run({ manual: true });
		expect(run.status).toBe("aborted");
		expect(run.message).toBe(
			"push source is empty — mirroring would wipe the remote; this is almost "
			+ "certainly wrong (seed the vault or switch to two-way/pull)",
		);
		expect(h.remoteFiles.has("a.md")).toBe(true); // nothing wiped
		expect(h.mutations).toHaveLength(0);

		// The "Sync now (ignore mass-change guard)" command does NOT bypass it.
		const forced = await h.engine.run({ manual: true, ignoreMassChangeGuard: true });
		expect(forced.status).toBe("aborted");
		expect(forced.message).toMatch(/push source is empty/);
		expect(h.remoteFiles.has("a.md")).toBe(true);
		expect(h.mutations).toHaveLength(0);
	});

	it("pull with an empty remote + non-empty vault aborts, even via the ignore-guard command", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "pull";
		h.vault.addFile("a.md", "local content", T0);

		const run = await h.engine.run({ manual: true });
		expect(run.status).toBe("aborted");
		expect(run.message).toBe(
			"pull source is empty — mirroring would wipe the local vault; this is almost "
			+ "certainly wrong (seed the remote or switch to two-way/push)",
		);
		expect(h.vault.hasFile("a.md")).toBe(true); // nothing wiped

		const forced = await h.engine.run({ manual: true, ignoreMassChangeGuard: true });
		expect(forced.status).toBe("aborted");
		expect(forced.message).toMatch(/pull source is empty/);
		expect(h.vault.hasFile("a.md")).toBe(true);
	});

	it("normal push/pull runs are unaffected when the source is non-empty", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "push";
		h.vault.addFile("a.md", "local content", T0);
		h.seedRemote("b.md", "remote content", T0);
		const pushRun = await h.engine.run({ manual: true });
		expect(pushRun.status).toBe("ok");
		expect(h.remoteFiles.has("a.md")).toBe(true);
		expect(h.remoteFiles.has("b.md")).toBe(false);
	});

	it("two-way regression: an empty vault + non-empty remote still seeds a download", async () => {
		const h = makeEngine(); // default direction: twoWay
		h.seedRemote("a.md", "remote content", T0);
		const run = await h.engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(h.vault.textOf("a.md")).toBe("remote content");
	});
});
