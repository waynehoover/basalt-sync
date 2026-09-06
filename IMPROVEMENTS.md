# Improvements from the POC review

Reviewed **2026-09-05**, commit **8f95bfe56e11c8d458ecad5c6b26e599e9031f47**. The concrete defects and their regression criteria are in [TODO.md](TODO.md). This document records improvements to pursue after or alongside those fixes, without treating every possible production feature as a POC requirement.

The current foundation is useful: one shared client engine, a small Go deployment, encrypted content-addressed chunks, metadata authentication, conservative conflict copies, explicit server limits, a journaled index, backup verification/rehearsal, and a substantial passing test suite. Preserve those properties while addressing the gaps.

## How to prioritize

| Horizon                      | Focus                                                                                                    | Suggested items           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| During fixes                 | Reuse lifecycle/protocol rules; make errors observable; turn reproduced failures into tests.             | I02–I04, I11, I19         |
| POC stabilization            | Bound work, exercise actual supported devices/filesystems, and make release/backup workflows dependable. | I05–I09, I12–I18, I20–I23 |
| When a measured need appears | Optimize serialization/storage, add deeper repair, or change cryptographic epochs.                       | I01, I07, I10, I14, I24   |

“Small,” “medium,” and “large” below describe relative scope, not delivery estimates. Items are proposals, not claims of additional proven defects.

## Client architecture and shared behavior

### I01 — Split large modules along existing responsibilities

- [ ] **Medium; incremental.** Extract code when touching its behavior rather than doing a broad rewrite first.

[engine.ts](client/src/core/engine.ts) combines reconciliation, hashing, transfer planning, conflict handling, recovery, retries, and persistence. [transport.ts](client/src/core/transport.ts) combines connection lifecycle, request matching, notifications, validation, transfer flow control, and administration. [plugin/main.ts](client/src/plugin/main.ts) mixes lifecycle, credentials, UI construction, and recovery. The Go [session](server/internal/server/session.go), [store](server/internal/store/store.go), and [CLI entrypoint](server/cmd/basaltd/main.go) have similar concentrations.

Useful boundaries are credential operations, protocol decoding, a sync-pass plan, conditional filesystem landing, index persistence, and UI presentation. Keep invariants and dependencies explicit, with narrow interfaces. Retain explanatory comments that justify durability/security choices; move lengthy historical narratives to design notes where they obscure the live control flow.

**Success measure:** a change to one credential or transfer rule has one main implementation site and focused tests, while CLI/plugin behavior remains aligned.

### I02 — Share credential-operation state machines between CLI and plugin

- [x] **Medium; high value during F02/F03/F23.** Model initial claim, registration, invitation redemption, rotation, and unlink as explicit stages with typed outcomes.

