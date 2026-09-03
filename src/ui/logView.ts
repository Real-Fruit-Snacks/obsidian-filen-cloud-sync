/**
 * Sync log viewer (v0.8.1 feature 6): replaces the plain text dump with a
 * real viewer — toolbar with case-insensitive substring search + level
 * dropdown ("All levels" / "Warnings + conflicts" / "Errors only") + Copy
 * (the FILTERED view) + Clear. Rows are a colored level chip (CSS vars
 * only), a muted mono timestamp, and the message in normal text so paths
 * stay readable. The filter itself is the pure `filterLogEntries` (sync/log)
 * — presentation only lives here. SyncLog.render() stays the raw full-text
 * pipeline for debugging; Copy renders the filtered entries through the same
 * line shape (renderLogEntries).
 */

import { App, Modal, Notice, Setting } from "obsidian";
import {
	filterLogEntries,
	logLevelChip,
	LogLevelFilter,
	renderLogEntries,
	SyncLog,
} from "../sync/log";
import { formatLogTime, relativeTime } from "../util";

const LEVEL_OPTIONS: Array<{ value: LogLevelFilter; label: string }> = [
	{ value: "all", label: "All levels" },
	{ value: "warnings", label: "Warnings + conflicts" },
	{ value: "errors", label: "Errors only" },
];

export class SyncLogModal extends Modal {
	private level: LogLevelFilter = "all";
	private query = "";
	/** Rows container — re-rendered alone so the search box keeps focus. */
	private listEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly log: SyncLog,
		private readonly getLastRun: () => { finishedAt: number; status: string; message: string } | null,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Filen Cloud Sync log");
		this.contentEl.addClass("filen-cloud-sync-log-modal");
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.listEl = null; // detached by empty() — recreated by renderList()

		// Header: last-run summary (unchanged from the plain viewer).
		const lastRun = this.getLastRun();
		if (lastRun) {
			const summary = this.contentEl.createDiv({ cls: "filen-cloud-sync-log-summary" });
			summary.setText(`Last sync: ${relativeTime(lastRun.finishedAt)} — ${lastRun.message}`);
		}

		/* ---- Toolbar: search + level + actions ---- */
		const toolbar = this.contentEl.createDiv({ cls: "filen-cloud-sync-log-toolbar" });
		const search = toolbar.createEl("input", {
			cls: "filen-cloud-sync-log-search",
			attr: { type: "search", placeholder: "Search log…", "aria-label": "Search log" },
		});
		search.value = this.query;
		search.addEventListener("input", () => {
			this.query = search.value;
			this.renderList();
		});
		const levelSelect = toolbar.createEl("select", {
			cls: "dropdown filen-cloud-sync-log-level",
			attr: { "aria-label": "Filter by level" },
		});
		for (const option of LEVEL_OPTIONS) {
			const opt = levelSelect.createEl("option");
			opt.value = option.value;
			opt.textContent = option.label;
		}
		levelSelect.value = this.level;
		levelSelect.addEventListener("change", () => {
			this.level = levelSelect.value as LogLevelFilter;
			this.renderList();
		});

		new Setting(toolbar)
			.addButton(button => button
				.setButtonText("Copy log")
				.onClick(() => {
					// Copies the FILTERED view (newest last, same line shape as
					// SyncLog.render()) so shared excerpts match what's on screen.
					const filtered = filterLogEntries(this.log.getEntries(), this.level, this.query);
					void navigator.clipboard.writeText(renderLogEntries(filtered));
					new Notice("Log copied — paste it anywhere to share");
				}))
			.addButton(button => {
				button.setDestructive();
				button.setButtonText("Clear log")
					.onClick(() => {
						this.log.clear();
						this.render();
					});
			})
			.addButton(button => button
				.setButtonText("Close")
				.onClick(() => this.close()));

		this.renderList();
	}

	/** Re-render ONLY the rows (toolbar keeps focus while typing). */
	private renderList(): void {
		if (!this.listEl || !this.listEl.isConnected) {
			this.listEl = this.contentEl.createDiv({ cls: "filen-cloud-sync-log-view" });
		}
		const view = this.listEl;
		view.empty();

		const entries = this.log.getEntries();
		if (entries.length === 0) {
			view.createDiv({ cls: "filen-cloud-sync-log-empty" })
				.setText("Nothing logged yet — run a sync and entries will appear here.");
			return;
		}
		const filtered = filterLogEntries(entries, this.level, this.query);
		if (filtered.length === 0) {
			view.createDiv({ cls: "filen-cloud-sync-log-empty" })
				.setText("No matching log entries.");
			return;
		}
		// Newest first, same as the plain viewer did.
		for (const entry of filtered.slice().reverse()) {
			const row = view.createDiv({ cls: "filen-cloud-sync-log-entry" });
			const chip = row.createSpan({
				cls: `filen-cloud-sync-log-chip filen-cloud-sync-log-chip-${entry.level}`,
			});
			chip.setText(logLevelChip(entry.level));
			row.createSpan({ cls: "filen-cloud-sync-log-ts" }).setText(formatLogTime(entry.ts));
			row.createSpan({ cls: "filen-cloud-sync-log-msg" }).setText(entry.message);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
