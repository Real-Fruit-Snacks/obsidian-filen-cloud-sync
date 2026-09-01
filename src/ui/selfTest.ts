/**
 * Self-test command (v0.4.0 feature B): five staged checks against the live
 * Filen account — auth/quota, folder create, an upload→tree→download SHA-512
 * round-trip of 32 KiB random bytes, own-metadata decrypt interop, and
 * trash cleanup. NEVER touches the vault or the sync state; all remote
 * artifacts live in a throwaway `filen-cloud-sync-selftest-<rand>` folder that is
 * trashed best-effort even when a stage fails. The first failure aborts the
 * remaining stages and surfaces the exact error.
 */

import { App, Modal, Setting } from "obsidian";
import type { FilenClient } from "../filen/client";
import { sha512Hex } from "../filen/crypto";
import { errMsg } from "../sync/engine";
import { SyncLog } from "../sync/log";
import { randomBytes, randomString } from "../util";

export type SelfTestStageStatus = "running" | "ok" | "failed" | "skipped";

export interface SelfTestStageResult {
	label: string;
	status: SelfTestStageStatus;
	durationMs: number;
	/** Extra info on success (e.g. account email + quota). */
	detail?: string;
	/** Exact error message on failure. */
	error?: string;
}

export interface SelfTestReport {
	stages: SelfTestStageResult[];
	passed: boolean;
	/** Failing stage label + exact error, when failed. */
	error?: string;
}

export interface SelfTestDeps {
	/** Account ROOT uuid (credentials.rootUuid), not the vault sync root. */
	rootUuid: string;
	/** Persisted per-device UUID (dirTree requires a UUID deviceId). */
	deviceId: string;
	log?: SyncLog;
	/** Progress callback: fired when a stage starts and when it settles. */
	onStage?: (index: number, stage: SelfTestStageResult) => void;
}

const STAGE_LABELS = [
	"Account & quota",
	"Create test folder",
	"Upload/download round-trip",
	"Metadata interop",
	"Cleanup",
] as const;

