/**
 * Settings model tests (v0.7.0): the sync-direction default, merge-safety
 * with old data.json, persistence round-trip, and the guarantee that the
 * per-device direction is NOT a shared-settings key.
 */

import { describe, expect, it } from "vitest";
import { defaultSettings, FilenSyncSettings } from "../src/settings";
import { SHARED_PREF_KEYS } from "../src/sync/sharedPrefs";

describe("syncDirection setting (v0.7.0)", () => {
	it("defaults to twoWay", () => {
		expect(defaultSettings("vault").syncDirection).toBe("twoWay");
	});

	it("merge-safe with an old data.json that lacks the key (stays twoWay)", () => {
		// main.ts loads: Object.assign({}, defaultSettings(name), loadData()).
		const oldDataJson = JSON.stringify({
			email: "user@example.com",
			conflictPolicy: "keep_newer",
		});
		const merged: FilenSyncSettings = Object.assign(
			{},
			defaultSettings("vault"),
			JSON.parse(oldDataJson) as Partial<FilenSyncSettings>,
		);
		expect(merged.syncDirection).toBe("twoWay");
		expect(merged.conflictPolicy).toBe("keep_newer"); // unrelated keys still merge
	});

	it("a persisted push/pull selection survives the data.json round-trip (dropdown persists)", () => {
		const settings = defaultSettings("vault");
		settings.syncDirection = "push";
		const reloaded: FilenSyncSettings = Object.assign(
			{},
			defaultSettings("vault"),
			JSON.parse(JSON.stringify(settings)) as Partial<FilenSyncSettings>,
		);
		expect(reloaded.syncDirection).toBe("push");
		settings.syncDirection = "pull";
		const reloadedPull: FilenSyncSettings = Object.assign(
			{},
			defaultSettings("vault"),
			JSON.parse(JSON.stringify(settings)) as Partial<FilenSyncSettings>,
		);
		expect(reloadedPull.syncDirection).toBe("pull");
	});

	it("is NOT a shared-settings key (per-device by nature)", () => {
		expect(SHARED_PREF_KEYS).not.toContain("syncDirection");
	});
});

/* ---------------- v0.7.2: first-run direction choice in the connect form ---------------- */

describe("connect flow direction choice (v0.7.2)", () => {
	it("applies the connect-form direction to settings on successful connect", async () => {
		const { FilenSyncSettingTab } = await import("../src/settings");
		const { encMeta, deriveAuthV2 } = await import("../src/filen/crypto");
		type HttpFn = import("../src/filen/types").HttpFn;

		const storage = new Map<string, string | null>();
		const app = {
			vault: { getName: () => "Vault" },
			loadLocalStorage: (key: string) => storage.get(key) ?? null,
			saveLocalStorage: (key: string, value: string | null) => {
				storage.set(key, value);
			},
		} as never;

		const settings = defaultSettings("Vault");
		settings.email = "user@example.com";
		const savedSettings: FilenSyncSettings[] = [];
		const plugin = {
			settings,
			saveSettings: async () => {
				savedSettings.push({ ...settings });
			},
			onConnected: () => undefined,
			setMemoryCredentials: () => undefined,
			getMemoryCredentials: () => null,
		} as never;

		const tab = new FilenSyncSettingTab(app, plugin);
		// Skip the full UI render at the end of the connect flow.
		(tab as unknown as { refresh: () => void }).refresh = () => undefined;
		(tab as unknown as { passwordValue: string }).passwordValue = "pw";
		(tab as unknown as { connectDirection: string }).connectDirection = "pull";

		const salt = "saltysalt";
		const masterKey = (await deriveAuthV2("pw", salt)).masterKey;
		const http: HttpFn = async request => {
			const url = request.url;
			let data: unknown;
			if (url.endsWith("/v3/auth/info")) {
				data = { email: "user@example.com", authVersion: 2, salt, id: "1" };
			} else if (url.endsWith("/v3/login")) {
				data = { apiKey: "k", masterKeys: null, publicKey: null, privateKey: null };
			} else if (url.endsWith("/v3/user/masterKeys")) {
				data = { keys: await encMeta(masterKey, masterKey, 2) };
			} else if (url.endsWith("/v3/user/baseFolder")) {
				data = { uuid: "root-uuid" };
			} else if (url.endsWith("/v3/dir/tree")) {
				data = { files: [], folders: [] };
			} else if (url.endsWith("/v3/dir/create")) {
				data = { uuid: `dir-${Math.random().toString(36).slice(2, 8)}` };
			} else {
				throw new Error(`unexpected ${url}`);
			}
			return {
				status: 200,
				headers: {},
				json: { status: true, data },
				text: JSON.stringify({ status: true, data }),
				arrayBuffer: new ArrayBuffer(0),
			};
		};

		const button = { disabled: false } as HTMLButtonElement;
		await (tab as unknown as {
			connectFlow: (b: HTMLButtonElement, h?: typeof http) => Promise<void>;
		}).connectFlow(button, http);

		// The chosen direction is applied to live settings AND persisted.
		expect(settings.syncDirection).toBe("pull");
		expect(savedSettings.at(-1)?.syncDirection).toBe("pull");
		// And the connection itself still completed (credentials stored).
		expect(storage.get("filen-cloud-sync/credentials")).toBeTruthy();
	});
});
