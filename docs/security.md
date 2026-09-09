# Security and privacy

[Documentation](index.md) · [Plugin guide](plugin.md)

Basalt is designed for one person's trusted devices and a server they control.
It encrypts note contents and filenames before uploading them. Your local vault
remains ordinary, readable files, so your device's security matters too.

## What the server can see

The server stores encrypted notes and filenames without the keys needed to
read them. It can see file sizes, timestamps, activity, device labels, and when
encrypted pieces repeat. Encryption does not hide all metadata.

Use a secure `wss://` connection, normally through Tailscale Serve or a TLS
proxy. Note encryption alone does not protect the device credentials sent over
an unencrypted connection. [Server setup](server.md#secure-access) covers this step.

## Keep your recovery key

Your first device shows a recovery key during setup. Keep it somewhere safe,
separate from your devices and server backup. Anyone holding it can add a
device and access the vault.

Use an invite to add devices during normal use. An invite works once and
expires after ten minutes by default. If every device is lost, use the recovery
key to pair a replacement. Basalt cannot recover that key for you.

A paired device keeps the credentials it needs to sync and decrypt your notes
locally. Protect device accounts, disks, and copies of the plugin or CLI state.

## If a device is lost or stolen

1. Open **Manage this vault → Devices** on another paired device and revoke
   the missing device.
2. Review the device list and outstanding invites. Revoke unfamiliar devices
   and cancel invites you no longer trust.
3. If the recovery key may also have been exposed, use **Replace the vault's
   secret** and save the new recovery key.

Revocation stops access through your server. It cannot erase notes or keys
already copied from the device. A revoked device still holds the data key and
can decrypt later encrypted content if it obtains that content elsewhere.

Replacing the vault's secret invalidates the old recovery key and outstanding
invites. It **does not** change the data-encryption key, re-encrypt history, or
revoke existing devices. These limits apply even after you complete the steps
above.

## What encryption does not guarantee

Basalt checks that received content and its protected metadata authenticate
under the vault's key. A server without that key cannot create arbitrary valid
note content. It can still withhold updates or replay a previously valid
version. Basalt does not fully detect those actions.

Paired devices are trusted to change the vault and invite other devices. Basalt
is not a system for sharing notes with people you do not trust. The CLI's
read-only mode controls that client's sync behavior; it is not a restricted
server credential.

## Backups still matter

Keep a backup of your readable local notes as well as the server's encrypted
history. A server backup needs a paired device or the recovery key to read it.
Sync propagates changes, including deletions; it is not an independent backup.

See [backup and restore](server-operations.md#backup) for the server procedure.
For the cryptographic construction and filesystem assumptions, see the
[technical design](design.md).
