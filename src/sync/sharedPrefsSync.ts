/**
 * v0.5.0 shared settings — glue between the pure sharedPrefs module, the
 * Filen client and the plugin. No obsidian imports (settings/log are
 * type-only), so the whole flow is unit-testable under vitest.
 *
 * Post-run check placement (the design docs: implementer's choice): main.ts passes the
 * JUST-USED remote tree from SyncRunResult into afterRun() — no extra API
 * call, and no engine coupling to settings persistence.
 *
 * Loop prevention:
 * - `applying` is set while remote prefs are written into settings; the
 *   upload-on-change path no-ops during that window.
 * - Our own uploads bump settings.sharedPrefsAppliedAt to the uploaded
 *   updatedAt, so the post-run check (updatedAt > appliedAt) never
 *   re-downloads a file this device just wrote.
 */

import type { FilenClient } from "../filen/client";
import type { StoredCredentials } from "../filen/types";
import type { FilenSyncSettings } from "../settings";
import { tryDecodeUtf8, utf8ToBytes } from "../util";
import type { SyncLog } from "./log";
import { scanRemote } from "./remoteScan";
import {
	applyPrefs,
	PREFS_FILE_NAME,
	parsePrefs,
	PrefsFile,
	prefsFromSettings,
	serializePrefs,
} from "./sharedPrefs";
import type { RemoteFile, RemoteTree } from "./types";

export const SHARED_PREFS_UPLOAD_DEBOUNCE_MS = 2000;

export interface SharedPrefsSyncDeps {
	client: FilenClient;
	getSettings: () => FilenSyncSettings;
	saveSettings: () => Promise<void>;
	getCredentials: () => StoredCredentials | null;
	deviceId: () => string;
	log: SyncLog;
	/** Notice — remotely-originated applies ONLY, never own uploads. */
	notify: (message: string) => void;
	/** Test seam — defaults to SHARED_PREFS_UPLOAD_DEBOUNCE_MS. */
	debounceMs?: number;
}

export class SharedPrefsSync {
	private applying = false;
	private uploadTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly debounceMs: number;

	constructor(private readonly deps: SharedPrefsSyncDeps) {
		this.debounceMs = deps.debounceMs ?? SHARED_PREFS_UPLOAD_DEBOUNCE_MS;
	}

	/** True while remote prefs are being applied (upload path must no-op). */
	get isApplying(): boolean {
		return this.applying;
	}

	/**
	 * Toggle off→on: fetch the remote prefs file (full tree scan — the file
	 * is looked up by name in the sync root) → found+valid: APPLY it; else
	 * upload the current local prefs as the seed. Returns false when the
	 * enable flow could not complete (caller reverts the toggle).
	 */
	async enable(): Promise<boolean> {
		const credentials = this.deps.getCredentials();
		if (!credentials) {
			this.deps.notify("Filen Cloud Sync: connect your Filen account before sharing settings");
			return false;
		}
		this.deps.client.setCredentials(credentials);
		let remote: RemoteTree;
		try {
			remote = (await scanRemote(this.deps.client, credentials.syncRootUuid, this.deps.deviceId())).tree;
		} catch (e) {
			const message = `could not look for shared settings: ${e instanceof Error ? e.message : String(e)}`;
			this.deps.log.warn(message);
			this.deps.notify(`Filen Cloud Sync: ${message} — sharing stays off`);
			return false;
		}
		const entry = remote.files.get(PREFS_FILE_NAME);
		const file = entry ? await this.downloadPrefs(entry) : null;
		if (file) {
			await this.applyRemote(file);
		} else {
			// No remote file (or an unreadable one): this device seeds it.
			await this.uploadNow();
		}
		return true;
	}

	/** Toggle off: stop both directions — cancel any pending upload. */
	disable(): void {
		if (this.uploadTimer !== null) {
			clearTimeout(this.uploadTimer);
			this.uploadTimer = null;
		}
	}

	/**
	 * Any of the six shared keys changed locally → debounced (2 s) upload
	 * with a FRESH updatedAt. No-ops while sharing is off or while remote
	 * prefs are being applied (loop guard).
	 */
	onSharedKeyChanged(): void {
		if (!this.deps.getSettings().shareSettings) return;
		if (this.applying) return;
		if (this.uploadTimer !== null) clearTimeout(this.uploadTimer);
		this.uploadTimer = setTimeout(() => {
			this.uploadTimer = null;
			void this.uploadNow().catch(e => {
				this.deps.log.warn(`shared settings upload failed: ${e instanceof Error ? e.message : String(e)}`);
			});
		}, this.debounceMs);
	}

