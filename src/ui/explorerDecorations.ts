/**
 * File-explorer "changed since last sync" indicators (v0.6.0 feature D).
 *
 * Two layers, deliberately separated:
 *
 * - `DirtyPathTracker` — PURE set logic (mark/clear/list). Obsidian-free,
 *   DOM-free, fully unit-testable. Tracks vault paths changed locally
 *   since the last fully successful sync.
 *
 * - `ExplorerDecorations` — the thin DOM layer. Adds the `filen-cloud-sync-dirty`
 *   class + a tooltip to `.nav-file-title[data-path="…"]` elements for
 *   every dirty path, and reapplies them via a MutationObserver whenever
 *   Obsidian re-renders the file-explorer tree. EVERYTHING is defensive:
 *   try/catch around DOM work, silent no-op when the explorer isn't in the
 *   DOM (sidebar closed, mobile, tests).
 *
 * Wiring (documented choice): main.ts owns an instance, registers it in
 * onload and disposes it in onunload. Vault create/modify events (inside
 * onLayoutReady) mark paths; main.ts calls `clear()` itself after runSync
 * completes with status "ok"/"empty" — the engine stays UI-free and the
 * "fully successful run" definition lives next to the other post-run
 * handling (shared prefs, dashboard refresh).
 */

import { normalizeVaultPath } from "../util";

/** CSS class + tooltip applied to dirty file-explorer rows. */
export const DIRTY_CLASS = "filen-cloud-sync-dirty";
export const DIRTY_TITLE = "Changed since last sync";

/* ---------------- pure set logic (unit-tested) ---------------- */

export class DirtyPathTracker {
	private readonly dirty = new Set<string>();

	/** Mark a vault path as changed since the last successful sync. */
	mark(path: string): void {
		const normalized = normalizeVaultPath(path);
		if (normalized.length === 0) return; // vault root — never a file
		this.dirty.add(normalized);
	}

	/** Forget everything (called after a fully successful sync). */
	clear(): void {
		this.dirty.clear();
	}

	has(path: string): boolean {
		return this.dirty.has(normalizeVaultPath(path));
	}

	/** Sorted snapshot of the dirty paths (stable for tests/UI). */
	list(): string[] {
		return [...this.dirty].sort();
	}

	get size(): number {
		return this.dirty.size;
	}
}

/* ---------------- thin DOM layer ---------------- */

/** Reapply debounce: Obsidian re-renders the tree in bursts. */
const REAPPLY_DEBOUNCE_MS = 50;

export class ExplorerDecorations {
	private readonly tracker = new DirtyPathTracker();
	private observer: MutationObserver | null = null;
	private observedContainer: Element | null = null;
	private reapplyTimer: number | null = null;
	private started = false;

	/** Start decorating + watching the explorer. Safe to call once. */
	start(): void {
		this.started = true;
		this.ensureObserver();
		this.apply();
	}

	/** Stop watching and remove every decoration from the DOM. */
	dispose(): void {
		this.started = false;
		if (this.reapplyTimer !== null) {
			window.clearTimeout(this.reapplyTimer);
			this.reapplyTimer = null;
		}
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
			this.observedContainer = null;
		}
		this.tracker.clear();
		this.apply(); // dirty set is empty → strips any stale classes
	}

	/** Vault create/modify event → mark + repaint. */
	mark(path: string): void {
		this.tracker.mark(path);
		this.apply();
	}

	/** Fully successful sync → nothing is dirty anymore. */
	clear(): void {
		if (this.tracker.size === 0) return;
		this.tracker.clear();
		this.apply();
	}

	/** Exposed for tests/status UIs. */
	list(): string[] {
		return this.tracker.list();
	}

	get size(): number {
		return this.tracker.size;
	}

	/**
	 * Attach the MutationObserver to the explorer container. Retried on
	 * every apply — the explorer leaf may not exist yet at plugin load
	 * (sidebar closed) and appear later.
	 */
	private ensureObserver(): void {
		try {
			const container = document.querySelector(".nav-files-container");
			if (!container) return; // explorer not in the DOM — silent no-op
			if (this.observer && this.observedContainer === container) return;
			this.observer?.disconnect();
			this.observer = new MutationObserver(() => this.scheduleApply());
			this.observer.observe(container, { childList: true, subtree: true });
			this.observedContainer = container;
		} catch {
			// No DOM / no MutationObserver (tests) — decorations just stay off.
		}
	}

	private scheduleApply(): void {
		if (this.reapplyTimer !== null) return;
		this.reapplyTimer = window.setTimeout(() => {
			this.reapplyTimer = null;
			this.apply();
		}, REAPPLY_DEBOUNCE_MS);
	}

	/**
	 * Single pass over every `.nav-file-title` in the document: dirty paths
	 * get the class + tooltip, everything else gets them stripped. One pass
	 * both applies and cleans, so re-renders, clears and disposes share the
	 * same code path. Attribute-only mutations → never retriggers the
	 * (childList-only) observer.
	 */
	private apply(): void {
		if (!this.started) return;
		try {
			this.ensureObserver();
			const titles = document.querySelectorAll(".nav-file-title");
			for (const title of Array.from(titles)) {
				const el = title as HTMLElement;
				const path = typeof el.dataset?.path === "string" ? el.dataset.path : "";
				if (path.length > 0 && this.tracker.has(path)) {
					if (!el.classList.contains(DIRTY_CLASS)) {
						el.classList.add(DIRTY_CLASS);
						el.setAttribute("title", DIRTY_TITLE);
					}
				} else if (el.classList.contains(DIRTY_CLASS)) {
					el.classList.remove(DIRTY_CLASS);
					el.removeAttribute("title");
				}
			}
		} catch {
			// Explorer absent or mid-teardown — silent no-op by design.
		}
	}
}
