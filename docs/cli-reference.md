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
| `--json` | Structured command output. |
| `--timeout MS` | Server wait; default `30000`. |
| `--read-only` | Hold back local sync changes; persisted by `init` and `pair`. |
| `--no-merge` | Keep conflicting versions separately for this invocation. |
| `--config-dir NAME` | Obsidian configuration folder; default `.obsidian`. |
| `--ignore NAME` | Exclude a file/folder name at any depth, local to this device; repeatable. |
| `--ttl DURATION` | Invite lifetime; default `10m`, maximum `1h`. |
| `--uid N` | Exact version for `restore`. |
| `--to PATH` | Destination for `restore`. |
| `--limit N` | `history`: default 20; `deleted`: default all. |
| `--before UID` | Earlier page for `deleted`. |
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

## Files and locking

Local state lives under `.basalt/`: private credentials, `index.json`,
`index.log`, lock records, and the displaced-version recovery log. Keep recovery
material until you have inspected the retained files. Use `unlink` to remove a
pairing; do not treat deleting state as routine repair.

Supported local macOS and Linux setups release CLI exclusion when the process
exits. Where Basalt reports a fallback, `unlock` refuses a running local holder.
Neither manual recovery nor `--force` makes a shared network filesystem supported.
