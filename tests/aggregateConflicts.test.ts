/**
 * v0.8.0 feature 7: conflicts are still logged per-path, but the user is
 * notified ONCE per run with an aggregate message (a single conflict keeps
 * its per-path notice).
 */

import { describe, expect, it } from "vitest";
import { emptyState, saveState } from "../src/sync/state";
import { makeEngine, ROOT, T0 } from "./harness";

/** Seed `path` as both-changed since the base record → keep_both conflict. */
function seedConflict(
	h: ReturnType<typeof makeEngine>,
	state: ReturnType<typeof emptyState>,
	path: string,
): void {
	state.files[path] = {
		localMtime: T0, localSize: 3, remoteUuid: `u-old-${path}`, remoteMtime: T0, remoteSize: 3,
	};
	h.vault.addFile(path, `local ${path}`, T0 + 5000);
	h.seedRemote(path, `remote ${path}`, T0 + 3000);
}

describe("aggregated conflict notices (v0.8.0 feature 7)", () => {
	it("3 conflicts → exactly 1 aggregate notify call mentioning the count", async () => {
		const h = makeEngine();
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		seedConflict(h, state, "a.md");
		seedConflict(h, state, "b.md");
		seedConflict(h, state, "c.md");
		saveState(h.app, state);

		const result = await h.engine.run({ manual: true });
		expect(result.status).toBe("ok");
		expect(result.plan?.conflicts).toHaveLength(3);

		const conflictNotices = h.notices.filter(n => n.includes("conflict"));
		expect(conflictNotices).toHaveLength(1);
		expect(conflictNotices[0]).toContain("3 conflicts");
		expect(conflictNotices[0]).toContain("kept both copies");

		// The log still carries each conflict individually.
		const logged = h.log.getEntries().filter(e => e.level === "conflict");
		expect(logged).toHaveLength(3);
	});

	it("1 conflict → the existing per-path message (no aggregate)", async () => {
		const h = makeEngine();
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		seedConflict(h, state, "note.md");
		saveState(h.app, state);

		const result = await h.engine.run({ manual: true });
		expect(result.status).toBe("ok");
		expect(result.plan?.conflicts).toHaveLength(1);

		const conflictNotices = h.notices.filter(n => n.includes("conflict"));
		expect(conflictNotices).toHaveLength(1);
		expect(conflictNotices[0]).toContain("note.md");
		expect(conflictNotices[0]).not.toContain("kept both copies (see dashboard");
	});
});
