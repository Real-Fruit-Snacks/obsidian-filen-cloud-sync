/**
 * v0.6.0 feature A (dry-run plan preview): a dry run takes the identical
 * scan → plan path as a real run but executes NOTHING — zero mutating client
 * calls, untouched persisted state/base, no ask-mode resolver, no per-op
 * notices — and reports guardWouldAbort instead of aborting.
 */

import { describe, expect, it } from "vitest";
import { emptyState, loadState, saveState } from "../src/sync/state";
import type { SyncOp } from "../src/sync/types";
import { makeEngine, ROOT, T0 } from "./harness";

/** Compact, order-independent op fingerprint for plan comparisons. */
function opFingerprint(ops: SyncOp[]): string[] {
	return ops
		.map(op => `${op.kind}:${op.path}:${op.toPath ?? ""}`)
		.sort();
}

function snapshotVault(vault: ReturnType<typeof makeEngine>["vault"]): Record<string, string> {
	const snapshot: Record<string, string> = {};
	for (const file of vault.getFiles()) snapshot[file.path] = vault.textOf(file.path);
	return snapshot;
}

/**
 * Mixed fixture: one upload, one download, one remote delete, one local
 * delete, one keep_both conflict — every preview category in one plan.
 */
function seedMixedFixture(h: ReturnType<typeof makeEngine>): void {
	const state = emptyState();
	state.remoteRootUuid = ROOT;

	// Synced before, deleted locally → trashRemote.
	h.seedRemote("deleted-locally.md", "gone here", T0);
	state.files["deleted-locally.md"] = {
		localMtime: T0, localSize: 9, remoteUuid: h.remoteFiles.get("deleted-locally.md")!.uuid,
		remoteMtime: T0, remoteSize: 9,
	};
	// Synced before, deleted remotely → trashLocal.
	h.vault.addFile("deleted-remotely.md", "gone there", T0);
	state.files["deleted-remotely.md"] = {
		localMtime: T0, localSize: 10, remoteUuid: "uuid-vanished", remoteMtime: T0, remoteSize: 10,
	};
	// Both sides changed since the base → conflict (local newer → winner).
	h.vault.addFile("conflict.md", "local version", T0 + 5000);
	h.seedRemote("conflict.md", "remote version", T0 + 3000);
	// Base holds the PRE-edit remote uuid — a remote edit mints a new uuid,
	// which is how the planner detects the remote side changed.
	state.files["conflict.md"] = {
		localMtime: T0, localSize: 3, remoteUuid: "uuid-before-remote-edit",
		remoteMtime: T0, remoteSize: 3,
	};
	// New on both sides → one upload + one download.
	h.vault.addFile("local-only.md", "local only", T0);
	h.seedRemote("remote-only.md", "remote only", T0);

	saveState(h.app, state);
}

