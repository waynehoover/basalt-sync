# Develop Basalt

[Documentation](index.md)

This section is for contributors and reviewers. For installation and everyday
use, start with the [server](server.md), [plugin](plugin.md), or
[CLI](../client/README.md) guide.

## Technical reference

| Document | Purpose |
|---|---|
| [Design](design.md) | Durability rules, supported environment, and threat model. |
| [Protocol](protocol.md) | Requests, replies, authentication, limits, and cryptography. |
| [Index journal](index-journal.md) | Client state format and recovery behavior. |
| [Engineering notes](research.md) | Historical measurements, design evaluations, and credits. |
| [Findings index](findings.md) | Definitions of review IDs cited in code. |
| [Documentation review](documentation-review.md) | Editorial changes and guidance for future docs. |

## Repository layout

```text
server/             basaltd: server, store, backup, verification, purge
client/src/core/    shared sync engine, crypto, chunking, merging, transport
client/src/plugin/  Obsidian plugin and Vault adapter
client/src/cli/     basalt CLI and filesystem adapter
client/src/stress/  fault, crash, collision, and scale coverage
scripts/           validation and release tools
```

Keep sync decisions in `core`; adapters supply filesystem and interface behavior.
Read [the design rules](design.md#the-durability-rules) before changing a write
or recovery path.

## Build and test

Use the Go version required by [server/go.mod](../server/go.mod), Bun for client
scripts, and Node 22 or newer for the shipped CLI.

```bash
cd client
bun install
bun run typecheck
bun run test
bun run stress
bun run build
```

The client tests build and run a real Go server. `bun run build` produces
`client/dist/basalt.mjs` and the three plugin assets under `client/dist/plugin/`.
Use `bun run format` for TypeScript formatting.

Before pushing, run the complete local gate from the repository root:

```bash
bash scripts/check.sh
```

Exit 0 means all checks applicable to this machine passed. A skipped check is
not a pass. Platform-specific checks may run only in CI; inspect CI for the
exact commit before releasing. A local pass does not establish CI success.

For a bug fix, demonstrate that its regression test fails without the fix and
passes with it. Test preservation of the actual edited bytes, not just agreement
between devices. Keep fault and stress tests in scope for durability changes.

Wait for completion signals rather than guessed sleep intervals. Tests can use
`core/test-async.ts`: `deferred` holds a race window, `receiveCommitted` waits for
an acknowledged peer write to arrive, and `within` adds a cancelled-on-completion
failure deadline. Use fake clocks for timer behavior. Real delays belong in slow
link simulations; bounded polling is a fallback when an external process or
filesystem provides no completion signal. Keep awaits that order reads, writes,
acknowledgements, and index saves.

Measure interactive sync separately from bulk transfers with
`cd client && bun run bench:cadence`. It checks exact contents after new notes,
rapid edits, and incoming updates, using the production timers and a local test
server. Its in-memory adapters do not measure a phone's filesystem or network.

## Plugin testing

Tests use the real Obsidian declarations with a `DataAdapter` fake and a runtime
stub. Bundle tests load the built plugin against that stub and a real server,
and check for accidental Node dependencies in the plugin bundle.

These tests do not establish that a real Obsidian release invokes every adapter
method as expected. Pairing, editing, recovery, suspension, and upgrade flows
also need acceptance on actual supported desktop and Android devices. Screenshots
and panel structure tests cover presentation, not filesystem durability.

For plugin reviewers: the repository also contains a Node CLI. Its imports do
not imply Node dependencies in the plugin bundle. Shared code uses `globalThis`
and platform-neutral timers; local-resource `fetch` is used for attachment
streaming. Review the built plugin and resolved types as well as source scans.

### Refresh the screenshots

Open a test vault in desktop Obsidian and enable its command-line interface.
With client dependencies installed, run from the repository root:

```bash
node scripts/screenshots.mjs --vault "Screenshot vault"
```

The script captures the actual plugin panels with sample notes, device names,
and pairing details in both themes. It writes `docs/assets/screenshots/`, then
removes its temporary preview plugin and restores the window and appearance.
It never connects to a server. Review the images before committing them.
Use `--scene invite --theme dark` to recapture one view; `--help` lists the scenes.
The `uploading` and `downloading` scenes show transfer activity, including in
phone previews.
Keep the test vault open until cleanup finishes.

Use `--device phone` to preview the settings at phone width with Obsidian's
mobile styles. The script checks action alignment, field widths, tap targets,
and horizontal overflow. This is a layout preview, not Android or iOS acceptance.
Use `--output /tmp/basalt-screenshots` for review images without replacing the
published gallery. A failed layout check leaves a `.failed.png` for inspection.

<details>
<summary>Screenshot gallery</summary>

| View | Light | Dark |
|---|---|---|
| Status panel | [View](assets/screenshots/panel.png) | [View](assets/screenshots/panel-dark.png) |
| Loading sync history | [View](assets/screenshots/loading.png) | [View](assets/screenshots/loading-dark.png) |
| Uploading changes | [View](assets/screenshots/uploading.png) | [View](assets/screenshots/uploading-dark.png) |
| Downloading changes | [View](assets/screenshots/downloading.png) | [View](assets/screenshots/downloading-dark.png) |
| Plugin settings | [View](assets/screenshots/settings.png) | [View](assets/screenshots/settings-dark.png) |
| Status indicator | [View](assets/screenshots/status.png) | [View](assets/screenshots/status-dark.png) |
| Setup choices | [View](assets/screenshots/pairing.png) | [View](assets/screenshots/pairing-dark.png) |
| First device | [View](assets/screenshots/setup.png) | [View](assets/screenshots/setup-dark.png) |
| Join a vault | [View](assets/screenshots/join.png) | [View](assets/screenshots/join-dark.png) |
| Confirm merging existing files | [View](assets/screenshots/join-confirm.png) | [View](assets/screenshots/join-confirm-dark.png) |
| QR invite and pairing code | [View](assets/screenshots/invite.png) | [View](assets/screenshots/invite-dark.png) |
| Server address | [View](assets/screenshots/server.png) | [View](assets/screenshots/server-dark.png) |
| Device list | [View](assets/screenshots/devices.png) | [View](assets/screenshots/devices-dark.png) |
| Deleted notes | [View](assets/screenshots/deleted.png) | [View](assets/screenshots/deleted-dark.png) |
| No deleted notes | [View](assets/screenshots/deleted-empty.png) | [View](assets/screenshots/deleted-empty-dark.png) |
| Version comparison | [View](assets/screenshots/changes.png) | [View](assets/screenshots/changes-dark.png) |

Phone layout previews (desktop rendering with mobile styles):

| View | Light | Dark |
|---|---|---|
| Status panel | [View](assets/screenshots/panel-phone.png) | [View](assets/screenshots/panel-phone-dark.png) |
| Loading sync history | [View](assets/screenshots/loading-phone.png) | [View](assets/screenshots/loading-phone-dark.png) |
| Uploading changes | [View](assets/screenshots/uploading-phone.png) | [View](assets/screenshots/uploading-phone-dark.png) |
| Downloading changes | [View](assets/screenshots/downloading-phone.png) | [View](assets/screenshots/downloading-phone-dark.png) |
| Setup choices | [View](assets/screenshots/pairing-phone.png) | [View](assets/screenshots/pairing-phone-dark.png) |
| First device | [View](assets/screenshots/setup-phone.png) | [View](assets/screenshots/setup-phone-dark.png) |
| Join a vault | [View](assets/screenshots/join-phone.png) | [View](assets/screenshots/join-phone-dark.png) |
| Confirm merging existing files | [View](assets/screenshots/join-confirm-phone.png) | [View](assets/screenshots/join-confirm-phone-dark.png) |
| QR invite and pairing code | [View](assets/screenshots/invite-phone.png) | [View](assets/screenshots/invite-phone-dark.png) |
| Server address | [View](assets/screenshots/server-phone.png) | [View](assets/screenshots/server-phone-dark.png) |
| Device list | [View](assets/screenshots/devices-phone.png) | [View](assets/screenshots/devices-phone-dark.png) |
| Deleted notes | [View](assets/screenshots/deleted-phone.png) | [View](assets/screenshots/deleted-phone-dark.png) |
| No deleted notes | [View](assets/screenshots/deleted-empty-phone.png) | [View](assets/screenshots/deleted-empty-phone-dark.png) |
| Version comparison | [View](assets/screenshots/changes-phone.png) | [View](assets/screenshots/changes-phone-dark.png) |

</details>

## Performance work

From `client/`, use `bun run bench`, `bun run bench:sync`, `bun run scale`, and
`bun run dedup`. Run CPU-sensitive measurements under both Bun and stock Node
where practical. Report the commit, hardware, runtime, network conditions, and
correctness checks with every timing. [Historical results](research.md) are
context, not measurements of the current checkout.

## Releases

The server uses `server/vX.Y.Z` tags, the CLI uses `cli/vX.Y.Z`, and the plugin
uses bare `X.Y.Z` tags matching its manifest. Versions can move independently;
protocol compatibility is separate.

Use [scripts/release.sh](../scripts/release.sh) for preparation and the current
runbook. `scripts/release.sh --runbook` prints instructions without building or
publishing. The workflows build and check release assets; verify the published
files with [scripts/verify-release.sh](../scripts/verify-release.sh).

To check an asset's build provenance:

```bash
gh attestation verify main.js --repo waynehoover/basalt-sync
```

An attestation identifies the build source. It is not a security audit or proof
that the application is defect-free.
