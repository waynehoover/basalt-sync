# Maintain your Basalt server

[Documentation](index.md) · [Server setup](server.md) · [Command reference](server-reference.md)

Keep independent backups, monitor available disk space, and test restoration
before you need it. These examples use `/var/lib/basalt` for server data and
`/srv/basalt-backup` for a backup. Substitute your actual paths and run
`basaltd` as an account with access to them.

## Backup

Back up the server while it is running:

```bash
basaltd backup -data /var/lib/basalt -to /srv/basalt-backup
basaltd verify -deep -data /srv/basalt-backup
```

`backup` copies the database and required encrypted content, including history,
and verifies the result. Reusing a destination copies content incrementally and
replaces its database snapshot only after a successful copy. An interrupted
backup leaves the previous completed snapshot available.

For Compose:

```bash
sudo install -d -m 700 -o 65532 -g 65532 /srv/basalt-backups
docker compose run --rm --no-deps -v /srv/basalt-backups:/backup \
  basalt backup -to /backup/snapshot
docker compose run --rm --no-deps -v /srv/basalt-backups:/backup \
  basalt verify -deep -data /backup/snapshot
```

The destination must be outside the data directory; Basalt refuses nested
backups. These commands use the image's default user, 65532. Adjust ownership
if your deployment uses another account. Copy the verified snapshot to another
disk or backup host as well.

**Keep the recovery key separately.** The server backup is encrypted. You need
a paired device or the recovery key to read it. Also back up the ordinary
Markdown files on a device for a readable copy independent of Basalt.

### Schedule backups

A nightly job should run backup, verification, and transfer **in that order**,
copying only after the earlier commands succeed. For example, a cron job or
systemd oneshot can run:

```bash
basaltd backup -data /var/lib/basalt -to /srv/basalt-backup && \
  basaltd verify -data /srv/basalt-backup && \
  rsync -a /srv/basalt-backup/ offsite:/backups/basalt/
```

Configure the remote path and credentials for the account running the job.
Prevent overlapping jobs, and do not modify the backup while it is being
transferred. Use `-deep` periodically to check existing content for corruption.
Do not copy the live database with ordinary file-copy tools.

Keep dated or otherwise separate backup generations when you need older
snapshots. Updating one destination is not a retention policy for old databases.

### Preserve history before a purge

Before purging, make a **separate backup directory** and leave it untouched for
as long as you want the old history.

Reusing a backup directory after a purge replaces its database with the
post-purge snapshot. Old content files may remain there, but without the old
version records they are not a usable history archive. Retaining a complete
pre-purge database and its content together is what preserves restoration.

`backup.json` records the snapshot date, database identity, version range, and
purge generation. It helps identify a backup; `basaltd verify -deep` checks
its actual contents. A newer date or matching version number alone does not
prove that an older note is recoverable.

## Restore rehearsal

Use a fresh directory and a separate port, keeping production devices pointed
at the live server:

```bash
rsync -a offsite:/backups/basalt/ /tmp/basalt-restore-test/
basaltd verify -deep -data /tmp/basalt-restore-test
basaltd stats -json -data /tmp/basalt-restore-test
basaltd serve -data /tmp/basalt-restore-test -addr 127.0.0.1:3004
```

Proceed only if verification succeeds and the reported vault and version range
match the backup you intended to restore. Confirm that the server starts, then
stop the test server. Retain the backup; remove only the temporary rehearsal
copy when finished.

These checks cover storage and startup. A full recovery check also pairs a
throwaway client against a controlled test server and reads restored notes;
do not repoint a production device casually to a rehearsal copy. The project's
CI runs an automated restore-and-readback test, but cannot validate your disk or
offsite backup.

## Restore

Stop the server and pause client sync before replacing server data. Preserve
the failed directory, verify the restored copy, and check its ownership before
starting it. For a systemd installation:

```bash
sudo systemctl stop basalt
sudo mv /var/lib/basalt /var/lib/basalt.before-restore
sudo rsync -a offsite:/backups/basalt/ /var/lib/basalt/
sudo chown -R basalt:basalt /var/lib/basalt
sudo -u basalt /usr/local/bin/basaltd verify -deep -data /var/lib/basalt
```

Use a new preservation path if `basalt.before-restore` already exists. Run the
commands one at a time and stop on an error. **Only after verification succeeds:**

