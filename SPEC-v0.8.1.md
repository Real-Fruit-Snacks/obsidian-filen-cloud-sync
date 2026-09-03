# SPEC v0.8.1 — polish batch (8 items)

Build on v0.8.0 (352 tests green). Version 0.8.1.

## 1. Dashboard guided empty state
When not connected (no credentials anywhere), the dashboard shows, instead of
the empty sections: a heading "Get started" + three numbered steps with
buttons — 1. "Connect your Filen account" (opens settings), 2. "Run self-test"
(disabled until connected), 3. "Sync now" (disabled until connected). Connected
but no run yet: keep current sections but "Last run" already has its text — fine.

## 2. Offline awareness
- Signal sources: `navigator.onLine === false` at run start AND repeated network
  failures (the existing friendlyError network patterns) during a run.
- State (in-memory on the plugin): `offline`. Enter offline when: navigator says
  offline, OR 2 consecutive runs fail with network-class errors. Exit offline on
  any successful gateway request (client reports success via a lightweight
  callback or by clearing on the next successful run).
- While offline: auto triggers (interval/save/startup) skip silently; manual
  runs show ONE Notice "You're offline — sync resumes when you're back";
  status bar shows "Filen: offline"; dashboard Connection section shows
  "Offline" state. No error-log spam (see also #3).

## 3. Error-notice throttle
main.ts friendlyNotice: identical message text → at most one Notice per
15 minutes (track lastShownAt per message in memory; dashboard/log unaffected).
Manual-run results always notify (they're user-invoked); the throttle applies
to repeated identical AUTO/background messages.

## 4. Dry-run shows sizes
Planner already has sizes: extend the dry-run counts line to include bytes per
direction — "3 uploads (2.4 MB), 1 download (310 KB), 0 deletes…" using
formatBytes. SyncPlan.counts gains uploadsBytes/downloadsBytes (sum of
LocalFile.size / RemoteFile.size for those ops). Pure planner change + modal
rendering; conflict copies count toward their direction.

## 5. Unlock modal ergonomics
ui/unlock.ts: autofocus the password input on open (`inputEl.focus()`), and
Enter in the password/2FA fields submits the form (keypress/Enter listener on
both inputs → same path as the unlock button).

## 6. Sync log becomes a real log viewer
Rework SyncLogModal (main.ts, or move to src/ui/logView.ts — implementer's call):
- Toolbar row: search text input (case-insensitive substring filter on
  message), level dropdown ("All levels" / "Warnings+ conflicts" / "Errors
  only"), Copy log (copies the FILTERED view), Clear.
- Rows: colored level badge chip (INFO/WARN/CONF/ERR — CSS vars only:
  success/warning/error/accent colors), timestamp in muted mono, message with
  normal text (paths stay readable). Conflict level uses warning color.
- Default level filter: All. Empty result state: "No matching log entries."
- The render() pipeline already produces plain text for copy — keep render()
  for clipboard (raw), the viewer is presentation-only.

## 7. About block in settings
Bottom of the settings tab, a subtle section: "Filen Cloud Sync <version> · by
Real-Fruit-Snacks · GitHub · Report an issue" (links to the repo and
repo/issues). Version read from this.manifest.version at runtime (never
hardcode).

## 8. Next auto sync line
Dashboard "Last run" section gains a muted second line when connected +
interval on + not paused: "Next auto sync in ~N min" (compute from
syncIntervalMinutes and lastSyncFinishedAt; if none this session: "on the next
interval"). No timers inside the view — computed at render/refresh only.

## Tests
- Offline state machine: navigator offline → offline mode; 2 consecutive
  network-fail runs → offline; success → online; auto triggers skip; manual
  notices once.
- Notice throttle: same message twice in 15 min → 1 notice; different messages
  → 2; after window → repeats.
- Dry-run sizes: counts bytes per direction correct (mixed op set).
- Unlock: no DOM test needed beyond existing patterns; keep smoke-level.
- Log viewer: filter logic (level + search) as a pure function tested
  separately (extract `filterLogEntries(entries, level, query)`).
- Status bar/About/dashboard lines: pure composers tested where extracted.

## Gates
build clean; ALL prior 352 tests + new green; eslint 0 errors; Node-builtin
grep zero; README bullets where user-visible; features.md sections; CHANGELOG
0.8.1; dist + filen-cloud-sync-0.8.1.zip; checkpoint rsync after each feature;
FINAL STEP: rebuild the repo zip from the output dir AFTER rsync and verify the
manifest inside reads 0.8.1.
