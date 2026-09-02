/**
 * Sync progress modal (feature E) — opened ONLY for manual runs. Shows the
 * current phase, a progress bar, an op counter with the current path, and a
 * live tail of the sync log. "Close" keeps the sync running in the
 * background; "Cancel sync" sets a flag the engine checks before every op.
 */

import { App, Modal, Setting } from "obsidian";
import type { SyncProgress } from "../sync/engine";
import type { SyncLog } from "../sync/log";

const LOG_TAIL_LINES = 6;
const AUTO_CLOSE_MS = 2500;

export class SyncProgressModal extends Modal {
	private phaseEl: HTMLElement | null = null;
	private barEl: HTMLProgressElement | null = null;
	private counterEl: HTMLElement | null = null;
	private detailEl: HTMLElement | null = null;
	private logEl: HTMLElement | null = null;
	private cancelButton: HTMLButtonElement | null = null;
	private cancelRequested = false;
	private autoCloseTimer: number | null = null;

	constructor(
		app: App,
		private readonly log: SyncLog,
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
		// v0.6.0 feature C: per-file chunk detail under the counter.
		this.detailEl = body.createDiv({ cls: "filen-cloud-sync-progress-detail" });
		this.logEl = body.createDiv({ cls: "filen-cloud-sync-progress-log" });
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
		// Chunk detail only while the engine reports it (v0.6.0 feature C);
		// the :empty CSS rule hides the row when there's no detail text.
		this.detailEl?.setText(progress.detail ?? "");
		this.renderLogTail();
	}

	private renderLogTail(): void {
		if (!this.logEl) return;
		this.logEl.empty();
		for (const entry of this.log.getEntries().slice(-LOG_TAIL_LINES)) {
			const line = this.logEl.createDiv({ cls: "filen-cloud-sync-progress-log-line" });
			if (entry.level === "error") line.addClass("filen-cloud-sync-log-error");
			if (entry.level === "warn" || entry.level === "conflict") line.addClass("filen-cloud-sync-log-warn");
			line.setText(entry.message);
		}
	}

	/**
	 * Run finished: show the summary. Clean success auto-closes after ~2.5s;
	 * errors/conflicts keep the modal open for review.
	 */
	finish(summary: string, clean: boolean): void {
		this.phaseEl?.setText(clean ? "Sync complete" : "Sync finished with issues");
		this.counterEl?.setText(summary);
		this.detailEl?.setText("");
		if (this.barEl) this.barEl.value = this.barEl.max;
		if (this.cancelButton) this.cancelButton.disabled = true;
		this.renderLogTail();
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
