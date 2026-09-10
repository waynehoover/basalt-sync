# Install Basalt with an agent

> Follow this runbook to install the Basalt server and Obsidian plugin, pair the
> user's devices, and verify sync. Continue through the steps you can complete;
> report any missing access or unfinished verification precisely.

Basalt is self-hosted Obsidian sync with encrypted content and filenames. The
plugin runs on macOS, Linux, and Android with local vault storage. iOS is
untested; Windows is unsupported. Android sync requires Obsidian in the
foreground. The CLI is experimental and optional.

Repository: <https://github.com/waynehoover/basalt-sync>.
Use the [server setup](docs/server.md), [plugin guide](docs/plugin.md), and
[maintenance guide](docs/server-operations.md) for details. If reading a raw copy
of this file, resolve those paths against the repository root at the same ref.
[llms.txt](llms.txt) provides absolute Markdown URLs.

## 1. Establish the target

Use information the user has already supplied. Inspect the accessible machines
before asking questions. Collect only missing information:

| Input | What to establish |
|---|---|
| Server | Existing Basalt endpoint, or the host and authorized access for a new installation. Check OS, architecture, local disk, Docker/Compose or service manager, and free port 3003. |
| Vault | Exact local path and device, Obsidian version, and configuration folder (normally `.obsidian`). Do not infer the intended vault from whichever one is open. |
| Existing sync | Whether this vault already uses Basalt or another sync service. Reuse an existing Basalt pairing. For another service, let outstanding sync finish, preserve a backup, and agree on the switch before enabling Basalt. |
| Secure connection | Existing HTTPS proxy/domain, or Tailscale on the server and devices. Prefer what is already configured. Ask for the user's choice if neither exists. |
| Recovery key | A user-controlled place to save it separately from the vault, such as their password manager. A temporary file on one device is not the final recovery copy. |
| Backup | An available separate disk or off-host destination, and an existing scheduler if any. |

Check whether this is a fresh installation, an upgrade, or an additional device.
An existing claimed server does not need initializing again. A second device
joins by invite. If only the local computer is accessible, do the local work and
identify the server or phone steps needing access.

Keep a short, secret-free record of the chosen host, paths, Compose project,
endpoint, versions, and completed steps. On a retry, inspect current state and
resume. Do not delete an existing volume, pairing, or recovery file to make the
instructions run again. Back up existing notes before the first sync.

## 2. Choose released artifacts

Use published, non-draft, non-prerelease artifacts from this repository unless
the user requested a development build. Release channels have different tags:

| Component | Tag / artifact |
|---|---|
| Obsidian plugin | Bare `X.Y.Z`; `main.js`, `manifest.json`, `styles.css`, and `SHA256SUMS`. |
| Server | `server/vX.Y.Z`; container image or `basaltd-OS-ARCH` binary. |
| CLI, if requested | `basalt-sync` on npm; source tags use `cli/vX.Y.Z`. |

List releases and choose the newest compatible stable plugin and server. Do not
assume GitHub's single “latest release” is the plugin, or that all components
share a version. Read the chosen release notes for protocol requirements and
upgrade the server before clients when required. Compare Obsidian's installed
version with the **downloaded** manifest's `minAppVersion`.

The following download template uses GitHub CLI; HTTPS downloads from the exact
release are also suitable. Replace `X.Y.Z` with the selected published plugin
tag. Do not run this placeholder unchanged.

```bash
BASALT_PLUGIN_TAG='X.Y.Z'
BASALT_DOWNLOAD_DIR="$(mktemp -d)"
gh release download "$BASALT_PLUGIN_TAG" --repo waynehoover/basalt-sync \
  --dir "$BASALT_DOWNLOAD_DIR" \
  --pattern main.js --pattern manifest.json --pattern styles.css --pattern SHA256SUMS
(cd "$BASALT_DOWNLOAD_DIR" && shasum -a 256 -c SHA256SUMS)
```

Stop on a failed download or checksum. Check that the manifest ID is
`basalt-sync` and its version matches the tag. Where GitHub attestation
verification is available, verify all three assets with `gh attestation verify
FILE --repo waynehoover/basalt-sync`. Report whether provenance was checked;
a matching checksum alone does not authenticate its publisher. Never silently
substitute source archives for the built plugin.

## 3. Run the server

Skip creation when the user already has a working compatible server. Inspect
and preserve its data and flags before any upgrade.

### Docker Compose, preferred when available

Clone the official repository into a new dedicated deployment directory:

