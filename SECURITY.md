# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them via
GitHub's private vulnerability reporting ("Security" tab → "Report a
vulnerability"), or contact the maintainer directly if listed in the plugin
manifest. We aim to acknowledge within 72 hours.

Include: what happened, what you expected, reproduction steps, your Filen
Sync version, platform (desktop OS / Android / iOS), and — if relevant — the
output of the **debug log** (Settings → Filen Sync → Debug log, then
reproduce). Logs never contain passwords, keys, or tokens, but they **do
contain vault file paths** — review before sending.

## Supported versions

Only the latest release receives security fixes. Keep the plugin updated.

## Security model (what the plugin does and doesn't do)

- **Zero-knowledge end-to-end encryption**: all file content and metadata is
  encrypted on your device with keys derived from your Filen password before
  anything is sent. Filen (the service) never sees plaintext — same model as
  Filen's official clients.
- **Your password is never stored and never sent.** It is used once, in
  memory, to derive keys (PBKDF2-SHA512, 200k iterations, or Argon2id for
  newer accounts) at connect time. Only the derived API key and master keys
  are kept.
- **Derived keys are stored per device** in Obsidian's keychain
  (`app.secretStorage` where available) or per-device local storage — never
  in the vault, never in `data.json`, never synced. Optional **memory-only
  mode** keeps keys in RAM only and asks for your password each session.
- **Sync state stays on device** (per-device local storage) — it is never
  written to the remote drive except the files you choose to sync.
- **No telemetry, no analytics, no third-party network calls.** The plugin
  talks only to Filen endpoints (`gateway.filen.io`, `ingest.filen.io`,
  `egest.filen.io` and their regional variants).
- **Deletes are trash-only** on both sides (Obsidian's trash and Filen's
  trash) — nothing is ever permanently deleted by the plugin.

## Out of scope / user responsibilities

- **Compromised device**: any sync client must hold usable keys locally.
  Full-disk encryption and a locked user session are the defense.
- **Other plugins' settings**: if you enable syncing of the `plugins` config
  folder, other plugins' `data.json` files (which may contain their own API
  tokens) are synced too — encrypted, but copied to every device.
- **Filen account security**: enable 2FA on your Filen account; the plugin
  supports it at connect time.
