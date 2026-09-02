# Changelog

## [0.6.2] — 2026-09-02

### Fixed
- Community-review follow-up: removed globalThis usage (window timers with a
  Node-only fallback for tests); adopted setDestructive directly and raised
  minAppVersion to 1.13.0 (no installs older than that exist).

## [0.6.1] — 2026-09-02

### Fixed
- Community-review feedback: use `FileManager.trashFile` (respects the user's
  deletion preference), remove the plugin name from command names/ids,
  popout-window-compatible timers, `setDestructive` with a `setWarning`
  fallback for older versions, build provenance attestations on release
  assets, and a README placeholder section removed.

All notable changes to Filen Cloud Sync are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/).

## [0.6.0] — first public release

Released as **Filen Cloud Sync** (`filen-cloud-sync`). Developed under the
working name "Filen Sync"; renamed before submission because that name was
already taken in the community directory.

### Added in 0.6.0 — 2026-09-01

### Added
- **Sync plan preview (dry run)** — "Preview sync plan (dry run)" command and
  dashboard button show exactly what a sync would do (uploads, downloads,
  deletes, renames, folders, conflicts) before anything happens. The
  mass-change guard report is shown as a warning instead of aborting.
- **Setup transfer** — export a `filen-cloud-sync://setup/...` link on one device
  and import it on another to copy settings (remote folder, email, shared
  preferences). Contains no passwords or keys. (QR code: planned.)
- **Per-file transfer progress** — uploads/downloads report chunk-level
  progress ("7/12 chunks") in the progress modal.
- **Explorer indicators** — files changed locally since the last successful
  sync get a dot in the file explorer.
- `CONTRIBUTING.md`, `SECURITY.md`, and this changelog.

## [0.5.2] — 2026-09-01

### Changed
- **Plain-language errors** — notices translate raw failures into readable
  titles + next steps (session expired, can't reach Filen, decryption,
  rate limiting, server trouble). Raw detail stays in the sync log.
- **Friendlier sync log** — "Deleted X on Filen (moved to trash)" instead of
  internal jargon; human-readable sizes; correct pluralization.
- **Log modal upgrade** — last-sync summary header, "Copy log" (one click to
  clipboard for bug reports), "Clear log", better empty state.
- **Dashboard** — relative timestamps ("3 minutes ago", exact time on hover).
- **Progress modal** — "View log" button.

## [0.5.1] — 2026-09-01

### Added
- **Config-sync preset toggles** — friendly one-row toggles for appearance &
  theme selection, theme files, hotkeys, CSS snippets, community/core plugin
  lists, and plugin files (with a data-safety warning), plus a "Custom config
  paths" box. All backed by the same allowlist.

## [0.5.0] — 2026-09-01

### Added
- **Shared settings** (opt-in) — sync a curated subset (conflict policy,
  merge-UI mode, dotfile rule, ignore patterns, ignored folders, config
  allowlist) across devices via an encrypted preferences file in the remote
  folder. Last-writer-wins convergence, loop-safe, device names for display.
  Credentials, sync state, remote folder, intervals, size limits, and
  debug/device options always stay per-device.

## [0.4.3] — 2026-09-01

### Fixed
- **Downloads failed in production** — the HTTP wrapper eagerly accessed
  `response.json`, and Obsidian parses JSON on access, throwing on binary
  (encrypted chunk) downloads. JSON is now parsed lazily.
- **Trash/move/rename reported as failed while succeeding** — Filen's action
  endpoints return success envelopes without a `data` field; the client now
  treats only `status: false` as an error (SDK-verified semantics).

## [0.4.2] — 2026-09-01

### Fixed
- **Settings page scrolled to top on toggle** — toggles no longer rebuild the
  whole settings tab; paired inputs update their disabled state in place and
  the config allowlist section dims instead of re-rendering.

## [0.4.1] — 2026-09-01

### Fixed
- **Events probe sent milliseconds; Filen expects seconds** — the fast-poll
  probe would have silently returned zero events forever, making the remote
  tree cache permanently stale (found by independent review against the SDK).
