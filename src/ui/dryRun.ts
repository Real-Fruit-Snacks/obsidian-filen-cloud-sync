/**
 * Dry-run plan preview modal (v0.6.0 feature A): shows what the NEXT sync
 * WOULD do — seed-mode note, mass-change-guard warning, pluralized counts
 * and a grouped, scrollable op list with plain-language labels. Nothing was
 * executed. "Sync now" closes the preview and runs a real manual sync.
 */

import { App, Modal, Setting } from "obsidian";
import type { ConflictPolicy, SyncOp, SyncOpKind, SyncPlan } from "../sync/types";
import { pluralize } from "../util";

/** Internal base-maintenance ops never surface in the preview. */
function isVisibleOp(op: SyncOp): boolean {
	return op.kind !== "refreshBase" && op.kind !== "dropBase";
}

interface OpGroup {
	title: string;
	icon: string;
	/** Action label, sentence-case, appended before the path. */
	label: string;
	kinds: SyncOpKind[];
}

const OP_GROUPS: OpGroup[] = [
	{ title: "Uploads", icon: "UP", label: "Upload", kinds: ["upload"] },
	{ title: "Downloads", icon: "DOWN", label: "Download", kinds: ["download"] },
	{ title: "Deletes on this device", icon: "DEL", label: "Delete here", kinds: ["trashLocal", "trashLocalDir"] },
	{ title: "Deletes on Filen", icon: "DEL", label: "Delete on Filen", kinds: ["trashRemote", "trashRemoteDir"] },
	{ title: "Renames on Filen", icon: "REN", label: "Rename on Filen", kinds: ["renameRemote"] },
	{ title: "New folders on this device", icon: "DIR", label: "Folder here", kinds: ["mkdirLocal"] },
	{ title: "New folders on Filen", icon: "DIR", label: "Folder on Filen", kinds: ["mkdirRemote"] },
];

function policyLabel(policy: ConflictPolicy): string {
	return policy === "keep_both" ? "keep both" : "keep newer";
}

function seedNote(seedMode: NonNullable<SyncPlan["seedMode"]>): string {
	switch (seedMode) {
		case "upload-all":
			return "First sync: only this device has files — everything uploads to Filen.";
		case "download-all":
			return "First sync: only Filen has files — everything downloads to this device.";
		case "both-nonempty":
			return "First sync: both sides already have files — same-name files are treated as conflicts.";
	}
}

export class DryRunModal extends Modal {
	constructor(
		app: App,
		private readonly plan: SyncPlan,
		private readonly guardWouldAbort: boolean,
		/** "Sync now": close the preview and run a real manual sync. */
		private readonly onSyncNow: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Sync plan preview");
		const { contentEl, plan } = this;
		contentEl.addClass("filen-cloud-sync-dry-run");

		if (plan.seedMode) {
			contentEl.createDiv({ cls: "filen-cloud-sync-dry-run-note" }).setText(seedNote(plan.seedMode));
		}
		if (this.guardWouldAbort) {
			contentEl.createDiv({ cls: "filen-cloud-sync-dry-run-guard" }).setText(
				"Warning: the mass-change guard would stop this run — review carefully.",
			);
		}

		const visibleOps = plan.ops.filter(isVisibleOp);
		if (visibleOps.length === 0 && plan.conflicts.length === 0) {
			contentEl.createDiv({ cls: "filen-cloud-sync-dry-run-empty" })
				.setText("Everything is already in sync.");
		} else {
			this.renderCounts(contentEl);
			this.renderOpList(contentEl, visibleOps);
		}

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText("Sync now")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSyncNow();
				}))
			.addButton(button => button
				.setButtonText("Close")
				.onClick(() => this.close()));
	}

	/** Counts line: uploads/downloads/deletes/folders/renames/conflicts. */
	private renderCounts(contentEl: HTMLElement): void {
		const c = this.plan.counts;
		const parts = [
			pluralize(c.uploads, "upload"),
			pluralize(c.downloads, "download"),
			pluralize(c.trashLocal + c.trashRemote + c.prunes, "delete"),
			pluralize(c.mkdirLocal + c.mkdirRemote, "folder"),
			pluralize(c.renames, "rename"),
			pluralize(c.conflicts, "conflict"),
		];
		contentEl.createDiv({ cls: "filen-cloud-sync-dry-run-counts" }).setText(parts.join(" · "));
	}

	private renderOpList(contentEl: HTMLElement, visibleOps: SyncOp[]): void {
		const list = contentEl.createDiv({ cls: "filen-cloud-sync-dry-run-list" });
		for (const group of OP_GROUPS) {
			const ops = visibleOps.filter(op => group.kinds.includes(op.kind));
			if (ops.length === 0) continue;
			list.createDiv({ cls: "filen-cloud-sync-dry-run-group" }).setText(group.title);
			for (const op of ops) {
				const row = list.createDiv({ cls: "filen-cloud-sync-dry-run-op" });
				row.createSpan({ cls: "filen-cloud-sync-dry-run-icon" }).setText(group.icon);
				const target = op.toPath ? `${op.path} -> ${op.toPath}` : op.path;
				row.createSpan({ cls: "filen-cloud-sync-dry-run-label" }).setText(`${group.label} ${target}`);
			}
		}
		if (this.plan.conflicts.length > 0) {
			list.createDiv({ cls: "filen-cloud-sync-dry-run-group" }).setText("Conflicts");
			for (const conflict of this.plan.conflicts) {
				const row = list.createDiv({ cls: "filen-cloud-sync-dry-run-op" });
				row.createSpan({ cls: "filen-cloud-sync-dry-run-icon" }).setText("CONF");
				const winner = conflict.winner === "local" ? "this device wins" : "Filen wins";
				row.createSpan({ cls: "filen-cloud-sync-dry-run-label" })
					.setText(`${conflict.path} — ${policyLabel(conflict.policy)} (${winner})`);
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
