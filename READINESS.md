# Readiness work

From [PRODUCT_READINESS.md](PRODUCT_READINESS.md), reviewed 2026-09-07 against
commit `01ae785`. That document proposes five changes; this is what we are
actually doing about each, including the two we are not doing and why.

The three earlier trackers ([TODO.md](TODO.md), [IMPROVEMENTS.md](IMPROVEMENTS.md),
[FOLLOW_UP_REVIEW.md](FOLLOW_UP_REVIEW.md)) are closed: 28, 24 and 54 items, all
ticked. Nothing here is a leftover from them.

## What the findings actually said

Where the 51 verification findings landed, which is the evidence for doing this
rather than starting again:

| Area                                | Findings |
| ----------------------------------- | -------- |
| Preservation / replacement contract | ~10      |
| Server store, verify, limits        | ~10      |
| Release plumbing                    | ~7       |
| Status and reporting                | ~5       |
| CLI lock                            | 4        |

The lock cost more effort than everything else together and is 416 lines with
one caller and no plugin caller. It is a leaf, not a foundation. The rest of
the tree is not being rewritten.

## Order

Harness first, because the recurring failure was not "this ordering is wrong",
it was "fixing one ordering and testing that ordering left another ordering
broken". Building the thing that finds orderings before fixing more of them is
the only step that changes the discovery rate rather than the count.

## A. A fault-injection harness

- [x] **A1** Collect every seam behind one registry so a driver can enumerate
      them instead of each test naming one by hand. Today: `midPublish`,
      `midEvict` (lock), `midRespell.pause` / `.parked` / `.beforeGivingBack`,
      `midTrash.pause` / `.afterCompare`, `midPreserve.beforeClaim`,
      `MemoryVault.midReplace`.
- [x] **A2** A driver that runs one scenario against every seam in turn,
      firing a competing action at each, over the real CLI adapter on a real
      directory rather than a mock.
- [x] **A3** Invariants checked after every permutation, not per-scenario
      assertions: every version that existed is at its name, at a reported
      path, or on the server; never two lock owners; status never reports
      clean while something is stranded.
- [x] **A4** Restart in the middle: the process is killed at a seam and the
      invariants are checked against what a fresh start can see.
- [x] **A5** Wire it into `bun run stress` and `scripts/check.sh`, so it is a
      gate rather than something to remember.

**What it found on its first run**, before a line of it was aimed at anything:

- `replace`, the widest destructive window in the client, had no seam in it at
  all. Every seam this file had was placed by the test for one earlier defect,
  and none of them was in the ordinary path, so a sweep of "every ordering"
  reached none of them. Two seams added: `replace.staged` and
  `replace.nameFree`.
- `retireName` is unreachable through `list` on macOS, and a `link` to the
  other Unicode spelling fails EEXIST there because it is the same name. Both
  established by the driver rather than assumed, and both are why that scenario
  drives the function directly with two ordinary names.
- The reporting half of the invariant was not exercised by any scenario, which
  a mutation showed: blanking `stranded` failed nothing. That is what the
  "a displaced version has nowhere to go" scenario is for.

Both halves are mutation-proven: `link` to `rename` in `replace` is caught at
`replace.nameFree`, a parked name made disposable is caught at three seams, and
a child that cannot start fails rather than passing quietly.

## B. Replace the lock

The doc points at `server/internal/dirlock`, which uses `syscall.Flock`. That
is not available here: Node has no flock binding, the packed CLI runs under
stock node, and the plugin cannot load a native addon at all. So we take the
doc's stated fallback.

- [x] **B1** Delete the generational claim protocol: `lock.<n>`, `liveOwner`,
      `highestGeneration`, `sweepSuperseded`, the fence, both retry loops.
- [x] **B2** One `lock` file, created with an exclusive `link`, holding the
      complete holder record. No automatic stale takeover in any case.
- [x] **B3** Refusal names the holder and says what to do, distinguishing a
      holder that is running from one that is not.
- [x] **B4** `basalt unlock`: reports the holder, refuses to break a lock a
      live local process holds, breaks a dead one, `--force` for a holder on
      another host that cannot be checked.
- [x] **B5** Compatibility, confirmed against the shipped artefact rather than
      inferred: `npm pack basalt-sync@0.4.2` and reading `dist/basalt.mjs`
      shows the published build uses the plain `lock` file with this holder
      shape and none of the generational names. The generational protocol
      never left this machine, so there is nothing to be compatible with.
- [x] **B6** Regression tests, each mutation-tested: revert the fix, watch it
      fail, restore.

