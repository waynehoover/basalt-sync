# Set up your Basalt server

[Documentation](index.md) · [Maintenance](server-operations.md) · [Command reference](server-reference.md)

Run one server for your personal vault, then connect your devices through the
Obsidian plugin. The server stores encrypted notes and history; you provide
storage, a secure connection, and backups.

You need a Linux or macOS machine with local storage. Docker is the simplest
route. Keep the data directory off NFS, SMB, and other network filesystems.

## Install

### Docker

From a copy of this repository:

```bash
git clone https://github.com/waynehoover/basalt-sync.git
cd basalt-sync
docker compose up -d
docker compose logs basalt
```

The included [compose.yaml](../compose.yaml) pins a server image and its digest,
preserves data in a named volume, and exposes port 3003 only on the host's
loopback interface.

For a quick trial without cloning:

```bash
docker run -d --name basalt --restart unless-stopped --stop-timeout 30 \
  -p 127.0.0.1:3003:3003 -v basalt-data:/data \
  ghcr.io/waynehoover/basalt-sync:latest
docker logs basalt
```

Use the pinned Compose setup for a server you keep. Both examples need the TLS
step below before other devices connect.

Named volumes get the required ownership automatically. If you replace one
with a bind mount, create a dedicated empty directory and make it writable by
UID/GID `65532:65532`, the container's user. Keep that directory when upgrading;
removing it removes the server's notes and history.

### A binary

Download the matching binary from a
[server release](https://github.com/waynehoover/basalt-sync/releases?q=server):
Linux amd64/arm64 or macOS amd64/arm64. Make it executable and run it with a
writable data directory:

```bash
chmod +x basaltd-linux-amd64
./basaltd-linux-amd64 serve -data ./basalt-data -addr 127.0.0.1:3003
```

Use your downloaded filename on macOS. For a persistent Linux service, install
the binary as `/usr/local/bin/basaltd`, create a dedicated `basalt` account and
writable `/var/lib/basalt` directory, then run:

```bash
basaltd service -data /var/lib/basalt -addr 127.0.0.1:3003 \
  -user basalt -binary /usr/local/bin/basaltd
```

This prints a systemd unit and installation commands; review and follow them.
It does not install the service itself. The generated unit includes restart
handling and a 30-second shutdown allowance.

## TLS

Basalt serves plain HTTP/WebSocket. Keep its port on loopback and expose a
secure `wss://` address through one of the following. Encryption of notes does
not replace transport security for device credentials.

### Tailscale

With Tailscale set up on the server and your devices:

```bash
tailscale serve --bg 3003
```

Use the HTTPS hostname Tailscale reports, with `wss://` for Basalt, such as
`wss://homelab.example.ts.net`. Your devices must be able to reach that tailnet.

### Caddy

For a domain pointing to your server, configure Caddy:

```caddyfile
sync.example.org {
    reverse_proxy 127.0.0.1:3003
}
```

Reload Caddy and use `wss://sync.example.org`. Keep Basalt's own port private;
Caddy handles the public TLS connection and WebSocket proxying.

For a test entirely on one machine, `basaltd serve -localhost` provides a
loopback `ws://` address. The first-device token is still required.

## The first device

The first startup log includes a setup string like `HOST:3003#TOKEN`.
Replace the address before `#` with your secure endpoint, keeping the token:

```text
wss://homelab.example.ts.net#TOKEN
```

1. [Install the plugin](plugin.md#install) on your first device.
2. Open Basalt and paste the string under **Start a new vault**.
3. Save the recovery key shown during setup, somewhere safe and separate.
4. Wait for sync to finish.
5. Use **Add another device → Create invite** for each additional device.

The setup token claims the server once. It is not your recovery key. Once the
vault is claimed, new devices join through invites or the recovery key.

Find the startup log with `docker compose logs basalt`, `docker logs basalt`,
or `journalctl -u basalt`, depending on how you installed it.

## Check your setup

Create a small note on the first device, let it sync, and confirm it arrives on
the second. Edit it there and check that the first device receives the edit.
Open version history to confirm you can find the earlier version.

For the server itself:

```bash
docker compose exec basalt /basaltd health
docker compose exec basalt /basaltd stats
```

With a binary installation, use `basaltd health` and
`basaltd stats -data /path/to/basalt-data`.

Before relying on the service, set up
[backups and a restore rehearsal](server-operations.md#backup). History grows
until you explicitly purge it; there is no automatic retention policy.

## Upgrade order

Back up first. Upgrade the server, then the plugin and CLI on every device.
Server, plugin, and CLI release numbers are separate; protocol compatibility
determines whether they can connect. An incompatible client stops with a
protocol error instead of syncing partially.

For Compose, update both the image tag and digest from the chosen server
release, then run `docker compose pull` and `docker compose up -d`. Preserve
the data volume and any customized flags, especially the file-size limit.
Never use `docker compose down -v` to upgrade.

Use `basaltd version` to check the server build and the plugin panel to check
what each device connected to. The [protocol reference](protocol.md) describes
the version used by this source tree.

## A vault that is not called `default`

A server serves one vault, named by `-vault` (default `default`). To use another
name, set it on the server and initialize the first device with the CLI:

```bash
basalt init 'wss://homelab.example.ts.net#TOKEN' --vault-id work --dir ~/vault
basalt invite --dir ~/vault
```

Run the server with `-vault work`. Other devices, including the plugin, learn
the name from the invite. The plugin cannot initialize a custom vault name.

## Connection troubleshooting

| Problem | Check |
|---|---|
| Cannot reach the server | Server process, proxy, hostname, and tailnet connectivity. |
| Setup token rejected | Copy it from this server's log. If already claimed, use an invite. |
| Protocol mismatch | Update the server and clients to compatible releases. |
| Device limit reached | Revoke unused rows in the plugin's **Devices** list. The limit is eight. |
| Browser origin rejected | Check the exact origin in the server log and the plugin's hint. Add only that required origin with `-allow-origin`. |
| Stopped after restoring a backup | Follow [server restoration](server-operations.md#restore), then use **Rejoin this server**. |
| File too large | Check the default 64 MiB limit and [how to change it](server-reference.md#serve). |

Android needs Obsidian in the foreground. For note recovery and device-specific
status messages, see the [plugin guide](plugin.md).
