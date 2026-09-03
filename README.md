# Filen Cloud Sync

![Filen Cloud Sync cover](docs/images/cover.png)

![CI](https://github.com/Real-Fruit-Snacks/obsidian-filen-cloud-sync/actions/workflows/ci.yml/badge.svg)
![Release](https://img.shields.io/github/v/release/Real-Fruit-Snacks/obsidian-filen-cloud-sync)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Two-way sync between your Obsidian vault and [Filen](https://filen.io), a
zero-knowledge, end-to-end encrypted cloud. Everything is encrypted on your
device before it leaves; your password is used once to derive your keys and
is never stored. Works on **desktop and mobile**.

> **Caution.** A sync plugin writes and deletes files on both sides by
> design. Deletions go to a recoverable trash on both sides and conflicts
> keep both copies — but test on a copy of your vault first, and keep a
> backup this plugin cannot reach.

## Features

- **Real two-way sync** — a persisted three-way base state tells a deletion
  apart from a new file, so edits, deletes, renames and empty folders all
  reconcile correctly. Trash-only deletes: nothing is ever permanently
  removed.
- **Desktop and mobile** — no Node dependencies, no proxy server. Runs
  as-is inside Obsidian on iOS and Android.
- **Sync directions** — two-way by default, or one-way mirrors: push (this
  device overwrites the cloud) and pull (the cloud overwrites this device),
  with a hard guard that refuses to mirror an empty source over your data.
  One-time "Push now" / "Pull now" buttons and commands run a single sync in
  the other direction without touching your default.
- **Pause syncing** — one click on the dashboard or in settings stops every
  sync trigger (automatic and manual) until you resume.
- **Conflict handling** — keep both copies by default, keep-newer optional,
  or a side-by-side merge view ("ask" mode) when you want to decide. Runs
  with several conflicts notify once with an aggregate count instead of a
  notice storm.
- **Conflict cleanup view** — "Review conflict copies" (command or dashboard
  button) lists every conflict copy in the vault with one-click open and
  trash actions.
- **Force sync current file** — command or right-click menu uploads one file
  to Filen right now, in any sync direction, with a confirmation when the
  remote copy changed since the last sync.
- **Background-change notice (opt-in)** — a single one-line notice when an
  automatic sync uploaded, downloaded or deleted files.
- **Status bar timestamp** — the idle status bar shows when the last sync
  finished ("Filen: idle · 3 minutes ago"), refreshed every minute.
- **Offline awareness** — when the network drops, automatic syncs pause
  silently and the status bar and dashboard show "offline"; manual runs get
  a single notice, and everything resumes by itself when you're back.
  Repeated identical error notices are throttled to one per 15 minutes.
- **Guided first run** — before you connect, the dashboard shows a 3-step
  checklist (connect → self-test → sync now) instead of empty panels, and a
  "Next auto sync in ~N min" line under the last run once interval syncing
  is on.
- **Log viewer** — the sync log is a real viewer: substring search, level
  filters (all / warnings + conflicts / errors) and a copy button that
  copies the filtered view.
- **Dry-run sizes** — the plan preview counts line includes per-direction
  byte totals ("3 uploads (2.4 MB), 1 download (310 KB)").
- **Version history** — browse and restore Filen file versions from the
  command palette or the right-click menu.
- **Selective sync** — ignore folders with a right-click; opt-in sync of
  appearance, hotkeys, snippets, plugin lists and more between machines.
- **Shared settings** — optionally sync a curated settings subset across
  devices; credentials and per-device options never travel.
- **Setup transfer** — onboard a second device with a paste-able setup link.
  No passwords or keys included.
- **Dry-run plan preview** — see exactly what the next sync would do before
  anything happens.
- **Sync dashboard + self-test** — connection, last run, quota and one-click
  verification of the whole pipeline against your live account.
- **Gentle by default** — mass-change guard, sync-on-save debounce, fast
  remote polling, parallel transfers, "changed since last sync" explorer
  dots.

The full guide — every option, every caveat, every edge case — lives in
**[docs/features.md](docs/features.md)**.

## Install

### BRAT (beta installs)

1. Install the **BRAT** plugin from the community directory.
2. Run "BRAT: Add a beta plugin for testing" and paste this repository's
   GitHub path. BRAT keeps the plugin updated automatically.

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest
   release.
2. Copy them into `<your vault>/.obsidian/plugins/filen-cloud-sync/`.
3. Enable Community plugins in Obsidian, then enable **Filen Cloud Sync**.

## Quickstart

1. **Settings → Filen Cloud Sync**: enter your Filen email and password
   (plus your 2FA code if enabled) and press **Connect & verify**. The
   remote folder is `Obsidian/<vault name>` by default — change it before
   connecting if you want something else.
2. First sync is a **seed**: an empty side simply receives everything. If
   both sides already have files, diverging same-name files are kept as
   conflict copies — nothing is overwritten silently.
3. Edit a note, wait a few seconds (or run **Sync now**), and check your
   Filen drive.
4. **Second device:** install the plugin, point it at the same remote
   folder, connect — everything downloads. Or paste a setup link from
   **Settings → Setup transfer** and just enter your password.

Commands: `Sync now`, `Open sync dashboard` (ribbon icon),
`Preview sync plan (dry run)`, `Browse version history`, `Run self-test`,
`Show sync log`.

## Requirements & network use

**A Filen account is required** (any plan, including free). The plugin talks
to Filen's public API endpoints and nothing else — `gateway.filen.io`
(auth/metadata), `ingest.filen.io` (encrypted uploads), `egest.filen.io`
(encrypted downloads). No telemetry, no third-party servers.

## Security model

- Zero-knowledge preserved: names, contents, sizes are encrypted client-side
  (AES-256-GCM, exactly like the official Filen clients).
- Your password is used only at connect time to derive keys
  (PBKDF2-SHA512 / Argon2id) and is never persisted.
- Derived keys are stored per device in Obsidian's keychain (never in
  `data.json`, never synced). Optional **memory-only mode** keeps even those
  off disk.
- Deletions on both sides go to trash — Filen's trash is your safety net.

## Warnings

- **One sync system per vault.** Do not run this alongside Obsidian Sync,
  Syncthing, iCloud, git, etc. on the same vault — they fight.
- **Sync only happens while Obsidian runs** (mobile suspends background
  apps).
- **Files larger than 50 MB are skipped by default** (configurable).
- First syncs where **both** sides already have files create conflict copies
  for diverging shared paths. For a clean one-way seed, start with one side
  empty.

## Troubleshooting

Enable **Settings → Filen Cloud Sync → Debug log**, reproduce the problem,
and read the `[filen-cloud-sync]`-tagged console output (details and
per-platform console access in [docs/features.md](docs/features.md#troubleshooting)).
Secrets are never logged; vault file paths are — review logs before sharing.

## Development

```sh
npm install
npm run build   # typecheck + production bundle
npm run test    # 260+ vitest unit tests
npm run lint    # eslint + eslint-plugin-obsidianmd
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security
reports: [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Obsidian or Filen.