describe("dry run — plan preview purity", () => {
	it("produces the same plan as a real run but executes nothing", async () => {
		const h = makeEngine();
		seedMixedFixture(h);

		const stateBefore = JSON.stringify(loadState(h.app));
		const vaultBefore = snapshotVault(h.vault);

		const dry = await h.engine.run({ manual: true, dryRun: true });
		expect(dry.status).toBe("dry-run");
		expect(dry.plan).toBeTruthy();
		expect(dry.guardWouldAbort).toBe(false);

		// Zero mutating client calls, vault + persisted state untouched.
		expect(h.mutations).toEqual([]);
		expect(snapshotVault(h.vault)).toEqual(vaultBefore);
		expect(JSON.stringify(loadState(h.app))).toBe(stateBefore);
		// No per-op notices (a conflict is present — a real run notifies).
		expect(h.notices).toEqual([]);

		// A real run on the untouched fixture plans EXACTLY the same op set.
		const real = await h.engine.run({ manual: true });
		expect(real.status).toBe("ok");
		expect(opFingerprint(real.plan?.ops ?? [])).toEqual(opFingerprint(dry.plan?.ops ?? []));
		expect(real.plan?.counts).toEqual(dry.plan?.counts);
		expect(real.plan?.conflicts).toEqual(dry.plan?.conflicts);
		expect(real.plan?.seedMode).toBe(dry.plan?.seedMode);

		// The preview covered every category: upload, download, both delete
		// directions and the conflict.
		const kinds = new Set((dry.plan?.ops ?? []).map(op => op.kind));
		expect(kinds.has("upload")).toBe(true);
		expect(kinds.has("download")).toBe(true);
		expect(kinds.has("trashLocal")).toBe(true);
		expect(kinds.has("trashRemote")).toBe(true);
		expect(dry.plan?.conflicts).toHaveLength(1);
	});

	it("never invokes the ask-mode conflict resolver", async () => {
		let resolverCalls = 0;
		const h = makeEngine(() => {
			resolverCalls++;
			throw new Error("resolver must not run during a dry run");
		});
		h.settings.conflictResolution = "ask";

		const state = emptyState();
		state.remoteRootUuid = ROOT;
		h.vault.addFile("conflict.md", "local version", T0 + 5000);
		h.seedRemote("conflict.md", "remote version", T0 + 3000);
		state.files["conflict.md"] = {
			localMtime: T0, localSize: 3, remoteUuid: "uuid-before-remote-edit",
			remoteMtime: T0, remoteSize: 3,
		};
		saveState(h.app, state);

		const dry = await h.engine.run({ manual: true, dryRun: true });
		expect(dry.status).toBe("dry-run");
		expect(resolverCalls).toBe(0);
		// The conflict is still shown in the preview (with the auto policy).
		expect(dry.plan?.conflicts).toHaveLength(1);
		expect(h.mutations).toEqual([]);
	});

	it("flags guardWouldAbort instead of aborting; the real run still aborts", async () => {
		const h = makeEngine();
		h.settings.massChangeAbortPercent = 50;

		// 4 synced files, 3 deleted locally → 75% deletes > 50% guard.
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		for (const name of ["a.md", "b.md", "c.md", "keep.md"]) {
			h.seedRemote(name, `content ${name}`, T0);
			state.files[name] = {
				localMtime: T0, localSize: 12, remoteUuid: h.remoteFiles.get(name)!.uuid,
				remoteMtime: T0, remoteSize: 12,
			};
		}
		h.vault.addFile("keep.md", "content keep.md", T0);
		saveState(h.app, state);

		const stateBefore = JSON.stringify(loadState(h.app));
		const dry = await h.engine.run({ manual: true, dryRun: true });
		expect(dry.status).toBe("dry-run");
		expect(dry.guardWouldAbort).toBe(true);
		// The full op set is previewed (re-planned with the guard off).
		expect(dry.plan?.counts.trashRemote).toBe(3);
		expect((dry.plan?.ops ?? []).filter(op => op.kind === "trashRemote")).toHaveLength(3);
		expect(h.mutations).toEqual([]);
		expect(JSON.stringify(loadState(h.app))).toBe(stateBefore);

		// Same fixture, real run: the guard aborts as usual.
		const real = await h.engine.run({ manual: true });
		expect(real.status).toBe("aborted");
		expect(h.mutations).toEqual([]);
	});

	it("seed mode is reported in the dry-run plan without seeding anything", async () => {
		const h = makeEngine();
		h.vault.addFile("note.md", "hello", T0);
		h.vault.addFile("sub/other.md", "world", T0);

		const dry = await h.engine.run({ manual: true, dryRun: true });
		expect(dry.status).toBe("dry-run");
		expect(dry.plan?.seedMode).toBe("upload-all");
		expect(dry.plan?.counts.uploads).toBe(2);
		expect(h.mutations).toEqual([]);
		// No base records were written.
		expect(Object.keys(loadState(h.app).files)).toHaveLength(0);
	});

	it("in-sync vault previews an empty plan", async () => {
		const h = makeEngine();
		h.vault.addFile("note.md", "hello", T0);
		h.seedRemote("note.md", "hello", T0);
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		state.files["note.md"] = {
			localMtime: T0, localSize: 5, remoteUuid: h.remoteFiles.get("note.md")!.uuid,
			remoteMtime: T0, remoteSize: 5,
		};
		saveState(h.app, state);

		const dry = await h.engine.run({ manual: true, dryRun: true });
		expect(dry.status).toBe("dry-run");
		expect(dry.message).toBe("everything up to date");
		expect((dry.plan?.ops ?? []).filter(
			op => op.kind !== "refreshBase" && op.kind !== "dropBase",
		)).toHaveLength(0);
		expect(h.mutations).toEqual([]);
	});
});
