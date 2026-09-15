# CLI reference

[Documentation](index.md) · [CLI quick start](../client/README.md)

`basalt` operates on a local vault. `basaltd` operates on the server.
Commands use the current directory unless `--dir` is set. Run `basalt --help`
for the installed version's usage.

## Commands

| Command | Purpose |
|---|---|
| `init SETUP` | Claim a new server vault and register this device. |
| `pair INVITE` | Join using an invite or recovery key. |
| `invite [--ttl 10m]` | Create an invite, valid once. |
| `devices` | List device IDs, labels, activity, and outstanding invites. |
| `rename NAME` | Change this device's label. |
| `revoke ID` | Revoke a registered device and close its connections. |
| `uninvite ID` | Cancel an outstanding invite. |
| `rotate KEY` | Replace the recovery key; keep history and existing devices. |
| `sync [--watch]` | Sync once, or keep syncing. |
| `mcp` | Serve notes to one local MCP host over stdio while syncing. |
| `preview` | Show planned changes without writing notes; `--json` includes paths and counts. |
| `status` | Check connection, local state, and recovery issues. |
| `history PATH [--before UID]` | Page through versions, newest first. |
| `deleted` | List deleted notes and recovery availability. |
| `restore PATH` | Restore the newest version with content, or use `--uid`. |
| `repair` | Resend missing server content available on this device. |
| `rebase [--backup-taken]` | Inspect or confirm rejoining a restored server. |
| `unlink` | Forget the local pairing and index; retain notes. |
| `unlock` | Recover a lock when manual intervention is required. |
| `--version` | Print the CLI version. |

## Options

| Option | Applies to / meaning |
|---|---|
| `--verify` | `sync` only, without `--watch`: re-read all file contents before syncing. |
| `--dir DIR` | Local vault directory. |
| `--device NAME` | Device label at pairing; default is hostname plus a random suffix. |
| `--vault-id ID` | Vault name for `init`; default `default`. |
| `--server URL --token TOKEN` | Alternative to the combined setup string for `init`. |
| `--json` | Structured command output, except `mcp`, which owns stdout for its protocol. |
| `--timeout MS` | Server wait; default `30000`. |
| `--read-only` | Hold back local sync changes; persisted by `init` and `pair`. For `mcp`, also omit mutation tools. |
| `--no-merge` | Keep conflicting versions separately for this invocation. |
| `--config-dir NAME` | Obsidian configuration folder; default `.obsidian`. |
| `--ignore NAME` | Exclude a file/folder name at any depth, local to this device; repeatable. |
| `--ttl DURATION` | Invite lifetime; default `10m`, maximum `1h`. |
| `--uid N` | Exact version for `restore`. |
| `--to PATH` | Destination for `restore`. |
| `--limit N` | `history`: default 20; `deleted`: default all. |
| `--before UID` | Earlier page for `history` or `deleted`. |
| `--key-file PATH` | Read a setup string, invite, or recovery key from a private file. |
| `--key-out PATH` | Also save a generated recovery key in a new file with mode `0600`. |
| `--recovery-key KEY` | Use the recovery key for `devices`, `revoke`, or `uninvite`. |
| `--allow-last` | Permit revoking the final device; requires the recovery key. |
| `--force` | `unlock` only: clear a holder recorded on another machine after verifying it stopped. |
| `-v`, `--verbose` | Engine logging. |
| `--` | End options; remaining arguments are literal values. |

For `init`, `pair`, and `rotate`, use `-` as the secret argument to read standard
input. `--key-out` refuses to overwrite an existing file and does not suppress
the key printed to normal output.

## Device access

Any paired device can revoke another or cancel an invite. To revoke the last
device, provide the recovery key explicitly:

```bash
basalt revoke DEVICE_ID --allow-last --recovery-key 'RECOVERY_KEY'
```

Replace `RECOVERY_KEY` with the actual key. Unlike the positional secret inputs
to `init`, `pair`, and `rotate`, `--recovery-key` accepts a literal value only;
it does not support `-` or `--key-file`. Avoid recording this command in shell
history, and be aware that the value is visible in process arguments.

The recovery key can also list devices and cancel invites when no working
paired device remains. It does not erase a device's local notes or data key.
See [Security and privacy](security.md).

In a paired directory, these commands target its saved server address. In an
unpaired directory, they use the address embedded in the recovery key.

Read-only mode governs ordinary synchronization. It is not an access restriction
on the server, and an explicit `repair` can upload missing content.
Repair leaves local notes and the sync index unchanged; it does not run an
ordinary sync when other devices send changes.

## Exit status and JSON

| Exit | Meaning |
|---|---|
| `0` | Successful command. Sync may have preserved conflicts or held back local changes. |
| `1` | Failure or an unresolved issue. Read the error and relevant paths. |
| `2` | Invalid command-line arguments. |

For sync and restore, the overall `outcome.kind` is one of:

