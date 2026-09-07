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

## Fourth verification — 2026-09-06

Reviewed **`8ee6db769b1295619da6a88f8ef455d113edf69b`**, including `c51bd6a`, `09f6b68`, and the plugin publication changes completed during this review. The implementation changed while the first checks were running, so final validation used an isolated snapshot. File fingerprints confirmed that its application, tests, configuration, and workflow files match the completed implementation. Earlier review sections remain unchanged.

**Six of R32–R39 are addressed for the reviewed cases. R34 and R38 remain partial.** There are **three open findings below: one P1 locking defect and two P2 release defects**. All have local reproductions; the release reproductions use simulated registry responses rather than a live publication.

### Checks and confirmed repairs

`bash scripts/check.sh` passed **25 checks, with 0 failed and 0 skipped**, on the final isolated snapshot. This included **1,396 client tests in 73 files**, the separate **16 panel tests and 10 stress tests**, Go race tests/vet, format/type/build checks, packaged CLI checks, and local Docker checks. Actual systemd execution and the Linux mounted-filesystem job remain explicitly CI-only on this macOS host.

The initial live-tree run and an intermediate snapshot each had one failing plugin test. The implementer subsequently corrected the test's hook to run after rename and completed the publication change. The final result above applies to that completed version, rather than those intermediate failures.

Independent probes confirmed that failed plugin preservation and an unanswerable presence check leave the original intact; the newer plugin publication preserves a competing save; all three adapters retain files when no baseline was available; current and legacy normalization recovery files survive scans; and a second trash move retains the first attempt's preserved version. Simulated cross-filesystem replacement stages beside the destination, and publication failure restores the original name. The original canceled-promotion/backport scenario now repairs all its aliases. The actual draft-gate shell code accepts a draft and refuses both a public release and an API failure.

Evidence is retained in `/tmp/basalt-review-round4/`, including `final-check.log`, `client-probes.ts`/`.log`, `plugin-probes.ts`/`.log`, `workflow-probes.mjs`/`.log`, and `final-worktree.patch`. The lock probe adds a scheduling pause to a temporary copy of the source; filesystem fixtures are disposable. Workflow probes execute the extracted promotion/gate shell bodies with mocked Git, registry, and GitHub commands. The mock image name and output-file location are fixed for local execution; alias selection and mutation logic are unchanged. No external release or registry was modified.

### Updated status of R32–R39

| Finding | Assessment | Evidence / remaining work |
|---|---|---|
| R32: plugin preservation failure | Fixed for reviewed cases | A failed move with an occupied or unknown destination returns `landed: false`. The subsequent plugin change uses `create`, and the after-rename competing-save probe retains both local versions. |
| R33: missing-baseline overwrite | Fixed for reviewed cases | CLI, plugin, and memory adapters preserve encountered files even without an expected digest. The original first-download engine probe now retains the local edit. |
| R34: stale-lock takeover | Still open | Moving the lock before identifying it creates an interval in which a live holder appears unlocked. R40. |
| R35: reaping displaced originals | Fixed for reviewed cases | Current normalization uses `preserved.*`; legacy `keep.*` and `respell.*` survive scans and are reported as stranded. |
| R36: trash retry destroys previous preservation | Fixed for reviewed case | Each attempt selects a fresh aside; the two-attempt probe retains A after moving B. |
| R37: replacement across filesystems | Fixed under simulated device/error conditions | Staging moves to the destination filesystem before preservation; failure restores the original name. Actual Linux mounted-filesystem acceptance remains CI-only here. |
| R38: canceled promotion strands aliases | Partial; original schedule fixed | Reconciliation repairs the canceled backport scenario, but a newer unpublished Git tag can still block eligible published images, and a prerelease-only history fails. R41/R42. |
| R39: mutation of a public release | Fixed for reviewed workflow | Draft state is checked in the shared prerequisite, and the whole workflow is serialized per tag. Public/error responses refuse before an upload job can run. |

### R40 — Taking a live lock aside admits another owner

- [x] **P1 · CLI locking · Remaining R34 · Reproduced.** Keep a live owner's exclusion continuously visible during stale takeover.