```bash
sudo systemctl start basalt
```

For Docker, stop the container, preserve its existing data, and restore the
verified backup into its data volume. Restore ownership to `65532:65532` and
verify it with the same server image before starting. Do not restore over a
running server or delete its volume as part of the procedure.

A device that has seen newer versions than the backup may stop with a `cursor`
error. Preserve its local notes and take a backup of the restored server, then:

- In Obsidian, use **Rejoin this server** and confirm the positions shown.
- In the CLI, inspect with `basalt rebase`, then run
  `basalt rebase --backup-taken`.

Repeat for each affected device. Writable clients send locally held versions
back to the server and preserve disagreements as separate copies. Prefer this
to unlinking and pairing again. A read-only mirror does not upload its local
changes.

## Repair missing content

If notes repeatedly fail to download, inspect the server:

```bash
basaltd verify -deep -data /var/lib/basalt
```

When content is missing, use **Send back what the server has lost** in the
plugin, or `basalt repair` on a client that still holds the notes. Repair resends
missing content without creating new versions. Repeat on other devices, then
verify the server again.

A device can supply only content it still has. Restore unavailable historical
content from a suitable backup when possible. Purge cannot recreate it and is
not the first recovery step.

## Purge

**Purge permanently removes older versions from the live server.** It keeps only
the newest entry for each path and removes unreferenced content. If the newest
entry is a deletion, that note's older content is no longer recoverable there.
Nothing purges automatically.

First inspect how much space it could reclaim:

```bash
basaltd stats -data /var/lib/basalt
```

Then stop the server, create a separate pre-purge backup, and verify it. For a
systemd installation, run each command in order and stop on any error:

```bash
sudo systemctl stop basalt
basaltd backup -data /var/lib/basalt -to /srv/basalt-before-purge
basaltd verify -deep -data /srv/basalt-before-purge
basaltd purge -data /var/lib/basalt -confirm default -backup /srv/basalt-before-purge -grace 0
sudo systemctl start basalt
```

The backup path must be writable by the server account. Substitute the actual
vault name for `default`; use `-vault NAME -confirm NAME` for a custom vault.
Keep the pre-purge backup separate from the next scheduled backup.

With the repository's Compose setup, the equivalent maintenance commands reuse
its image and volume:

```bash
docker compose stop basalt
docker compose run --rm --no-deps basalt backup -to /data/before-purge
docker compose run --rm --no-deps basalt verify -deep -data /data/before-purge
docker compose run --rm --no-deps basalt purge -confirm default -backup /data/before-purge -grace 0
docker compose start basalt
```

Copy that backup off the server as well. These Compose commands are for the
included Compose installation, not a separately created `docker run` volume.

Purge refuses a running server, a mismatched confirmation, or a backup that does
not meet its checks. The default one-hour grace period retains recent
unreferenced content; `-grace 0` removes that delay on a stopped server. Review
the result for content it could not collect. Do not bypass the backup check
just to make a refusal disappear.

## Monitor the server

| Signal | Action |
|---|---|
| `basaltd health` fails | Read the reason and server logs. Check disk space, mounts, and permissions. |
| `nospace` or growing disk usage | Add capacity, or plan a verified backup and purge. |
| `verify` reports missing/corrupt content | Repair from devices or restore from backup. |
| A device stays behind | Check its connection and status; compare the positions shown on devices. |
| Unrecognized device or invite | Review the device list and revoke or cancel it. |
| Service repeatedly fails | Read `journalctl -u basalt`. After fixing the cause, use `systemctl reset-failed basalt` if required. |

Use `basaltd stats -json` for storage automation. Check `reclaimComplete` before
using the reclaim estimates; a partial scan cannot give a reliable total.
`store-busy` is temporary contention, not by itself a reason to restart the
server. [Health responses and flags](server-reference.md#health) are listed
in the reference.

## Rotating the vault secret

If the recovery key was exposed, replace it in the plugin or with
`basalt rotate --key-file /private/path/recovery.txt`. Save the new key and
review the device list afterwards.

Rotation keeps history and existing devices, while invalidating the old recovery
key and outstanding invites. It does not replace the data-encryption key or
remove a device. See [Security and privacy](security.md) for what revocation
and rotation can and cannot protect.