- **Nested folders in config allowlist didn't recurse** (`adapter.list` is
  non-recursive; test mocks now match the real contract).
- **Renaming a synced config file crashed** on a Vault-API call (config files
  are adapter-only); rename hash pre-pass had the same issue.
- **Disabling config sync trashed previously synced config files** on all
  devices — out-of-scope config paths are now protected like ignored folders.
- Merge UI no longer offered for config conflicts (which are always
  keep-newest); progress recount after merge decisions; watermark race;
  memory-only mode no longer persists the key-bearing remote-tree cache
  (kept in-session only); dashboard skip-count double-count.

## [0.4.0] — 2026-09-01

### Added
- **Selective `.obsidian` config sync** (opt-in) — allowlist-based, adapter
  IO, keep-newest conflicts, `workspace.json` hard-blocked.
- **Self-test command** — five-stage live verification (account/quota,
  folder create, encrypted upload→download hash round-trip, metadata
  interop, cleanup) that never touches the vault.
- **Parallel chunk transfers** — pool of 3 for uploads and downloads.
- **Fast remote polling** — events probe skips the full remote scan when
  nothing changed (30-minute TTL, prune-skip on cached trees, full scan on
  any doubt or manual run).
- **Conflict merge view** — optional "ask" mode with a side-by-side diff;
  keep local / keep remote / keep both / concatenate.
- **Status dashboard** — sidebar view: connection, last run, conflicts,
  skipped files, Filen storage quota, action buttons.

## [0.3.1] — 2026-09-01

### Fixed
- Restore could fail to propagate in a same-second edge case.
- Double-clicking "Sync now" opened a dead progress modal.
- Version restore now refuses mid-sync and detects the file having changed
  since the version list loaded; `fileMove` test coverage added.

## [0.3.0] — 2026-09-01

### Added
- **Selective folder ignore** — multi-folder, suggest-as-you-type picker and
  right-click "Ignore in Filen Cloud Sync"; ignored paths are never touched on
  either side and resume cleanly.
- **Version history** — browse and restore Filen file versions from Obsidian.
- **Memory-only credential mode** (optional) — keys never touch disk; unlock
  with your password each session.
- **Rename detection** — server-side rename/move instead of delete+re-upload
  (conservative content-hash matching).
- **Sync progress modal** — live phase, progress bar, op counter, log tail,
  cancel button.

## [0.2.0] — 2026-09-01

### Added
- On/off toggles for automatic interval sync, large-file skipping, and the
  mass-change guard (values grey out when disabled).

## [0.1.4] — 2026-09-01

### Fixed
- **Chunk uploads rejected with "Invalid API key"** — the ingest server
  requires the `Authorization` header (verified against the SDK).

## [0.1.3] — 2026-09-01

### Fixed
- **`Invalid deviceId`** — the server requires a UUID (now persisted per
  device).
- **Latent data-loss bug**: always request the full remote tree
  (`skipCache: 1`) — Filen's cache contract can answer a known device with an
  empty tree meaning "unchanged", which a cache-less client would read as
  "remote empty" and plan mass local deletions.

## [0.1.2] — 2026-09-01

### Added
- **Debug log setting** — opt-in, secret-free console diagnostics
  (`[auth]`/`[http]`/`[transfer]`/`[sync]` tags).

## [0.1.1] — 2026-09-01

### Fixed
- Three Filen routes are GET-only (`/v3/user/dek`, `/v3/user/baseFolder`,
  `/v3/user/keyPair/info`) — the client POSTed them, causing
  "Invalid endpoint" after a successful login.

## [0.1.0] — 2026-09-01

### Added
- Initial release: two-way vault sync to Filen (zero-knowledge E2EE) on
  desktop and mobile via a minimal pure-TypeScript Filen client (WebCrypto,
  no Node dependencies), three-way reconciliation with persisted base state,
  keep-both/keep-newer conflict policies, trash-only deletes, first-sync
  seed modes, mass-change guard, atomic downloads, ignore patterns,
  size limits, sync-on-save + interval sync, and a sync log.
