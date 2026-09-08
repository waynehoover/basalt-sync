# <img src="docs/assets/logo.svg" width="40" alt=""> Basalt Sync

**Fast, secure, self-hosted sync for Obsidian. Simple setup.**

Basalt keeps your notes in sync through a server you control. Note contents and
filenames are encrypted on your devices. Keep writing offline, catch up when
you reconnect, and recover earlier versions from inside Obsidian.

[![CI](https://github.com/waynehoover/basalt-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/waynehoover/basalt-sync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/basalt-sync?logo=npm&label=basalt-sync)](https://www.npmjs.com/package/basalt-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**[Get started](docs/server.md)** · [How it compares](docs/compared.md) · [Documentation](docs/index.md)

<table>
  <tr>
    <th align="center">Sync status at a glance</th>
    <th align="center">Find and restore an earlier version</th>
  </tr>
  <tr>
    <td align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/panel-dark.png">
        <img src="docs/assets/screenshots/panel.png" alt="Basalt's panel with sync status, Sync now, Add another device, and Recover a deleted note.">
      </picture>
    </td>
    <td align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/changes-dark.png">
        <img src="docs/assets/screenshots/changes.png" alt="A note's version history, showing changes against the current copy.">
      </picture>
    </td>
  </tr>
</table>

## Made for your personal vault

- **Host it where you want.** Run a Docker container or a standalone server
  binary on your homelab. Basalt is free, open-source software; you provide the
  hosting and backups.
- **Keep your notes private.** Contents and filenames are encrypted before
  upload. The server stores the encrypted copies.
- **Send less when you edit.** Basalt uploads changed pieces of a file and
  reuses the rest, reducing transfers and storage across versions.
- **Recover your work.** Browse history, compare changes, and restore deleted
  notes. Restoring creates a separate copy when a file already exists.
- **Handle conflicting edits.** Basalt combines edits when its merge checks
  pass and keeps both versions when they do not.
- **Add devices with an invite.** Pair up to eight of your devices and revoke
  a lost device from another one.

## Get started

1. **[Set up your server](docs/server.md).** Run Basalt, configure a secure
   connection, and get the setup string for your first device.
2. **[Install the Obsidian plugin](docs/plugin.md#install).** Start the vault
   with that string and save the recovery key shown during setup.
3. **[Add your other devices](docs/plugin.md#pairing).** Create an invite on a
   paired device and paste it into Basalt on the next one.

For a NAS or a machine without Obsidian, the experimental
**[command-line client](client/README.md)** can keep a local mirror.

## Before you choose Basalt

Basalt is an early project for one person's devices. The supported setup is
Obsidian on **macOS, Linux, and Android**, with local storage. The plugin needs
Obsidian **1.7.2 or newer** and is installed manually. iOS is untested; Windows
is not supported.

On Android, sync runs while Obsidian is open in the foreground. Settings,
themes, plugins, and hidden files do not sync. Attachments are included, with a
default limit of **64 MiB per file**.

Use one sync service per local vault, and keep it off network filesystems.
Basalt needs you to maintain the server and keep backups. See
**[How it compares](docs/compared.md)** if you prefer a hosted service or need
different storage options.

## Find what you need

| I want to… | Guide |
|---|---|
| Run Basalt on my server | [Server setup](docs/server.md) |
| Pair devices or recover a note | [Obsidian plugin](docs/plugin.md) |
| Back up, restore, or free server space | [Server maintenance](docs/server-operations.md) |
| Keep a copy without Obsidian | [Command-line client](client/README.md) |
| Understand privacy and recovery keys | [Security and privacy](docs/security.md) |
| Build or contribute | [Developer documentation](docs/development.md) |

## License

[MIT](LICENSE).
