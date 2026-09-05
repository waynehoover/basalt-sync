# Fixes from the client, CLI, and server review

Reviewed **2026-09-05**, commit **8f95bfe56e11c8d458ecad5c6b26e599e9031f47**. Scope: shared TypeScript sync/crypto/protocol code, Node CLI and filesystem adapter, Obsidian plugin, Go server and storage, administrative commands, tests, and build/release configuration.

This backlog prioritizes the POC's existing promises: preserve notes, make acknowledgements durable, keep recovery possible, and report failures accurately. [IMPROVEMENTS.md](IMPROVEMENTS.md) covers architectural improvements, operational work, and optional enhancements. Application code was not changed during this review.

- **P1:** fix before relying on Basalt as the only synchronized copy of important notes. Includes security defects in the documented untrusted-server model.
- **P2:** correctness, lifecycle, portability, and resilience fixes to complete during POC stabilization.
- **Reproduced:** a controlled experiment demonstrated the current behavior. **Inspection:** the finding follows from the cited execution path; the proposed failure scenario was not executed end to end.

There are **28 fix items: 13 P1 and 15 P2**. Twenty were reproduced. Each checkbox remains open; reproducing a bug does not fix it.

## Suggested implementation order

| Order | Work                  | Reason                                                                                  |
| ----- | --------------------- | --------------------------------------------------------------------------------------- |
| 1     | F01–F09, F12–F13      | Protect local edits, recovery keys, persistence, backup history, and exclusive writers. |
| 2     | F10–F11, F17–F20, F28 | Close protocol integrity and resource-boundary gaps.                                    |
| 3     | F14–F16, F21–F27      | Repair state handling, lifecycle behavior, recovery UI, and CLI reporting.              |

## P1: data, recovery, and integrity

### F01 — Recheck local content before applying an incoming change

- [x] Make download, merge, and deletion landing conditional on the local version used to make the sync decision.

