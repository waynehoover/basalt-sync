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