const PAYLOAD_SIZE = 32 * 1024;

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit] as string}`;
}

export async function runSelfTest(client: FilenClient, deps: SelfTestDeps): Promise<SelfTestReport> {
	const stages: SelfTestStageResult[] = STAGE_LABELS.map(label => ({
		label, status: "skipped", durationMs: 0,
	}));
	const emit = (index: number): void => deps.onStage?.(index, { ...stages[index] as SelfTestStageResult });

	let folderUuid: string | null = null;
	let folderTrashed = false;
	let failed: { index: number; error: string } | null = null;

	for (let index = 0; index < STAGE_LABELS.length; index++) {
		const stage = stages[index] as SelfTestStageResult;
		stage.status = "running";
		emit(index);
		const started = Date.now();
		try {
			switch (index) {
				case 0: {
					const account = await client.userAccount();
					stage.detail = `${account.email} — ${formatBytes(account.storage)} of `
						+ `${formatBytes(account.maxStorage)} used`;
					break;
				}
				case 1: {
					const name = `filen-cloud-sync-selftest-${randomString(8).toLowerCase()}`;
					folderUuid = await client.dirCreate(name, deps.rootUuid);
					stage.detail = name;
					break;
				}
				case 2: {
					if (!folderUuid) throw new Error("test folder missing");
					const payload = randomBytes(PAYLOAD_SIZE);
					const fileName = `selftest-${randomString(8).toLowerCase()}.bin`;
					const upload = await client.uploadFile(
						folderUuid, fileName,
						payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
						Date.now(),
					);
					// Tree-visible: the fresh dirTree must list the uploaded uuid.
					const tree = await client.dirTree(deps.rootUuid, deps.deviceId);
					const tuple = tree.files.find(f => f[0] === upload.uuid);
					if (!tuple) throw new Error("uploaded file not visible in dir tree");
					const meta = await client.decryptFileMetadata(tuple[5]);
					const { data } = await client.downloadFile(
						{ uuid: upload.uuid, bucket: upload.bucket, region: upload.region, chunks: upload.chunks },
						meta.key,
					);
					const expected = await sha512Hex(payload);
					const actual = await sha512Hex(data);
					if (actual !== expected) {
						throw new Error(`round-trip hash mismatch (expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…)`);
					}
					stage.detail = `${PAYLOAD_SIZE / 1024} KiB byte-exact`;
					break;
				}
				case 3: {
					if (!folderUuid) throw new Error("test folder missing");
					// Re-fetch the tree and decrypt OUR OWN metadata: folder name
					// and file name/size must match what was written.
					const tree = await client.dirTree(deps.rootUuid, deps.deviceId);
					const folderTuple = tree.folders.find(f => f[0] === folderUuid);
					if (!folderTuple) throw new Error("test folder not visible in dir tree");
					const folderName = await client.decryptFolderName(folderTuple[1]);
					if (!folderName.startsWith("filen-cloud-sync-selftest-")) {
						throw new Error(`folder name metadata mismatch: ${folderName}`);
					}
					const fileTuple = tree.files.find(f => f[4] === folderUuid);
					if (!fileTuple) throw new Error("test file not visible in dir tree");
					const meta = await client.decryptFileMetadata(fileTuple[5]);
					if (meta.size !== PAYLOAD_SIZE || !meta.name.startsWith("selftest-")) {
						throw new Error(`file metadata mismatch: ${meta.name} (${meta.size} B)`);
					}
					stage.detail = `${meta.name} (${formatBytes(meta.size)})`;
					break;
				}
				case 4: {
					if (!folderUuid) throw new Error("test folder missing");
					await client.dirTrash(folderUuid);
					folderTrashed = true;
					// Verify trashed: the folder must be gone from the tree.
					const tree = await client.dirTree(deps.rootUuid, deps.deviceId);
					if (tree.folders.some(f => f[0] === folderUuid)) {
						throw new Error("test folder still visible after trash");
					}
					break;
				}
			}
			stage.status = "ok";
			stage.durationMs = Date.now() - started;
			deps.log?.info(`self-test passed: ${stage.label} (${stage.durationMs} ms)`);
		} catch (e) {
			stage.status = "failed";
			stage.durationMs = Date.now() - started;
			stage.error = errMsg(e);
			failed = { index, error: stage.error };
			deps.log?.error(`self-test FAILED: ${stage.label}: ${stage.error}`);
			emit(index);
			break; // abort remaining stages with the exact error
		}
		emit(index);
	}

	// Best-effort cleanup even on failure — never leave test artifacts.
	if (folderUuid && !folderTrashed) {
		try {
			await client.dirTrash(folderUuid);
			deps.log?.info("self-test cleanup: test folder trashed after failure");
		} catch (e) {
			deps.log?.warn(`self-test cleanup failed (trash it manually): ${errMsg(e)}`);
		}
	}

	if (failed) {
		return {
			stages,
			passed: false,
			error: `${STAGE_LABELS[failed.index] as string}: ${failed.error}`,
		};
	}
	deps.log?.info("self-test: all checks passed");
	return { stages, passed: true };
}

/** Staged pass/fail + duration modal. Runs the test on open. */
export class SelfTestModal extends Modal {
	private listEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private latest = new Map<number, SelfTestStageResult>();

	constructor(
		app: App,
		private readonly runner: (
			onStage: (index: number, stage: SelfTestStageResult) => void,
		) => Promise<SelfTestReport>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Filen Cloud Sync self-test");
		const body = this.contentEl.createDiv({ cls: "filen-cloud-sync-selftest" });
		this.summaryEl = body.createDiv({ cls: "filen-cloud-sync-selftest-summary" });
		this.summaryEl.setText("Running self-test…");
		this.listEl = body.createDiv({ cls: "filen-cloud-sync-selftest-list" });
		new Setting(body)
			.addButton(button => button
				.setButtonText("Close")
				.onClick(() => this.close()));
		void this.runner((index, stage) => {
			this.latest.set(index, stage);
			this.renderStages();
		}).then(report => {
			for (let i = 0; i < report.stages.length; i++) {
				this.latest.set(i, report.stages[i] as SelfTestStageResult);
			}
			this.renderStages();
			if (report.passed) {
				this.summaryEl?.setText("All checks passed");
			} else {
				this.summaryEl?.setText(`Self-test failed — ${report.error ?? "unknown error"}`);
				this.summaryEl?.addClass("filen-cloud-sync-log-error");
			}
		}).catch((e: unknown) => {
			this.summaryEl?.setText(`Self-test crashed: ${errMsg(e)}`);
			this.summaryEl?.addClass("filen-cloud-sync-log-error");
		});
	}

	private renderStages(): void {
		if (!this.listEl) return;
		this.listEl.empty();
		for (const [index, stage] of [...this.latest.entries()].sort((a, b) => a[0] - b[0])) {
			const row = this.listEl.createDiv({ cls: "filen-cloud-sync-selftest-row" });
			const mark = stage.status === "ok" ? "PASS"
				: stage.status === "failed" ? "FAIL"
					: stage.status === "running" ? "RUN" : "WAIT";
			const markEl = row.createSpan({ cls: "filen-cloud-sync-selftest-mark" });
			markEl.setText(mark);
			if (stage.status === "failed") markEl.addClass("filen-cloud-sync-log-error");
			if (stage.status === "ok") markEl.addClass("filen-cloud-sync-selftest-ok");
			const label = row.createSpan({ cls: "filen-cloud-sync-selftest-label" });
			label.setText(`${index + 1}. ${stage.label}`);
			const right = row.createSpan({ cls: "filen-cloud-sync-selftest-detail" });
			if (stage.status === "ok" || stage.status === "failed") {
				right.setText(`${stage.detail ?? stage.error ?? ""} (${stage.durationMs} ms)`.trim());
			}
			if (stage.error) {
				const err = row.createDiv({ cls: "filen-cloud-sync-selftest-error filen-cloud-sync-log-error" });
				err.setText(stage.error);
			}
		}
	}

	onClose(): void {
		this.latest.clear();
		this.contentEl.empty();
	}
}
