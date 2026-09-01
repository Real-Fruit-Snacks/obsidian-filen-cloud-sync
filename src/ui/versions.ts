/**
 * Version history UI (feature B): list a file's Filen versions newest-first
 * and restore an older one. Restore downloads the version by ITS OWN uuid,
 * decrypts with the key from ITS metadata, sha512-verifies when a hash is
 * present, and writes with mtime = now so the restored content wins the
 * next sync and propagates as a new version everywhere (intentional).
 */

import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { FilenClient } from "../filen/client";
import type { FileMetadata, FileVersionsResponse } from "../filen/types";
import type { SyncLog } from "../sync/log";
import { errMsg } from "../sync/engine";
import { loadState } from "../sync/state";
import { ConfirmModal } from "./confirm";

type VersionEntry = FileVersionsResponse["versions"][number];

interface ResolvedVersion {
	entry: VersionEntry;
	metadata: FileMetadata | null; // null when metadata would not decrypt
	isCurrent: boolean;
}

/** Version timestamps are seconds in listing rows; tolerate ms too. */
function versionMillis(timestamp: number): number {
	return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class VersionHistoryModal extends Modal {
	private resolved: ResolvedVersion[] = [];

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly versions: VersionEntry[],
		private readonly currentUuid: string,
		private readonly client: FilenClient,
		private readonly log: SyncLog,
		private readonly isSyncRunning: () => boolean = () => false,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`Filen version history — ${this.file.name}`);
		const list = this.contentEl.createDiv({ cls: "filen-cloud-sync-versions-list" });
		list.setText("Loading versions…");
		void this.loadVersions(list);
	}

	private async loadVersions(list: HTMLElement): Promise<void> {
		const resolved: ResolvedVersion[] = [];
		for (const entry of this.versions) {
			let metadata: FileMetadata | null = null;
			try {
				metadata = await this.client.decryptFileMetadata(entry.metadata);
			} catch (e) {
				this.log.warn(`version ${entry.uuid.slice(0, 8)}… metadata not decryptable: ${errMsg(e)}`);
			}
			resolved.push({ entry, metadata, isCurrent: entry.uuid === this.currentUuid });
		}
		// Newest first; the current version pinned to the top.
		resolved.sort((a, b) => versionMillis(b.entry.timestamp) - versionMillis(a.entry.timestamp));
		if (!resolved.some(v => v.isCurrent) && resolved.length > 0) {
			(resolved[0] as ResolvedVersion).isCurrent = true; // fall back to newest
		}
		resolved.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
		this.resolved = resolved;
		this.renderList(list);
	}

	private renderList(list: HTMLElement): void {
		list.empty();
		if (this.resolved.length === 0) {
			list.setText("No versions found on Filen for this file.");
			return;
		}
		for (const version of this.resolved) {
			const row = list.createDiv({ cls: "filen-cloud-sync-version-row" });
			const info = row.createDiv({ cls: "filen-cloud-sync-version-info" });
			const when = new Date(versionMillis(version.entry.timestamp)).toLocaleString();
			const size = version.metadata ? formatSize(version.metadata.size) : "unknown size";
			info.createDiv({ cls: "filen-cloud-sync-version-title" })
				.setText(`${when} — ${size}`);
			if (version.isCurrent) {
				info.createDiv({ cls: "filen-cloud-sync-version-badge" }).setText("Current version");
			} else if (!version.metadata) {
				info.createDiv({ cls: "filen-cloud-sync-version-badge" }).setText("Metadata not decryptable");
			}
			if (!version.isCurrent && version.metadata) {
				new Setting(row).addButton(button => button
					.setButtonText("Restore")
					.onClick(() => this.confirmRestore(version)));
			}
		}
	}

	private confirmRestore(version: ResolvedVersion): void {
		const when = new Date(versionMillis(version.entry.timestamp)).toLocaleString();
		new ConfirmModal(
			this.app,
			"Restore this version?",
			`Replace ${this.file.path} with the version from ${when}? `
			+ "The restored file gets the current time, so it wins the next sync and "
			+ "your current content is kept as a Filen version.",
			"Restore",
			() => void this.restore(version),
		).open();
	}

	private async restore(version: ResolvedVersion): Promise<void> {
		const metadata = version.metadata;
		if (!metadata) return;
		if (this.isSyncRunning()) {
			new Notice("Filen Cloud Sync is running — restore after it finishes");
			return;
		}
		// Stale-file guard: the file may have changed since this modal opened.
		const fresh = this.app.vault.getFileByPath(this.file.path);
		if (!fresh || fresh.stat.mtime !== this.file.stat.mtime) {
			new Notice(`Filen Cloud Sync: ${this.file.path} changed since the version list loaded — re-open version history`);
			return;
		}
		const notice = new Notice("Filen Cloud Sync: restoring version…", 0);
		try {
			const { data, verified } = await this.client.downloadFile(
				{
					uuid: version.entry.uuid,
					bucket: version.entry.bucket,
					region: version.entry.region,
					chunks: version.entry.chunks,
				},
				metadata.key,
				metadata.hash,
			);
			if (!verified) {
				this.log.warn(`integrity check failed restoring ${this.file.path} — writing anyway (warn only)`);
			}
			// mtime = NOW so the restored content wins the next sync and
			// propagates everywhere as a new version (intentional). Same-second
			// hole guard: if the base record has the same whole-second mtime AND
			// the same size, stat-based change detection would see no change and
			// the restore would never propagate — bump by one second.
			let mtime = Date.now();
			const base = loadState(this.app).files[this.file.path];
			if (base && base.localSize === data.byteLength
				&& Math.floor(mtime / 1000) === Math.floor(base.localMtime / 1000)) {
				mtime = base.localMtime + 1000;
			}
			await this.app.vault.modifyBinary(fresh, data, { mtime });
			this.log.info(`restored ${this.file.path} from version of ${new Date(versionMillis(version.entry.timestamp)).toLocaleString()}`);
			notice.hide();
			new Notice(`Restored ${this.file.path} — run "Sync now" to propagate it everywhere`);
			this.close();
		} catch (e) {
			notice.hide();
			const message = `version restore failed for ${this.file.path}: ${errMsg(e)}`;
			this.log.error(message);
			new Notice(`Filen Cloud Sync: ${message}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
