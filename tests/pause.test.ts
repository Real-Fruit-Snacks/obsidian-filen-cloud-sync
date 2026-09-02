/**
 * v0.7.1 feature B — the pause switch:
 * - Every trigger path funnels through engine.run(), which returns early
 *   {status:"paused"} with ZERO planner/client activity while paused —
 *   manual commands/dashboard buttons ({manual:true}), the auto interval,
 *   sync-on-save and startup ({manual:false}), and dry-run previews.
 * - Resume restores normal operation.
 * - syncPaused defaults to false, is merge-safe with an old data.json,
 *   persists through a settings round-trip, and is NOT a shared-settings key.
 */

import { describe, expect, it } from "vitest";
import { defaultSettings, FilenSyncSettings } from "../src/settings";
import { SYNC_PAUSED_MESSAGE } from "../src/sync/engine";
import { SHARED_PREF_KEYS } from "../src/sync/sharedPrefs";
import { emptyState, saveState } from "../src/sync/state";
import { makeEngine, ROOT, T0 } from "./harness";

/** Assert a run was blocked by the pause switch with zero client activity. */
function expectBlocked(
	h: ReturnType<typeof makeEngine>,
	run: { status: string; message: string },
): void {
	expect(run.status).toBe("paused");
	expect(run.message).toBe(SYNC_PAUSED_MESSAGE);
	// Zero planner/client activity: no scans, no probes, no mutations.
	expect(h.eventsControl.dirTreeCalls).toBe(0);
	expect(h.eventsControl.eventsCalls).toBe(0);
	expect(h.mutations).toHaveLength(0);
}

describe("pause switch blocks every trigger path (v0.7.1)", () => {
	it("manual command/dashboard run ({manual:true})", async () => {
		const h = makeEngine();
		h.settings.syncPaused = true;
		h.vault.addFile("pending.md", "unsynced", T0);
		expectBlocked(h, await h.engine.run({ manual: true }));
		expect(h.remoteFiles.has("pending.md")).toBe(false);
	});

	it("one-time direction commands ({manual:true, direction})", async () => {
		const h = makeEngine();
		h.settings.syncPaused = true;
		h.vault.addFile("pending.md", "unsynced", T0);
		expectBlocked(h, await h.engine.run({ manual: true, direction: "push" }));
		expectBlocked(h, await h.engine.run({ manual: true, direction: "pull" }));
	});

	it("auto triggers: interval, sync-on-save debounce and startup ({manual:false})", async () => {
		const h = makeEngine();
		h.settings.syncPaused = true;
		h.vault.addFile("pending.md", "unsynced", T0);
		// All three auto paths call runSync({manual:false}) in main.ts.
		expectBlocked(h, await h.engine.run({ manual: false })); // interval
		expectBlocked(h, await h.engine.run({ manual: false })); // sync-on-save
		expectBlocked(h, await h.engine.run({ manual: false })); // startup
	});

	it("dry-run preview ({manual:true, dryRun:true})", async () => {
		const h = makeEngine();
		h.settings.syncPaused = true;
		h.vault.addFile("pending.md", "unsynced", T0);
		expectBlocked(h, await h.engine.run({ manual: true, dryRun: true }));
	});

	it("resume restores normal operation", async () => {
		const h = makeEngine();
		const state = emptyState();
		state.remoteRootUuid = ROOT;
		saveState(h.app, state);
		h.vault.addFile("pending.md", "sync me after resume", T0);

		h.settings.syncPaused = true;
		expectBlocked(h, await h.engine.run({ manual: true }));
		expect(h.remoteFiles.has("pending.md")).toBe(false);

		h.settings.syncPaused = false; // Resume
		const run = await h.engine.run({ manual: true });
		expect(run.status).toBe("ok");
		expect(h.remoteFiles.has("pending.md")).toBe(true);
		expect(new TextDecoder().decode(h.remoteFiles.get("pending.md")!.data))
			.toBe("sync me after resume");
	});
});

describe("syncPaused setting (v0.7.1)", () => {
	it("defaults to false", () => {
		expect(defaultSettings("vault").syncPaused).toBe(false);
	});

	it("merge-safe with an old data.json that lacks the key (stays false)", () => {
		// main.ts loads: Object.assign({}, defaultSettings(name), loadData()).
		const oldDataJson = JSON.stringify({
			email: "user@example.com",
			syncDirection: "pull",
		});
		const merged: FilenSyncSettings = Object.assign(
			{},
			defaultSettings("vault"),
			JSON.parse(oldDataJson) as Partial<FilenSyncSettings>,
		);
		expect(merged.syncPaused).toBe(false);
		expect(merged.syncDirection).toBe("pull"); // unrelated keys still merge
	});

	it("persists through a settings reload (data.json round-trip)", () => {
		const settings = defaultSettings("vault");
		settings.syncPaused = true;
		const reloaded: FilenSyncSettings = Object.assign(
			{},
			defaultSettings("vault"),
			JSON.parse(JSON.stringify(settings)) as Partial<FilenSyncSettings>,
		);
		expect(reloaded.syncPaused).toBe(true);
	});

	it("is NOT a shared-settings key (per-device by nature)", () => {
		expect(SHARED_PREF_KEYS).not.toContain("syncPaused");
	});
});