	/**
	 * Post-run check (called by main.ts with the run's own remote tree):
	 * remote prefs content newer than the last applied updatedAt → download,
	 * apply, persist applied-at. updatedAt INSIDE the file is authoritative;
	 * equality (own uploads) never re-applies. Missing remote file while
	 * sharing is on → re-seed (self-heal; the file can only vanish via a
	 * manual delete in the Filen app, never via sync ops).
	 */
	async afterRun(remote: RemoteTree | null): Promise<void> {
		if (!this.deps.getSettings().shareSettings) return;
		if (!remote) return;
		const entry = remote.files.get(PREFS_FILE_NAME);
		if (!entry) {
			this.deps.log.info("shared settings: remote file missing — re-uploading local prefs");
			await this.uploadNow();
			return;
		}
		const appliedAt = this.deps.getSettings().sharedPrefsAppliedAt;
		// Cheap pre-filter: this plugin always writes the file with
		// mtime == updatedAt, so a non-newer mtime means "no new content" and
		// the download can be skipped entirely. The in-file updatedAt remains
		// authoritative once downloaded.
		if (entry.lastModified <= appliedAt) return;
		const file = await this.downloadPrefs(entry);
		if (!file) return; // already logged
		if (file.updatedAt > appliedAt) {
			await this.applyRemote(file);
		}
	}

	/** Upload the current local prefs with a fresh updatedAt; record applied-at. */
	private async uploadNow(): Promise<void> {
		const settings = this.deps.getSettings();
		if (!settings.shareSettings) return;
		if (this.applying) return;
		const credentials = this.deps.getCredentials();
		if (!credentials) return;
		this.deps.client.setCredentials(credentials);
		const updatedAt = Date.now();
		const body = serializePrefs(prefsFromSettings(settings), settings.deviceName, updatedAt);
		const bytes = utf8ToBytes(body);
		const buffer = bytes.buffer.slice(
			bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;
		await this.deps.client.uploadFile(credentials.syncRootUuid, PREFS_FILE_NAME, buffer, updatedAt);
		settings.sharedPrefsAppliedAt = updatedAt;
		await this.deps.saveSettings();
		this.deps.log.info(`shared settings uploaded from ${settings.deviceName}`);
	}

	/** Download + validate a remote prefs file; null (logged) on any failure. */
	private async downloadPrefs(entry: RemoteFile): Promise<PrefsFile | null> {
		let text: string | null = null;
		try {
			const { data, verified } = await this.deps.client.downloadFile(
				{
					uuid: entry.uuid,
					bucket: entry.bucket,
					region: entry.region,
					chunks: entry.chunks,
				},
				entry.key,
				entry.hash,
			);
			if (!verified) {
				this.deps.log.warn("shared settings: integrity check failed — ignoring remote file");
				return null;
			}
			text = tryDecodeUtf8(data);
		} catch (e) {
			this.deps.log.warn(`shared settings download failed: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
		if (text === null) {
			this.deps.log.warn("shared settings: remote file is not valid UTF-8 — ignoring");
			return null;
		}
		const file = parsePrefs(text);
		if (!file) {
			this.deps.log.warn("shared settings: remote file failed validation — ignoring");
			return null;
		}
		return file;
	}

	/**
	 * Apply remotely-originated prefs: write the six shared keys + applied-at,
	 * persist, log, and Notice. The `applying` flag blocks the upload-on-change
	 * path for the whole window (loop guard).
	 */
	private async applyRemote(file: PrefsFile): Promise<void> {
		const settings = this.deps.getSettings();
		this.applying = true;
		try {
			const changed = applyPrefs(settings, file.prefs);
			settings.sharedPrefsAppliedAt = file.updatedAt;
			await this.deps.saveSettings();
			this.deps.log.info(
				`shared settings applied (written by ${file.device})`
				+ (changed.length > 0 ? `: ${changed.join(", ")}` : " — no local changes"),
			);
			if (changed.length > 0) {
				this.deps.notify(`Filen Cloud Sync: shared settings applied (written by ${file.device})`);
			}
		} finally {
			this.applying = false;
		}
	}
}
