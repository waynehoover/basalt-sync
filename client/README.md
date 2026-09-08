# Basalt command-line client

**Fast, secure, self-hosted sync for Obsidian. Simple setup.**

Keep a local copy of your Obsidian notes on a NAS or another machine without
Obsidian. Basalt connects to your own server, encrypts content before upload,
and provides note history and recovery from the terminal.

**Experimental.** Use macOS or Linux, Node **22 or newer**, and a local
filesystem. Run one Basalt process that writes to each vault, and keep other
sync tools and the Obsidian plugin off that same directory. For everyday
editing, use the
[Obsidian plugin](https://github.com/waynehoover/basalt-sync/blob/main/docs/plugin.md).

## Set up a mirror

Create an invite on an existing device, using **Add another device** in the
plugin or `basalt invite`. An invite works once and expires after ten minutes;
`--ttl` raises that to at most one hour. Then, on the mirror machine:

```bash
npm install -g basalt-sync
mkdir -p ~/basalt-mirror
cd ~/basalt-mirror
basalt pair 'INVITE' --read-only
basalt sync --watch
```

Replace `INVITE` with the string you created. It works once and expires after
ten minutes by default. `--read-only` is saved during pairing, so subsequent
syncs keep local changes from being uploaded even without the flag.

Keep the process running for continuous sync. For a scheduled job, use
`basalt sync --dir /path/to/basalt-mirror` instead.

## Start a new vault

If no device has claimed the server yet, use its setup string:

```bash
basalt init 'wss://homelab.example.ts.net#TOKEN' --dir ~/vault
basalt sync --dir ~/vault
```

This creates a writable client. Save the recovery key printed during setup,
separate from your devices. If every device is lost, the key lets you pair a
replacement. Basalt cannot recover it for you.

See [server setup](https://github.com/waynehoover/basalt-sync/blob/main/docs/server.md)
for TLS and obtaining the token. A named server vault also needs
`--vault-id NAME` on `init`.

## Everyday commands

Commands use the current directory unless you pass `--dir DIR`.

| Command | Use it to… |
|---|---|
| `basalt sync` | Sync once and exit. |
| `basalt sync --watch` | Keep syncing and reconnect after temporary outages. |
| `basalt status` | Check connection, local changes, and recovery issues. |
| `basalt invite` | Add another device with a single-use invite. |
| `basalt devices` | List devices and outstanding invites. |
| `basalt rename NAME` | Rename this device's label. |
| `basalt history "Note.md"` | View a note's versions, newest first. |
| `basalt deleted` | List deleted notes and whether they can be restored. |
| `basalt restore "Note.md"` | Restore the newest version with content. |
| `basalt unlink` | Remove local pairing and index while keeping notes. |

The [command reference](https://github.com/waynehoover/basalt-sync/blob/main/docs/cli-reference.md)
covers all flags, device revocation, rotation, repair, and server recovery.

## A mirror, and turning merging off

`--read-only` stops ordinary sync from uploading local edits, deletions, and
conflict copies. It still downloads and changes local files. Preserve local
edits you care about separately; this mode does not make the local directory
immutable.

The setting is a client behavior, **not a server-enforced permission**. The
client keeps an ordinary device credential, and explicit administrative
commands still work. In particular, `basalt repair` can resend missing content.
Use this mode on a machine you trust.

`init` and `pair` persist `--read-only`; passing it to `sync` applies it to that
invocation. There is no flag to turn a persisted setting off.

To review conflicting edits yourself instead of merging them:

```bash
basalt sync --no-merge
basalt sync --watch --no-merge
```

Pass `--no-merge` on each invocation that should use it. Basalt keeps both
versions when a merge would otherwise be needed.

## Recovery

```bash
basalt history "Quarterly plan.md"
basalt restore "Quarterly plan.md" --uid 42
basalt restore "Quarterly plan.md" --uid 42 --to "Recovered plan.md"
```

Restore never overwrites an existing file. If the target is occupied, it writes
a copy such as `Quarterly plan (restored 42).md`. On a writable client, it then
attempts to send that copy. On a read-only mirror, the copy stays local.

When the server has been restored from an older backup, use `basalt rebase`
to inspect the recovery situation, then `basalt rebase --backup-taken` after
preserving local notes and backing up the server. This rejoins without deleting
local files and sends local-only versions when the device is writable.

If a command reports a version kept at a hidden path, preserve that file and
`.basalt/`. Copy the retained version to a new visible filename and inspect it
before removing recovery material. An unreadable recovery inventory needs
attention even when other transfers succeed.

## Automation and output

Use `--json` for structured output. Exit **0** means the command succeeded,
**1** means a failure or unresolved issue, and **2** means invalid arguments.
For sync, `outcome` explains the result and the counters describe the work.

A conflict exits 0 because both versions were preserved. Ignored files and
changes held back by read-only mode also do not make a sync fail. Inspect those
fields if your job needs a stricter condition. Incomplete recovery is a failure.

Restore separates `restored` (the local file was written) from `ok` (the overall
operation succeeded). Check both before retrying it.

To keep setup strings, invites, and recovery keys out of command arguments, use
an existing private file or standard input:

```bash
basalt pair --key-file /private/path/invite.txt --read-only
basalt pair - --read-only < /private/path/invite.txt
basalt rotate --key-file /private/path/recovery.txt --key-out /private/path/new-recovery.txt
```

`--key-out` creates a new private file and refuses to overwrite one. The key is
also printed, so protect command output and logs.

## Files and local state

Basalt stores credentials and the sync index in `.basalt/`, which never syncs.
Protect this directory: it contains the keys this device needs to read notes.
Unlink through the command rather than deleting state files by hand.

The CLI excludes dot-prefixed files and folders, `node_modules`, and the
Obsidian configuration folder. Use `--config-dir NAME` if yours differs from
`.obsidian`. Add `--ignore NAME` for a file or folder name to exclude at every
depth; repeat the flag for more names. These choices apply to this device only.

Equivalent Unicode filename spellings are normalized. If two distinct files
would become the same name, Basalt blocks those paths and identifies them;
rename one yourself. Keep clients updated together to avoid older clients
reintroducing obsolete spellings. Filesystem renames can appear as a deletion
of the old path and a creation of the new one; both names retain their history.

## A command says the vault is locked

Stop an existing watcher before starting another command that writes to the
vault. On supported local macOS and Linux setups, process exit releases the
lock automatically, including after a crash.

If Basalt reports that manual recovery is required, run `basalt unlock` after
confirming the previous process has stopped. It refuses a live local holder.
`--force` is only for a holder recorded on another machine and requires you to
verify that it is stopped. Shared network vaults remain unsupported.

## More

- [Install with an agent](https://github.com/waynehoover/basalt-sync/blob/main/llm.md)
- [All documentation](https://github.com/waynehoover/basalt-sync/blob/main/docs/index.md)
- [Command reference](https://github.com/waynehoover/basalt-sync/blob/main/docs/cli-reference.md)
- [Security and privacy](https://github.com/waynehoover/basalt-sync/blob/main/docs/security.md)
- [Build and contribute](https://github.com/waynehoover/basalt-sync/blob/main/docs/development.md)
