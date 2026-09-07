# Follow-up review: verification and remaining fixes

Reviewed **2026-09-06**, at commit **`cddca484548cec41a0a969b426d12322620a8377`**, against the original [TODO.md](TODO.md) and [IMPROVEMENTS.md](IMPROVEMENTS.md). The original code review covered `8f95bfe56e11c8d458ecad5c6b26e599e9031f47`; this verification covers the subsequent 26 commits and 96 changed files, including adjacent client, CLI, plugin, server, and release behavior.

**I cannot confirm that everything is fixed.** Substantial work landed, and the existing checks pass. However, several completed checkboxes describe protections that remain incomplete. This review identifies **17 actionable findings: 8 P1 and 9 P2**. Thirteen findings have focused reproductions; four are supported by source inspection. Some are gaps in the original fixes, and some are regressions introduced by those fixes.

This remains a personal-use POC. The priorities below concern preserving notes and recovery material, truthful results, and reliable operation. They do not require a broader product architecture or new deployment model. Application code and the two original review documents were left unchanged.

## Verification and its limits

`bash scripts/check.sh` completed with **23 passed, 0 failed, 0 skipped**. This included Go tests with race detection and vet, client formatting/typechecking/build, **1,319 client tests in 66 files**, compression compatibility checks, the packaged CLI under Node, a separate 16-test panel run, 10 stress tests, and local Docker build/run/Compose checks.

The script separately labels systemd validation and the Linux mounted-filesystem job **“only in CI.”** Those jobs were not executed on this macOS machine. Real Obsidian desktop/mobile behavior, power-cut durability, live GitHub publication, and dependency-advisory results were not independently exercised. Passing stub tests or finding a workflow in the repository does not verify those environments.

Additional probes used temporary vaults and a fresh copy of the current Go server. They demonstrated 14 scenarios supporting 13 findings. For deterministic scheduling, the lock, filename, and trash-copy probes added pause hooks to temporary copies of production source; they did not change the operations being reviewed. The status probe exposed its private helper. Plugin probes used the repository's Obsidian stub. The normalization probe exercised the link-success branch with a controlled alias; actual Unicode behavior on a normalization-distinct filesystem remains a separate platform test.

Local evidence is retained under `/tmp/basalt-followup-repros/`: `client-probes.log`, `plugin-probes.log`, `server-probes.log`, `server-probes-race.log`, `backup-identity-final.log`, `check.log`, and the probe sources. The Go probes also reproduced under race detection. These are scratch artifacts, not committed regression tests. The reproduction descriptions below are included so the findings remain understandable without those files.

## Remaining fixes

### R01 — Incoming changes can still overwrite an intervening local edit

- [x] **P1 · Client core · F01 · Reproduced.** Replace the metadata-only landing check with a strategy that preserves the actual local version across destructive operations.