[core/client.ts](client/src/core/client.ts#L1005) already shares low-level registration, but [CLI](client/src/cli/cli.ts#L972) and [plugin](client/src/plugin/main.ts#L1309) independently handle persistence, uncertain outcomes, and recovery messages. That duplication is where the reviewed key-handoff and lifecycle behaviors diverge.

Return outcomes such as prepared, committed, definitely refused, and unknown, with the exact recoverable state that must be retained. Let each surface decide how to display or securely export it. Put generation/cancellation and persistence obligations into the shared contract rather than relying on every caller to remember them.

### I03 — Make protocol contracts executable across TypeScript and Go

- [ ] **Medium.** Establish one documented field contract and shared valid/invalid wire fixtures.

[TypeScript transport](client/src/core/transport.ts) and [Go wire types](server/internal/wire/wire.go) represent the same protocol separately. Define required fields, canonical encodings, safe numeric ranges, reply identity, authentication coverage, per-message byte limits, and valid state transitions. Keep the deliberate policy that device clocks are not trusted for ordering.

Start with golden JSON fixtures consumed by both suites; schema generation is optional if it reduces maintenance. Include protocol-version compatibility and malformed-message cases. This supports F10/F17/F19/F20/F28 without introducing a heavyweight RPC stack.

### I04 — Use one failure/outcome vocabulary from core to UI and automation

- [x] **Medium; high value during F15/F16/F26/F27.** Define connection failure, whole-pass failure, retrying path, permanent refusal, conflict preserved, and fully synchronized as distinct outcomes.

[SyncReport](client/src/core/engine.ts), [Client.sync](client/src/core/client.ts#L396), [CLI renderReport](client/src/cli/cli.ts#L1611), and [plugin announcements](client/src/plugin/main.ts#L685) currently expose different slices of the result. Prefer structured causes/codes and path context over consumers parsing prose or treating “resolved promise” as “all work succeeded.”

Document stable CLI exit codes and JSON/JSON-lines events, including partial completion and offline state. Keep secrets and plaintext note contents out of routine diagnostics. Test that the same underlying failure produces compatible explanations in both surfaces.

## Performance and responsiveness

### I05 — Coalesce queued passes and make waiting cancellable

- [ ] **Medium.** Bound queued work as well as active work.

[Client.serial](client/src/core/client.ts#L186) queues requests; multiple external triggers can enqueue redundant sync passes. [runForever](client/src/core/client.ts#L928) waits through its backoff delay without an abort signal. The engine's internal coalescing does not automatically eliminate passes already serialized above it.

Use a single pending-sync indication where equivalent triggers can be combined. Propagate an abort/lifecycle signal through reconnect waits, backlog waits, socket requests, and expensive background work. Define how administration/history requests share the connection without starvation.

**Measure:** event storms create bounded pending work, and unload/shutdown ends waiting tasks promptly even during the maximum reconnect delay.

### I06 — Limit filesystem scan concurrency

- [ ] **Small to medium.** Replace whole-directory/tree `Promise.all` fan-out with a bounded work queue in [NodeVault.list](client/src/cli/vault.ts#L663).

Keep scans fast on ordinary vaults while avoiding large numbers of concurrent stats/recursive walks on large or network-backed folders. Make the bound internal initially; add a user setting only if measurements justify one. Preserve existing disappeared-file and ambiguous-name handling.

**Measure:** a large synthetic vault under a low descriptor limit and slow filesystem stays within a predictable memory/concurrency envelope and completes without starvation. Compare elapsed time against the current implementation.

### I07 — Reduce CPU and allocations on unchanged or lightly changed passes

- [ ] **Medium; measure before changing.** Track dirty paths or immutable revisions instead of repeatedly rebuilding the entire index representation.

[Engine.save](client/src/core/engine.ts#L2757) packs all local/remote entries; [journal delta construction](client/src/core/index-journal-store.ts) compares full shapes. The journal reduces disk writes but does not by itself eliminate full-map traversal, serialization, and retained copies. Incoming chunk-reuse planning is another place to profile repeated vault-wide work.

Benchmark unchanged, one-note-changed, rename-heavy, and catch-up workloads at increasing vault sizes. Prefer targeted improvements with identical recovery semantics. Treat a new on-disk index format as a separate migration decision, not a prerequisite for fixing F09/F14.

### I08 — Budget merge/diff work and keep the Obsidian UI responsive

- [ ] **Medium.** Add time/input/work budgets and safe fallbacks for synchronous merge, preview diff, and compression/decompression.

[merge-regions.ts](client/src/core/merge-regions.ts#L77) disables the diff timeout; [merge.ts](client/src/core/merge.ts) performs several comparisons and span cross-products; [history diff](client/src/plugin/history.ts#L374) runs on the UI path. Valid but repetitive or heavily rewritten notes can consume disproportionate CPU even below file-size ceilings.

Benchmark adversarial text shapes, not just random inputs. Where supported, move costly work into a worker; otherwise yield or stop within a budget and preserve a conflict copy. Include cancellation and output equivalence tests. F28 covers memory safety; this item covers responsive handling of valid workloads.

### I09 — Reduce duplicate chunk I/O without weakening verification

- [ ] **Medium; measurement-driven.** Profile the server fetch path and client byte copies before changing caching.

[Session fetch](server/internal/server/session.go#L1988) checks requested chunks and later reads them again to send. Client receive/decrypt/assemble paths can retain encrypted, framed, and plaintext buffers at the same time. Batching improves latency, but can multiply peak memory.

Consider verified reads with bounded retention or streaming within the protocol's existing ordering requirements. Preserve the rule that a named ciphertext body is verified, and do not replace safe re-reading with an unbounded plaintext/ciphertext cache. Record throughput, disk reads, allocations, and peak RSS on repeated attachments and poor links.

### I10 — Profile SQLite queries and startup work against large histories

- [ ] **Medium; when data warrants it.** Use query plans and representative databases before adding indexes or denormalization.

[History/deletions](server/internal/store/store.go#L839), [chunk attachment](server/internal/store/store.go#L997), [stats](server/internal/store/store.go#L1141), and [startup reporting](server/cmd/basaltd/main.go#L570) scale with entries, chunk references, or on-disk files. Large chunk lists and unbounded history growth are different workloads from many small current notes.

Measure startup latency, deletion-page queries, backup/verify duration, and sync tail latency with large version histories. Keep health/startup status clear if an expensive scan runs before listening. Add indexes only when a demonstrated query plan benefits, accounting for append and backup costs.

## User-facing behavior and operations

### I11 — Extend existing diagnostics with durable, actionable failure context

- [ ] **Small to medium.** Build on the existing status/progress UI and operational guidance rather than adding a second dashboard.

Expose the last completed pass time, its unresolved paths, the last successful server acknowledgement, and whether the current local scan is fresh. Give each actionable refusal a next step: rename a collision, reduce an oversized file, repair an index, resolve lost server history, or retry a transient failure.

Make a local diagnostic export explicitly redact recovery/device credentials, note contents, and filenames by default. Keep errors available after reconnect so a transient green status does not erase the explanation for a still-unsynchronized path. Coordinate with F16/F27.

### I12 — Support secret input without shell history or process arguments

- [ ] **Small.** Offer explicit stdin/file input for recovery and invite material in [CLI argument handling](client/src/cli/cli.ts#L1739), with documented restrictive file permissions.

Current positional-key workflows are convenient but expose secrets to command history and process inspection. Keep existing interactive convenience if appropriate, and offer a deliberate secure export destination for newly generated recovery keys. Never silently send a secret to a log stream, pager, or diagnostic export. Test JSON output and piping so errors do not accidentally discard the only generated key.

### I13 — Align custom-vault setup and command examples

- [ ] **Small.** Either make the non-default vault flow complete across server, setup payload, CLI, plugin, and generated service instructions, or clearly constrain the POC UI to `default`.

The server accepts `-vault`; [plugin first pairing](client/src/plugin/main.ts#L907) hardcodes `default`, while the setup string carries address/token rather than the selected vault. [Generated service purge guidance](server/cmd/basaltd/service.go#L161) includes `-confirm` but omits the custom `-vault`. Review argument handling too: reject unsupported command flags/extra positional arguments rather than silently ignoring meaningful input.

Use executable examples for default and non-default names, including spaces where names support them. Avoid advertising a supported configuration whose onboarding path cannot express it.

### I14 — Add an explicit repair path for quarantined/missing server bodies

- [ ] **Medium to large; after durability fixes.** Define how an operator can repopulate damaged server chunks from a healthy device without manufacturing arbitrary note edits.

[Chunk integrity checks](server/internal/chunks/chunks.go) can detect/quarantine bad content, and [purge output](server/cmd/basaltd/main.go#L1009) says it is waiting for devices to resend. Ordinary reconciliation may consider an unchanged local note already synchronized and never upload its missing body.

A repair operation could inventory required chunk names, verify matching local content, and resend only recoverable bodies. Require a backup first when changing metadata, report irrecoverable history distinctly, and preserve UID/authentication semantics. Test with one corrupted current chunk, one historical-only chunk, and a healthy second device.

### I15 — Separate read-only inspection from database creation and migration

- [ ] **Medium.** Add explicit create/open-existing/read-only modes and a supported schema-version check.

[Store.OpenWithSync](server/internal/store/store.go#L509) creates directories, runs migrations, and executes schema setup. Administrative inspection and backup coverage currently use that general opening path. A diagnostic command should have a clear contract about whether it can alter the store it is inspecting.

Refuse a future incompatible schema instead of allowing an older binary to proceed on assumptions. Take consistent read snapshots for related stats/verification queries when concurrent writes matter. Test inspection on read-only backups and downgrade/future-schema refusal without modification.

### I16 — Strengthen backup identity, retention, and restore verification

- [ ] **Medium; alongside F04/F06.** Bind backup metadata to a specific database generation and make retention preserve usable database-and-body sets.

[Backup metadata](server/internal/store/backup.go) is useful operational context; file size alone does not establish that a sidecar belongs to a database. A changed database of the same size can leave plausible stale coverage information. Record/check a durable generation identifier or equivalent binding, and distinguish successful completion from a partially staged attempt.

The existing [restore rehearsal](server/cmd/basaltd/rehearsal_test.go) validates server-side rows/bodies. Add a periodic end-to-end rehearsal that starts from a retained backup, pairs a fresh TypeScript client with the recovery material, decrypts known notes/attachments, and compares plaintext hashes. Include an older backup followed by the documented rebase flow, and a backup taken after purge. Document retention of independent usable generations, not only leftover bodies.

### I17 — Make operational health and shutdown limits observable

- [ ] **Small to medium.** Build on existing `health`, stats, and alert guidance with machine-readable reasons and bounded operational behavior.

Distinguish process responsiveness from ability to persist a note, disk exhaustion, slow fsync/SQLite operations, and a failed last backup. Do not put expensive deep verification on every health probe. Record sync refusal counts, queue saturation, and storage failure counts without high-cardinality filenames or secrets.

[Server shutdown](server/internal/server/server.go) drains sessions, while service/container managers impose their own deadlines. Document the interaction, propagate cancellation into cancellable database work, and test slow/stuck operations. Preserve durable acknowledgements rather than abandoning an in-progress commit merely to make shutdown appear fast.

### I18 — Document filesystem and device support as an explicit matrix

- [ ] **Small documentation work; medium validation.** State which guarantees have been exercised on macOS/Linux, case-sensitive/insensitive volumes, mounted subdirectories, network filesystems, Obsidian desktop, and mobile adapters.

[CLI durability helpers](client/src/cli/vault.ts), [Obsidian adapter](client/src/plugin/vault.ts), and [server fsync](server/internal/fsync/fsync.go) depend on different filesystem capabilities. Distinguish atomic visibility, readback verification, and persistence across power loss. Review blanket directory-sync error suppression in [config removal](client/src/cli/config.ts#L102): an unsupported operation and an actual I/O failure should not become the same success.

This can begin as a short tested/untested/unsupported table with exact test commands. Keep unusual filesystem support conditional on demonstrated need, while fixing destructive failures on the configurations already accepted.

## Tests, release integrity, and maintenance

### I19 — Turn the review probes into an invariant-focused failure suite

- [x] **Medium; incremental with each TODO fix.** Prefer tests at durability and ownership boundaries over tests that merely mirror implementation branches.

The suite already has fake sockets, adapters, race tests, stress/fuzz cases, and server rehearsals. Extend those helpers with named pause/failure points: before/after durable publication, after a config save, before an editor-overwriting write, during journal repair, and during uncertain remote commits.

Assert properties: every acknowledged version is readable after restart; a newer local edit survives; only one writer owns a vault; recovery material survives an uncertain result; failed input does not advance a cursor; read operations do not mutate. Use process kill/restart and targeted fault injection where timing matters. Do not add broad low-value snapshot tests for every UI wording change.

### I20 — Add representative real-runtime and filesystem coverage

- [ ] **Medium.** Keep fast stub tests, and supplement them with a small acceptance matrix using actual supported environments.

[Plugin tests](client/src/plugin/main.test.ts) explicitly use an Obsidian runtime stub. Panel rendering tests cannot establish actual adapter semantics, event order, unload timing, mobile suspension, or editor-save interaction. [The check script](scripts/check.sh) also cannot execute systemd validation on a macOS host.

Prioritize real Obsidian desktop editing-during-fetch, mobile suspend/resume and large attachment recovery, Linux systemd execution, and Node runtime behavior distinct from Bun. Include case-sensitive and case-insensitive filesystem jobs, a mounted-directory case, and an end-to-end packaged CLI smoke test. Keep expensive scenarios separate from the quick development loop.

### I21 — Gate published artifacts on validation of the same commit

- [ ] **Medium.** Require successful checks before npm/container/release assets become public, and test the artifact that will actually ship.

[npm publishing](.github/workflows/npm-publish.yml), [container release](.github/workflows/release.yml), and [release attestation](.github/workflows/attest.yml) build artifacts but do not depend on this repository's checks for that exact commit. Running CI elsewhere is useful only if publication cannot race ahead of a failed or missing run.

Use reusable validation jobs or an explicit successful-check gate. Test the packed npm CLI, both supported container architectures where practical, and the exact plugin bundle. Prefer draft/staged releases followed by promotion after verification, so provenance rebuilding does not expose one set of bytes and later replace it unnoticed.

### I22 — Pin the build environment and schedule dependency checks

- [ ] **Small to medium.** Pin action revisions and reproducible tool versions; update them deliberately through a tested workflow.

Workflows use mutable action tags, `bun-version: latest`, and `npm@latest`; the Docker base and build environment also influence outputs. Keep lockfiles and the existing compression golden check, and record the versions used for released artifacts. Changes to compression bytes can affect deduplication and protocol assumptions, so retain cross-runtime compatibility checks when updating libraries.

Add scheduled JavaScript and Go dependency advisory checks with actionable ownership and an update policy. This review did not query vulnerability databases, so it makes no claim that the locked dependency set is vulnerability-free. An advisory result should be triaged for affected code paths, not treated as automatic proof of exploitability.

### I23 — Make release channels, checksums, and version preparation consistent

- [ ] **Small to medium.** Define stable/prerelease/backport behavior before relying on automated moving tags.

[Container release](.github/workflows/release.yml) always requests `latest` for matching server tags. Explicitly decide whether a prerelease or an older maintenance release may move that tag or a minor alias. Validate full tag syntax and the version printed by the published image before promotion.

[release.sh](scripts/release.sh) builds from a clean tracked tree and then updates `versions.json`; move version-map preparation into an explicit pre-release step that is committed before final artifacts are built/tagged. Review untracked build inputs as part of source cleanliness. Align checksum file paths with the downloadable assets and automate final checksum/provenance verification across CLI, plugin, binary, and image channels.

## Security model and scope

### I24 — Clarify revocation, rotation, and the scope of cryptographic trust

- [ ] **Small documentation work; large only if requirements change.** Explain the guarantees in terms of credentials, retained data keys, and ciphertext access.

[The key design](docs/design.md#the-keys) deliberately keeps the data key stable when rotating the root. Revocation prevents a device from authenticating to the honest server; rotation changes root authority and invalidates outstanding invites. Neither erases a data key already held by a stolen device, and a device possessing that key can decrypt future ciphertext if it obtains it through another route. Make that future-ciphertext distinction explicit in lost/stolen-device guidance and UI copy.

F10/F11 address concrete gaps in the existing untrusted-server integrity claim. Beyond those fixes, separate content authenticity from freshness, completeness, rollback/fork detection, and attribution to a particular device. The shared metadata key establishes that a key holder authored something; it is not a per-device digital signature.

Only introduce data-key epochs, re-encryption, or stronger per-device signing if the intended threat model requires them. Those changes affect history recovery, offline devices, deduplication, revocation, backup compatibility, and migration; they should be designed and tested as protocol changes.

## POC boundaries to retain

These are deliberate scope decisions, not missing-feature findings:

- One small private deployment with SQLite and filesystem chunks; no requirement for clustering, alternate databases, object storage, or a public multi-tenant service.
- TLS can remain the responsibility of the documented proxy/private-network deployment. Built-in certificate management is not necessary to fix the reviewed defects.
- No requirement for teams, a hosted web dashboard, billing, or an enterprise permissions system.
- Keep conservative conflict preservation, exclusion rules, protocol refusal behavior, and stable data keys unless there is a specific requirement to change them.
- Add measurements and focused regression tests before major abstraction, cache, merge-algorithm, or storage-format changes.

The first milestone should be the P1 fixes with regression coverage, followed by truthful status/recovery behavior and the real-runtime checks most relevant to the devices actually used for this POC.