```bash
git clone https://github.com/waynehoover/basalt-sync.git
cd basalt-sync
docker compose config
docker compose up -d
docker compose exec basalt /basaltd version
docker compose exec basalt /basaltd health
```

Review the included [compose.yaml](compose.yaml) before starting. It pins an
image tag and digest, uses a persistent named volume, and publishes
`127.0.0.1:3003`. Confirm that the pin is a published server compatible with the
chosen plugin; do not assume an arbitrary source tag carries the newest pin.
Record the actual image digest and Compose directory. Reuse that directory and
project name for later commands so maintenance targets the same volume.

If the directory or container name already exists, inspect it and reuse the
correct installation instead of overwriting it. Keep the published port on
loopback, persistent storage, and the 30-second stop allowance. Do not use
`docker compose down -v` for installation, upgrade, or troubleshooting.

### Binary alternative

Use this route when Docker is unsuitable. Download the matching published
server binary: Linux or Darwin, amd64 or arm64. Verify its exact checksum entry
from that release's `SHA256SUMS` before running it. Use a dedicated writable
local data directory and bind `127.0.0.1:3003`.

For Linux persistence, follow [binary installation](docs/server.md#a-binary):
create the service account and data directory, then use `basaltd service` to
print the unit and installation instructions. Apply those instructions through
the available authorized service manager. The command only prints; it does not
install or start the service. On macOS, use an appropriate existing service
manager and verify restart behavior; a foreground process alone is a trial.

Check both the running version and health. Use the same data directory for all
subsequent maintenance commands.

## 4. Establish the secure endpoint

Run Basalt behind Tailscale Serve or an HTTPS reverse proxy. It does not provide
TLS itself; keep its own HTTP/WebSocket port private. Recommend Tailscale Serve
for a new personal homelab, or preserve the user's existing HTTPS proxy.

- **Existing Tailscale:** check the current Serve configuration, then configure
  `tailscale serve --bg 3003` without replacing unrelated routes. Obtain the
  actual hostname and HTTPS port from its output, replacing `https://` with
  `wss://` for the plugin. If the default Serve route is occupied, use a free
  HTTPS port and include it in the endpoint. Do not use Funnel for tailnet-only
  access. Verify Tailscale is connected on both the server and every device.
  Tailscale installation, login, or HTTPS enablement may require the user.
- **Existing domain and proxy:** configure Caddy or the user's existing proxy
  to forward WebSockets to `127.0.0.1:3003`. Preserve unrelated sites. For a new
  Caddy site, the [secure access guide](docs/server.md#caddy) gives the configuration.
  A containerized proxy needs a shared private network to reach the Basalt
  container; its own loopback does not reach the host.
  Validate configuration and certificates before using it.

Check the public endpoint's `/health` over HTTPS from a client device, in
addition to the server-local health check. Do not disable certificate
verification to make the check pass. If authentication at the proxy prevents
normal Basalt WebSocket connections, resolve that configuration before pairing.
Plain `ws://` is only for an explicitly local test on loopback.

The initial server log contains a one-use setup string `HOST:3003#TOKEN`.
Capture that log through a private channel or a permission-restricted file;
do not paste the token into the conversation. Replace only the address before
`#` with the verified endpoint: `wss://actual-hostname#TOKEN`. Preserve the token
exactly. It is distinct from the recovery key generated during pairing.

## 5. Install and enable the plugin

On each accessible device:

1. Resolve the intended vault and configuration folder. Preserve an existing
   plugin directory before an upgrade, including its state and credentials.
2. Disable a running Basalt plugin before replacing its files. Copy the three
   verified release assets into `<vault>/<config-folder>/plugins/basalt-sync/`.
   Update only `main.js`, `manifest.json`, and `styles.css`; keep all other files.
3. Reload Obsidian's plugin discovery, enable **Basalt Sync**, and check the
   installed version. Leave unrelated plugins and settings intact.
4. Open Basalt's panel and inspect its actual pairing or sync state.

On desktop, check `obsidian help` for supported automation commands. When
available, these commands target a specific open vault:

```bash
obsidian vault="My Vault" vault info=path
obsidian vault="My Vault" plugin:enable id=basalt-sync
obsidian vault="My Vault" plugin id=basalt-sync
obsidian vault="My Vault" commands filter=basalt-sync
```

Replace `My Vault` with the verified vault name and check the returned path.
Use the listed command IDs to open the panel or trigger sync. New manually
copied files may require an app reload before they are discoverable. Enable
community plugins if needed, accounting for any existing disabled plugins.
`plugin:install` searches the community directory; it is not a substitute for
manual release installation while Basalt is outside that directory.

Use app automation when available. If Obsidian or Android is inaccessible,
prepare the verified files and give the user just the remaining install/enable
steps. Do not invent an installation API or claim the plugin is enabled because
files exist. [Obsidian's CLI documentation](https://obsidian.md/help/cli) and the
installed CLI's help describe available capabilities.

## 6. Pair and save the recovery key

Interact with the actual panel through available app controls. There is no
documented Basalt CLI command that writes the plugin's pairing state. Do not
manufacture `data.json`, copy another device's credentials, or run the headless
client against the plugin's vault as a shortcut.

**First device, unclaimed server:** choose **Use a setup line**, enter a device
name and the secure setup string, then press **Start a new vault**. The panel
shows the recovery key under **Write this down**. Help the user save it in the
chosen private location. Press **I have written it down** only after the user
has saved it, or after verifying a save to a destination they designated for
this purpose. Wait for pairing and sync to finish.

**Additional device:** an empty local vault downloads the synced files directly.
If files already exist, **Confirm merge** asks before combining them with the
synced vault. Continue only when the user wants those files included; an older
copy can reintroduce moved or deleted files. Cancelling leaves the invite unused.
For a fresh copy, create a new empty Obsidian vault and preserve the old vault
separately; do not clear it automatically. Sync runs both ways after pairing.

On a paired device, choose **Add another device → Create
invite**. On the new device, choose **Paste an invite**, supply a device name and
the invite, then press **Pair**. Invites expire after ten minutes by default and
work once. Create one per device. A recovery key is the fallback when no paired
device remains, not the routine handoff.

If pairing is interrupted, inspect the panel and saved state before retrying.
Keep any recovery key already generated. Do not initialize a second vault or
unlink simply because a previous attempt timed out.

Keep secrets out of chat, screenshots, command arguments, and routine logs. Use
private local files or protected input when supported. Do not extract keys into
a transcript to automate a button. When no private interaction is available,
let the user enter or save the secret while continuing independent setup work.

## 7. Verify the installed system

Use the app or its CLI for note operations so Obsidian observes the changes.
Never overwrite an existing note for a test. Keep the test note unless the user
asks to remove it.

1. Confirm server health locally and through the secure endpoint.
2. Confirm the plugin is enabled, paired to that endpoint, and has no unresolved
   sync or recovery error. Inspect reasons for ignored or oversized files.
3. Create a uniquely named small Markdown note on device A. Wait for sync and
   read back the same content on device B.
4. Edit that note on B and confirm A receives the edit. Open its Basalt version
   history and confirm the earlier version is present.
5. Restore that earlier version. Verify the restored content appears as a
   separate copy while the current note remains intact.

A local health check proves neither pairing nor sync between devices. If only
one device is available, report that limitation and leave the two-device and
restore checks pending. Do not equate files installed with working sync.

## 8. Arrange backups and finish

Follow [server backup](docs/server-operations.md#backup) to create and verify a
snapshot, copy it to the chosen separate disk or host, and configure an ordered,
non-overlapping scheduled job. Verify the schedule and destination. A backup
inside the server volume alone does not protect against losing that disk.
Schedule a [restore rehearsal](docs/server-operations.md#restore-rehearsal);
do not replace live data for this check. If no backup destination is available,
state that backups are pending and ask for the missing destination. Installation
does not authorize purging history or discarding existing backups.

Report concisely:

- Server endpoint, running version, service/Compose location, and health result.
- Plugin version and paired vault/device names, without keys or invites.
- Sync and recovery checks that actually passed, with any remaining device steps.
- Recovery-key handoff and backup location/schedule, or what is still pending.

Distinguish **installed**, **paired**, and **verified between devices** in the
result. Link [the plugin guide](docs/plugin.md) for daily use. Do not ask for
repeated approvals for routine work already authorized by the user.

## Optional: a headless mirror

Only install the CLI if the user also wants a copy on a machine without
Obsidian. It needs Node 22 or newer and its **own local directory**. Follow the
[CLI guide](client/README.md), pair with `--read-only` for a mirror, and supply
an invite through `--key-file` or standard input. Do not run it in a vault the
plugin is already syncing. Read-only mode is local behavior, not a server access
restriction.

## Working from development source

This source tree, the Compose image, and released 0.8.x clients use protocol 7.
Version 0.7.x uses protocol 6 and cannot connect. For source builds, build the
server and clients from the same checkout.
Keep existing data and credentials, and verify the reported protocol after
connecting. Pairing a populated vault now pauses for a preview: review its
counts with the user before choosing Continue sync. `basalt preview --json`
provides a read-only plan for CLI vaults.
