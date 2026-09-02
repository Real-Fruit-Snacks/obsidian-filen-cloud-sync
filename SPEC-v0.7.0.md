# SPEC v0.7.0 — sync directions (two-way / push / pull)

Build on v0.6.9 (261 tests green). Version 0.7.0. One feature: a sync-direction
setting with three modes.

## Modes

- `twoWay` (default, current behavior — unchanged)
- `push` — **mirror local → cloud**: the vault is the source of truth.
  Uploads local changes, deletes remote files deleted locally, and REVERTS
  foreign cloud edits by re-uploading the local copy. Never downloads.
- `pull` — **mirror cloud → local**: the cloud is the source of truth.
  Downloads remote changes, deletes local files deleted remotely, and REVERTS
  foreign local edits by re-downloading. Never uploads.

## Settings

`syncDirection: "twoWay" | "push" | "pull"` (default `twoWay`), dropdown in the
Sync section: "Two-way (sync both ways)" / "Push (this device overwrites the
cloud)" / "Pull (the cloud overwrites this device)". Desc: "Push and pull are
MIRRORS: the source side wins everywhere — foreign edits on the other side are
reverted, and deletions propagate from the source." NOT a shared-settings key
(per-device by nature).

## Planner decision tables (exact — implement in planFile/opts.syncDirection)

"changed" = differs from base (size or whole-second mtime; remote changed =
new uuid). The existing equality short-circuit (stat-equal, or SHA-512 hash
match) applies BEFORE any mode logic: equal → treat as synced, refresh base.

**twoWay:** existing table, untouched.

**push:**
| local | remote | base | action |
| ✓ | ✗ | any | upload |
| ✗ | ✓ | no base | trashRemote |
| ✓ | ✓ | equal | nothing |
| ✓ | ✓ | localChanged | upload |
| ✓ | ✓ | remoteChanged (local unchanged) | upload (revert foreign remote edit) |
| ✓ | ✓ | both changed | upload (local wins; NO conflict record) |
| ✗ | ✓ | base exists (any remote state) | trashRemote |
| ✓ | ✗ | base exists | upload (remote was deleted; mirror re-uploads) |
| history-only (both gone) | | | drop base record |

**pull:** symmetric mirror:
| ✗ | ✓ | any | download |
| ✓ | ✗ | no base | trashLocal |
| ✓ | ✓ | equal | nothing |
| ✓ | ✓ | remoteChanged | download |
| ✓ | ✓ | localChanged (remote unchanged) | download (revert foreign local edit) |
| ✓ | ✓ | both changed | download (remote wins; NO conflict record) |
| ✓ | ✗ | base exists (any local state) | trashLocal |
| ✗ | ✓ | base exists | download (local was deleted; mirror re-downloads) |
| history-only | | | drop base record |

Mirror modes produce NO conflict records (winner is deterministic). Folders:
push prunes remote folders (existing remote-prune logic); pull prunes local
folders (existing local-prune logic). Rename detection: push keeps renameRemote
(as today); pull suppresses it entirely (rename = trashLocal + download; never
writes remote).

## Empty-source hard guard (data-loss prevention)

In push mode: if the local tree has ZERO files AND the remote tree has files →
abort the run with a clear error: "push source is empty — mirroring would wipe
the remote; this is almost certainly wrong (seed the vault or switch to
two-way/pull)". In pull mode: remote tree empty AND local tree has files →
abort with the mirror message. Applies regardless of base state; the manual
"Sync now (ignore mass-change guard)" command does NOT bypass this guard.
(The mass-change guard itself still applies everywhere else.)

## Tests (mandatory, data-loss-critical)

Planner, for BOTH mirror modes: every table row above (upload/download/revert/
trash/nothing/drop-base), no conflict records, hash-confirm equality still
short-circuits, renameRemote suppressed in pull, present in push.
Engine: full runs per mode (push uploads+reverts+trashes remote; pull
downloads+reverts+trashes local; two-way regression intact).
Guards: empty-source abort both directions; guard NOT bypassed by the
ignore-guard command; normal runs unaffected when source non-empty.
Settings: dropdown persists; default twoWay.

## Gates

build clean; ALL prior 261 tests + new green; eslint 0 errors; Node-builtin
grep zero; README features bullet + features.md section for sync directions;
CHANGELOG 0.7.0; dist + filen-cloud-sync-0.7.0.zip; rsync back to
/mnt/agents/output/obsidian-filen-sync (checkpoint after each chunk).
