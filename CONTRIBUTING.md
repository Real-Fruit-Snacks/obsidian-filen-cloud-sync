# Contributing to Filen Sync

Thanks for helping out. This document covers development setup, the project
rules that keep the plugin working everywhere, and the release process.

## Setup

```sh
git clone <repo-url> filen-sync
cd filen-sync
npm install
npm run dev        # esbuild watch mode → main.js
```

Install into a **test vault** (never your real one) by symlinking or copying
the repo into `<vault>/.obsidian/plugins/filen-sync/`, then enable it in
Obsidian. Iterate with `npm run dev` + "Reload app without saving".

## Before you submit anything

All four gates must pass:

```sh
npm run build      # tsc type-check + esbuild production bundle
npm run test       # vitest unit tests
npm run lint       # eslint + eslint-plugin-obsidianmd (0 errors)
grep -nE 'require\("(fs|crypto|path|os|stream|buffer|https|url|util|events|node:.*)"\)' main.js
# ^ must output NOTHING — this is the mobile-crash tripwire
```

## Project rules (the ones that bite)

1. **No Node.js built-ins anywhere in runtime code** (`fs`, `crypto`, `path`,
   `stream`, `Buffer`, `process`…). The plugin runs in a mobile WebView where
   they don't exist. Crypto = WebCrypto (`crypto.subtle`) + `@noble/hashes`.
2. **All HTTP goes through `requestUrl`** (via the injected `HttpFn` in
   `src/http.ts`) — never `fetch`/axios; `requestUrl` bypasses CORS on mobile.
3. **No regex lookbehind** (crashes iOS < 16.4 WebViews).
4. **NFC-normalize every path** (`normalizeVaultPath`); compare mtimes in
   whole seconds; preserve mtimes on writes (`DataWriteOptions`).
5. **Trash-only deletes** — never a permanent delete, local or remote.
6. **Pure modules stay pure**: `src/filen/crypto.ts`, `src/filen/client.ts`,
   `src/sync/planner.ts`, `src/util.ts` import nothing from `obsidian` so
   they run under plain-Node vitest.
7. **UI**: sentence-case labels, no `innerHTML` with user data
   (`createEl`/`createDiv`/`setText`), CSS classes over inline styles,
   Obsidian CSS variables over hardcoded colors. Don't call `display()` in
   settings onChange handlers (it resets scroll) — update inputs in place.
8. **Filen wire formats are sacred.** The client reimplements Filen's
   protocols; any change there must be verified against `@filen/sdk` source
   or the live API. `src/filen/` documents the formats inline.
9. **Tests**: add/extend unit tests for every behavior change. Mock HTTP via
   the injected `HttpFn`; never hit the real network in tests.

## Architecture map

- `src/filen/` — pure-TypeScript Filen client (auth, E2EE crypto, transfers).
- `src/sync/` — three-way sync engine (scans, planner, executor, state, log).
- `src/ui/` — modals, dashboard, explorer decorations.
- `tests/` — vitest unit suite (pure modules run under plain Node).

## Pull requests

- One concern per PR; describe the user-visible change.
- Keep the four gates green; add tests for new behavior.
- Explain any deviation from the documented design decisions and why.

## Releases (maintainers)

1. `npm version <x.y.z>` (bumps manifest.json + versions.json via
   `version-bump.mjs`).
2. Push the tag — CI builds and attaches `main.js`, `manifest.json`,
   `styles.css` to the GitHub release. The tag must equal the manifest
   version exactly (e.g. `0.6.1`).
3. Update `CHANGELOG.md` before tagging.