| Kind | Meaning |
|---|---|
| `synced` | No outstanding issue reported for this pass. |
| `conflicted` | Both versions were preserved. |
| `retrying` | Paths need another attempt. |
| `refused` | Paths need intervention. |
| `recoveryUnknown` | The recovery inventory is incomplete or unreadable. |
| `recoveryNeeded` | Preserved versions remain at hidden paths and need recovery. |
| `passFailed` | The sync pass did not finish. |
| `offline` | No usable server connection. |

Only `synced` and `conflicted` give exit 0. Other command schemas differ; do not
assume every command returns a sync report. Restore's `restored` flag describes
local restoration separately from overall `ok`; `sent` says whether that copy
was acknowledged by the server. After `restored: true`, retry `sync` if needed
instead of restoring again. Sync counters include uploads,
downloads, merges, conflicts, ignored paths, and changes held back on this device.

For history, `--before UID` selects versions older than that UID. JSON output
includes `nextBefore`; use it for the next page until it is `null` (an exactly
full final page may require one empty request):

```bash
basalt history "Notes/Meeting.md" --limit 100 --json
basalt history "Notes/Meeting.md" --limit 100 --before 1234 --json
basalt preview --dir ~/vault --json
basalt sync --dir ~/vault --verify
```

Command-specific flags used on another command are refused with exit 2.
Preview leaves notes, staging files, and the recovery ledger unchanged, so it
can run while a watcher holds the vault. Sync checks the plan again before writing.

## MCP over stdio

