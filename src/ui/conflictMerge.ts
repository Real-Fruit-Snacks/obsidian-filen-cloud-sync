/**
 * Conflict merge modal (v0.4.0 feature E, "ask" mode): side-by-side LOCAL vs
 * REMOTE view of a text conflict with line-diff highlighting (self-contained
 * Myers LCS from util.ts — purely visual; with no base content there is NO
 * auto-merge). The engine awaits the decision promise; closing via the close button/Esc
 * resolves as "Keep both" — the never-data-lossy default policy behavior.
 */

import { App, Modal, Setting } from "obsidian";
import type { ConflictPromptRequest } from "../sync/engine";
import type { MergeDecision } from "../sync/planner";
import { diffLines, formatBytes, formatLogTime } from "../util";

/** Rendering cap for pathological files (diff itself has a fallback too). */
const MAX_RENDERED_ROWS = 2000;

export class ConflictMergeModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly request: ConflictPromptRequest,
		private readonly resolve: (decision: MergeDecision) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Resolve conflict");
		const body = this.contentEl.createDiv({ cls: "filen-sync-merge" });

		const header = body.createDiv({ cls: "filen-sync-merge-header" });
		header.createDiv({ cls: "filen-sync-merge-path" }).setText(this.request.path);
		const meta = header.createDiv({ cls: "filen-sync-merge-meta" });
		meta.setText(
			`Local: ${formatLogTime(this.request.localMtime)} · ${formatBytes(this.request.localSize)}`
			+ ` — Remote: ${formatLogTime(this.request.remoteMtime)} · ${formatBytes(this.request.remoteSize)}`,
		);

		const diff = diffLines(this.request.localText, this.request.remoteText);
		const columns = body.createDiv({ cls: "filen-sync-merge-columns" });
		const localCol = columns.createDiv({ cls: "filen-sync-merge-col" });
		const remoteCol = columns.createDiv({ cls: "filen-sync-merge-col" });
		localCol.createDiv({ cls: "filen-sync-merge-col-head" }).setText("Local");
		remoteCol.createDiv({ cls: "filen-sync-merge-col-head" }).setText("Remote");
		const localLines = localCol.createDiv({ cls: "filen-sync-merge-lines" });
		const remoteLines = remoteCol.createDiv({ cls: "filen-sync-merge-lines" });

		let rendered = 0;
		let truncated = 0;
		for (const op of diff) {
			if (rendered >= MAX_RENDERED_ROWS) {
				truncated++;
				continue;
			}
			rendered++;
			const localLine = localLines.createDiv({ cls: "filen-sync-merge-line" });
			const remoteLine = remoteLines.createDiv({ cls: "filen-sync-merge-line" });
			if (op.type === "same") {
				localLine.setText(op.line.length > 0 ? op.line : " ");
				remoteLine.setText(op.line.length > 0 ? op.line : " ");
			} else if (op.type === "remove") {
				localLine.addClass("filen-sync-merge-removed");
				localLine.setText(op.line);
				remoteLine.addClass("filen-sync-merge-blank");
				remoteLine.setText(" ");
			} else {
				remoteLine.addClass("filen-sync-merge-added");
				remoteLine.setText(op.line);
				localLine.addClass("filen-sync-merge-blank");
				localLine.setText(" ");
			}
		}
		if (truncated > 0) {
			body.createDiv({ cls: "filen-sync-merge-truncated" })
				.setText(`… ${truncated} further changed lines not shown`);
		}

		new Setting(body)
			.setDesc(
				"Concatenate writes local + remote into the local file (current time as "
				+ "mtime) and syncs it as a new version. The remote file is never trashed — "
				+ "its superseded content stays in Filen's version history.",
			)
			.addButton(button => button
				.setButtonText("Keep local")
				.onClick(() => this.choose("keep_local")))
			.addButton(button => button
				.setButtonText("Keep remote")
				.onClick(() => this.choose("keep_remote")))
			.addButton(button => button
				.setButtonText("Keep both")
				.onClick(() => this.choose("keep_both")))
			.addButton(button => button
				.setButtonText("Concatenate")
				.onClick(() => this.choose("concat")));
	}

	private choose(decision: MergeDecision): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(decision);
		this.close();
	}

	onClose(): void {
		// Close button / Esc without a choice = Keep both (never data-lossy).
		if (!this.resolved) {
			this.resolved = true;
			this.resolve("keep_both");
		}
		this.contentEl.empty();
	}
}