[`evicting`](client/src/cli/lock.ts#L226) renames the lock away before identifying the file it actually took. If its earlier observation is stale, that file belongs to a live owner. The authoritative lock path is now absent. A third contender can acquire it before the evictor [tries to restore the live lock](client/src/cli/lock.ts#L245). Restoration then fails because the name is occupied, and `finally` deletes the displaced live holder's lock. The original owner receives no revocation and continues working.

**Observed:** A reads the dead lock and pauses before rename. B evicts it and successfully acquires the vault. A resumes, moves B's live lock aside, and pauses at `midEvict`. C now successfully acquires the empty lock path. After A resumes, A refuses, but **B and C both retain successful lock acquisitions**. No clock boundary or process crash is required. A crash after moving B aside would leave the same unsafe absence; the comment calling that the safe direction is incorrect.

**Fix and acceptance:** use an exclusion mechanism whose ownership survives takeover, or fail closed on stale/ambiguous locks until all writers have stopped. A possibly live lock must not be removed from its authoritative name while its owner can still write. Add this three-contender schedule and interruption after taking a live lock to the maintained suite. Checking that only the evictor loses does not establish that the other two contenders are mutually exclusive.

### R41 — An unpublished newer Git tag prevents promotion of a valid release

- [x] **P2 · Image release · Remaining R38 · Reproduced with simulated registry state.** Select the newest eligible published image before choosing each alias target.

[`release-aliases.sh`](scripts/release-aliases.sh#L40) chooses the highest stable Git tag, without establishing whether its image was successfully published. The promotion job then [skips that alias when image lookup fails](.github/workflows/release.yml#L258), rather than considering the next eligible version. The assumption that the missing version's own promotion will eventually run fails when its build or validation failed.

**Observed:** Git contains `0.4.1`, `0.4.2`, and `0.5.0`; only the first two images exist, and `latest` still points at `0.4.1`. Run the actual reconciliation body. It moves `0.4` to `0.4.2`, skips `latest` because `0.5.0` is absent, and exits **0**. The newest successfully published image remains unavailable through `latest`. Repeating the job does not repair it while the failed tag remains.

**Fix and acceptance:** resolve the validated, published version set before selecting the maximum for each alias. Distinguish an unpublished image from a registry/authentication failure; handle uncertainty without rolling an existing newer alias backward. Test a newer failed build, a valid completed older release, and a transient lookup failure in addition to the three-successful-release case.

### R42 — A valid prerelease-only history makes promotion fail

- [x] **P2 · Image release · Regression in reconciliation · Reproduced with simulated registry state.** Treat an empty alias plan as a successful no-op when no stable release exists.

The helper correctly [returns no aliases for an entirely prerelease history](scripts/release-aliases.sh#L45). The workflow nevertheless [requires `checked > 0`](.github/workflows/release.yml#L280), based on the incorrect comment that every release moves a minor alias. Prereleases intentionally move neither a minor alias nor `latest`.

**Observed:** with only `server/v0.5.0-rc.1` and its successfully published immutable image, the reconciliation body makes no registry mutation and exits **1** with `no alias resolved to a published image, which cannot be right`. This affects the first prerelease in a repository without stable server tags; it is not a failure of the image build itself.

**Fix and acceptance:** separate “no stable aliases are expected” from “expected aliases could not be resolved.” The first case should succeed without creating moving tags; genuine resolution errors should remain visible. Exercise the workflow body for an initial prerelease, an ordinary stable release, and a nonempty plan whose image lookups all fail.

### Verification limits

Plugin probes use the repository adapter/stub; real Obsidian desktop/mobile acceptance was not run. The installed Obsidian 1.13.7 desktop adapter's rename ordering was inspected: its existence check and native rename execute in the adapter's queue, which is relevant to its own writes and is not a general filesystem lock. Physical power cuts, Linux mounted-filesystem behavior, and live GitHub scheduling/publication were not independently exercised. F11's authenticated replay protection remains the earlier explicit POC deferral.

R40 is the remaining data-integrity priority. The release issues can be corrected independently while retaining the preservation and draft-gate fixes confirmed above.

## Fifth verification — 2026-09-06

**The fixes are not all complete. R40, R41, and R42 still reproduce, and R43 below is an additional data-loss defect. There are four open findings from this verification: two P1 and two P2.** Earlier sections and their finding numbers are retained.

Reviewed **`33d58b152fdd6d94a7a48d01363282ce4130fb38`** and the working-tree snapshot captured during this pass. The implementer continued changing server code during validation. The isolated snapshot includes the captured backup changes in `server/cmd/basaltd/main.go`, `server/internal/store/backup.go`, and `server/internal/store/backup_test.go`. Subsequent chunk-count/schema changes in `server/internal/store/store.go` and accompanying `store_test.go` changes were outside that snapshot and are **not covered by the passing gate below**. The client code and release files underlying all four findings matched the live checkout when the findings were written.

### Checks and confirmed repairs

`bash scripts/check.sh` completed with **26 passed, 0 failed, 0 skipped** on the isolated snapshot. This includes **1,412 client tests in 74 files**, the separate **16 panel tests and 10 stress tests**, Go race tests/vet, format/type/build checks, packaged CLI checks, and local Docker checks. Actual systemd execution and the Linux mounted-filesystem job remain CI-only on this macOS host.

Independent filesystem probes confirmed that an incoming removal with no baseline now preserves the local file, and failure to create its preservation destination restores the original name. The maintained suite also passed with the new pairing cancellation/retry, normalization bookkeeping, memory-adapter, server budget, and health tests. These repairs are useful, but they do not close the findings below.

Evidence is in `/tmp/basalt-review-round5/`: `check.log`, `lock-probe.ts`/`.log`, `preservation-probe.ts`/`.log`, `workflow-probes.mjs`/`.log`, `source-hashes.json`, and `worktree.patch`. The captured patch has SHA-256 `b09ff9dbdfda7f413afc33971ed5767aa8242f64e9760b1ba070c58231580054`. The lock probe now uses the source's existing scheduling hooks, without editing or copying its implementation. Preservation probes use the real `NodeVault`, including an engine-driven update. Release probes execute the extracted workflow shell with simulated Git/registry/GitHub responses; no external release was changed.

### Status of the three previous findings

| Finding | Result | Current evidence |
|---|---|---|
| **R40 · P1 · CLI lock takeover** | **Still open** | A stale evictor takes B's live lock away; C acquires the empty name. B and C both successfully acquire before either releases. |
| **R41 · P2 · Published-image selection** | **Still open; implementation unchanged** | With tags `0.4.1`, `0.4.2`, `0.5.0`, but images only for the first two, promotion moves `0.4` to `0.4.2`, leaves `latest` at `0.4.1`, and exits 0. |
| **R42 · P2 · Prerelease-only promotion** | **Still open; implementation unchanged** | With only `server/v0.5.0-rc.1`, reconciliation creates no aliases and exits 1: `no alias resolved to a published image, which cannot be right`. |

### R40 follow-up — Retrying restoration does not preserve exclusion

- [x] **P1 · CLI locking · Reconfirmed with the current implementation.** Prevent a contender from acquiring while the displaced lock's owner is still active.

The new retry loop distinguishes `EEXIST` from I/O failures, but [`rename(path, taken)`](client/src/cli/lock.ts#L245) still removes a possibly live lock from its authoritative name. The [`EEXIST` branch](client/src/cli/lock.ts#L276) then treats that live lock as a duplicate and [deletes it](client/src/cli/lock.ts#L289). It is a different owner's proof, not a duplicate of C's ownership.

**Reconfirmed schedule:** A reads a dead holder and pauses at `midEvict.beforeTake`; B completes takeover and acquires. A resumes and moves B's live lock aside, then pauses at `midEvict.pause`. C acquires. A resumes, cannot restore over C, deletes B's displaced lock, and refuses. **B and C both remain successful holders.** No injected filesystem error, crash, or clock boundary is involved. The added restoration-error test checks whether B's file survives; it does not establish that other callers are excluded.

**Acceptance remains:** continuous exclusion for a live owner, including this three-contender schedule and interruption after taking a live lock. If safe automatic stale takeover cannot be implemented, fail closed until writers have stopped. Retaining a file under `lock.taken.*` alone does not exclude callers that only consult `lock`.

The commit `3447d9c` uses the label “R40” for a pairing-panel fix. That is a separate issue; it does not close this document's R40 locking finding.

### R41/R42 follow-up — The promotion fixes have not been applied

- [x] **R41 · P2:** choose alias targets from eligible published images, handling registry uncertainty without an unintended rollback. The current [Git-tag selection](scripts/release-aliases.sh#L40) and [skip-on-lookup-failure branch](.github/workflows/release.yml#L258) still reproduce the failed-newer-build case.
- [x] **R42 · P2:** accept a valid empty alias plan as a no-op. The helper's [prerelease-only exit](scripts/release-aliases.sh#L45) still reaches the workflow's [unconditional `checked > 0` requirement](.github/workflows/release.yml#L280).

The original successful backport reconciliation and draft-release guard still passed their probes. The outstanding cases above require their own workflow-level regression coverage.

### R43 — Preservation can overwrite a note at the chosen conflict path

- [x] **P1 · CLI filesystem adapter/core · Newly identified remaining preservation defect · Reproduced on disk.** Claim preservation destinations without replacing a file that appeared there after selection.

The engine [chooses a currently free conflict name](client/src/core/engine.ts#L2742), then calls the adapter. [`NodeVault.replace`](client/src/cli/vault.ts#L1378) uses ordinary `rename(full, kept)`, which replaces an occupied destination on the tested filesystem. A competing note created after name selection is therefore overwritten by the very operation intended to preserve notes. [`removeExpecting`](client/src/cli/vault.ts#L1540) has the same problem when moving its parked original to `keepAt`. Its new error recovery does not help: this overwrite succeeds.

**Observed through the engine:** sync `note.md = remote one`, then receive `remote two`. After the engine selects its free conflict-copy name, create a distinct unsent note at that name before the adapter moves the original. The update finishes with only `note.md = remote two`. The competing note is gone; the displaced baseline is also removed by the normal matching-baseline cleanup. The report says **`downloaded: 1`, `conflicted: 0`**, with no retry or attention item.

**Observed through removal:** start with an unsent original and no expected baseline. Create a second unsent note at `keepAt` in the existing `midTrash.parked` hook. Removal returns `{ keptAt, landed: true }`, but that path now holds only the original; the second note was overwritten.

**Fix and acceptance:** use a preservation operation that refuses an occupied destination at the actual publication boundary, then safely retry with another name or refuse while retaining both files. A preceding existence check does not reserve the path. Cover both replacement and removal, including a matching baseline where ordinary cleanup follows. Assert that every distinct local version survives when the conflict destination becomes occupied after selection; neither the incoming path's exclusive create nor `placeBeside` protects these separate rename operations.

### Verification limits

This pass confirms the four failures above and the stated repairs in the captured snapshot; it does not certify the additional server schema work being edited concurrently. Real Obsidian desktop/mobile operation, physical power cuts, Linux mounted-filesystem acceptance, and live GitHub publication were not exercised. Application code was not changed by this review.

## Sixth verification — 2026-09-06

Reviewed **`f6eeca23d932eaad54d52d0a219de9ba33386703`**, including the completed server changes in `496f225`. **Not all fixes are complete: five findings remain below, two P1 and three P2.** The original R43 conflict-destination collisions and R42 prerelease-only failure are fixed. R40 still permits concurrent owners under a different schedule, R41 still permits rollback under registry uncertainty, and the new preservation/server paths have three additional defects.

### Validation and status

The checkout was clean when captured. `bash scripts/check.sh` passed **27 checks, 0 failed, 0 skipped**, in an isolated snapshot of this commit: **1,414 client tests in 74 files**, the separate **16 panel tests and 10 stress tests**, Go race tests/vet, format/type/build checks, release-shell tests, packaged CLI checks, and local Docker checks. Systemd execution and the mounted-filesystem job remain CI-only on this macOS host. Unlike the previous pass, this gate includes the completed server schema work.

| Previous finding | Assessment | Evidence |
|---|---|---|
| R40: live-lock takeover | Partial; still open as R44 | The original schedule is covered by the new tests, but release cleanup allows generation reuse and a paused contender can acquire alongside a live owner. |
| R41: unpublished newer image | Original case fixed; uncertainty remains as R45 | `latest` now advances to `0.4.2` when `0.5.0` was never published. A readable existing alias is protected during a version lookup failure, but an unreadable existing alias is not. |
| R42: prerelease-only promotion | Fixed for reviewed case | With only `server/v0.5.0-rc.1`, the actual promotion body exits 0 and makes no alias mutation. |
| R43: occupied preservation destination | Fixed for both original collisions | The engine-driven matching-baseline update retains the competing note. Removal selects a different preservation name and retains both local versions. A subsequent preservation failure has the separate recovery defect R46. |

The original backport reconciliation, draft-release guard, unknown-baseline removal, and restoration after a removal error also passed their probes. Evidence is retained in `/tmp/basalt-review-round6/`: `check.log`, `lock-probe.ts`/`.log`, `preservation-probe.ts`/`.log`, `preservation-failure-probe.ts`/`.log`, `preservation-retry-probe.ts`/`.log`, `workflow-probes.mjs`/`.log`, `server-probe/`, `server-probe.log`, and `source-hashes.json`. These use the unchanged implementation, existing scheduling hooks, disposable filesystem/SQLite fixtures, and simulated registry responses. No external release was modified.

### R44 — Reusing lock generations admits a paused contender beside a live owner

- [x] **P1 · CLI locking · Remaining R40 · Reproduced.** Preserve exclusion across release, cleanup, and reacquisition, including contenders paused before publication.

[`lockVault`](client/src/cli/lock.ts#L117) publishes the successor of the generation it read earlier. Release [removes its claim and sweeps older claims](client/src/cli/lock.ts#L127), allowing generation numbering to restart at 1. A paused caller can then publish a higher generation computed before that reset, without checking the live owner of the newly reused lower generation.

**Observed:** begin with a dead generation 1. A reads it and pauses at `midEvict.pause`, intending to claim generation 2. B acquires generation 2, finishes, and releases; cleanup leaves no claim files. C acquires generation 1 and remains active. Resume A: it successfully links generation 2 and returns a release function. **C and A both hold successful acquisitions**, while `currentHolder` reports only A. This uses unmodified source and the existing hook; no filesystem error or clock manipulation is required.

**Fix and acceptance:** make the ownership protocol safe against stale observations across cleanup. Do not recycle ownership generations while an older contender can still publish against them; retaining a monotonically increasing fence needs a complete release/recovery protocol too. An OS-owned lock or conservative refusal is preferable to another unprotected check. Add this exact acquire/release/reacquire schedule and verify that at most one caller may write throughout it, not merely that the highest claim names someone.

### R45 — A failed lookup of the current alias bypasses rollback protection

- [x] **P2 · Image promotion · Remaining R41 · Reproduced with simulated registry failures.** Treat an unreadable alias as unknown, not as an absent alias that may be assigned an older image.

The workflow [converts any alias lookup failure to `now=""`](.github/workflows/release.yml#L295). The rollback guard [runs only when `now` is nonempty](.github/workflows/release.yml#L310). Consequently, simultaneous lookup failures for the newest version and the existing alias bypass the protection added in this commit.

**Observed:** all three immutable images `0.4.1`, `0.4.2`, and `0.5.0` exist; `latest` points at `0.5.0`. Make inspection fail for `0.5.0` and `latest`, while older inspections and alias creation succeed. The actual workflow body resolves `0.4.2`, **moves `latest` backward to it, and exits 0**. When only the version lookup fails and the alias remains readable, the guard works; that narrower case is the one the added test covers.

**Fix and acceptance:** distinguish confirmed absence from authentication/network/registry failure before mutation, or conservatively retain an alias whose current state cannot be established. Test failure of both lookups together, a readable newer alias, a confirmed missing alias, and recovery on a subsequent healthy run.

### R46 — Failed preservation leaves an unsent edit hidden after sync recovers

- [x] **P1 · CLI preservation/recovery · Regression in the R43 implementation · Reproduced through the engine.** Keep displaced originals discoverable across failed claims and subsequent successful retries.

Replacement now parks the original beside the note as `<name>..basalt-tmp-keep<token>`. After publishing the incoming file, [`claimPreserved` can fail](client/src/cli/vault.ts#L1494), leaving that parked original behind. [`isTemporary`](client/src/cli/vault.ts#L2160) excludes it from scans, while the [`stranded` inventory](client/src/cli/vault.ts#L948) only inspects `.basalt/tmp`. The first error includes the hidden path, but no durable recovery state keeps it visible after the engine retries successfully.

**Observed:** during an engine-driven update, save an unsent local edit after the last comparison. At the preservation-claim hook, temporarily make the parent directory unwritable so the real `link` fails with `EACCES`. Restore permissions and let the ordinary retry backoff expire. The next sync reports **`unchanged: 1`, `retrying: 0`, no attention items**. The normal note contains the remote version. The only local edit remains in the hidden sibling; a fresh `NodeVault` lists only the remote note and reports **`stranded: []`**. The bytes survive on disk, but sync and recovery reporting have lost track of them.

**Fix and acceptance:** record or discover every parked original until it is durably handed to a visible recovery path. A transient error string is insufficient. After a failed claim, safely complete preservation, restore without clobbering another version, or maintain a persistent recovery item that prevents a clean status from concealing the stranded edit. Test filesystem failure and interruption between parking and claiming, then retry and restart; assert that both versions remain discoverable and any unresolved recovery is still reported.

### R47 — Deep verification reports a truncated chunk list as healthy

- [x] **P2 · Server verification · Incomplete integration of the new chunk-count check · Reproduced through the CLI.** Apply stored chunk-count and ordering invariants to verification as well as entry reads.

Entry reads now compare the recorded `n_chunks` with the retrieved list. [`verifyEntries`](server/internal/store/store.go#L1990) still checks only whether a content-bearing entry has zero chunks, or a bodyless entry has any; it does not read `n_chunks`. A nonempty truncated list therefore passes deep verification even though the same binary refuses to serve it.

**Observed:** append one entry with three valid stored chunks, then remove only its final `entry_chunks` row. `EntryByUID` refuses with `was written with 3 chunks and has 2`. `Verify(true)` returns no faults, and the current **`basaltd verify -deep` exits 0**, printing `checked 1 entries and 2 chunk references and 0 registry rows, 0 faults`. This is a false clean result for structural information the server now records and can validate.

**Fix and acceptance:** include expected counts and contiguous ordering in the verifier's entry checks, preserving the explicit unknown-count handling for migrated rows. Exercise a missing tail, an interior gap, and an ordinary valid entry through both the library and CLI; a known mismatch must produce a fault and nonzero verification exit.

### R48 — Read-only entry queries cannot inspect a previous-version backup

- [x] **P2 · Server backup compatibility · Regression from `n_chunks` · Reproduced.** Support the immediately preceding schema without modifying a backup during inspection.

The shared [`entryCols`](server/internal/store/store.go#L820) now unconditionally selects `n_chunks`. [`ReadOnly` opening deliberately skips migration](server/internal/store/open.go#L109), and backups written before this commit have no such column. Opening succeeds because the schema version remains supported, but the first entry read fails. [`backupCovers`](server/cmd/basaltd/main.go#L1280) uses this read-only path, so a valid existing backup can no longer establish purge coverage after the upgrade.

**Observed:** create a valid entry, recreate the previous schema by removing only `n_chunks`, and reopen with `OpenMode(..., ReadOnly, ...)`. Opening succeeds and deep verification reports zero faults, but `EntryByUID` fails with **`no such column: n_chunks`**. This is a compatibility failure on inspection; writable opening would migrate it, which is not permission for an inspection command to alter the backup.

**Fix and acceptance:** detect the schema shape on read-only opening and select an explicit unknown count for older rows, or provide another supported inspection path that leaves the backup unchanged. Test coverage against a backup made by the previous schema, verify its bytes are unchanged after inspection, and retain count validation for current-schema backups.

### Verification limits

All five findings concern the captured commit; the previous sections describe their earlier reviewed versions. No application code was changed. Real Obsidian desktop/mobile operation, physical power cuts, Linux mounted-filesystem acceptance, and live GitHub publication were not exercised. The preservation probe restores temporary permissions and waits for the normal retry; the registry probe changes only mock responses; the server probes modify disposable database fixtures.

## Seventh verification — 2026-09-07

Reviewed **`99c47e841f312bc25ae792ea60133546337c65aa`**. **Three defects remain: one P1 locking defect and two P2 reporting/verification defects.** All five original R44–R48 reproductions now pass, but additional schedules and boundary cases below prevent closing the corresponding areas completely.

### Validation and updated status

`bash scripts/check.sh` passed **27 checks, 0 failed, 0 skipped**, on the isolated snapshot: **1,417 client tests in 74 files**, the separate **16 panel tests and 10 stress tests**, Go race tests/vet, formatting/type/build checks, release-shell tests, packaged CLI checks, and local Docker checks. Systemd execution and the Linux mounted-filesystem job remain CI-only on this macOS host.

| Finding | Assessment | Evidence |
|---|---|---|
| R44: generation reuse | Original schedule fixed; exclusion still fails as R49 | A higher-numbered contender now yields to an already active lower-numbered owner. Reversing which delayed claimant finishes first still produces two successful owners. |
| R45: unreadable alias rollback | Fixed for reviewed cases | Simultaneous lookup failures for the newest version and `latest` leave the existing alias unchanged. The normal failed-newer-build case still advances to the newest available image. |
| R46: hidden parked originals | Discovery fixed; text recovery output incomplete as R50 | After a real preservation failure, permission recovery, normal retry, and a fresh scan, `stranded` retains the parked original's path. Text status nevertheless directs the user to the old staging directory. |
| R47: missing chunk tail | Original case fixed; ordering check incomplete as R51 | A missing tail produces `shortchunks` and nonzero CLI verification. An invalid list whose count and maximum still match escapes the new check. |
| R48: previous-schema backups | Fixed for reviewed cases | Read-only entry queries work without `n_chunks`; the maintained purge-coverage test also accepts the previous schema and checks that inspection leaves the backup unchanged. |

Earlier conflict-destination collisions, unknown-baseline removal, restoration after removal failure, backport reconciliation, prerelease-only promotion, and draft-release guard probes still pass. Evidence is in `/tmp/basalt-review-round7/`: `check.log`, `lock-probe.ts`/`.log`, `lock-delayed-lower-probe.ts`/`.log`, `preservation-probe.ts`/`.log`, `preservation-retry-probe.ts`/`.log`, `recovery-status-probe.ts`/`.log`, `workflow-probes.mjs`/`.log`, `server-probe/`, `server-probe.log`, and `source-hashes.json`.

### R49 — A delayed lower claim takes ownership after a higher owner has acquired

- [x] **P1 · CLI locking · Remaining R44 · Reproduced with existing hooks.** A caller that has acquired the vault must remain exclusive until it releases, regardless of later claim numbers.

The new post-publication check [yields only to a lower-generation rival](client/src/cli/lock.ts#L138). This resolves two claims only when both callers are still deciding. If the higher-generation caller has already returned success, a delayed lower-generation caller also returns success: nothing revokes the existing owner's permission to write.

**Observed:** start with dead generation 1. A reads it and pauses, intending to publish generation 2. B acquires generation 2, releases, and sweeps the directory. C reads the now-empty directory and pauses, intending to publish generation 1. Resume A first: it acquires generation 2 and `currentHolder` reports A. Then resume C: its post-publication check sees A but does not yield to a higher generation. **Both A and C return successful acquisitions before either releases**; `currentHolder` merely changes its answer to C. Both files remain on disk. This is the existing R44 schedule with C's publication delayed, not a filesystem failure or artificial clock change.

**Fix and acceptance:** do not let a late claimant displace an owner that has already been admitted. Use an ownership protocol that distinguishes established ownership from competing claims, or conservatively refuse ambiguous acquisition. An extra observation and a numeric tie-break are insufficient without that guarantee. Add both completion orders around release/reacquisition, asserting continuous mutual exclusion rather than only the winner reported by `currentHolder`.

### R50 — Text status sends recovery to an empty directory

- [x] **P2 · CLI recovery reporting · Remaining integration of R46 · Reproduced through `status`.** Print the actual locations of parked originals.

The scan now records parked files beside their original notes, using paths relative to the vault. [`status` still says every stranded version is in `.basalt/tmp`](client/src/cli/cli.ts#L1530), and prints neither the recorded path nor another location. That was correct for the old staging-only inventory and is false for the files this fix newly discovers.

**Observed:** place the recovery fixture at `notes/note.md..basalt-tmp-keep12345678`. JSON status correctly includes that path in `stranded`; text status says `kept 1 version(s) this client could not put back, in <vault>/.basalt/tmp`. That directory is empty. The only unsent edit remains under `notes/`, where the ordinary vault listing deliberately hides it. The probe uses an unreachable loopback endpoint; this local recovery output does not depend on a live server.

**Fix and acceptance:** give all recovery entries an unambiguous path convention, including both old staging entries and new sibling entries, and render their actual locations in text status. Test a staging-only fixture, a nested sibling fixture, and both together. A user following the printed path must reach the retained bytes without guessing or switching to JSON.

### R51 — Matching count and maximum ordinal do not prove a valid chunk sequence

- [x] **P2 · Server verification · Remaining R47 · Reproduced through library and CLI.** Verify the complete zero-based chunk ordering that the reader requires.

The new ordering predicate [compares only `MAX(ord)` with `COUNT(*) - 1`](server/internal/store/store.go#L2106). The schema's primary key prevents duplicate ordinals but does not prohibit negative ones. A list can have the expected count and maximum while omitting ordinal 0 and containing a negative ordinal instead.

**Observed:** append a valid three-chunk entry, then change the first row's ordinal from 0 to -1, preserving all bodies and the declared count. The list is now `[-1, 1, 2]`. `EntryByUID` refuses with `chunk ord -1 out of sequence at position 0`. `Verify(true)` reports no faults, and **`basaltd verify -deep` exits 0**, printing `checked 1 entries and 3 chunk references and 0 registry rows, 0 faults`. The ordinary missing-tail case correctly fails in the same probe.

**Fix and acceptance:** validate a zero-based contiguous sequence, including its lower bound. With distinct integer ordinals, checking both minimum 0 and maximum `count - 1` is sufficient; walking the ordered rows as the reader does is another option. Apply this to current and previous schemas. Add a negative ordinal replacing 0 alongside valid, missing-tail, and interior-gap fixtures; invalid ordering must cause a fault and nonzero CLI exit.

### Verification limits

The worktree was clean when captured, and final source fingerprints were checked against the isolated snapshot. Application code was not changed; this review only appends the document. Filesystem and SQLite mutations were confined to disposable fixtures, and release probes used mocked registry/Git/GitHub commands. Real Obsidian desktop/mobile operation, physical power cuts, Linux mounted-filesystem acceptance, and live GitHub publication were not exercised.

## Product readiness recommendations — 2026-09-07

[PRODUCT_READINESS.md](PRODUCT_READINESS.md) records the architectural assessment
of the recurring bug classes, proposed threat-model and release-scope boundaries,
implementation priorities, and public-beta acceptance criteria. It is a strategic
recommendation based on these reviews, not another verification or confirmation
that subsequent fixes are complete.

## Readiness implementation review — 2026-09-07

Reviewed **`e347e024aa79d6374855b8fcea7055a8f86f7c00`**, covering the four readiness
commits after `01ae785`. The direction is sound: exclusive acquisition without
automatic takeover, a shared recovery record, and a reusable fault driver address
the recurring mechanisms. **The readiness guarantees are not yet complete.**
The four findings below use separate RR identifiers to distinguish them from the
earlier numbered verification rounds.

### Validation and scope

- The working tree was clean when captured. Review probes ran in an isolated
  archive of the commit at `/tmp/basalt-readiness-review.AhLn2e/`.
- **123 existing tests passed** across CLI lock/unlock/displaced-version tests,
  the core ledger tests, and plugin vault tests.
- **All 11 new fault-driver stress tests passed** against the original source.
- **Five additional safety assertions failed**: continuous lock exclusion,
  recovery after a failed ledger append, recovery with an unreadable ledger,
  discovery after interruption immediately following preservation, and recovery
  after a short compaction write. Logs and probes are retained in that directory.
- Plugin probes use the repository's `FakeAdapter` and the actual `ObsidianVault`
  implementation. The interrupted-operation probe reconstructs the persisted
  state at the first preservation rename; it is not a real mobile SIGKILL test.
- A private mutation of the crash child demonstrated RR4 and was restored before
  running the original fault-driver tests. No application source was changed in
  the working repository.
- The extracted Obsidian 1.13.7 artifact supports the decision about
  `Vault.process()`: both adapter implementations write in place. The public
  read-modify-write guarantee does not establish crash-safe replacement.
- The reported full 27-check gate, all 1,442 client tests, all 21 stress tests,
  published npm compatibility, and real Obsidian platform acceptance were not
  independently rerun in this focused assessment.

### RR1 — Manual unlock still admits two active writers

- [x] **P1 · CLI ownership · Reproduced with real filesystem operations and the public lock functions.**

[`unlockVault`](client/src/cli/lock.ts#L227) checks the holder, then moves the
lock aside. Another unlock can finish and a writer can acquire between those
steps. Taking that new holder aside exposes an empty lock path again. Returning
`contested` afterwards does not withdraw either writer's permission to write.

**Observed:** begin with a dead holder. U1 pauses at `beforeTaking`; U2 clears
the stale lock; A acquires through `lockVault`. Resume U1, which moves A's lock
aside; B acquires at `taken`. Both acquisitions return before either releases.
U1 returns `contested`. No fixture rewrites a live lock: after seeding the dead
holder, this schedule uses only `unlockVault` and `lockVault` calls.

The existing test acknowledges a related residual race but asserts the warning
and retained lock file rather than continuous mutual exclusion. The new general
fault sweep never invokes either ownership operation.

**Fix and acceptance:** make recovery depend on an enforced exclusion mechanism,
or explicitly limit manual recovery to a quiescent maintenance procedure with
all writers, launchers, and other recovery attempts stopped. A warning after two
successful admissions is not a completed ownership guarantee. Preserve this
schedule as an exclusion test if concurrent recovery remains supported.

### RR2 — Plugin discovery still depends on a ledger record that may never exist or be readable

- [x] **P1 · Plugin recovery · Three focused probes fail.**

[`removeExpecting`](client/src/plugin/vault.ts#L881) moves the note into a hidden
folder before recording anything. It records only if a later operation throws.
[`record`](client/src/core/displaced.ts#L88) swallows append errors, and
[`parse`](client/src/core/displaced.ts#L146) returns an empty array on read errors.
The comments rely on a fallback scan, but the
[plugin explicitly uses only the ledger](client/src/plugin/vault.ts#L576).

**Observed:** each of these leaves the retained note bytes readable at their
hidden path while a fresh plugin adapter reports `stranded: []`:

- Preserve a note, collide with an existing conflict destination, and fail the
  ledger append with `ENOSPC`; restore normal I/O and restart the adapter.
- Successfully record a stranded note, then fail the ledger read with `EACCES`.
  The listing succeeds with an empty recovery inventory and only a log message.
- Reconstruct the persisted state immediately after the first preservation
  rename, before either the normal continuation or its catch block runs. There
  is no ledger record, and the fresh listing shows neither the note nor recovery.

**Fix and acceptance:** provide discovery independent of successful after-the-fact
bookkeeping, for example a recovery-directory scan or durable intent established
before hiding the note. Propagate an unknown recovery state when inventory cannot
be established; logging an error and returning an empty inventory is insufficient.
Test both discovery and user-visible state after restart and I/O recovery.

### RR3 — Plugin ledger compaction can destroy the only recovery inventory

- [x] **P1 · Plugin recovery durability · Reproduced with a short write.**

[`ObsidianDisplacedFiles.rewrite`](client/src/plugin/vault.ts#L1648) replaces the
ledger through an in-place `adapter.write`. A failed compaction can truncate it,
although the [catch comment](client/src/core/displaced.ts#L136) assumes the old
records remain. The next parse skips the damaged content, and the plugin has no
fallback discovery for the files those records named.

**Observed:** record one live hidden note and 32 resolved records. Let compaction
write eight bytes and then throw `ENOSPC`, using the existing adapter fault
mechanism. The current listing still holds the live record in memory. After
restoring normal I/O and constructing a fresh adapter, the ledger contains only
`{"at":".`, `stranded` is empty, and the hidden note bytes still exist.

**Fix and acceptance:** use recoverable staged replacement for this inventory, or
defer compaction. Maintain the previous valid inventory until its replacement is
durable to the supported platform's guarantees. The same objection used to reject
in-place `Vault.process()` writes applies to this recovery metadata. Add a
short-write-and-restart test, checking discovery rather than just a warning.

### RR4 — The crash driver can treat a lost version as an unreached seam

- [x] **P2 · Verification harness · Demonstrated with a private mutation.**

[`crashSweep`](client/src/stress/faults.ts#L309) decides whether the seam fired by
searching for the version token it is supposed to prove survived. If that token
is lost, it returns `fired: false` with no faults before checking preservation.
The sweep requires only one reached seam per scenario, so other reached cases
can hide this omission.

**Observed:** in the private child only, remove the tracked version after the
competitor writes at `cli/vault:replace.staged`, then retain the normal SIGKILL.
The parent reports `faults: []` and `fired: false`. The mutation was restored.

The coverage description also needs narrowing. On this macOS run, only **6 of
12 registered seams** were reached by the five scenarios. None of the three
lock seams were reached, nor `respell.beforeGivingBack`, `trash`, or
`trash.afterCompare`. The sweep drives `NodeVault`, not the plugin or server,
and contains no general assertion about active lock owners or rendered clean
status. These are limits of this new sweep, not claims that the entire existing
test suite lacks coverage of those areas.

**Fix and acceptance:** establish seam reachability independently of the bytes
being checked, using a separate handshake or the expected child termination
protocol. A killed run that loses its token must fail. Maintain an explicit
expected-reachability matrix, and include lock and plugin scenarios before
claiming those invariants. A seam registry improves reuse but does not enumerate
all operation boundaries or all schedules by itself.

### Assessment of the design decisions

Keep the simpler acquisition path and shared recovery model. Rejecting
`Vault.process()` as a drop-in durability fix is supported by the inspected
artifact. Keeping merge is a reasonable scope decision; filename identity
normalization and physically renaming files during a scan remain separate design
questions. The immediate priority is to close RR2/RR3 for the Obsidian product,
repair RR4 so its tests can expose losses, and resolve or explicitly constrain
RR1 while the CLI remains experimental. None of these findings calls for a
wholesale rewrite.

## Readiness re-verification — 2026-09-07

Verified the RR1–RR4 repairs in **`c0e972d`**. The working branch advanced during
verification to **`4505318fe254e34410e8152ef6cd763774efd158`**; that subsequent
commit changes only `IMPROVEMENTS.md` and `READINESS.md`, so the application code
is the same as the tested snapshot. **The original reproductions are repaired;
two P2 follow-ups remain, RR5 and RR6 below.**

### Validation and updated status

`bash scripts/check.sh` passed **27 checks, 0 failed, 0 skipped** in an isolated
worktree: **1,449 client tests in 76 files**, **16 panel tests**, **24 stress
tests**, Go race tests/vet, formatting/type/build checks, release-shell tests,
packaged CLI checks, and local Docker checks. Systemd acceptance and the Linux
mounted-filesystem run remain CI-only on this macOS host.

| Finding | Assessment | Evidence |
|---|---|---|
| RR1: overlapping unlocks | Fixed for the reported schedule | The second unlock is refused by the recovery lock. The two-writer reproduction no longer admits two owners. |
| RR2: missing/unreadable recovery records | Original cases fixed; follow-ups RR5/RR6 remain | Failed intent append leaves the note at its visible name. A fresh plugin sees the intent after the preservation rename. Unreadable inventory is explicitly incomplete. |
| RR3: destructive plugin compaction | Fixed | The plugin no longer implements compaction; the short-write probe leaves the existing inventory intact across restart. |
| RR4: lost token classified as unreached | Fixed for the reported mutation | Deleting the tracked version in the private crash child now returns `fired: true` and a preservation fault. The coverage matrix accounts for all 12 seams, with 7 reached here and 5 explicitly outside these scenarios. |

The five prior safety probes pass with assertions adapted to the intended new
behavior: a refusal that keeps the note visible is safe, an unreadable inventory
must be incomplete, and a restart image includes the intent now written before
the rename. Two additional probes fail as described below.

Evidence is retained in `/tmp/basalt-readiness-recheck.6sonFc/check.log` and
`/tmp/basalt-readiness-probes.y253cc/`: `probes.log`, `driver-probe.log`, and
`client/src/readiness-review-probes.test.ts` / `readiness-driver-probe.ts`.
Private mutations were restored. Application code in the working repository
was not changed.

### RR5 — Sync still reports success when recovery is unknown

- [x] **P2 · CLI outcome consistency · Reproduced against a real local server.**

[`cmdSync`](client/src/cli/cli.ts#L1209) passes `unknownRecovery` to the renderer
but still returns `exitCodeFor(report)`. The
[JSON renderer](client/src/cli/cli.ts#L2153) also derives `ok` and `outcome` only
from the sync report. Neither success decision incorporates the recovery
inventory. `status` now correctly incorporates it, so the commands disagree.

**Observed:** initialize an empty vault against a reachable test server, write a
torn record to `.basalt/displaced.log`, and run both commands. `sync --json`
returns exit **0**, `ok: true`, and `outcome: { kind: "synced" }` alongside a
non-null `recoveryUnknown` explaining that the log cannot be parsed.
`status --json` on the same vault returns exit **1**, `ok: false`, and
`recoveryComplete: false`. Network/authentication failure is not involved.

The warning is present; the defect is the success signal delivered to automation.
`rebase` uses the same separation between warning rendering and return status.

**Fix and acceptance:** include recovery completeness in the shared overall
outcome used for JSON, text, and exit status. Preserve the distinction between
successful data transfer and unresolved recovery, but do not advertise an
unqualified successful overall result. Test `sync` and `status` against a
reachable server with incomplete recovery inventory and assert their success
flags and exit codes agree on that condition.

### RR6 — A torn ledger tail absorbs the next recovery intent

- [x] **P2 · Plugin recovery after interrupted I/O · Reproduced through the plugin adapter.**

[`DisplacedLedger.record`](client/src/core/displaced.ts#L131) appends a JSON
record followed by a newline without separating it from an existing torn tail.
A later append can therefore return success even though its record is joined to
an unfinished JSON fragment and cannot be parsed. The plugin then treats that
success as permission to hide the note.

**Observed:** inject a short first append that writes eight bytes and throws.
The new guard correctly leaves `note.md` visible. Restore normal I/O, create a
fresh plugin instance, and retry. The next intent append succeeds and the note
is moved into its hidden folder. Reconstruct the persisted state immediately
after that rename, including the entire ledger. The log begins with the prior
fragment immediately followed by the new JSON object, on one malformed line.
The fresh plugin reports `waiting: []`; the retained note bytes remain readable
at the hidden path, but that path is not in its recovery inventory.

The new incomplete-inventory warning works: this case is no longer silently
reported as a complete inventory. It still fails the promise that the intent
successfully recorded before hiding the note will let a restarted plugin locate
that note. The subsequent catch-path record cannot repair a process interrupted
before that catch runs.

**Fix and acceptance:** make append framing recover safely from a torn previous
record, or refuse to hide a note until the new intent is independently readable.
Preserve unresolved evidence from the earlier failure. After a short append,
restored I/O, retry, and interruption after the preservation rename, the new
hidden path must appear in the recovery inventory even if the older damaged
record still makes the inventory incomplete.

### Verification limits

Plugin fault probes use the repository's `FakeAdapter` with the actual
`ObsidianVault`; the restart probe reconstructs persisted adapter state rather
than killing a real Obsidian process. Real desktop/mobile acceptance, physical
power cuts, and CI-only filesystem checks were not independently exercised.
I25/I26 are explicitly deferred improvements, not newly discovered blockers in
this verification.