`basalt mcp --dir /absolute/path/to/agent-vault` starts one local MCP server
and keeps that paired directory in sync. Pair separately with `init` or `pair`;
MCP has no pairing or device-administration tools. Use Node 22 or newer and a
dedicated headless directory on local macOS or Linux storage. See the
[host configuration](../client/README.md#connect-a-local-agent).

The process holds the same vault lock as `sync --watch`. Stop the watcher before
starting the host, and use one host process per directory. Root aliases do not
bypass the lock. EOF, SIGINT and SIGTERM stop admission and drain work before
releasing it. An admitted edit can finish after cancellation or disconnection;
inspect the note if its response was lost.

Stdout contains only MCP messages; diagnostics and verbose logs go to stderr.
`--json`, `--watch`, `--verify` and `--listen` are invalid for this command.
`--read-only`, `--no-merge`, `--timeout`, `--config-dir` and `--ignore` apply.
This release provides stdio only.

### Tools and bounds

Arguments below are JSON objects supplied to MCP tools, not shell commands.
Unknown arguments are refused. Paths are relative to the vault, with a maximum
of 4096 UTF-8 bytes. Excluded paths, child symlinks, non-regular files and ambiguous
Unicode/case spellings are refused. A symlink for the vault root itself may
resolve to its canonical local directory.

| Tool | Arguments and behavior |
|---|---|
| `list_notes` | Optional `folder`, `nameContains`, `after`, `limit` (default 100, max 500), `includeBackups` (default false). Lists notes, attachment metadata and folders. `nameContains` is a case-sensitive filename substring. |
| `read_note` | Required `path`; optional `uid`, `startLine` (default 1), `maxLines` (default 200, max 1000), `base`. Returns exact text, the complete note's SHA-256 `base`, and `nextLine`. `uid` selects authenticated server history. |
| `search_notes` | Required literal `query` (max 1024 bytes); optional `folder`, `caseSensitive` (default false), `cursor`, `limit` (default 50, max 200), `contextLines` (default 0, max 3), `includeBackups`. Returns matches and explicit skipped/omitted counts. |
| `note_history` | Required `path`; optional `before`, `limit` (default 20, max 100). Returns authenticated versions newest first and `nextBefore`. Device names are labels, not proof of authorship. |
| `deleted_notes` | Optional `before`, `limit` (default 50, max 200). Returns deleted notes, their latest recoverable version UID (`restorable`, or 0) and `nextBefore`. |
| `sync_status` | Optional `preview:true`, then optional `after` and `limit` (default 100, max 500). Basic status includes connection, write readiness, last pass/failure, exclusions and recovery inventory. Preview is an observing estimate. |
| `edit_note` | Required `path`, current `base`, and 1 to 32 `{old,new}` edits. Each nonempty `old` must occur exactly once. Edits must not overlap and all refer to the original source. Each `old`/`new` is at most 8 KiB; combined input is at most 64 KiB. |
| `append_note` | Required `path`, current `base`, and nonempty `text` (max 64 KiB). Appends exactly those bytes to an existing note. Include any wanted newline yourself. |
| `create_note` | Required `path` and `content` (max 1 MiB). Exclusively creates a note at a free path. |
| `restore_note` | Required source `path`, inspected version `uid`, and distinct explicit destination `to`. Exclusively creates that destination; an occupied path gives `exists`. Repeating a request never invents another filename. |

Content reads and searches accept UTF-8 `.md` and `.txt` notes up to 1 MiB.
Mutations also require those formats and refuse `.excalidraw.md` drawings and
MCP backup/recovery names. Attachments can be listed but not read or changed.
There is no whole-file replacement, deletion, rename or backup-cleanup tool.

Every read page is at most 64 KiB. A single line larger than that gives
`line_too_large`; reducing `maxLines` cannot split it. Follow `nextLine` with
`startLine` and the same returned `base` to detect changes between pages.
A history base identifies historical bytes, not the current local version.
Follow `nextAfter` as `after`, `nextCursor` as `cursor`, and `nextBefore` as
`before` until null. Keep query options unchanged. Listings/searches are live
observations, not a frozen inventory; rerun if a concurrent edit matters.

Search bounds content scanning to 512 candidate files and approximately 8 MiB
per call (the final file can exceed that work budget). It still walks the full
inventory. A page can have no matches and still have `nextCursor`.
Inspect `skipped` and `complete`; no matches does not prove absence from
unreadable notes or ambiguous paths. Ambiguous paths in the requested folder
appear in `skipped` with `why: "ambiguous_path"` on every page and keep
`complete:false`. Counts include blocked paths, which can represent entire
unexamined folders, and samples are limited to 20 paths. Deleted pages may be
empty after filtering and still have `nextBefore`. A historical lookup stops after 5000 versions with
`lookup_incomplete`, which does not establish absence. Purged, missing and
unverifiable content cannot be restored.

### Readiness and write results

Initialization does not wait for initial sync. Local read/list/search and basic
status remain available while connecting or offline, and may reflect an older
local copy. A missing local path gives `not_found_local`, not proof of deletion
from the server. History and preview require a settled server connection.
Mutations require `writeReady:true`; a queued mutation waits at most five seconds
to start and otherwise returns `busy`. An admitted mutation finishes in the
owning sync client's serial queue even if its connection subsequently drops.

`--read-only`, including a saved read-only pairing, removes all four mutation
tools. It still permits incoming sync to change local files. It is a local
process policy, not a restricted server credential.

Before an edit or append changes existing bytes, it creates a visible sibling,
reads it back, compares every byte and flushes it. Failure stops the edit before
touching the original. Creation and restore have no before-image because their
destinations must be absent. An unchanged edit returns `noop:true` without a write.

Inspect the structured tool result, including on errors:

| Field | Meaning |
|---|---|
| `applied` | `true`: intended bytes were verified at the destination; `false`: they did not land; `"unknown"`: inspect before deciding. |
| `durable` | `true`: the reported local result was flushed. This can describe retained recovery content even when `applied:false`. Absent, false or unknown does not establish a durable intended result. |
| `base` | Digest of the verified result, when available. |
| `beforeImage` | Verified before-image of the note, when one was completed. |
| `preserved` | Other recovery paths to inspect. A failed write may leave an incomplete attempted copy here. |
| `sync.state` | `pending`: ordinary sync was scheduled. It is not a server acknowledgement. |

An error can accompany `applied:true`. A race may preserve another writer's
bytes under a conflict name or keep the proposed edit in an MCP recovery copy.
Read every reported recovery path. On `stale`, cancellation, a lost response or
an unknown result, reread and reconsider the change. Never automatically replace
the base or repeat an append. `localWritesSincePass` says whether a pass scanned
since the local commit; zero does not prove server delivery. Inspect the last
pass, pending work and recovery state, and read from a second device when
delivery matters.

### Inspect and recover

After an edit, pass the returned `beforeImage` path to `read_note`. To find older
copies, use `list_notes` with `includeBackups:true`; backup rows include `backupOf`.
Names look like `daily (MCP backup 20260915T120000Z 0123456789abcdef).md`.
They are ordinary synced files and remain until the owner deliberately removes
them outside MCP. To recover one locally, read every page with a pinned base,
then pass the exact content to `create_note` at a new path.

For server history, first call `note_history` with `{"path":"daily.md"}`.
Choose a returned version with content and inspect it. If its UID is 42, the
following tool calls recover it without changing the current source:

```text
read_note    {"path":"daily.md","uid":42}
restore_note {"path":"daily.md","uid":42,"to":"Recovered/daily.md"}
read_note    {"path":"Recovered/daily.md"}
```

Use the actual returned UID, follow any `nextLine` before choosing the version,
and check `applied` and `durable`. The destination must be unused. After a lost
restore response, read that destination before retrying; `exists` does not
create a second recovery copy. A deleted note follows the same path: discover it
with `deleted_notes`, inspect `note_history` and `read_note(uid)`, then restore
to a free name. `restorable:0` means no content remains available.

## Files and locking

Local state lives under `.basalt/`: private credentials, `index.json`,
`index.log`, lock records, and the displaced-version recovery log. Keep recovery
material until you have inspected the retained files. Use `unlink` to remove a
pairing; do not treat deleting state as routine repair.

Supported local macOS and Linux setups release CLI exclusion when the process
exits. Where Basalt reports a fallback, `unlock` refuses a running local holder.
Neither manual recovery nor `--force` makes a shared network filesystem supported.
