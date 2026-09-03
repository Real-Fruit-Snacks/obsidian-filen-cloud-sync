/**
 * Conflict cleanup view (v0.8.0 feature 1): lists every keep-both conflict
 * copy in the vault ("name (conflict YYYY-MM-DD HHmm).ext" — the exact
 * conflictPathFor pattern, matched via conflictCopyOriginalPath) with its
 * derived original path. Per row: Open copy, Open original (disabled + noted
 * when the original is gone) and Delete copy (fileManager.trashFile — the
 * copy is trashed on Filen on the next sync too). Refreshes after each delete.
 */

import { App, Modal, Notice } from "obsidian";
import type { TFile } from "obsidian";
import { baseNameOf, conflictCopyOriginalPath, pluralize } from "../util";

interface ConflictRow {
	copy: TFile;
	originalPath: string;
}

export class ConflictReviewModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Conflict copies");
		this.render();
	}

	private collectRows(): ConflictRow[] {
		const rows: ConflictRow[] = [];
		for (const file of this.app.vault.getFiles()) {
			const originalPath = conflictCopyOriginalPath(file.path);
			if (originalPath !== null) rows.push({ copy: file, originalPath });
		}
		rows.sort((a, b) => a.copy.path.localeCompare(b.copy.path));
		return rows;
	}

	private render(): void {
		this.contentEl.empty();
		const rows = this.collectRows();
		if (rows.length === 0) {
			this.contentEl.createDiv({ cls: "filen-cloud-sync-conflict-empty" })
				.setText("No conflict copies in this vault.");
			return;
		}
		this.contentEl.createDiv({ cls: "filen-cloud-sync-dashboard-muted" })
			.setText(
				`${pluralize(rows.length, "conflict copy", "conflict copies")} — `
				+ "each kept-both conflict left one of these behind.",
			);
		for (const row of rows) {
			const rowEl = this.contentEl.createDiv({ cls: "filen-cloud-sync-conflict-row" });
			rowEl.createDiv({ cls: "filen-cloud-sync-conflict-name" }).setText(row.copy.name);
			rowEl.createDiv({ cls: "filen-cloud-sync-dashboard-muted" })
				.setText(`Original: ${row.originalPath}`);
			const buttons = rowEl.createDiv({ cls: "filen-cloud-sync-conflict-actions" });

			const openCopy = buttons.createEl("button");
			openCopy.setText("Open copy");
			openCopy.addEventListener("click", () => {
				void this.app.workspace.openLinkText(row.copy.path, "", false);
				this.close();
			});

			const openOriginal = buttons.createEl("button");
			openOriginal.setText("Open original");
			const original = this.app.vault.getFileByPath(row.originalPath);
			if (original) {
				openOriginal.addEventListener("click", () => {
					void this.app.workspace.openLinkText(row.originalPath, "", false);
					this.close();
				});
			} else {
				// The original is gone — disable and say why (hover/aria).
				openOriginal.disabled = true;
				openOriginal.setAttribute("title", "Original file no longer exists");
				openOriginal.setAttribute("aria-label", `Original file ${row.originalPath} no longer exists`);
			}

			const deleteButton = buttons.createEl("button", { cls: "mod-warning" });
			deleteButton.setText("Delete copy");
			deleteButton.setAttribute(
				"title",
				"Moves the copy to trash — it is also trashed on Filen on the next sync",
			);
			deleteButton.addEventListener("click", () => {
				void (async () => {
					// FileManager.trashFile respects the user's deletion preference
					// (system trash vs vault trash) — never a hard delete.
					await this.app.fileManager.trashFile(row.copy);
					new Notice(
						`Moved ${baseNameOf(row.copy.path)} to trash — `
						+ "it will be trashed on Filen on the next sync",
					);
					this.render(); // refresh the list after each delete
				})();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
