# SPEC v0.7.1 — per-run direction override + pause switch

Build on v0.7.0 (313 tests green). Version 0.7.1.

## A — One-time sync with a chosen direction (dashboard)

- Engine: `SyncRunOptions.direction?: SyncDirection` — when present it takes
  precedence over `settings.syncDirection` FOR THAT RUN ONLY. Persisted
  settings never change. Planner already accepts `syncDirection`; wire
  through: `direction: options.direction ?? settings.syncDirection`.
- Dashboard (src/ui/dashboard.ts): replace the single "Sync now" button with
  three: **Sync now** (uses the default direction), **Push now**, **Pull now**
  (one-time each). Under them, a small muted note: "Push/Pull run once with
  that direction — your default (<current direction>) is unchanged."
- Commands (main.ts): "Push now (one-time)" and "Pull now (one-time)" in the
  command palette, alongside "Sync now".
- The empty-source hard guard (v0.7.0) applies to one-time runs identically.

## B — Pause syncing

- Setting `syncPaused: boolean` default false (data.json; NOT a shared key).
- When paused: ALL sync runs are blocked — auto interval, sync-on-save,
  startup, AND manual commands. `runSync` returns early
  `{status: "paused", message: "Syncing is paused — resume from the dashboard or settings"}`
  without touching anything. Manual triggers show that message as a Notice;
  auto triggers skip silently (status bar shows the state).
- Dashboard: prominent paused state — when paused, a clearly styled banner
  "Syncing is paused" with a **Resume** button; when running, a **Pause**
  button instead. Pause/Resume is one click, persisted.
- Settings tab: a "Pause syncing" toggle in the Sync section with desc
  "Stop all syncing (automatic and manual) until resumed."
- Status bar shows "paused" state; ribbon tooltip notes it.

## Tests

- Per-run override: a Push run executes push semantics with settings on
  twoWay, and the next default-direction run is unaffected (no setting mutation).
- Empty-source guard fires on one-time push.
- Pause: every trigger path (manual command, interval, sync-on-save, startup)
  blocked when paused; zero planner/client calls made; resume restores
  normal operation; state persists through a settings reload.

## Gates

build clean; ALL prior 313 tests + new green; eslint 0 errors; Node-builtin
grep zero; README bullet for pause + one-time buttons (features.md section);
CHANGELOG 0.7.1; dist + filen-cloud-sync-0.7.1.zip; checkpoint rsync to
/mnt/agents/output/obsidian-filen-sync after each chunk. **FINAL STEP: rebuild
the repo zip from the output dir AFTER rsync (verify manifest version inside).**
