# SPEC v0.8.0 — QOL batch: conflict cleanup view, background-change notice,
# force-sync-current-file, status-bar timestamp, aggregated conflict notices

Build on v0.7.7 (328 tests green). Version 0.8.0.

## 1. Conflict cleanup view

- New command "Review conflict copies" + a "Review conflict copies" button in
  the dashboard Conflicts section.
- New `src/ui/conflictReview.ts` modal: scans `vault.getFiles()` for the
  conflict-copy pattern (name contains " (conflict " and ends with ")" before
  the extension — reuse/share the exact conflict-name pattern from the
  engine/planner rather than re-implementing it) and lists each copy with its
  derived original path (suffix stripped).
- Per row: copy name, original path, buttons **Open copy**
  (workspace.openLinkText or openFileText — check current API),
  **Open original** (disabled + noted if the original is gone),
  **Delete copy** (fileManager.trashFile; desc notes it also trashes the copy
  on Filen next sync).
- Empty state: "No conflict copies in this vault."
- Modal refreshes after each delete.

## 2. Background-change notice (opt-in)

- Setting `notifyOnBackgroundChanges: boolean` default false + toggle in the
  Sync section: "Notify when a background sync changes files".
- In main.ts's non-manual runSync completion path: if enabled and the run
  transferred anything (uploads+downloads+trashes > 0 from plan counts), show
  ONE friendly one-line Notice, e.g. "Filen Cloud Sync: 2 files updated from
  the cloud" / "1 file uploaded" (compose from counts; pluralize). Empty/error
  runs stay silent (existing error notice behavior unchanged).

## 3. Force sync current file

- Command "Force sync current file" (uses the active editor file) + file-menu
  item on TFile ("Force sync to Filen", icon "upload-cloud").
- New engine method `forceUploadFile(path)`:
  - Paused → Notice "Syncing is paused…" and stop.
  - File missing → Notice error.
  - If a base record exists AND the remote file changed vs base (remoteUuid ≠
    base.remoteUuid): ConfirmModal "Remote copy changed since the last sync —
    overwrite it on Filen? (Your current remote version is kept as a Filen
    version.)" → on confirm proceed, else abort.
  - Upload (new uuid as always), update the base record, persist state, one
    Notice on success ("Uploaded <path>"). Errors → friendly notice + log.
  - Allowed in ANY sync direction (explicit user intent beats the mode).
  - Uses the existing upload path (parent chain ensure, chunk progress not
    needed, concurrency not relevant for one file).
- If conflictResolution is "ask" — force sync does NOT open the merge view;
  the confirm modal above is the only prompt.

## 4. Status bar last-sync timestamp

- Idle status bar text becomes "Filen: idle · <relativeTime>" using the
  existing relativeTime util and lastSyncFinishedAt. Paused stays "paused",
  running stays "running", error stays "error".
- A `registerInterval(window.setInterval(..., 60_000))` refreshes the idle
  timestamp text every minute (cheap, auto-cleaned on unload). No-op on mobile
  (status bar hidden there anyway).

## 7. Aggregated conflict notices

- Engine conflict loop: still logs each conflict individually (log keeps
  detail), but calls `this.notify` ONCE per run with an aggregate message:
  "N conflict(s) — kept both copies (see dashboard or sync log)". Single
  conflict: the existing per-path message is fine as-is.

## Tests

- Conflict-copy pattern matcher: matches real conflict names, rejects
  lookalikes ("note (conflict).md", "conflicting.md", "note (conflict x).md").
- Background notice: fires only when enabled + transfers > 0; silent on empty/
  error runs and when disabled.
- Force sync: uploads + base updated + persisted; remote-changed confirmation
  gate (confirm proceeds / cancel aborts, no upload); paused blocks; missing
  file errors; works under pull mode.
- Aggregate notice: 3 conflicts → exactly 1 notify call with "3"; 1 conflict →
  per-path message.
- Status bar text composition (idle with relative time, paused, error).

## Gates

build clean; ALL prior 328 tests + new green; eslint 0 errors; Node-builtin
grep zero; README features bullets + features.md sections; CHANGELOG 0.8.0;
dist + filen-cloud-sync-0.8.0.zip; checkpoint rsync after each feature to
/mnt/agents/output/obsidian-filen-sync; FINAL STEP: rebuild the repo zip from
the output dir AFTER rsync and verify the manifest inside reads 0.8.0.