**Evidence — reproduced.** [Engine.reconcile](client/src/core/engine.ts#L1274) decides from an earlier scan; [land](client/src/core/engine.ts#L2323) overwrites after awaiting the fetch. The same pattern appears in [merge](client/src/core/engine.ts#L2557), [landFromLocal](client/src/core/engine.ts#L2307), and [applyDeletes](client/src/core/engine.ts#L2175).

A fake server delivered version 2 while a user edit was injected during its fetch. The final vault contained only version 2: zero uploads, zero conflict copies, and the unsent edit disappeared. Serializing engine passes does not serialize the user's editor.

**Done when:** intervening edits, replacements, and deletions are detected before destructive landing; the engine recomputes or preserves both versions. Add deterministic races for download, merge, local chunk reuse, and queued deletion. A final stat alone is insufficient for edits preserving size/timestamps or another change between check and write; define an adapter operation or preservation strategy that closes that gap.

### F02 — Preserve the initial recovery key until the user can retain it

- [x] Separate creating/registering the first device from retiring the only durable copy of its recovery key.

**Evidence — reproduced for the plugin; CLI crash window identified by inspection.** [registerAsDevice](client/src/core/client.ts#L1263) replaces the root-bearing config with the device credential, then proves that the device connects. [Plugin.pairFirst](client/src/plugin/main.ts#L902) only returns the recovery key after this succeeds. Its catch path omits the key when the disk already holds a device credential. The panel receives the key only on successful completion. [CLI init](client/src/cli/cli.ts#L317) also prints the key after registration.

Failing the device proof after saving credentials left the plugin with a working device credential but no saved or returned recovery key. A crash between replacement and display has the same consequence. Sync may continue, masking the loss of the ability to recover or administer the vault later.

**Done when:** first pairing cannot erase the sole root copy before a recoverable handoff. Test failure/crash boundaries before and after claim, registration, config replacement, proof, and key display. Preserve the design that normal device configs do not retain the root indefinitely.

### F03 — Make recovery-key rotation recoverable across an uncertain outcome

- [ ] Give rotation a prepare/commit/recovery flow that preserves the candidate key before the server can commit.

**Evidence — reproduced for CLI JSON mode; plugin crash window identified by inspection.** [cmdRotate](client/src/cli/cli.ts#L990) only emits the candidate before rotation in text mode. If rotation commits, its reply is lost, and the follow-up probe cannot connect, JSON output contains an error telling the user to keep both keys but never supplies the new one. The candidate is not saved. [Plugin.rotate](client/src/plugin/main.ts#L1322) also keeps the candidate only in memory until the operation returns.

**Done when:** committed, rejected, and unknown outcomes all leave the candidate available through an explicit secure handoff or a recoverable pending operation. Test CLI text/JSON, plugin reload/process termination, lost replies, failed probes, and concurrent rotation. Avoid placing recovery keys in ordinary logs or restoring permanent root storage to all devices.

### F04 — Require an independent, verified backup before purge

- [ ] Replace UID-only backup coverage with verification that the history being removed exists in an independent usable backup.

**Evidence — reproduced.** [backupCovers](server/cmd/basaltd/main.go#L1063) checks for `basalt.db` and compares maximum UIDs. A temporary two-version store accepted its own directory as `-backup`, removed one version, and printed that this same “backup” held the removed history. Another vault incarnation with the same name and a sufficiently large UID, or a backup missing chunk bodies, can also satisfy the current check.

**Done when:** reject identical/overlapping/aliased source and backup paths; check vault identity and the actual retained versions/chunks needed by this purge; hold a stable backup view through verification. Test self-backup, symlink aliases, unrelated stores with matching names/UIDs, incomplete bodies, and changed backups. A maximum UID or a sidecar file alone must not authorize irreversible deletion.

### F05 — Hide newly published chunks until their publication is durable

- [ ] Make every deduplication and metadata-commit path wait for chunk durability, including chunks being written by another session.

**Evidence — reproduced.** [chunks.place](server/internal/chunks/chunks.go#L305) renames a body into its final name before [Put](server/internal/chunks/chunks.go#L265) or the batch writer flushes the directory. Its early `Has` return treats visibility as completion. `Missing`/`Size` and [AppendEntry](server/internal/store/store.go#L670) can also observe the published body during this window.

Blocking the first writer's leaf-directory fsync allowed a second `Put` of the same chunk to return success immediately. Another upload can therefore commit a version referencing a chunk whose directory entry is not yet durable. The existing concurrent-directory test covers different chunks, which does not close this same-chunk race.

**Done when:** a chunk's visible/durable state is coordinated across `Put`, batch writers, missing-chunk negotiation, and entry commit. Test two same-chunk uploads, first-writer fsync failure, delayed batch close, and restart after an acknowledged second upload. Verify the acknowledged version remains readable.

### F06 — Lock and validate the backup destination

- [ ] Prevent backup from replacing an active store or colliding with another backup into the same destination.

**Evidence — reproduced.** [cmdBackup](server/cmd/basaltd/main.go#L1096) locks the source; [Store.Backup](server/internal/store/backup.go#L350) does not acquire destination locks. It uses a fixed `.basalt.db.snapshot`, removes that name, and eventually replaces the destination database. The source/destination overlap guard exists, but does not protect a distinct destination in use by another server.

A probe held the destination's server and data locks; backup nevertheless succeeded and replaced that directory's different vault database. Concurrent backups can also remove or replace each other's staging file.

**Done when:** hold destination exclusion compatible with serving, purge, and other backups; establish backup ownership/identity; refuse unrelated live stores; use operation-specific staging. Test concurrent backups, an active destination, and interrupted replacement with an existing WAL. Preserve the last usable backup on failure.

### F07 — Make CLI lock acquisition and stale-lock recovery atomic

- [ ] Replace the create/write/read/unlink protocol with an ownership scheme that cannot steal a live lock.

**Evidence — reproduced.** [lockVault](client/src/cli/lock.ts#L42) creates an empty file with `wx`, then writes its holder. A competitor treats the temporarily empty file as corrupt and deletes it. Holding that initial empty file open allowed a second caller to acquire the lock. Stale-holder inspection followed by unconditional unlink has a similar replacement race; release compares PID/host without a unique acquisition token.

**Done when:** two processes never both enter the protected section, including during initialization, stale takeover, and release/reacquire. Test paused initialization and multiple simultaneous stale-lock contenders. Preserve clear owner diagnostics and consider the documented filesystem/platform support when selecting a lock primitive.

### F08 — Keep inspection and device administration from starting sync writes

- [ ] Add an explicit connection mode that receives/query-validates server state without scheduling filesystem synchronization; use it for CLI inspection and administration.

**Evidence — reproduced at the shared Client boundary.** [CLI dispatch](client/src/cli/cli.ts#L159) omits the vault lock for `history`, `deleted`, device-list/administration operations, and `status`. These paths can construct the normal [Client](client/src/core/client.ts#L123), whose batch handler schedules [soon → sync](client/src/core/client.ts#L380). `waitForBacklog: false` changes waiting, not this behavior.

A client that only connected received a batch, downloaded a note, and saved its index without an explicit sync request. Slow history/device requests leave enough time for the same work inside an unlocked command. This can run concurrently with `sync --watch`, change notes during inspection, and conflict with index writes.

**Done when:** inspection/administration does not write notes or the sync index, including during a long backlog or slow query. Run these commands while watch holds the lock and verify no writes/uploads occur. Any command intentionally synchronizing must acquire the same writer exclusion.

### F09 — Repair a damaged journal tail before appending new state

- [ ] Force a safe snapshot/replacement, or truncate to the verified prefix, after partial journal replay.

**Evidence — reproduced.** [JournalIndexStore.load](client/src/core/index-journal-store.ts#L274) logs a stopped replay, then calls `settle` without retaining `mustSnapshot`. [save](client/src/core/index-journal-store.ts#L300) can append after the bad record. Every subsequent restart stops at that same record, hiding later acknowledged saves.

The probe saved cursors 1 and 2, appended a malformed tail, reopened successfully at 2, saved 3 successfully, and reopened at 2 again.

**Done when:** the first changed save after a torn, corrupt, or out-of-sequence tail produces a replayable state. Test repeated restarts and a crash while repairing the tail on both filesystem adapters. A successful save of cursor 3 must reload cursor 3.

### F10 — Bind recovery history to the requested path and page

- [ ] Validate history response identity, entry paths, UID bounds/order, and pagination progress before presenting or restoring versions.

**Evidence — reproduced.** [Transport.history](client/src/core/transport.ts#L1514) checks entry shape, but not the response/entry path against the request. [Client.history](client/src/core/client.ts#L430) verifies each entry's MAC and then relabels it with the caller's requested plaintext path. A valid signed entry from `other.md` was returned as a version of `requested.md`. Matching its signed chunk list later does not repair this path substitution.

[findVersion](client/src/core/client.ts#L569) also advances from the last returned UID without enforcing strictly decreasing page progress, allowing a repeated full page to loop indefinitely.

**Done when:** cross-path replies and entries are refused before exposure or write; pages respect `before`, ordering, uniqueness, and progress. Exercise a valid MAC on the wrong path, a wrong echoed path, duplicate/repeated pages, and a server that substitutes another requested UID. Preserve normal restore-as-a-copy behavior after authenticating the original path.

### F11 — Detect replay of signed old versions, and correct the threat-model claim

- [ ] Design authenticated version freshness/ancestry and state the current limitation accurately until it is implemented.

**Evidence — reproduced.** [EntryFacts/canonical](client/src/core/crypto.ts#L809) authenticate content metadata and parent, but not the server-assigned UID. [Engine.acceptBatch](client/src/core/engine.ts#L910) accepts a valid old entry with a new UID without establishing that it is a new authorized version. Replaying signed version 1 as UID 3 after version 2 reverted a synchronized note to its old contents.

The server does not need to forge a MAC. This exceeds the withholding-only limitation described in [the design](docs/design.md#what-the-server-can-and-cannot-do), and qualifies the integrity promise in [README](README.md#security).

**Done when:** define the supported protection against replay, rollback, and forks; add adversarial tests for old files, old tombstones, restart, and a newly paired device. Consider authenticated writer sequencing/ancestry and retained checkpoints. Simply signing a server-assigned UID is not a complete design, and local duplicate detection alone cannot protect a fresh device.

### F12 — Do not overwrite a file created during filename normalization

- [ ] Give normalization and case correction a no-clobber destination operation.

**Evidence — reproduced with an injected enumeration/rename interleaving.** [NodeVault.list](client/src/cli/vault.ts#L650) uses a directory listing to decide the normalized target is free, then [normalizeName](client/src/cli/vault.ts#L480) uses replacing `rename`. A new destination created after enumeration was overwritten by the old file. [matchCase](client/src/cli/vault.ts#L791) needs the same race audit.

**Done when:** a destination created after enumeration survives unchanged and the ambiguity is surfaced. Test case-sensitive and case-insensitive filesystems, Unicode normalization, files/folders, and competing editor creates. Do not turn an adapter scan into a destructive rename on stale evidence.

### F13 — Flush a cross-filesystem trash copy before removing its source

- [ ] Make the copy/verify/delete fallback durable, including directory trees, before deleting the original.

**Evidence — inspection.** [NodeVault.remove](client/src/cli/vault.ts#L829) falls back on `EXDEV` to [copyVerifiedThenRemove](client/src/cli/vault.ts#L1429). This copies and reads the result to verify it, then deletes the source without fsyncing the copied files and destination directory hierarchy. Subsequent directory-only flushes cannot establish that file contents were durable before source deletion.

**Done when:** retain the source until every copied file and required destination directory has been flushed successfully. Fault-inject copy, file-sync, directory-sync, and removal failures; rehearse interruption at each boundary. Also detect edits made to the source while copying/verifying, rather than deleting a newer source after comparing an older copy.

## P2: stabilization and truthful behavior

### F14 — Store arbitrary filenames without object-prototype semantics

- [ ] Use null-prototype dictionaries or safe own-property construction throughout index serialization and journal deltas.

**Evidence — reproduced.** [Engine.save](client/src/core/engine.ts#L2757) assigns filename keys into `{}`. A valid top-level `__proto__` file downloaded successfully and advanced the cursor, but disappeared from both saved maps. [Journal delta construction/replay](client/src/core/index-journal.ts) uses ordinary object assignment too.

**Done when:** `__proto__`, `constructor`, and `toString` round-trip through snapshots, deltas, compaction, restart, rename, and deletion. Assert own keys and restored sync behavior, not just serialized cursor values.

### F15 — Report a restored file as sent only after its upload succeeds

- [ ] Inspect the restore's synchronization result and report the restored path's actual outcome.

**Evidence — reproduced using the Obsidian stub.** [restoreAndSend](client/src/plugin/main.ts#L1004) ignores the returned `SyncReport`. `settle` can resolve with retrying/skipped work; the function still returns `sent: true`. A stubbed retrying upload produced that exact result.

**Done when:** a restored local copy remains distinguishable from a server-acknowledged version. Test transient upload failures, permanent skips, blocked paths, disconnection, and unrelated failures elsewhere in the vault. Avoid marking this path unsent solely because another path failed.

### F16 — Surface background sync failures and later watch reports

- [ ] Provide a structured background-error callback and consume per-pass reports in both user-facing clients.

**Evidence — inspection.** [Client.sync](client/src/core/client.ts#L396) catches exceptions, logs only when an optional logger exists, and returns `undefined`. Automatic arrival/periodic callers do not turn that into a user-visible failure. [CLI clientOptions](client/src/cli/cli.ts#L1574) does not supply `onPass`; watch's initial settle report therefore does not provide ongoing per-path failure reporting.

**Done when:** a file/index failure after a successful connection changes the visible status, appears in normal CLI/watch output and JSON events, and can recover after a later successful pass. Distinguish connection errors, whole-pass failures, retrying files, and permanently skipped files without repeated notification spam.

### F17 — Reject malformed JSON frame shapes inside the transport boundary

- [ ] Validate that parsed frames are objects and consistently convert malformed fields to protocol failures.

**Evidence — reproduced.** [Transport.onFrame](client/src/core/transport.ts#L679) catches JSON syntax errors, but passes valid JSON `null` to `onTextFrame` outside that catch. The probe threw a `TypeError` out of the socket callback and left the socket open. Arrays/scalars and several notification fields also lack complete schema validation.

**Done when:** null/scalar/array frames, invalid discriminators, unsafe/fractional cursors, and malformed batch metadata close/reject cleanly without uncaught callbacks or cursor advancement. Reuse the existing request validation conventions; history already checks safe integer entry UIDs, so do not remove that protection.

### F18 — Handle chunk-hash rejection immediately during a multi-body fetch

- [ ] Attach failure handling as each hash check starts, and abort a corrupt fetch without waiting for all later bodies.

**Evidence — reproduced.** [Transport.fetch](client/src/core/transport.ts#L1629) collects promises that can reject, but only observes them with `Promise.all` after receiving every body. A corrupt first body followed by a delayed second body emitted `unhandledRejection` before the eventual normal fetch rejection. This can terminate runtimes configured to treat unhandled rejections as fatal.

**Done when:** corrupt early/middle bodies immediately reject the operation and close the connection as appropriate, without unhandled rejections, leaked waiters, or waiting for an attacker to finish sending. Test delayed and never-delivered remaining bodies.

### F19 — Apply the served-vault restriction to every authentication route

- [ ] Enforce the configured vault before registrar, device, or invite authentication.

**Evidence — reproduced for device authentication.** [DerivedAuth](server/internal/server/server.go#L683) checks the allowed vault; [helloAsDevice](server/internal/server/session.go#L900) and [helloAsInvite](server/internal/server/session.go#L1073) bypass it and query the supplied vault directly. A device connected to a different existing vault while the configured authenticator served only `served-vault`. The CLI describes `-vault` as the one served vault and startup calls other vaults “not served.”

**Done when:** valid credentials/invites for an unserved vault are refused without consuming the invite. Test a store containing two vaults across a `-vault` configuration change. This is a scope-enforcement defect; it does not permit access without the other vault's credentials.

### F20 — Validate MAC/parent shape on folders and tombstones too

- [ ] Move common authenticated metadata validation before the no-body early return, and extend store verification to catch already-persisted malformed rows.

**Evidence — reproduced.** [Entry.Validate](server/internal/store/store.go#L583) returns for folders/deletions before checking `Mac` and `Parent`. Both kinds accepted an empty MAC and malformed parent. [verifyEntries](server/internal/store/store.go#L1816) checks body/chunk-count consistency but does not detect this shape error. A buggy authenticated writer can persist an entry that honest clients refuse to apply.

**Done when:** every entry kind passes the same applicable structural checks before commit; rejected entries consume no UID. Verification identifies existing malformed rows with vault/UID and recovery guidance. The server should validate shape without pretending it can verify a MAC whose key it does not hold.

### F21 — Add real pagination for deleted notes

- [ ] Add a stable deletion-page cursor through store, protocol, shared client, CLI, and plugin.

**Evidence — inspection.** [Store.Deleted](server/internal/store/store.go#L905) caps results at `DeletedMax` (1,000) and has no page cursor. [Plugin “Show older”](client/src/plugin/main.ts#L2592) doubles the returned count; at 1,000 it repeatedly requests the same capped set. [CLI guidance](client/src/cli/cli.ts#L1373) says increasing `--limit` reveals older entries, which stops being true at that cap.

**Done when:** recover/list more than 1,000 deleted paths with stable ordering and no repeats, including changes arriving during pagination. Keep per-page limits. Distinguish exhausted history from truncated results and purged content.

### F22 — Remove the plugin's journal before its snapshot

- [ ] Make plugin index reset/unlink interruption-safe and align it with the CLI's removal order.

**Evidence — inspection.** [ObsidianIndexStore.remove](client/src/plugin/vault.ts#L1105) iterates [live snapshot, temporary snapshot, journal](client/src/plugin/vault.ts#L1136). Failure after deleting the live snapshot leaves an orphan journal, which the journal loader refuses. [CLI removeIndex](client/src/cli/config.ts#L119) already deletes the journal first for this reason.

**Done when:** interruption after each removal leaves a loadable previous snapshot or a clean empty index, and retry completes safely. Test both thrown adapter failures and silent no-op removals without deleting note files.

### F23 — Prevent pairing/admin completion from reviving an unloaded plugin

- [ ] Track and cancel lifecycle-sensitive operations, and guard their saves and restarts with the generation that began them.

**Evidence — reproduced for invite pairing.** [pairWithInvite](client/src/plugin/main.ts#L860) awaits redemption then directly saves and starts. Unlike the root registration save path, it does not use `saveDuringRun`. [onunload](client/src/plugin/main.ts#L328) retires sync clients but not that operation. Completing redemption after unload still invoked a config save and restart in the probe. First-pairing error paths and rotation also need the same lifecycle audit.

**Done when:** unload/unlink/re-pair cannot be followed by stale writes, UI updates, or a new background loop from an older operation. Preserve enough information to resolve an already-committed registration/rotation rather than silently losing its credentials. Test completion on both sides of unload, not only cancellation before network I/O.

### F24 — Validate trash and staging directories as well as note destinations

- [ ] Enforce filesystem containment/ownership for `.trash`, `.basalt`, and temporary-file directories.

**Evidence — reproduced for trash.** [NodeVault.remove](client/src/cli/vault.ts#L829) validates the source's parents, then constructs a trash destination without the same check. A pre-existing `.trash` symlink caused a note to be moved outside the vault. [staging](client/src/cli/vault.ts#L774) and [config saving](client/src/cli/config.ts#L78) likewise use internal directories without equivalent containment validation.

**Done when:** tests with linked trash/state/staging ancestors cannot move or expose note/config data outside the supported location. Define whether linked internal directories are refused or explicitly supported. Do not claim resistance to arbitrary hostile local filesystem races unless the chosen file operations provide it.

### F25 — Support exclusive creation across mounted subdirectories

- [ ] Handle `EXDEV` when publishing a new file from the root staging directory, while preserving no-overwrite semantics.

**Evidence — inspection.** [NodeVault.create](client/src/cli/vault.ts#L970) stages under `.basalt/tmp` then hard-links into the destination. Its fallback covers `EPERM`, `ENOTSUP`, and `EOPNOTSUPP`, but not `EXDEV`. Restores/conflict copies into a mounted subdirectory therefore fail even where ordinary write has a cross-device fallback.

**Done when:** create/restore/conflict-copy succeeds on a different filesystem without replacing an existing target. Test a real mount or injected `EXDEV`, racing target creation, and partial write failure. Clean up incomplete exclusively created files only when their ownership is certain.

### F26 — Preserve rebase failure exit codes in JSON mode

- [ ] Use the same report-to-exit-status policy for JSON and text rebase results.

**Evidence — inspection.** [cmdRebase](client/src/cli/cli.ts#L1128) returns zero unconditionally in its JSON branch, while the text branch calls `exitCodeFor(report)`. The same incomplete replay can consequently be a failure interactively and a success in automation.

**Done when:** retrying/skipped/blocked replay cases produce consistent exit codes in both formats and machine output clearly represents partial completion. Check other commands' `ok` fields against their exit status while defining that contract.

### F27 — Distinguish server catch-up from unsynchronized local edits in status

- [ ] Scan local changes without writing, or explicitly label local-change knowledge as stale/unexamined.

**Evidence — inspection.** [cmdStatus](client/src/cli/cli.ts#L1210) reads the persisted index and server cursor. When the cursors match and the stored pending set is empty, it prints “up to date with the server” without checking files added, edited, or removed since the last pass.

**Done when:** editing/creating/removing a note after a successful sync cannot produce an unqualified all-current status. Expose the distinction in JSON too. Coordinate with F08 so improved status remains safe to run during watch.

### F28 — Enforce receive and decompression limits before allocating work

- [ ] Bound incoming notification backlog, frame/body bytes, response entries/chunk lists, and decompressed output before retaining or expanding them.

**Evidence — inspection.** [onFrame](client/src/core/transport.ts#L679) accepts received body buffers without a byte budget; [queueNotification](client/src/core/transport.ts#L823) chains work without a backlog bound. [openChunk](client/src/core/crypto.ts#L608) calls unbounded `inflateSync` before the engine checks assembled size. Server [NextBatch](server/internal/store/store.go#L770) and history are count-bounded, but maximum chunk lists can make a permitted response much larger than the nominal queue budget.

An untrusted server can flood frames/backlogged work. Creating new valid encrypted compressed content requires a data-key holder; do not attribute that capability to a keyless server.

**Done when:** define and enforce consistent encrypted/plaintext and queue limits at both ends, abort excess work with actionable errors, and maintain reasonable memory on mobile during large legitimate catch-up. Test oversized frames, many queued batches, huge metadata lists, and an authenticated compressed payload that expands beyond its declared/configured limit.

## Validation performed

`bash scripts/check.sh` completed on macOS arm64 with **18 passed, 0 failed, 0 skipped** at the script level:

- Client unit/integration suite: **56 files, 1,221 tests passed**.
- Panel suite: **16 tests passed**. Stress suite: **10 tests passed**.
- Go formatting/vet and `go test -race ./...` passed; the restore-rehearsal tagged test passed.
- Frozen dependency install, client formatting/type checks, compression golden check, bundles, Docker build/run, Compose validation, and the script's CI-step coverage check passed.

The Linux systemd execution check skips internally on this macOS host. Plugin probes used the repository's Obsidian stub; this review did not exercise real Obsidian desktop/mobile lifecycle behavior or perform a physical power-cut test. No dependency-vulnerability database audit or remote deployment review was performed.

Twenty additional controlled probes reproduced F01–F12, F14–F15, F17–F20, F23–F24. They ran in temporary directories or a temporary copy of the Go server, leaving application code and its existing tests unchanged. Useful regression recipes:

| Area                   | Minimal scenario                                                                              | Observed result                                                |
| ---------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Engine                 | Use `engineOnFakeSocket`; edit a synced note inside the second version's fetch callback.      | Incoming contents replace the edit; no conflict copy/upload.   |
| First pairing          | Use the plugin stub; fail device proof after credentials replace the root config.             | Error has no recovery key; disk holds only device credentials. |
| Rotation               | Stub a committed rotation with lost response and an unreachable probe; run CLI with `--json`. | Error asks to keep a candidate key that is never output.       |
| Purge                  | Seed two versions in a temporary store; use that store itself as `-backup`.                   | One version removed, with a false backup assurance.            |
| Chunk durability       | Block the first same-chunk writer's leaf-directory sync; start a second writer.               | Second writer returns success before the first sync completes. |
| Backup                 | Hold normal server/data locks on a distinct destination with a different vault.               | Destination database replaced anyway.                          |
| CLI lock               | Pause after creating the lock file and before writing its holder.                             | Another acquisition deletes the live lock and succeeds.        |
| Inspection             | Connect a normal Client without calling sync; deliver a batch and wait beyond 150 ms.         | Note downloaded and index saved.                               |
| Journal                | Save 1/2, append malformed log data, reload, save 3, reload.                                  | Final cursor is 2.                                             |
| Recovery identity      | Answer history for A with an authenticated entry for B.                                       | B is presented as a version of A.                              |
| Replay                 | Apply v1/v2; send the original signed v1 with a new UID.                                      | Note reverts to v1.                                            |
| Normalization          | Create a target after directory enumeration, before normalized rename.                        | New target contents overwritten.                               |
| Index filenames        | Download a top-level `__proto__`, then inspect the saved state.                               | Cursor advances; both filename maps omit it.                   |
| Restore UI             | Resolve settle with an upload retry for the restored path.                                    | Plugin returns `sent: true`.                                   |
| Frame validation       | Deliver JSON `null` through `FakeSocket.raw`.                                                 | Uncaught callback TypeError; connection stays open.            |
| Fetch validation       | Send a corrupt first body; delay the second by 100 ms.                                        | An unhandled rejection precedes the eventual fetch error.      |
| Vault scope            | Configure DerivedAuth for A; authenticate a registered device for existing B.                 | B receives ready/caught-up.                                    |
| Entry validation       | Validate a folder/deletion with empty MAC and malformed parent.                               | Both pass.                                                     |
| Plugin lifecycle       | Pause invite redemption, unload, then complete redemption.                                    | Save and restart still run.                                    |
| Filesystem containment | Make temporary `.trash` a symlink outside the temporary vault, then remove a note.            | The note moves outside the vault.                              |

Convert these probes into focused regression tests as the fixes are implemented. Existing green tests establish the baseline; they do not cover these interleavings.
