/**
 * v0.7.1 feature A — one-time direction overrides (engine full runs against
 * the fake vault + stateful mock Filen client, tests/harness):
 * - SyncRunOptions.direction takes precedence over settings.syncDirection
 *   FOR THAT RUN ONLY — the persisted setting is never mutated, and the
 *   next default-direction run is unaffected.
 * - The empty-source hard guard fires on one-time runs identically.
 */

import { describe, expect, it } from "vitest";
import { emptyState, saveState } from "../src/sync/state";
import { makeEngine, ROOT, T0 } from "./harness";

describe("one-time direction override (v0.7.1)", () => {
	it("a Push run on a twoWay setting executes push semantics and never mutates the setting", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "twoWay"; // the persisted default

		// Diverged pair, no base: two-way would download remote.md and upload
		// local.md; push mirrors local → cloud instead.
		h.vault.addFile("local.md", "local only", T0);
		h.seedRemote("remote.md", "remote only", T0);

		const run = await h.engine.run({ manual: true, direction: "push" });
		expect(run.status).toBe("ok");
		expect(run.plan?.conflicts).toHaveLength(0); // mirrors never conflict
		expect(run.plan?.ops.some(op => op.kind === "download")).toBe(false);

		// Push semantics: the cloud now mirrors the vault.
		expect(h.remoteFiles.has("local.md")).toBe(true); // uploaded
		expect(h.remoteFiles.has("remote.md")).toBe(false); // remote-only trashed
		expect(h.mutations).toContain("uploadFile");
		expect(h.mutations).toContain("fileTrash");

		// Nothing was written locally…
		expect(h.vault.hasFile("remote.md")).toBe(false);

		// …and the persisted setting was NOT mutated by the override.
		expect(h.settings.syncDirection).toBe("twoWay");
	});

	it("the next default-direction run is unaffected by an earlier one-time override", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "twoWay";

		h.vault.addFile("local.md", "local only", T0);
		h.seedRemote("remote.md", "remote only", T0);

		const pushRun = await h.engine.run({ manual: true, direction: "push" });
		expect(pushRun.status).toBe("ok");
		expect(h.remoteFiles.has("remote.md")).toBe(false); // mirror already ran

		// A new remote-only file appears; the DEFAULT run (no override) must
		// behave as two-way again → download, not trash.
		h.seedRemote("new-remote.md", "appeared later", T0 + 5000);
		const defaultRun = await h.engine.run({ manual: true });
		expect(defaultRun.status).toBe("ok");
		expect(h.vault.textOf("new-remote.md")).toBe("appeared later"); // downloaded
		expect(h.remoteFiles.has("new-remote.md")).toBe(true); // kept remotely
		expect(h.settings.syncDirection).toBe("twoWay");
	});

	it("a Pull run on a push setting executes pull semantics for that run only", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "push"; // persisted default is push

		h.vault.addFile("local.md", "local only", T0);
		h.seedRemote("remote.md", "remote only", T0);

		const run = await h.engine.run({ manual: true, direction: "pull" });
		expect(run.status).toBe("ok");
		expect(run.plan?.ops.some(op => op.kind === "upload")).toBe(false);

		// Pull semantics: the vault now mirrors the cloud.
		expect(h.vault.textOf("remote.md")).toBe("remote only"); // downloaded
		expect(h.vault.hasFile("local.md")).toBe(false); // local-only trashed
		expect(h.remoteFiles.has("local.md")).toBe(false); // never uploaded

		expect(h.settings.syncDirection).toBe("push"); // setting untouched
	});

	it("the empty-source hard guard fires on a one-time push (settings twoWay)", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "twoWay";

		// Empty local vault, non-empty cloud: a two-way run would download-all,
		// but the one-time PUSH override must hit the empty-source hard guard.
		h.seedRemote("important.md", "do not wipe me", T0);
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		saveState(h.app, state);

		const run = await h.engine.run({ manual: true, direction: "push" });
		expect(run.status).toBe("aborted");
		expect(run.message).toContain("push source is empty");

		// Nothing was touched on either side.
		expect(h.mutations).toHaveLength(0);
		expect(h.remoteFiles.has("important.md")).toBe(true);
		expect(h.settings.syncDirection).toBe("twoWay");
	});

	it("the empty-source hard guard fires on a one-time pull (settings twoWay)", async () => {
		const h = makeEngine();
		h.settings.syncDirection = "twoWay";

		h.vault.addFile("only-local.md", "do not wipe me", T0);
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		saveState(h.app, state);

		const run = await h.engine.run({ manual: true, direction: "pull" });
		expect(run.status).toBe("aborted");
		expect(run.message).toContain("pull source is empty");
		expect(h.mutations).toHaveLength(0);
		expect(h.vault.hasFile("only-local.md")).toBe(true);
	});
});
