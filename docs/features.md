# Filen Cloud Sync — full feature guide

The detailed reference. The [README](../README.md) covers the overview;
this document covers every option, caveat and edge case.

## Table of contents

- [Ignored folders](#ignored-folders)
- [Version history](#version-history)
- [Memory-only credentials](#memory-only-credentials)
- [Rename detection](#rename-detection)
- [Sync progress modal](#sync-progress-modal)
- [Selective .obsidian config sync](#selective-obsidian-config-sync)
- [Shared settings](#shared-settings)
- [Dry-run plan preview](#dry-run-plan-preview)
- [Setup transfer](#setup-transfer)
- [Explorer "changed since last sync" indicators](#explorer-changed-since-last-sync-indicators)
- [Self-test](#self-test)
- [Parallel chunk transfers](#parallel-chunk-transfers)
- [Fast remote polling](#fast-remote-polling)
- [Conflict merge view (ask mode)](#conflict-merge-view-ask-mode)
- [Sync dashboard](#sync-dashboard)
- [Troubleshooting with the debug log](#troubleshooting)
- [Known limitations](#known-limitations)
- [Non-goals](#non-goals)

## Ignored folders

Add folders under **Settings → Filen Cloud Sync → Ignored folders**
(type-ahead folder suggestions) or right-click a folder in the file explorer
→ **Ignore in Filen Cloud Sync**. Ignored folders are completely excluded
from syncing in **both** directions: local changes inside them are not
uploaded, remote changes are not downloaded, and deletions never propagate
in or out. Their sync base records are preserved, so removing a folder from
the ignore list later resumes syncing it cleanly (no conflict duplicates).

## Version history

Run **Browse version history** (or right-click a file → **Filen version
history**) to list the versions Filen keeps for the current file, newest
first. **Restore** downloads that version, verifies its SHA-512, and
replaces the local file with the current time as mtime — so the restored
content wins the next sync and propagates everywhere as a new version (your
replaced content stays on Filen as a version, too).

## Memory-only credentials

**Settings → Filen Cloud Sync → Memory-only credentials**: keys are kept
only in memory and never written to disk. Each Obsidian start begins
**locked** (lock ribbon icon); run **Unlock sync** and enter your password
(+2FA) to unlock for the session. Enabling the toggle wipes any previously
stored keys; disabling it offers to persist the unlocked keys or discard
them. In this mode the remote-tree cache (which contains per-file content
keys) is also kept off disk — it lives only for the session, so the first
sync after each unlock always fetches the full remote tree once.

## Rename detection

When you rename or move a file whose content is unchanged, the sync compares
size + SHA-512 against the remote and performs a server-side rename/move (no
re-upload). Detection is deliberately conservative: if the content changed,
the hash is missing, or more than one candidate matches, it falls back to a
plain delete + upload.

## Sync progress modal

Manual runs (**Sync now**) open a progress modal: phase, progress bar, op
counter, live log tail. **Close** keeps syncing in the background; **Cancel
sync** stops cleanly after the current operation (partial progress is kept,
the next sync resumes). Automatic syncs stay silent.

While a multi-chunk file transfers, a per-file chunk counter appears under
the op counter (`3/7 chunks`) — chunks complete out of order through the
transfer pool, so the counter counts completions, not chunk indices.

## Selective .obsidian config sync

**Settings → Filen Cloud Sync → Sync Obsidian config folder** (off by
default) syncs an allowlist of files inside `.obsidian`. Friendly **preset
toggles** cover the common items — appearance & theme selection, theme files
(`themes`), hotkeys, CSS snippets, community/core plugin lists, and plugin
files (`plugins`) — all enabled by default except `themes` and `plugins`.
A **Custom config paths** box takes anything else (one path per line;
folders sync recursively). Everything not listed stays excluded. Caveats:

- **`workspace.json` (and every `workspace*` file) is never synced**, even
  if you add it to the allowlist — layouts are per-device.
- Config paths always resolve conflicts as **keep-newest** (the loser goes
  to trash, no conflict copies), regardless of the global conflict policy —
  don't edit the same setting on two devices at once.
- Config changes don't fire vault events, so they're picked up on the next
  interval, manual or startup sync — not instantly on save.
- Config files are invisible to Obsidian's Vault API, so the plugin reads,
  writes and trashes them through the filesystem adapter (soft-delete only,
  like everything else).
- The plugin's own folder is hard-excluded even under the `plugins` preset —
  its per-device state would conflict forever; the shared-settings feature
  (below) is the channel for preferences.

## Shared settings

**Settings → Filen Cloud Sync → Share settings across devices** (off by
default) syncs a **curated subset** of settings between your devices via an
encrypted `.filen-cloud-sync-preferences.json` file stored directly in the
remote sync folder. The synced keys are exactly:

- **Conflict policy** (`keep both` / `keep newer`)
- **Conflict resolution** (`auto` / `ask` merge view)
- **Exclude dot files** toggle
- **Ignore patterns**
- **Ignored folders**
- **Config sync allowlist** (the allowlist content — the "Sync Obsidian
  config folder" toggle itself stays per-device)

Everything else always stays per-device: credentials and email, the remote
folder, sync intervals and startup/save toggles, the config-sync toggle,
size limits, the mass-change guard, fast remote polling, memory-only
credentials and the debug log.

How it converges:

- Enabling the toggle fetches the remote file: if another device already
  wrote one, its values are applied locally; otherwise your current local
  values become the seed.
- While enabled, changing any of the six keys uploads the file (debounced,
  2 s), and after every sync run a newer remote file is downloaded and
  applied. **Last writer wins** — the `updatedAt` timestamp inside the file
  decides; there is no merging. Don't edit the same shared setting on two
  devices at the same time.
- Each device can set a **Device name** (defaults to the vault name); it
  appears in sync-log lines like `shared settings applied (written by …)`.
- The file itself is never synced as vault content (hard-excluded from
  every scan and plan), is managed only through explicit encrypted client
  calls, and turning the toggle off stops both directions — local values
  stay as they are.

## Dry-run plan preview

Run **Preview sync plan (dry run)** from the command palette (or the
**Preview sync plan** button on the dashboard) to see exactly what the next
sync *would* do — before anything happens. The preview runs the same
scan → plan pipeline as a real sync but executes nothing: no uploads,
downloads or deletes, no changes to the local sync state, and no progress
modal. The modal shows a counts line (uploads / downloads / deletes /
folders / renames / conflicts) and a grouped, scrollable list of every
planned operation in plain language, plus a first-sync (seed mode) note when
applicable.

If the mass-change guard *would* stop a real run, the preview says so with
a warning instead of aborting, so you can review the full plan first.
**Sync now** in the preview footer closes it and starts a real sync.

## Setup transfer

**Settings → Filen Cloud Sync → Setup transfer** copies your configuration
to another device with a setup link (`filen-cloud-sync://setup/…`):

- **Export setup** shows a read-only link regenerated from your current
  settings, with a **Copy** button. The link contains the remote folder,
  your email (if set) and the six shared-prefs keys — **never passwords,
  API keys or master keys**.
- **Import setup** on the other device pastes the link and applies it: the
  email (only if none is set locally), the remote folder and the six shared
  keys. Importing never connects and never stores credentials — you still
  enter your Filen password (and 2FA) yourself.

QR code transfer is intentionally out of scope for now.

## Explorer "changed since last sync" indicators

Files created or modified locally since the last fully successful sync get a
small accent-colored dot next to their name in the file explorer (hover
shows "Changed since last sync"). The dots are a local, visual reminder
only — they don't affect sync decisions. A successful sync clears them; a
failed or aborted run keeps them. The decorator watches the explorer with a
MutationObserver and reapplies after Obsidian re-renders the tree; when the
file explorer isn't open (e.g. mobile), it stays quietly out of the way.

## Self-test

**Run self-test** checks your connection end to end without touching the
vault or the sync state: account/quota lookup, creation of a throwaway
`filen-cloud-sync-selftest-<random>` folder, an encrypted
upload → download round-trip of 32 KiB random bytes verified by SHA-512,
decryption of the plugin's own metadata, and cleanup (the test folder is
trashed — best-effort even when a stage fails). The modal shows each stage
with PASS/FAIL and its duration; the first failure aborts the rest with the
exact error.

## Parallel chunk transfers

File chunks (1 MiB each) transfer through a fixed pool of 3 workers, for
uploads and downloads alike. Chunks are index-addressed so completion order
doesn't matter; a failing chunk fails the file (the existing per-chunk
retry/backoff still applies first). Note that Obsidian offers no range-read
API, so whole files are still buffered in memory during transfer — the
default 50 MB size limit (Settings → Skip large files) is the mitigation.

## Fast remote polling

**Settings → Filen Cloud Sync → Fast remote polling** (on by default) probes
Filen's events feed after each local scan. When the feed reports **no
changes** since the last watermark, the full remote directory scan is
skipped and the cached remote tree (at most **30 minutes** old) is reused
instead. Safety rails:

- A failed probe **never** trusts silence — it falls back to a full scan.
- Manual **Sync now** runs always scan in full.
- A cache older than 30 minutes is always refreshed.
- While a cached tree is in use, **remote-folder cleanup (pruning) is
  skipped entirely** — cheap insurance against pruning a folder the stale
  cache doesn't know about. File-level logic is unchanged, and the three-way
  base plus trash-only deletes bound the blast radius in any case.

## Conflict merge view (ask mode)

**Settings → Filen Cloud Sync → Conflict resolution → Ask** pauses the sync
on each text conflict (UTF-8-decodable, ≤ 1 MiB) and opens a side-by-side
**Local vs Remote** view with line-diff highlighting. Buttons: **Keep
local** (upload; the remote version goes to Filen trash), **Keep remote**
(download; the local version goes to trash), **Keep both** (the default
policy behavior — also what closing the view does), and **Concatenate**
(local + remote written into the local file and synced as a new version; the
remote file is never trashed). Multiple conflicts queue sequentially. Binary
or oversized files silently fall back to the auto policy. Note the diff is
visual only — with no common base version there is no auto-merge.

## Sync dashboard

Run **Open sync dashboard** (or click the ribbon icon — it toggles the
dashboard; when memory-only mode is locked it still opens the unlock
prompt). The right-sidebar view shows the connection state and remote
folder, the last run's time/status/summary, conflicts from the last plan,
the skipped/excluded count, and your Filen storage quota with a thin
progress bar (fetched when the view opens and after manual syncs; "quota
unavailable" on failure). Buttons: **Sync now**, **Preview sync plan**,
**Run self-test**, **Open settings**, **Show sync log**. The view refreshes
on open, after each completed run and on settings save — no background
timers.

## Troubleshooting

Enable **Settings → Filen Cloud Sync → Debug log**, then open the developer
console and reproduce the problem:

- **Desktop:** `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Opt+I` (macOS) →
  Console tab
- **Android:** `chrome://inspect` on a connected desktop (USB debugging)
- **iOS:** Safari → Develop menu → Web Inspector (macOS required)

Every line is prefixed `[filen-cloud-sync]` and tagged by area:

| Tag | What it shows |
|---|---|
| `[auth]` | connect-flow steps (auth version detected, login ok, keys ok) |
| `[http]` | every request: method, endpoint, HTTP status, duration, retry attempts, server error code/message |
| `[transfer]` | uploads/downloads: file, size, chunk count, SHA-512 verify result |
| `[sync]` | engine: tree sizes, plan summary, conflicts, guard aborts, errors |

**Never logged:** your password, derived keys, API token, master keys, DEK,
file keys, upload keys, request bodies, or `Authorization` headers. Vault
file paths **are** included — don't paste logs into public places without
reviewing them first. Debug mode also records verbose "info" entries into
the persisted sync log (command: **Show sync log**). Turn the toggle off
again for daily use.

## Known limitations

- **Cross-side case-only renames are still risky.** Local renames of
  unchanged files are detected via content hash, but Filen's backend is
  case-insensitive (names are hashed lowercase), so renaming `Note.md` →
  `note.md` while another device still has the old casing can produce a
  conflict copy or duplicate instead of a clean rename. Change more than
  the case, or rename on all devices.
- **Rename detection needs the remote content hash.** Files uploaded by
  clients that don't store a SHA-512 in metadata fall back to delete +
  re-upload on rename.
- **authVersion-3 accounts and live-account interop with the official
  Filen clients still require real-account testing.** The wire formats are
  reimplemented from the official `@filen/sdk`, but v3 logins and
  mixed-client vaults have not been verified against production accounts
  yet — test on a copy of your vault first.
- **Config sync is last-writer-wins.** `.obsidian` config paths always use
  keep-newest conflict semantics with no conflict copies, so simultaneous
  edits of the same setting on two devices lose the older edit (recoverable
  from trash). Config changes also don't trigger live sync — they propagate
  on the next scheduled/manual run.
- **Whole files are buffered in memory during transfer.** Obsidian has no
  range-read API (and Node `fs` is unavailable on mobile), so chunk
  parallelism does not reduce peak memory. The default 50 MB per-file limit
  (Settings → Skip large files) is the mitigation.
- **The events cache can be up to 30 minutes stale.** Fast remote polling
  reuses a cached remote tree while Filen's events feed is quiet. If the
  feed itself ever misses a change, the cache is at most 30 minutes old, a
  failed probe forces a full scan, remote-folder pruning is skipped for
  cached trees, and manual syncs always scan in full — plus the three-way
  base and trash-only deletes bound any mistake.
- **No automatic content merge.** Conflicts between text files can be
  resolved interactively in ask mode, but the diff is visual only: a two-way
  sync has no common base version, so a correct three-way auto-merge is
  impossible — you pick a side (or concatenate) explicitly.

## Non-goals

No live/realtime sync, no background sync while Obsidian is closed, no
automatic merging of conflicting file contents, no shared-vault or
public-link features.
