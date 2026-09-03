/**
 * Sync progress modal — opened ONLY for manual runs. Shows the current
 * phase, a progress bar, an op counter with the current path, and per-file
 * chunk detail. On completion it shows WHAT WAS DONE (summary + conflict
 * paths) — not log lines; the full sync log is one "View log" click away.
 * "Close" keeps the sync running in the background; "Cancel sync" sets a
 * flag the engine checks before every op.
 */

import { App, Modal, Setting } from "obsidian";
import type { SyncProgress } from "../sync/engine";

const AUTO_CLOSE_MS = 2500;

export class SyncProgressModal extends Modal {
	private phaseEl: HTMLElement | null = null;
	private barEl: HTMLProgressElement | null = null;
	private counterEl: HTMLElement | null = null;
	private detailEl: HTMLElement | null = null;
	private resultEl: HTMLElement | null = null;
	private cancelButton: HTMLButtonElement | null = null;
	private cancelRequested = false;
	private autoCloseTimer: number | null = null;

	constructor(
		app: App,
		private readonly onShowLog?: () => void,
	) {
		super(app);
	}

	get isCancelRequested(): boolean {
		return this.cancelRequested;
	}

	onOpen(): void {
		this.setTitle("Filen Cloud Sync");
		const body = this.contentEl.createDiv({ cls: "filen-cloud-sync-progress" });
		this.phaseEl = body.createDiv({ cls: "filen-cloud-sync-progress-phase" });
		this.phaseEl.setText("Starting…");
		this.barEl = body.createEl("progress", { cls: "filen-cloud-sync-progress-bar" });
		this.barEl.max = 1;
		this.barEl.value = 0;
		this.counterEl = body.createDiv({ cls: "filen-cloud-sync-progress-counter" });
		// Per-file chunk detail under the counter (v0.6.0 feature C).
		this.detailEl = body.createDiv({ cls: "filen-cloud-sync-progress-detail" });
		// Result block (summary + conflicts) — hidden until finish() (v0.7.7).
		this.resultEl = body.createDiv({ cls: "filen-cloud-sync-progress-result" });
		const buttons = new Setting(body);
		if (this.onShowLog) {
			buttons.addButton(button => button
				.setButtonText("View log")
				.onClick(() => {
					this.onShowLog?.();
				}));
		}
		buttons
			.addButton(button => button
				.setButtonText("Close")
				.onClick(() => this.close())) // sync keeps running in the background
			.addButton(button => {
				this.cancelButton = button.buttonEl;
				button.setDestructive();
				button.setButtonText("Cancel sync")
					.onClick(() => {
						this.cancelRequested = true;
						button.setButtonText("Canceling…");
						button.setDisabled(true);
					});
			});
	}

	/** Engine progress callback. */
	update(progress: SyncProgress): void {
		if (this.autoCloseTimer !== null) return; // summary already showing
		this.phaseEl?.setText(`${progress.phase}…`);
		if (this.barEl) {
			this.barEl.max = Math.max(progress.total, 1);
			this.barEl.value = Math.min(progress.done, progress.total);
		}
		const current = progress.current ? ` — ${progress.current}` : "";
		this.counterEl?.setText(
			progress.total > 0
				? `${progress.done} of ${progress.total}${current}`
				: progress.phase,
		);
		// Chunk detail only while the engine reports it; the :empty CSS rule
		// hides the row when there's no detail text.
		this.detailEl?.setText(progress.detail ?? "");
	}

	/**
	 * Run finished: show what was done — the summary line plus any conflict
	 * paths. Clean success auto-closes after ~2.5s; errors/conflicts keep the
	 * modal open for review.
	 */
	finish(summary: string, clean: boolean, conflicts: string[] = []): void {
		this.phaseEl?.setText(clean ? "Sync complete" : "Sync finished with issues");
		this.counterEl?.setText("");
		this.detailEl?.setText("");
		if (this.barEl) this.barEl.value = this.barEl.max;
		if (this.cancelButton) this.cancelButton.disabled = true;
		if (this.resultEl) {
			this.resultEl.empty();
			this.resultEl.createDiv({ cls: "filen-cloud-sync-progress-summary" }).setText(summary);
			if (conflicts.length > 0) {
				const block = this.resultEl.createDiv({ cls: "filen-cloud-sync-progress-conflicts" });
				block.createDiv({ cls: "filen-cloud-sync-progress-conflicts-head" })
					.setText(`Conflicts — kept both copies (${conflicts.length}):`);
				for (const path of conflicts) {
					block.createDiv({ cls: "filen-cloud-sync-progress-conflict-path" }).setText(path);
				}
			}
		}
		if (clean) {
			this.autoCloseTimer = window.setTimeout(() => this.close(), AUTO_CLOSE_MS);
		}
	}

	onClose(): void {
		if (this.autoCloseTimer !== null) {
			window.clearTimeout(this.autoCloseTimer);
			this.autoCloseTimer = null;
		}
		this.contentEl.empty();
	}
}