**What the mutation testing found.** Three of four mutations were caught at
once. The fourth, `link` to `rename` in the put-back, was not, and tracing why
found a hole `unlock` had opened by itself: taking a *live* holder's lock aside
to decide about it leaves the vault looking free, so a `basalt sync` starting
in that instant takes it beside the holder. Two writers, caused by the command
whose whole job is to prevent them. Fixed by reading first and refusing without
touching anything, so every ordinary refusal has no window at all; only a lock
already read as abandoned is moved. The residual race, where the lock changes
between the read and the rename and a third process acquires in between, is
reported as `contested` rather than hidden.

## C. Make displaced versions durable and discoverable

`stranded` is rediscovered by scanning. The bytes survive a restart but the
knowledge does not: nothing records which note a parked file came from, or
why. The plugin can strand a version (`removeExpecting`, the hidden-folder
path) and does not implement `stranded` at all, so the Obsidian product, which
is the actual product, reports nothing.

- [x] **C1** A displaced-version ledger in core over a small shell-supplied
      file interface, in the shape of `JournalFiles`: everything hard above it,
      one implementation for both shells.
- [x] **C2** Records written when a version is displaced and cleared when it is
      resolved, carrying the note it came from and the reason.
- [x] **C3** The CLI adapter writes and reads it; the scan reconciles the
      ledger against the disk rather than replacing it.
- [x] **C4** The plugin adapter implements `stranded` from the same records.
- [x] **C5** `status`, the sync report and the plugin panel all read the ledger,
      so there is one answer to "what is waiting".
- [x] **C6** Tests, including across a restart.

**What it found.** The plugin could strand a version and reported nothing at
all: `removeExpecting` leaves one in a hidden folder Obsidian does not list,
and `stranded` was never implemented there, so the actual product answered a
question the headless client answered. Typing the panel-shot table, which was
`unknown`, also found two shots drawn from a state the plugin cannot be in
(`offline.refused` is a boolean and they passed `0` and `1`). Three mutations,
all caught.

## D. Vault.process()

The plugin's safety currently rests on rename behaviour read out of
`obsidian-1.13.7.asar` rather than a documented contract.

- [x] **D1** Establish from the shipped artifact what `Vault.process()`
      guarantees. Verify against the artifact; where it cannot answer, say so.
- [x] **D2** Use it for text replacement if it is a real read-modify-write, or
      record why not.
- [x] **D3** Record the finding in `docs/plugin.md` either way.

**The answer is no, and the artefact is why.** Both shipped adapters implement
`process` as read, call, and write back **in place** with no temporary and no
rename. The "atomically" in the declaration means "serialised on Obsidian's own
operation queue", which is one in-process promise chain, not a filesystem
guarantee. Adopting it would trade a crash-safe staged write for a truncatable
one, it is strings only so attachments are out, it covers replacement and none
of the deletion or conflict-copy paths, and the desktop queue races each
operation against a timeout so a rejection does not establish that the write
did not land. Written up in `docs/plugin.md`.

## E. Narrow the supported environment

- [ ] **E1** Say which platforms are tested, and that iOS is not.
- [ ] **E2** Exclude overlapping sync tools, nested mounts and network
      filesystems, in writing.
- [ ] **E3** One Basalt writer per local vault, stated as a rule rather than
      implied by the lock.
- [ ] **E4** Mark the CLI experimental, given where the lock stands.

## F. Purge and capacity

Mostly already true; this is verification, not construction.

- [ ] **F1** Confirm purge is manual only: `-confirm`, `-backup` or
      `-no-backup-check`, exclusive dirlock. Nothing automatic.
- [ ] **F2** Confirm storage usage is exposed and that a full store refuses
      with `nospace` rather than failing some other way.
- [ ] **F3** Record both, so the next reader does not have to rediscover it.

## Not doing

**Deferring merge.** Merge appears in exactly one finding title (R19), and that
finding was about the preservation contract rather than merge logic. Removing a
headline feature that is not producing failures buys no safety and costs the
product.

**Deferring filename normalisation.** It exists because NFC/NFD divergence
loses notes across devices. R07 was about it being destructive, and it is not
any more. Reverting to "report collisions" reintroduces a known loss in order
to avoid a fixed one.

**Rewriting on a fresh `main`.** See the table above.

**Simplifying release-alias reconciliation.** Agreed in principle, but it is
now covered by `scripts/release-promote.test.sh` and
`scripts/release-order.test.sh` and costs nothing to keep. Low stakes either
way; not worth the churn.