[unchangedSince](client/src/core/engine.ts#L2578) compares size and rounded modification time. [land](client/src/core/engine.ts#L2635), local chunk reuse, merge, and deletion still perform a separate destructive operation afterward. A same-length edit with the same timestamp passes this check. There is also a gap between the final check and the write/removal. Merge reads local bytes before obtaining its metadata baseline, so an intervening edit can associate newer metadata with older bytes.

**Observed:** while fetching `server v2`, the probe replaced `server v1` with `LOCAL NEW`, preserving length and mtime. The completed vault contained only `server v2`; the local edit had no surviving copy.

**Fix and acceptance:** define a conditional landing/preservation operation at the adapter boundary. Preserve an intervening version, or refuse and recompute, instead of relying on a final stat. Test unchanged timestamps, atomic editor replacements, and changes after the last check for download, merge, local-body reuse, and deletion. The newly added changed-mtime races are useful but do not establish the original F01 invariant.

### R02 — Displaying recovery keys before commit is still not a recoverable handoff

- [x] **P1 · Plugin and CLI credentials · F02/F03, I02 · Inspection.** Require a completed secure handoff or recoverable pending operation before retiring recovery material.

[pairFirst](client/src/plugin/main.ts#L983) now displays the key before registration, and error messages retain it. However, its callback is optional and synchronous. The panel stores the key in memory, then registration replaces the root-bearing config with the device credential immediately. Reloading/crashing before the user retains the key still loses the only root copy. [Plugin rotation](client/src/plugin/main.ts#L1429) similarly adapts an optional display callback into the shared rotation function's awaited handoff; it does not wait for retention or save pending recovery state.

The CLI now emits candidates in both text and JSON flows, which fixes the original missing-output bug. Its optional [writeKeyOut](client/src/cli/cli.ts#L1239) syncs the new file but does not sync its parent directory before remote commitment; creation of the filename therefore lacks the directory-durability step used elsewhere in this repository.

**Fix and acceptance:** make handoff an explicit stage: for example, acknowledge secure retention before proceeding, or retain a restricted, recoverable pending record until that acknowledgement. Sync the output file's parent directory where supported and handle actual I/O failure. Do not retain roots indefinitely in ordinary device configs. Test process termination/plugin reload after candidate creation, after device-config replacement, and after a remote commit with a lost reply. Showing text or returning from a callback must not be treated as proof that the user has retained it.

### R03 — Stale CLI lock takeover can still grant ownership to two callers

- [x] **P1 · CLI · F07 · Reproduced.** Remove the check-then-unlink race from stale-lock recovery.

[removeIfStill](client/src/cli/lock.ts#L170) reads a token and then unlinks the path separately. The new atomic hard-link publication fixes the empty-file initialization race, but does not make stale takeover atomic.

**Observed:** A reads the dead token and pauses before unlinking. B removes that stale lock and successfully acquires its own live lock. A resumes, unlinks B's lock, and successfully publishes A's lock. Both acquisition promises return release functions. Neither caller has been told it lost ownership.

**Fix and acceptance:** use an ownership primitive or takeover protocol that cannot remove a replacement owner's lock. Include unreadable-lock recovery and release/reacquire in the design. Test the interleaving above with two active holders, not just which token is left on disk. The comment claiming the subsequent atomic publication makes this window safe should be corrected with the implementation.

### R04 — Purge still accepts an unusable backup

- [x] **P1 · Server administration · F04, I15/I16 · Reproduced.** Verify the retained backup data and hold a stable backup view before deleting history.

[backupCovers](server/cmd/basaltd/main.go#L1146) now rejects self/overlapping paths and checks every source UID. However, it compares only the stored MAC string, not the complete authenticated metadata/chunk sequence, and uses `Chunks().Has` to establish body presence. A regular file with incorrect contents passes. The backup directory is not locked through verification/purge, and the backup is opened through the writable `openStore` path.

**Observed:** create a real backup, corrupt its `version one` body while preserving the chunk filename, then purge the source using that backup. Purge succeeds and removes two historical versions. Its assurance about recoverable history is false for the corrupted version.

**Fix and acceptance:** compare the actual retained entry fields and ordered chunk references; hash-check the required backup ciphertext bodies; use an appropriate backup-directory lock and consistent read-only view. The server need not decrypt notes to verify ciphertext hashes and equality with the source records. Test body corruption, metadata changes with an unchanged MAC field, and concurrent backup replacement. A coverage sidecar or file-existence test must not authorize deletion.

### R05 — Overlapping batch uploads can deadlock on chunk ownership

- [x] **P1 · Server chunk storage · Regression in F05 · Reproduced.** Avoid holding a batch's chunk claims while waiting for claims held by another batch.

[Writer.run](server/internal/chunks/chunks.go#L538) acquires each chunk's publication claim and retains all claims until [Writer.Close](server/internal/chunks/chunks.go#L620). `Close` waits for workers before releasing any claims. Two batches that need the same chunks in different orders can each hold one claim while waiting for the other.

**Observed:** A publishes X and B publishes Y; A next queues Y and B queues X. Both `Close` calls remain blocked. The probe had to release claims through test-only cleanup to let either finish. Using one worker per batch makes the schedule deterministic; additional workers do not remove the cyclic dependency.

**Fix and acceptance:** design publication coordination without cyclic hold-and-wait, while preserving durability. Test overlapping batches in opposite orders, worker failure, and cancellation. Both operations must complete or fail within the defined shutdown/cancellation behavior. A blocked publication wait currently has no cancellation path of its own.

### R06 — Chunk visibility can still be mistaken for durability

- [x] **P1 · Server chunk storage and entry commit · F05 · Reproduced twice.** Coordinate publication state across negotiation, commit, and failure recovery.

[Size/Has/Missing](server/internal/chunks/chunks.go#L217) ignore the new pending-publication map. [AppendEntry](server/internal/store/store.go#L662) validates references with `Size`, so another session can skip uploading a visible body and commit metadata before its publisher has flushed the directory. Separately, a post-rename fsync failure leaves the body visible; a retry takes [place's existing-body return](server/internal/chunks/chunks.go#L383) and can report success without retrying that flush.

**Observed:** an entry referencing a batch-written chunk committed at UID 1 before the batch's `Close` had run. In another probe, the first `Put` failed its directory flush; the second returned success with no additional flush call. The latter probe initialized directories first so the injected failure occurred after body publication, rather than during directory creation.

**Fix and acceptance:** represent pending, durable, and failed publication distinctly. Negotiation and entry commit must not admit a pending/failed body as durable. A failed publication must remain retryable or be removed/quarantined safely. Test cross-session deduplication, delayed batch close, post-rename fsync failure, and restart after the other session receives an acknowledgement. Fix this together with R05; a durability barrier that deadlocks is not sufficient.

### R07 — Filename normalization can delete a newly saved source file

- [x] **P1 · CLI filesystem adapter · F12 · Reproduced with a scheduling hook.** Remove destructive normalization from scans or make it preserve concurrent source replacements.

[normalizeName](client/src/cli/vault.ts#L481) now uses `link(from, to)` followed by `rm(from)` for the link-success case. This protects an existing destination, but not the source name. An editor can atomically replace `from` between these calls. The unlink then deletes the newly saved file, while `to` still points at the old inode. The directory and same-inode fallback branches also retain check-then-rename operations.

**Observed:** after the link, an editor replacement put `new unsent` at the source path. Normalization removed it and left only the linked `old` contents.

**Fix and acceptance:** prefer keeping filesystem scans observational and using the existing logical spelling mapping. If physical renaming remains, specify preservation and no-clobber behavior for both source and destination. Cover atomic source replacement, competing destination creation, folders, and actual Unicode/case behavior on each supported filesystem. Audit `matchCase` under the same contract.

### R08 — Cross-filesystem trash can delete an edit made after copy verification

- [x] **P1 · CLI filesystem adapter · F13 · Reproduced with a scheduling hook.** Do not remove a newer source using proof about an older copy.

[copyVerifiedThenRemove](client/src/cli/vault.ts#L1564) now flushes the copied files and directories, which repairs the original missing-fsync problem. It still compares the trees, flushes the target, and unconditionally removes the source path. An editor can replace or modify the source after the comparison, including while the potentially lengthy tree flush is running.

**Observed:** replace the source with `new unsent` after target flush but before removal. The helper succeeds, deletes the source, and leaves only `old` in the trash copy.

**Fix and acceptance:** preserve the actual source version being removed and avoid deleting a replacement at the original name based on stale evidence. Retain changed content and retry/refuse where the adapter cannot establish that invariant. Test edits and new descendants during copy, verification, flush, and final removal, alongside the newly added flush-failure tests.

### R09 — A restored file can still be reported sent when its upload failed

- [x] **P2 · Plugin and shared outcomes · F15, I04 · Reproduced.** Base restore success on an authoritative result for that path.

[restoreAndSend](client/src/plugin/main.ts#L1091) checks `skippedPaths` and `retryingPaths` for the restored filename. Those arrays are [sorted and truncated to five names](client/src/core/engine.ts#L1332) for display. Absence from a sample is not evidence of successful upload. Blocked/waiting outcomes also have no affirmative upload acknowledgement in this check.

**Observed:** a report with six retrying paths and only `a.md` through `e.md` in the sample makes a restore of `z.md` return `{ path: "z.md", sent: true }`.

**Fix and acceptance:** retain complete per-path outcomes separately from UI samples, or expose a path-specific acknowledged revision/result. Test more than five failures, a blocked restored path, a pass that still has waiting work, and unrelated failures when the restored file actually succeeded.

### R10 — Recovery-key pairing can restart an unloaded plugin

- [x] **P2 · Plugin lifecycle · F23, I02 · Reproduced.** Guard every pairing completion with the generation that began the operation.

Invite pairing gained lifecycle guards. The recovery-key branch of [pair](client/src/plugin/main.ts#L841) still calls `start()` after `registerAsDevice` returns, without rechecking generation after the device proof. Its recovery catch can also restart from a persisted credential after unload. `pairFirst` has related unguarded completion paths and captures its generation after its initial asynchronous save.

**Observed:** pause the device proof after saving credentials, unload the plugin, then complete the proof. The pairing operation calls `start()` after unload.

**Fix and acceptance:** capture generation before asynchronous work, propagate cancellation, and guard configuration changes/restarts after every externally awaited stage. Preserve credentials already committed, but do not restart retired work. Test both success and failure after unload for root pairing, first pairing, invite pairing, and rotation.

### R11 — State and staging containment is enforced inconsistently

- [x] **P2 · CLI filesystem/configuration · F24 · Reproduced.** Apply containment checks to every internal write path.

Ordinary `NodeVault.write` now calls [checkStaging](client/src/cli/vault.ts#L889), and trash handling has additional checks. However, [NodeVault.create](client/src/cli/vault.ts#L1093) opens a staging file without that check. [saveConfig](client/src/cli/config.ts#L78) follows `.basalt` and its `tmp` directory without establishing containment. Index and lock paths also need to share the internal-directory contract.

**Observed:** make `<vault>/.basalt` a symlink to another temporary directory and call `saveConfig`. The config, containing recovery/device material, is written outside the vault. No concurrent symlink swap was needed.

**Fix and acceptance:** validate internal directory containment/ownership before configuration, index, lock, and staging operations, with a common implementation where practical. Cover both `.basalt` and `.basalt/tmp` symlinks, exclusive creation/restoration, and normal in-vault directories. Keep the threat boundary explicit: this also prevents accidental writes through pre-existing filesystem layout, not just a hypothetical hostile local process.

### R12 — Status can report zero unsent work without examining local notes

- [x] **P2 · CLI inspection · F08/F27, I04 · Reproduced.** Represent unknown local state explicitly and make status scans observational.

[unsentHere](client/src/cli/cli.ts#L1333) returns `0` immediately when there is no stored index. Its catch also returns `0` on scan failure, despite the adjacent comment saying that guessing zero would be incorrect. With matching cursors and no pending index work, the text command can consequently say “up to date with the server.”

**Observed:** a vault with one unsent note and no index returns `unsent: 0`. This is an ordinary state immediately after pairing and before the first sync. The existing-index path also calls `NodeVault.list`, which invokes temporary cleanup and filename normalization; it is not the read-only scan described by this unlocked command.

**Fix and acceptance:** count notes against an empty baseline where appropriate; report `unknown` plus a reason when scanning fails. Do not interpret same-size/same-mtime metadata as proof of content equality. Provide an observational scan for inspection commands. Test first sync, denied/unreadable paths, same-stamp edits, and status concurrent with an active watcher, asserting no filesystem/index writes.

### R13 — Receive limits still apply after expensive allocation, or only count objects

- [x] **P2 · Client transport/crypto · F28, I03/I08 · Inspection.** Enforce byte and expansion budgets before parsing, retaining, or expanding incoming work.

[openChunk](client/src/core/crypto.ts#L625) calls `inflateSync(payload)` and only afterward checks the expanded size against 16 MiB. The potentially dangerous allocation has already happened. The raw-marker branch returns its payload without applying that plaintext ceiling. [Transport.onFrame](client/src/core/transport.ts#L679) parses text before checking a frame-byte ceiling, and the binary receive path appends bodies without a cumulative byte budget. A notification-count ceiling does not bound memory occupied by each notification.

**Fix and acceptance:** enforce text/binary byte limits as early as the runtime permits, count queued/retained bytes, validate aggregate response work, and use decompression that stops at a fixed output budget. Apply the plaintext limit to every encoding. Test refusal before large allocation and cursor advancement. A valid compressed expansion requires a writer with the data key; oversized transport frames do not. These are different trust boundaries and should have separate tests.

### R14 — The new backup identity stamp does not uniquely identify a snapshot

- [x] **P2 · Server backup metadata · I16 · Reproduced.** Bind coverage metadata to the actual snapshot rather than its SQLite change counter and size.

[DatabaseStamp](server/internal/store/backup.go#L168) and [ReadBackupMeta](server/internal/store/backup.go#L270) now use the SQLite file-header change counter. Independently generated backup files can have the same counter even when their contents differ. It is not a unique identifier for a snapshot from this backup pipeline.

**Observed:** take backup A, append a new version of a note through the normal store API, then take backup B through `Store.Backup`. Both database files were 65,536 bytes with change counter 3. Replacing A's database with B's while retaining A's sidecar was accepted by `ReadBackupMeta`.

**Fix and acceptance:** use a snapshot content digest or an explicit generation identifier durably bound to that exact database. Test replacement using two normal completed backups, not only a direct `SnapshotInto` output or manually changed header. Define compatibility for older sidecars and distinguish unverified legacy coverage. This stamp is operational evidence; it must not replace the independent purge checks in R04.

### R15 — Health can claim persistence is available when the database cannot write

- [x] **P2 · Server health · I17 · Reproduced.** Separate connectivity/free-space checks from evidence of write capability, and fix the duration result.

[CheckHealth](server/internal/store/health.go#L89) executes `SELECT 1` and checks chunk-volume space. A constant select succeeds against a read-only database; `statfs` does not establish that the chunk directory is writable. Nevertheless the result is called `CanPersist`, and the improvement document explicitly claims read-only database detection. Also, `Took` is assigned in a defer after an unnamed return value has been copied, so callers receive zero.

**Observed:** with SQLite `query_only=ON`, health returned `CanPersist=true` and `Took=0s`; an immediate `AppendEntry` failed with “attempt to write a readonly database.”

**Fix and acceptance:** define precisely what health promises, incorporate appropriate bounded storage/write-failure evidence, and avoid reporting write capability based only on `SELECT 1`. Return the measured duration correctly. Test read-only DB/chunk storage, write/flush failures, low space, and shutdown. Keep deep verification out of the frequent health path.

### R16 — Release assets become public before the new validation gate runs

- [x] **P2 · Release integrity · I21 · Inspection.** Build, validate, checksum, and attest release assets before publishing them.

The new CI gate protects npm and container promotion. For plugin/server downloadable assets, [attest.yml](.github/workflows/attest.yml#L14) still runs on `release: published`. [release.sh](scripts/release.sh#L241) instructs the operator to create a public release with locally built assets; only afterward does the workflow check CI, rebuild, and replace those assets using `--clobber`. If CI fails, the original public assets remain downloadable. If the rebuild differs, users can receive different bytes under the same release name.

The plugin attestation job replaces its three assets without regenerating the uploaded plugin `SHA256SUMS`, so differing rebuilt bytes can also leave a stale checksum file. The server job does regenerate its checksums.

**Fix and acceptance:** prepare a draft/staged release, validate and attest the exact downloadable files, generate matching checksums for both channels, and publish as the final step. Test missing/failed CI and differing staged bytes. No public release should exist with unchecked assets because a later workflow was expected to repair it.

### R17 — Concurrent image releases can still move a stable tag backward

- [x] **P2 · Container release · I23 · Inspection.** Serialize moving-tag promotion and decide eligibility at promotion time.

[release.yml](.github/workflows/release.yml#L59) computes eligible tags before building. The workflow has no shared promotion exclusion, and the final [tagging step](.github/workflows/release.yml#L152) uses that old decision unchanged.

**Failure schedule:** release A starts while it is the newest version and records `latest`. Release B is tagged, builds, and promotes a newer version. A finishes later and applies its previously recorded `latest` tag, moving the channel backward. Both jobs can pass their own immediate digest check.

**Fix and acceptance:** serialize promotion for the image's moving channels, refresh relevant release/tag state inside that protected stage, and recompute allowed aliases immediately before applying them. Preserve immutable version tags. Test out-of-order completion for two stable releases, same-minor patches, backports, and prereleases.

## Status of every original TODO item

**Verified** means the targeted implementation and relevant existing tests support the original fix, within the environment limits above. **Partial** means useful changes landed but a listed gap remains. **Documented/deferred** means the limitation is now stated explicitly; it does not mean the behavior was repaired.

| Item | Assessment | Verification / remaining work |
|---|---|---|
| F01: conditional incoming landing | Partial | Added stat checks and changed-mtime races; same-stamp edits still disappear. R01. |
| F02: initial recovery-key preservation | Partial | Key display/output moved before registration; durable handoff remains incomplete. R02. |
| F03: uncertain rotation recovery | Partial | Shared outcome handling and CLI JSON candidate output landed; plugin/crash handoff remains incomplete. R02. |
| F04: independent backup before purge | Partial | Self/alias/overlap and missing-version/body checks landed; corruption and stable-view gaps remain. R04. |
| F05: durable chunk publication | Partial | Same-name publishers coordinate, but batches can deadlock and negotiation/commit bypass durability. R05/R06. |
| F06: backup destination exclusion | Verified | `cmdBackup` now obtains destination exclusion compatible with serving and other backup/purge operations; active-destination tests pass. |
| F07: CLI mutual exclusion | Partial | Complete-file publication and unique tokens landed; stale takeover still grants two owners. R03. |
| F08: inspection without synchronization | Partial | `inspect` mode prevents automatic backlog sync writes. Status's new filesystem scan still has side effects. R12. |
| F09: damaged journal tail | Verified | Stopped replay forces a replacement snapshot before further deltas; journal and shell recovery tests pass. |
| F10: history identity/pagination | Verified | Response/entry path, UID ordering, bounds, and page progress are validated; adversarial transport/history tests pass. |
| F11: authenticated replay protection | Documented/deferred | Design/README now describe replay accurately. A regression test deliberately demonstrates acceptance of a renumbered signed old version. No freshness protection was implemented. |
| F12: normalization no-clobber | Partial | Destination collisions are better protected; the new link/unlink path can remove a newer source. R07. |
| F13: cross-filesystem trash durability | Partial | Copied files/directories are flushed before deletion; concurrent source edits can still be lost. R08. |
| F14: arbitrary filename keys | Verified | Safe dictionary construction and prototype-name snapshot/journal tests landed. |
| F15: truthful restore result | Partial | Restore checks report samples; a failed sixth path is still reported sent. R09. |
| F16: background failures/watch reports | Verified | Shared background error callbacks and later watch report consumption landed with tests. |
| F17: malformed JSON frame shapes | Verified | Non-object top-level JSON is rejected at the transport boundary; malformed-frame tests pass. Byte-budget work remains under F28. |
| F18: immediate chunk-hash rejection | Verified | Rejection handling is attached as hash work starts and corrupt fetches abort promptly; tests pass. |
| F19: served-vault authentication scope | Verified | Scope checks precede registrar/device/invite authentication; server route tests pass. |
| F20: folder/tombstone authentication shape | Verified | Common MAC/parent checks run before no-body early returns; persisted-row verification was extended. |
| F21: deleted-note pagination | Verified | Store/protocol/client/CLI/plugin use a deletion cursor; multi-page coverage passes. |
| F22: plugin index removal order | Verified | Journal removal precedes snapshot removal; shell/adapter ordering tests pass. |
| F23: pairing after unload | Partial | Invite guards landed; recovery-key pairing can restart after unload. R10. |
| F24: internal directory containment | Partial | Trash and ordinary-write staging checks landed; config/exclusive-create paths remain inconsistent. R11. |
| F25: exclusive create across mounts | Verified, with runtime limit | `EXDEV` uses exclusive creation and preserves no-overwrite behavior in tests. A real Linux cross-device run was not performed here. |
| F26: JSON rebase exit status | Verified | JSON/text share the report-derived exit policy; CLI tests pass. |
| F27: local unsent status | Partial | Existing-index stat comparison landed; missing index and scan failure become zero. R12. |
| F28: receive/decompression limits | Partial | Notification count and post-inflate checks landed; byte/expansion allocation boundaries remain open. R13. |

For these 28 fixes: **13 verified within the stated limits, 14 partial, and 1 explicitly documented/deferred.** The old checked boxes should not be read as 28 repaired invariants.

## Status of every original improvement

These items were intentionally incremental and measurement-driven. A scoped implementation or documented POC boundary can be appropriate without implementing every possible extension. Benchmark results mentioned in the original document were reviewed as committed evidence; their performance numbers were not independently remeasured in this pass.

| Item | Assessment | What landed / what remains |
|---|---|---|
| I01: split large modules incrementally | In place for this increment | Rotation and outcome handling have shared modules. The decision to keep broader modules together is explicit; no rewrite is needed to close this review. |
| I02: shared credential state machines | Partial | Shared rotation outcomes landed. Initial-pairing handoff and lifecycle obligations still diverge across shells. R02/R10. |
| I03: executable protocol contracts | Foundation in place | Shared Go/TypeScript fixtures and negative cases landed. They do not establish complete byte/state budgets; finish the relevant contract through R13. |
| I04: shared failure vocabulary | Partial | `core/outcome.ts` centralizes interpretation and exit policy. Path samples and false-clean status still produce incorrect user results. R09/R12. |
| I05: coalescing/cancellable waiting | In place | Equivalent sync work coalesces; reconnect waits can be woken/cancelled, including plugin unload. Broader lifecycle races are tracked in R10. |
| I06: bounded scan concurrency | In place | Stat concurrency is bounded and a scan benchmark documents the selected approach. This does not make the scan observational; see R12. |
| I07: quiet-pass CPU/allocations | In place for measured bottleneck | Quiet passes stop refreshing `synctime` and journaling every unchanged entry. A dirty-map/index-format rewrite was reasonably avoided. |
| I08: merge/UI work budgets | Partial | Line-merge work has a deterministic budget and fallback. Preview/compression work remains synchronous, and decompression allocation is not bounded before expansion. R13. |
| I09: duplicate chunk reads | In place | Fetch retains verified bodies within an 8 MiB budget and reuses them when possible; benchmark evidence is present. |
| I10: query/startup profiling | In place | Representative query benchmarks landed; expensive startup reporting moves after listening. No speculative index changes were introduced. |
| I11: actionable diagnostics | In place | Shared recovery advice, background reports, and explicit cursor context were added. Correctness of particular status/restore claims remains R09/R12. |
| I12: secret input/output | In place, with durability follow-up | Explicit stdin/file input and restrictive key output were added. Complete key-file durability and handoff through R02. |
| I13: custom-vault setup scope | In place as a POC boundary | CLI custom-vault handling and documentation were aligned; default-only plugin/setup behavior is constrained explicitly. |
| I14: body repair | In place for recoverable local bodies | `resend`/`repair` repair referenced missing bodies without allocating new versions. Historical bodies absent from this device still require another source; output directs operators to server verification. Repair also depends on closing R05/R06. |
| I15: read-only store inspection | Partial | Open modes/schema-version checks and read-only stats/verify landed. Purge's backup inspection still opens writable. R04. |
| I16: backup binding/rehearsal | Partial | End-to-end recovery-key-only plaintext restore rehearsals landed. Snapshot binding still accepts a different completed backup. R14. |
| I17: health/shutdown observability | Partial | Reason codes, shutdown state, and deployment stop budgets landed. Persistence detection and duration are incorrect. R15. |
| I18: filesystem/device matrix | In place | Tested/untested boundaries are documented, case-folding CI was added, and real directory-sync errors are distinguished from unsupported operations. |
| I19: invariant-focused failure suite | Partial | Numerous useful boundary tests were added. The focused reproductions in R01–R15 expose missing invariants; add them to the maintained suite when fixing those paths. |
| I20: real-runtime coverage | Partial, explicitly scoped | Packaged Node CLI, case-folding, Linux filesystem, and systemd jobs were added. Real Obsidian desktop/mobile acceptance remains unexercised; Linux-only jobs were not independently run here. |
| I21: validate before publication | Partial | Exact-commit CI gates, packed CLI checks, and digest-first image checks landed. Public release assets still precede validation/attestation. R16. |
| I22: pinned builds/advisories | In place for main tooling | Action revisions and key runtime/tool versions are pinned; scheduled advisory checking exists. This is not a live advisory result or a claim that every external build input is immutable. |
| I23: release channels/checksums | Partial | Stable/prerelease/backport selection, version-map preparation, and downloadable checksum paths improved. Concurrent promotion can still roll back tags; plugin replacement can leave stale sums. R16/R17. |
| I24: cryptographic trust scope | In place as documentation | Revocation, stable data keys, future-ciphertext exposure, and malicious-server replay limits are now explicit. Documentation does not add replay protection. |

## Suggested completion order

1. Fix chunk ownership and durability together (R05/R06), then purge verification (R04) and CLI mutual exclusion (R03).
2. Close note-preservation races (R01/R07/R08) and recovery-key handoff (R02).
3. Correct restore, lifecycle, containment, and status behavior (R09–R12).
4. Finish byte budgets, backup identity, and health correctness (R13–R15), then publication/promotion ordering (R16/R17).
5. Add deterministic regressions at the actual failed boundaries. Re-run the full suite and the supported platform checks, and mark fixes complete only when the corresponding invariant survives the relevant failure schedule.

Keep F11 visibly documented as a POC limitation unless authenticated replay/rollback protection is intentionally taken into scope. Keep the real Obsidian and platform acceptance gaps visible as well; the current automated checks do not establish those guarantees.

## Second verification — 2026-09-06

This section reviews **`0527f7bcef9039576f9307ea46d9514bd9ad24e2` — “Close the seventeen the follow-up review found.”** The changes were initially uncommitted and were committed while verification was running. File fingerprints confirmed that the reviewed source bytes did not change during the checks. The earlier sections above are historical findings against `cddca48`; this section supplies their updated status.

**The seventeen findings are not all closed.** Six original failure cases are addressed within the verification limits below; eleven still have gaps. There are also regressions in the new implementations. The **14 findings below comprise 7 P1 and 7 P2 items**; ten have local reproductions and four are supported by source/platform-documentation review. A fixed original failure can coexist with a different new defect in the same component.

### Checks and confirmed repairs

`bash scripts/check.sh` passed **24 checks, with 0 failed and 0 skipped**. This includes **1,355 client tests in 72 files**, the separate 16-test panel run and 10 stress tests, Go race tests/vet, build/type/format checks, packaged Node CLI, and local Docker checks. Linux mounted-filesystem and actual systemd execution remain explicitly CI-only. Real Obsidian desktop/mobile, power loss, and live GitHub publication were not exercised.

Independent positive probes confirmed that opposite-order chunk batches now finish; failed chunk publication stays unavailable until a successful retry flush; entry commit refuses a body before batch close; a different completed backup is rejected by the new digest; the sixth retrying restored path is no longer reported sent; and recovery-key pairing no longer restarts after unload at the previously reproduced boundary. The Go probes also ran under race detection.

New failure probes used disposable directories, the repository's Obsidian stub, a real local test server for CLI status, and a copied Go module. Temporary copies of source added scheduling/fault hooks for replacement publication, stale-marker cleanup, normalization, and final trash removal. No application code was changed by this verification. Evidence and runnable probe sources are retained in `/tmp/basalt-review-round2/`, including `check.log`, `client-probes.log`, `plugin-probes.log`, `status-probes.log`, `server-probes.log`, `fixed-probes.log`, and `limits-probe.log`.

### Updated status of R01–R17

| Original finding | Current assessment | Evidence / remaining work |
|---|---|---|
| R01: incoming edit preservation | Partial, with regressions | Ordinary downloads use the new adapter operation, but error cleanup can lose the original; local reuse and merge still bypass it, and the plugin still has a destructive read/write gap. R18/R19. |
| R02: recovery-key handoff | Partial | First pairing now waits for the panel acknowledgement, and CLI key-file creation syncs its parent. Rotation still proceeds after display without acknowledgement. R24. |
| R03: CLI stale takeover | Partial | Ordinary stale takeover is serialized; recovery of a stale eviction marker repeats the ownership race. R20. |
| R04: usable/stable purge backup | Partial | Complete entry comparison, body hashing, and read-only opening landed. The backup lock ends before purge starts. R23. |
| R05: overlapping chunk deadlock | Fixed for the reproduced case | Per-batch held claims were removed. Independent opposite-order batches both completed. |
| R06: visibility versus durability | Fixed for the reproduced cases | Unproven bodies are withheld from presence/commit; independent pre-close commit and failed-flush retry probes now behave correctly. This is not a physical power-cut certification. |
| R07: normalization source replacement | Partial | The first source replacement is protected by rename-aside. A second competing save can leave the preserved version in a directory whose reaper deletes it. R21. |
| R08: cross-filesystem trash race | Partial | It compares the source again after flushing, but comparison and final unlink are still separate. R22. |
| R09: sixth failed restored path | Fixed for the reproduced case | Success now consults `serverHasOurs`; the independent six-retry probe returns `sent: false`. |
| R10: pairing restart after unload | Fixed for the reproduced case | Final generation checks reject stale completion; the independent proof-after-unload probe no longer calls `start`. |
| R11: state/staging containment | Partial | Configuration, lock, and exclusive-create guards improved. The normal scan's staging cleanup still follows an outside symlink and deletes external files. R21. |
| R12: truthful observational status | Partial | Missing-index counting, observing scans, and unknown-state text landed. Same-stamp edits remain invisible, and unknown-state JSON exits successfully. R25. |
| R13: pre-allocation limits | Partial | Incremental inflation, raw plaintext bounds, text checks, and cumulative fetch bytes landed. Network limits are still selected by the peer and notification bytes are not budgeted. R26. |
| R14: backup snapshot identity | Fixed for the reproduced case | A SHA-256 binding rejects substitution of another completed backup. A malformed digest introduces a separate panic, R27. |
| R15: health persistence claim | Partial | Read-only SQLite detection and measured duration are corrected. Unwritable chunk storage can still report healthy. R28. |
| R16: validate before release publication | Incomplete; default flow stalls | Draft creation/checksum generation improved, but draft creation does not trigger the selected Actions event. R29. |
| R17: moving-tag rollback | Original two-release race addressed; new queue defect | Promotion is serialized and tag eligibility is refreshed. With three releases, the default concurrency queue can cancel a release before its immutable image is published. R30. |

### R18 — Replacement cleanup can delete the only copy of a local edit

- [x] **P1 · CLI adapter/core · Regression in R01 · Reproduced.** Retain displaced content durably until the entire preservation operation succeeds.

[NodeVault.replace](client/src/cli/vault.ts#L1152) renames the original into `keep.<token>`, then unconditionally removes that file in `finally`. This cleanup runs if publication, reading the preserved file, or computing its digest fails. It also removes the file before the engine has successfully written the returned bytes to a conflict copy.

**Observed:** injecting an EIO at publication after rename-aside left no `note.md` and an empty staging directory: the original had been deleted by failure cleanup. A second probe began with an unsent A, created unsent B at the destination after A was moved aside, and attempted to land a remote version. The result retained B at the destination and returned the remote bytes, while A was deleted. The `landed ? was : bytes` return can preserve only one of the two displaced versions in this schedule.

**Fix and acceptance:** make preservation a durable handoff with explicit successful cleanup, not a `finally` that deletes recovery data. Keep every distinct local version when another editor save takes the destination. Do not remove preserved files before the engine's conflict copy is durable. Include read/hash/publish/conflict-write failure and crash/restart tests. The new rename into root staging also needs a supported cross-filesystem strategy: an existing file under another mount currently reaches an unhandled `EXDEV` path.

### R19 — Local reuse, merge, and plugin landing still lose intervening edits

- [x] **P1 · Core/plugin · Remaining R01 · Reproduced.** Apply the preservation contract to every destructive landing path and distinguish absence from an unreadable baseline.

[landFromLocal](client/src/core/engine.ts#L2585) still calls ordinary `vault.write` after a metadata check. [Merge](client/src/core/engine.ts#L3022) also retains its read-then-stat baseline and ordinary write. [ObsidianVault.replace](client/src/plugin/vault.ts#L672) reads the old bytes, writes, and only then compares the bytes it read; an editor save between read and write is not preserved. Missing expectations take an unconditional write branch in the adapters, and failed baseline reads can become that same missing expectation.

**Observed:** when an incoming note reused another local file's chunks, a same-length/same-mtime edit to the destination disappeared; both remaining files contained the incoming version. In the Obsidian stub, an edit injected after the preservation read was overwritten and `replace` returned no preserved bytes.

**Fix and acceptance:** route reuse and merge through a safe adapter contract, capture baselines consistently, and refuse destructive work when preservation cannot be established. Treat expected absence and failed observation as different states. Test all landing routes, a new destination created after the last stat, and read failures. The updated design document acknowledges a plugin gap; that documents the limitation but does not repair it.

### R20 — Recovering an abandoned eviction marker can still create two lock owners

- [x] **P1 · CLI locking · Remaining R03 · Reproduced.** Make recovery of the new lock-recovery mechanism obey the same ownership invariant.

[clearDeadMarker](client/src/cli/lock.ts#L252) checks the eviction marker's owner/token and then unlinks its path separately. Another contender can replace the marker between those operations. This removes a live evictor's exclusion, permitting two evictors to act on stale observations of the original lock.

**Observed:** start with a dead vault lock and a dead eviction marker. Pause A after its final check of the marker. B removes the old marker, takes a new one, and pauses after reading the dead vault lock. A resumes, deletes B's marker, takes eviction ownership, and acquires the vault. B resumes its stale unlink and subsequently acquires the vault too. Both callers receive release functions.

**Fix and acceptance:** use ownership/recovery primitives that cannot unlink a replacement owner at either level. Test a process dying during eviction, two contenders recovering its marker, and a live holder acquired during that recovery. Serializing the first-level stale operation alone is insufficient.

### R21 — Staging cleanup deletes both external files and preserved note versions

- [x] **P1 · CLI filesystem adapter · Remaining R07/R11 · Reproduced twice.** Separate recovery data from disposable temporaries and validate containment before cleanup.

[reapStaleTemps](client/src/cli/vault.ts#L746) follows the staging directory and removes every old file in it without a containment check or a disposable-file classification. [retireName](client/src/cli/vault.ts#L196) now leaves an unexpected displaced version there if a second save takes its original name. That preserved version is never surfaced as a normal note and is eligible for the same reaper. Rename preserves the file's mtime, so it can be considered old immediately.

**Observed:** a pre-existing `.basalt/tmp` symlink to another temporary directory caused `NodeVault.list()` to delete an old `valuable.md` outside the vault. Separately, normalization preserved unsent A in staging when unsent B took its old name; the next scan deleted A because it carried an old timestamp. The reaper was invoked by an ordinary scan, before any guarded write.

**Fix and acceptance:** check containment before enumeration/removal; delete only positively identified disposable artifacts. Put preserved versions in durable, discoverable recovery storage and never age them out as write debris. Test symlinked staging, two consecutive editor replacements, old timestamps, and restart. Include the remaining index/journal write paths in the common internal-directory audit rather than assuming the config check covers them.

### R22 — The final trash digest check still races with unlink

- [x] **P1 · CLI filesystem adapter · Remaining R08 · Reproduced.** Preserve the actual version removed, rather than checking the path once more.

The new [removeMatching](client/src/cli/vault.ts#L1943) hashes the source and copied destination, compares them, and then calls `rm(from)`. An editor replacement after the hash still makes that unlink remove a newer file. The old flush-width window became a shorter window; it was not closed.

**Observed:** inject a new unsent source after the final successful digest comparison and before unlink. The helper succeeds, the source is gone, and the trash contains only the old bytes.

**Fix and acceptance:** couple removal to preservation/identification of the actual removed object. If that cannot be established, retain the source and report the incomplete move. Put the regression hook after the final comparison, including the analogous descendant-file boundary for directory trees.

### R23 — The backup lock is released before purge uses its verification

- [x] **P1 · Server administration · Remaining R04 · Reproduced.** Hold backup exclusion through the destructive operation.

[backupCovers](server/cmd/basaltd/main.go#L1146) acquires the new backup lock and [defers its release inside the helper](server/cmd/basaltd/main.go#L1174). That defer runs when the helper returns, before `cmdPurge` deletes history. The comment claiming the caller's defer chain retains the lock is incorrect. A backup replacement or purge can therefore change the checked backup in the gap.

**Observed:** immediately after `backupCovers` returned successfully, and before any source purge, the probe acquired the backup's exclusive data lock successfully. The caller no longer held the protection that the check purported to establish.

**Fix and acceptance:** acquire/release the backup lock in the caller's lifetime, or return a verified snapshot handle whose cleanup occurs after purge. Pause between successful verification and source deletion and prove that competing backup replacement/purge cannot acquire the destination. Retain the new full-entry comparison, body hashes, and read-only opening.

### R24 — Rotation does not await the new recovery-key acknowledgement

- [x] **P1 · Plugin credentials · Remaining R02 · Inspection.** Wire the acknowledgement stage into rotation as well as first pairing.

The first-pairing panel callback now waits for `writtenDown`. The callback in [renderRotate](client/src/plugin/main.ts#L2577) still sets `freshRecoveryKey`, renders, and returns immediately. [Plugin.rotate](client/src/plugin/main.ts#L1521) consequently proceeds to the remote rotation without waiting for the newly displayed acknowledgement button. The new candidate remains only in memory until the user retains it.

**Failure boundary:** remote rotation commits; the plugin/app reloads before the user copies or acknowledges the candidate. Normal device configs do not contain that root, and the old key has been retired. First-pairing acknowledgement tests do not exercise this operation.

**Fix and acceptance:** use the same explicit awaited handoff for rotation, with cancellation and recoverable pending state where required. Test the actual rotation panel callback: no rotation request before acknowledgement, and recoverability around reload, committed/lost replies, and failed probes.

### R25 — Status still produces false-clean or inconsistent outcomes

- [x] **P2 · CLI · Remaining R12 · Reproduced twice.** Separate metadata estimates from synchronization proof, and align text/JSON exit policy.

The [unsent scan](client/src/cli/cli.ts#L1371) still checks only size/mtime. A same-stamp edit is counted as zero, allowing the final text to claim the vault is up to date. Separately, the [JSON branch](client/src/cli/cli.ts#L1481) returns success whenever the server is reachable, even when `unsent` is `"unknown"`; the text branch now returns failure for that same state.

**Observed:** changing `base` to `edit` while retaining an exact integral timestamp returned zero unsent files. Against a real local server, making a subdirectory unreadable produced `unsent: "unknown"` with text exit **1** and JSON exit **0**.

**Fix and acceptance:** either establish content equality or label local state as an estimate/unverified instead of claiming synchronization. Derive text and JSON exit status from the same outcome. Test matching timestamps, missing index, read failure, and server reachability combinations in both formats. Keep the new observational scan and first-sync counting.

### R26 — A peer can raise the client's network memory limits arbitrarily

- [x] **P2 · Client transport · Remaining R13 · Reproduced limit acceptance; allocation risk inspected.** Impose local ceilings and account for queued bytes independently of server advertisements.

[readReady](client/src/core/transport.ts#L1296) accepts any non-negative safe integer for `maxBatchBytes` and `maxFetchBytes`. The new text-frame ceiling is twice the advertised batch value; the fetch-byte ceiling is the advertised fetch value. A faulty or hostile server therefore chooses how much the client will accept. Notification queuing still limits the number of messages to 1,024 rather than the total bytes retained by those messages.

**Observed:** a handshake advertising `9,007,199,254,740,991` for both limits was accepted and produced a text-frame ceiling of `18,014,398,509,481,982`. The probe did not allocate a large frame or induce an OOM.

**Fix and acceptance:** apply independent local resource caps, taking the minimum of local policy and negotiated limits; validate units and ranges, and bound queued notification bytes. Keep the incremental inflater/raw bounds. Test oversized advertisements and multiple individually valid frames that together exceed the queue budget, verifying refusal before retaining excessive work.

### R27 — A malformed backup digest panics during validation

- [x] **P2 · Server backup inspection · New regression near R14 · Reproduced.** Validate the digest shape and format errors without unsafe slicing.

[ReadBackupMeta](server/internal/store/backup.go#L354) accepts a nonempty digest of any length from JSON, then slices `meta.Database.Digest[:16]` when reporting a mismatch. A short value panics instead of returning an ordinary invalid-backup error.

**Observed:** take a valid backup and change only its sidecar digest to `"x"`. Reading the metadata panics with `slice bounds out of range [:16] with length 1`. The new snapshot digest correctly rejects a different normal backup; this is a separate malformed-input regression.

**Fix and acceptance:** require a correctly encoded SHA-256 value when the field is present; safely report invalid length/encoding. Test empty legacy values, short strings, non-hex values, and valid-but-wrong digests. Diagnostics for damaged recovery metadata must remain usable.

### R28 — Health still reports persistence available on unwritable chunk storage

- [x] **P2 · Server health · Remaining R15 · Reproduced.** Include chunk-write capability in the advertised persistence guarantee.

[CheckHealth](server/internal/store/health.go#L100) now correctly exercises a SQLite write transaction and returns a nonzero duration. Its chunk-side check remains [statfs](server/internal/store/health.go#L150), which establishes space/volume availability but not write permission. The runbook still describes `200 ok` as a note arriving now being stored.

**Observed:** remove write permission from the chunk root while leaving the database writable. Health returns `CanPersist=true`; an immediate chunk upload fails with permission denied. This was run as a non-root user so the permission failure was real.

**Fix and acceptance:** add appropriate bounded write-capability/failure evidence for chunk storage or narrow the health claim and expose storage-write readiness separately. Test database and chunk storage failures independently, including permissions, read-only mounts, and flush errors.

### R29 — Draft release creation does not trigger the new attestation workflow

- [x] **P2 · Release automation · Regression in R16 fix · Source and platform documentation.** Use an event that actually runs while assets are still private.

[release.sh](scripts/release.sh#L247) now instructs operators to create draft releases and says the attestation workflow will publish them. [attest.yml](.github/workflows/attest.yml#L29) listens for `release: created`. GitHub explicitly excludes draft releases from the `created`, `edited`, and `deleted` workflow triggers. Following the documented default flow therefore leaves a draft without starting the workflow. [GitHub release-event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

**Fix and acceptance:** explicitly dispatch the existing workflow after creating the draft, or trigger a workflow that creates/builds the draft itself. Keep publication last and verify that assets are still private before replacement. Test the platform event/dispatch flow; merely checking that the YAML contains `created` and the script contains `--draft` cannot establish this behavior. No live release was created during this review.

### R30 — The image concurrency group can cancel an unpublished queued release

- [x] **P2 · Container release · Regression adjacent to R17 · Source and platform documentation.** Queue all required immutable releases instead of retaining only the newest pending job.

[The image job](.github/workflows/release.yml#L60) has a common concurrency group with `cancel-in-progress: false`. This prevents cancellation of the running job, but the default concurrency policy retains only one pending job; another arrival cancels the previous pending one. The setting covers the entire build/publish job, so that canceled release never receives its immutable image tag. GitHub documents an explicit `queue` policy for retaining multiple pending runs. [GitHub concurrency documentation](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

**Failure schedule:** A is building, B waits, C arrives, and B is canceled despite `cancel-in-progress: false`. The workflow comment and local ordering test incorrectly treat that setting as a guarantee that a queued release will wait.

**Fix and acceptance:** opt into the supported multi-pending queue policy, such as `queue: max`, with appropriate handling of capacity, or decouple immutable publication from a durable promotion queue. Retain promotion-time tag refresh. Validate three concurrent releases and confirm that each immutable tag appears while moving aliases stay monotonic.

### R31 — The new “streamed” baseline digest buffers the entire file twice

- [x] **P2 · Client memory/performance · Regression in R01 implementation · Inspection.** Compute the baseline digest incrementally or enforce an explicit whole-file budget.

[Engine.digestOf](client/src/core/engine.ts#L2651) stores every `readBlocks` result in `parts`, then allocates another array of the complete file size and copies all parts into it before hashing. The comment claims streaming avoids a whole-file copy, but the implementation retains all source blocks and the concatenated allocation. For a 256 MiB attachment, the assembly stage alone can require roughly 512 MiB of file payload buffers, excluding other sync state. No peak-memory benchmark was run for this finding.

This helper runs when queuing downloads and local deletions, adding that memory requirement to paths that previously compared metadata. [toBuffer](client/src/core/crypto.ts#L812) avoids another copy for a whole-span array; it does not remove the earlier duplication.

**Fix and acceptance:** use a digest implementation that consumes blocks incrementally, or make the whole-file limit explicit and safe for supported devices. Measure an incoming replacement of a large existing attachment, not just first download into an empty vault, and retain the edit-preservation guarantees while bounding peak memory.

### Next verification targets

Close the destructive preservation/cleanup and ownership gaps first: R18–R23. Complete rotation handoff through R24, then align status/resource/health behavior and repair the release flow. Add regression schedules at the **last destructive boundary**, including errors and recovery of abandoned recovery state; several new tests pause before an added check and therefore miss the race immediately after it.

The positive repairs above should be retained. The new section records remaining defects and regressions, rather than resetting the earlier work or treating every original finding as still unchanged. F11's authenticated replay protection and real Obsidian/platform acceptance remain the previously documented scope limitations.

## Third verification — 2026-09-06

Reviewed **`370a1b5cd5383985829e25f4a5fe9043b5f36baa`**, including `82fa0f3` and the subsequent “eight defects in the fixes themselves” commit. This section supersedes the completion claims for R18–R31; the earlier sections and their checkboxes are retained as history.

**Not all fixes are complete.** Seven previous findings are addressed within the checks described here; seven remain partial, including regressions in their replacements. The **eight open findings below are 5 P1 and 3 P2 items**. Six have direct local reproductions, including fault/scheduling injection. One combines a local release-tag reproduction with documented GitHub scheduling behavior; one is a workflow inspection finding.

### Verification and confirmed fixes

`bash scripts/check.sh` completed with **25 passed, 0 failed, 0 skipped**: **1,377 client tests across 73 files**, the separate **16 panel tests and 10 stress tests**, Go race tests/vet, formatting/type/build checks, packaged CLI checks, and local Docker checks. Actual systemd execution and the Linux mounted-filesystem job remain explicitly CI-only on this macOS host.

Independent probes confirmed that CLI publication failure now leaves the original at a visible sibling; a competing destination preserves both local versions; local chunk reuse retains a same-stamp edit; staging cleanup leaves an external symlink target alone; and a save after the final trash comparison survives the original race. An oversized handshake was capped to 16 MiB per batch and 64 MiB per fetch. Against a real local server, an unreadable local directory now makes both text and JSON status exit 1, with JSON `ok: false` and `unsent: "unknown"`.

Source inspection and the maintained tests confirm the purge caller now holds the backup lock through deletion, malformed digests return errors, an unwritable chunk root fails health, rotation waits for the panel acknowledgement, and the CLI baseline digest hashes incrementally. The draft-release instructions now include an explicit workflow dispatch. Immutable image version tags are published outside the promotion concurrency group.

Evidence and runnable probes are in `/tmp/basalt-review-round3/`: `check.log`, `client-probes.ts`/`.log`, `plugin-probes.ts`/`.log`, `status-probe.ts`/`.log`, `release-probe.log`, and the small current-source instrumentation script `prepare.mjs`. Filesystem probes used disposable directories; plugin probes used the repository's Obsidian adapter/stub. The epoch race uses a controlled clock and a pause immediately before unlink. The cross-filesystem replacement probe injects `EXDEV`; it is not a claim that the Linux mount job ran locally. No release was published or altered.

### Updated status of R18–R31

| Finding | Assessment at `370a1b5` | Evidence / remaining work |
|---|---|---|
| R18: durable replacement preservation | Partial | Publication errors and a competing destination retain local originals. Publishing into a different filesystem still fails after moving the original. R37. |
| R19: all destructive landing paths | Partial | Local reuse and merge now use `writePreserving`. Plugin preservation errors still permit overwrite, and an absent/unreadable baseline bypasses preservation. R32/R33. |
| R20: stale-lock takeover | Partial | Recursive marker recovery was removed. Time buckets still permit overlapping owners at the final unlink boundary. R34. |
| R21: staging containment and recovery | Partial | External staging symlinks are refused; the ordinary two-save normalization case gets a visible sibling. Interrupted `respell.*` and legacy `keep.*` recovery files are still reaped. R35. |
| R22: final trash removal race | Partial; original schedule fixed | Rename-aside protects the original final-comparison race. A retry can overwrite the previous attempt's preserved file. R36. |
| R23: backup lock through purge | Fixed for reviewed case | Caller defers the returned release; maintained tests exercise exclusion before deletion and release afterward. |
| R24: rotation acknowledgement | Fixed for reviewed case | The actual panel callback awaits `writtenDown`; the panel test checks that rotation waits before acknowledging. |
| R25: status honesty and exit codes | Fixed by explicit estimate | Size/timestamp comparison is labeled in both formats. The reachable-server probe confirms consistent failure for an unknown local scan. This is still an estimate, not a content audit. |
| R26: client-owned receive limits | Fixed for reviewed cases | Negotiated limits are clamped locally and notifications have a byte budget as well as a count limit; tests cover both. |
| R27: malformed backup digest | Fixed for reviewed cases | Digest shape is validated before comparison/formatting; short, nonhex, and wrong-length values are covered. |
| R28: unwritable chunk-root health | Fixed for reviewed case | Health attempts a chunk-root write; the nonroot permission test and probe-cleanup tests passed. |
| R29: draft-release start and publication gate | Partial; trigger fixed | Explicit dispatch replaces the inactive draft event. Neither upload job establishes that the target release is still a draft. R39. |
| R30: canceled queued image release | Partial; immutable tag fixed | Builds publish their own version tags independently. A canceled promotion can still strand `latest` and minor aliases. R38. |
| R31: whole-file baseline buffering | Fixed for reviewed case | CLI uses an incremental digest; the engine no longer retains blocks and concatenates a second full buffer. Obsidian retains its whole-file adapter limitation. |

### R32 — A failed plugin preservation rename still permits destructive overwrite

- [x] **P1 · Plugin · Remaining R19 · Reproduced.** Abort replacement when the preservation move fails for a reason other than confirmed absence.

[ObsidianVault.replace](client/src/plugin/vault.ts#L716) catches every failure of `adapter.rename(from, kept)`, sets `moved = false`, and immediately calls `write` on the original path. Permission, I/O, and destination errors are treated like a nonexistent original. The method then returns `landed: true` without reporting any preserved version.

**Observed:** begin with an unsent local edit, supply an older expected digest, and make only the preservation rename fail. The incoming write succeeds, the local edit disappears, and the result is `{ landed: true }`. This is a failure-handling defect independent of the documented plugin write race.

**Fix and acceptance:** propagate/refuse an unsuccessful preservation move; only use a missing-file path after establishing absence, and give that path safe creation semantics. Inject preservation rename failures while allowing ordinary writes to succeed. Assert that the original remains and the engine cannot record the incoming version as successfully landed.

The separate plugin rename-to-publication gap also remains reproducible: an editor save after rename is overwritten while only the earlier edit survives at the sibling. The source acknowledges that platform limitation; it should remain visible in completion claims rather than being counted as closed by moving the race boundary.

### R33 — Missing content baselines still select an unconditional overwrite

- [x] **P1 · Core/CLI/plugin · Remaining R19 · Reproduced.** Separate confirmed absence from unknown content, and preserve any file encountered at publication.

[The engine's baseline](client/src/core/engine.ts#L2230) is undefined for a new path and when content cannot be read. That reaches [`NodeVault.replace`](client/src/cli/vault.ts#L1268), [the plugin adapter](client/src/plugin/vault.ts#L723), and the memory adapter as an ordinary overwrite. The last metadata check precedes several awaited operations, including conflict-name selection and staging; it cannot establish that the destination is still absent when the write lands.

**Observed:** during an incoming file's first download, create `fresh.md` with `unsent local` at the existing `midReplace` hook, after the engine's last check. Sync finishes with only `fresh.md = remote`; there is no preserved copy. The production adapters contain the same undefined-baseline branch. A failed digest must not be permission to take that branch either.

**Fix and acceptance:** represent “expected absent” and “could not establish content” separately. Use exclusive creation for an absent destination where supported; otherwise preserve/refuse an occupied destination. An unreadable baseline must cause conservative preservation or a retry. Test creation after the final stat and temporary baseline-read failure, including the real filesystem adapter.

### R34 — An eviction that crosses a minute boundary can delete a new owner's lock

- [x] **P1 · CLI locking · Remaining R20 · Reproduced.** Keep exclusion valid through the destructive syscall.

[The epoch check](client/src/cli/lock.ts#L240) and `rm(path)` remain separate. After the check succeeds, execution or the filesystem operation can pause across the minute boundary. A contender in the next epoch owns a different marker and can evict the old lock and acquire its own. The earlier eviction then removes that new live lock using its stale observation.

**Observed:** pause A immediately after its final epoch check, advance the controlled clock to the next bucket, and let B acquire the stale lock. Resume A. Both `lockVault` calls return successfully, and the lock changes from B to A while B still believes it owns the vault. The source comment acknowledges the residual gap; a smaller probability is not mutual exclusion.

**Fix and acceptance:** use an ownership mechanism that remains exclusive through takeover on the supported platform, or refuse ambiguous automatic takeover. Do not substitute another time/read check for that ownership. Retain a regression paused after the last guard and exercise delayed filesystem completion and process suspension.

### R35 — The staging allowlist still deletes displaced edits after interruption

- [x] **P1 · CLI normalization/recovery · Remaining R21 · Reproduced.** Classify preservation files as recovery data from the moment the original is moved.

[The disposable prefixes](client/src/cli/vault.ts#L1907) include `respell.` and `keep.`. Those names can contain the only local version of a note. Current [`retireName`](client/src/cli/vault.ts#L237) renames the source into `respell.<token>` before it knows whether the bytes belong to the original inode. An interruption before restoration/sibling publication leaves that name in staging. The legacy `keep.*` comment also incorrectly assumes those files are server duplicates: the previous implementation moved unsent edits into them before comparing content.

**Observed:** interrupt current normalization just after moving an old-timestamp unsent edit aside. A new `NodeVault.list()` removes the sole `respell.*` file. A separate legacy `keep.*` crash fixture is also deleted. Because rename preserves mtime, the original edit can already exceed the one-hour threshold when preservation starts.

**Fix and acceptance:** use names that are never reaped for potentially displaced originals, and dispose of them only after verified duplication or a completed recovery handoff. Retain old `keep.*`/`respell.*` files conservatively on upgrade. Test interruption immediately after rename, an old source timestamp, restart/scan, and upgrade leftovers—not only successful restoration.

### R36 — A trash-move retry overwrites the previous attempt's preserved file

- [x] **P1 · CLI filesystem adapter · Regression in R22 fix · Reproduced.** Never reuse an occupied preservation name.

[`removeMatching`](client/src/cli/vault.ts#L2186) always parks a given source at `<source>..basalt-tmp-moving`. When the displaced version differs from the copied bytes and another save takes the source name, the function leaves that aside file and reports an incomplete move. The next attempt uses `rename(from, aside)` with the same destination; rename replaces the preserved file.

**Observed:** the first copy holds `old`; a later save A is moved aside, then save B occupies the original path. The first call correctly fails and retains A. Retry `copyVerifiedThenRemove` on B. It succeeds, but A is overwritten and then deleted during cleanup. Only `old` and B remain in the two destinations.

**Fix and acceptance:** allocate a fresh, nonoverwriting preservation path for every attempt, retain/report unresolved versions, and make subsequent retries/restart recover them safely. Add a two-attempt regression that uses the first attempt's actual leftover rather than a pristine fixture. Also test interruption before the aside is identified.

### R37 — Replacement still cannot publish an existing note across filesystems

- [x] **P2 · CLI filesystem adapter · Remaining R18 · Fault-injection reproduction.** Stage publication on the destination filesystem or refuse before moving the existing note.

The original now moves to a sibling, which avoids the earlier rename `EXDEV`. However, [the incoming file is still staged under root `.basalt/tmp`](client/src/cli/vault.ts#L1279), then [hard-linked into the note's directory](client/src/cli/vault.ts#L1305). That link cannot span filesystems. Only `EEXIST` is handled; the ordinary write helper's cross-device fallback is not used here.

**Observed:** inject `EXDEV` at that publication link after preservation succeeds. The operation throws, the original note name is missing, the original bytes remain at the sibling, and the incoming version does not land. This preserves bytes but breaks updating an existing note under a mounted subdirectory.

**Fix and acceptance:** choose staging compatible with the destination before moving the original, or use a verified, nonoverwriting fallback with equivalent preservation. Exercise an existing-note replacement in the Linux mount job, as well as an injected publication failure. Success must leave the incoming note at its intended name; refusal should not needlessly remove the original name.

### R38 — A canceled promotion can still strand `latest` and minor aliases

- [x] **P2 · Image release · Remaining R30 · Local tag reproduction plus documented scheduling.** Preserve required promotions or reconcile every affected alias.

[The promotion job](.github/workflows/release.yml#L213) still uses the default one-pending concurrency queue. Moving immutable publication outside that group fixes the lost version tag. The comment that the next promotion will repair any canceled aliases is incorrect when releases belong to different minor lines or arrive out of version order.

**Reproduced decision:** with A running, B (`0.5.0`) pending, and C (`0.3.9`) arriving, the default queue cancels B. Running the actual `release-tags.sh` against those tags shows B would set `0.5` and `latest`; C sets neither. B's immutable image exists, but its moving aliases remain missing or stale. This is a local decision/scheduling reproduction, not an observed live Actions run. [GitHub documents pending-run replacement and the optional `queue: max` setting](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

**Fix and acceptance:** retain queued promotions with an explicit bounded queue and an overflow policy, or make a surviving job reconcile all eligible aliases from validated published images. Test three overlapping releases including a backport, not just two releases advancing one minor line. Keep immutable builds independent.

### R39 — Attestation assumes its target is private without checking

- [x] **P2 · Release publication · Remaining R29/R16 gate · Source inspection.** Establish draft state before mutating release assets.

The dispatch accepts a tag and checks CI, but neither the [plugin upload](.github/workflows/attest.yml#L133) nor [server upload](.github/workflows/attest.yml#L216) checks the release's draft state before `gh release upload --clobber`. A manual rerun against an already public release therefore replaces public assets before the final “publish” step. If rebuilt/uploaded bytes differ or an upload fails partway, the public release can expose a partially replaced asset set or mismatched checksums. This was not exercised against a live release.

**Fix and acceptance:** reject an already published target before the first asset mutation, and serialize work for the same release so another run cannot publish it during replacement. If public re-attestation is intentionally supported, give it a separate policy that does not replace public bytes under the draft-only guarantee. Test draft and public release responses and assert that the public case makes no upload/delete/edit calls.

### Remaining verification limits

Real Obsidian desktop/mobile behavior, physical power cuts, Linux mount behavior, and live GitHub publication were not independently exercised here. In particular, the plugin's documented last-write race remains a limitation even after R32 is corrected. Authenticated replay/rollback protection (F11) remains the earlier explicit POC deferral. These are not newly implemented guarantees.

Prioritize R32–R36, then the cross-filesystem and release issues. Keep regression hooks after the last guard and carry real leftovers into retries: several current tests cover a successful first attempt while the remaining failures happen after preservation or during a second attempt.
