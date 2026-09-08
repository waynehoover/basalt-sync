# Basalt Sync

Fast, secure, self-hosted sync for Obsidian. Simple setup.

## Layout and scope

- `server/`: Go server, `basaltd`.
- `client/src/core/`: shared sync engine.
- `client/src/cli/`: headless client, `basalt`.
- `client/src/plugin/`: Obsidian plugin and adapter.

Read [docs/design.md](docs/design.md) before adding features. The supported scope
is one person's devices, one server per vault, local storage, and one sync
service per local vault. Storage backends, teams, and web interfaces are outside
that scope.

## Preserve notes

**Do not lose a note.** Correctness takes priority over simplicity; cut a feature
if necessary. Preserve the eleven [durability rules](docs/design.md#the-durability-rules).

Every write to a live Obsidian vault on a development machine must go through
the `obsidian` CLI, never direct `mv`, `rm`, or `cp`. This preserves Obsidian's
view of changes. Repository files are not live vault notes.

## Architecture

The server is a static Go binary with embedded SQLite, no cgo, and no external
database. TLS terminates at a proxy such as Tailscale Serve or Caddy. The server
must not receive plaintext notes or client decryption secrets.

Keep shared sync behavior in core and platform operations in adapters. Read
[the protocol](docs/protocol.md) for wire contracts. Verify claims against the
shipped artifact; state what could not be established.

## Verification

**Run `scripts/check.sh` before pushing.** Exit 0 means the full local gate
passed; exit 2 means checks could not run and is not a pass. Inspect CI for the
exact commit too: local success does not establish CI success. The script's
drift guard checks CI step coverage, not equivalence between environments.

A unit-test pass alone does not cover stress or real-runtime behavior. For every
bug fix, show that its regression test fails without the fix and passes with
it. Check preservation of the edited content, not just agreement between clients.

## Documentation and prior art

Write the README and user guides for people choosing, installing, and using
Basalt. Put implementation details in the [developer documentation](docs/development.md).
[llm.md](llm.md) is the installation runbook for agents helping users.

Credit projects and record design evaluations in [docs/research.md](docs/research.md),
including LiveSync's influence on content-defined chunking. Keep product
comparison in [docs/compared.md](docs/compared.md) focused on user needs. Historical
review IDs are defined in [docs/findings.md](docs/findings.md).
