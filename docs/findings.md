# Findings

[Back to the README](../README.md)

Every numbered finding a code comment cites. Code says `(R40)` or `(I29)` where
a decision came from a review rather than from the design, and this is where the
number resolves to a sentence. Three schemes that resolved to nothing are gone
from the code instead; the last section says which and why.

The reviews themselves are gone from the tree. They were eight files and 3,115
lines of checklists with nothing open in any of them, which is a filing cabinet
rather than a document. `git log -- FOLLOW_UP_REVIEW.md IMPROVEMENTS.md
READINESS.md TODO.md PRODUCT_READINESS.md` has all of it: the reproductions, the
acceptance criteria, the evidence and the arguments, at the commit each was
written. What is kept here is the index, because a citation in a comment should
resolve without a `git log`.

Titles are the reviewers' own words, extracted rather than paraphrased. Every
one of these is closed.

## R: the review rounds

- **R01** Incoming changes can still overwrite an intervening local edit
- **R02** Displaying recovery keys before commit is still not a recoverable handoff
- **R03** Stale CLI lock takeover can still grant ownership to two callers
- **R04** Purge still accepts an unusable backup
- **R05** Overlapping batch uploads can deadlock on chunk ownership
- **R06** Chunk visibility can still be mistaken for durability
- **R07** Filename normalization can delete a newly saved source file
- **R08** Cross-filesystem trash can delete an edit made after copy verification
- **R09** A restored file can still be reported sent when its upload failed
- **R10** Recovery-key pairing can restart an unloaded plugin
- **R11** State and staging containment is enforced inconsistently
- **R12** Status can report zero unsent work without examining local notes
- **R13** Receive limits still apply after expensive allocation, or only count objects
- **R14** The new backup identity stamp does not uniquely identify a snapshot
- **R15** Health can claim persistence is available when the database cannot write
- **R16** Release assets become public before the new validation gate runs
- **R17** Concurrent image releases can still move a stable tag backward
- **R18** Replacement cleanup can delete the only copy of a local edit
- **R19** Local reuse, merge, and plugin landing still lose intervening edits
- **R20** Recovering an abandoned eviction marker can still create two lock owners
- **R21** Staging cleanup deletes both external files and preserved note versions
- **R22** The final trash digest check still races with unlink
- **R23** The backup lock is released before purge uses its verification
- **R24** Rotation does not await the new recovery-key acknowledgement
- **R25** Status still produces false-clean or inconsistent outcomes
- **R26** A peer can raise the client's network memory limits arbitrarily
- **R27** A malformed backup digest panics during validation
- **R28** Health still reports persistence available on unwritable chunk storage
- **R29** Draft release creation does not trigger the new attestation workflow
- **R30** The image concurrency group can cancel an unpublished queued release
- **R31** The new “streamed” baseline digest buffers the entire file twice
- **R32** A failed plugin preservation rename still permits destructive overwrite
- **R33** Missing content baselines still select an unconditional overwrite
- **R34** An eviction that crosses a minute boundary can delete a new owner's lock
- **R35** The staging allowlist still deletes displaced edits after interruption
- **R36** A trash-move retry overwrites the previous attempt's preserved file
- **R37** Replacement still cannot publish an existing note across filesystems
- **R38** A canceled promotion can still strand `latest` and minor aliases
- **R39** Attestation assumes its target is private without checking
- **R40** Taking a live lock aside admits another owner
- **R41** An unpublished newer Git tag prevents promotion of a valid release
- **R42** A valid prerelease-only history makes promotion fail
- **R43** Preservation can overwrite a note at the chosen conflict path
- **R44** Reusing lock generations admits a paused contender beside a live owner
- **R45** A failed lookup of the current alias bypasses rollback protection
- **R46** Failed preservation leaves an unsent edit hidden after sync recovers
- **R47** Deep verification reports a truncated chunk list as healthy
- **R48** Read-only entry queries cannot inspect a previous-version backup
- **R49** A delayed lower claim takes ownership after a higher owner has acquired
- **R50** Text status sends recovery to an empty directory
- **R51** Matching count and maximum ordinal do not prove a valid chunk sequence

## RR: the re-verification rounds

- **RR1** Manual unlock still admits two active writers
- **RR2** Plugin discovery still depends on a ledger record that may never exist or be readable
- **RR3** Plugin ledger compaction can destroy the only recovery inventory
- **RR4** The crash driver can treat a lost version as an unreached seam
- **RR5** Sync still reports success when recovery is unknown
- **RR6** A torn ledger tail absorbs the next recovery intent
- **RR7** A read-only mirror repeatedly creates the same conflict copy
- **RR8** Restore JSON reports success while its exit status reports incomplete recovery
- **RR9** A read-only mirror never settles a successful automatic merge

## I: improvements, done or evaluated and declined

The declined ones are worth reading before anybody proposes them again:
I25 (a WebAssembly codec) and I26 (a maintained diff-match-patch fork).
`docs/compared.md` has the measurements under "Measured and refused".

- **I01** Split large modules along existing responsibilities
- **I02** Share credential-operation state machines between CLI and plugin
- **I03** Make protocol contracts executable across TypeScript and Go
- **I04** Use one failure/outcome vocabulary from core to UI and automation
- **I05** Coalesce queued passes and make waiting cancellable
- **I06** Limit filesystem scan concurrency
- **I07** Reduce CPU and allocations on unchanged or lightly changed passes
- **I08** Budget merge/diff work and keep the Obsidian UI responsive
- **I09** Reduce duplicate chunk I/O without weakening verification
- **I10** Profile SQLite queries and startup work against large histories
- **I11** Extend existing diagnostics with durable, actionable failure context
- **I12** Support secret input without shell history or process arguments
- **I13** Align custom-vault setup and command examples
- **I14** Add an explicit repair path for quarantined/missing server bodies
- **I15** Separate read-only inspection from database creation and migration
- **I16** Strengthen backup identity, retention, and restore verification
- **I17** Make operational health and shutdown limits observable
- **I18** Document filesystem and device support as an explicit matrix
- **I19** Turn the review probes into an invariant-focused failure suite
- **I20** Add representative real-runtime and filesystem coverage
- **I21** Gate published artifacts on validation of the same commit
- **I22** Pin the build environment and schedule dependency checks
- **I23** Make release channels, checksums, and version preparation consistent
- **I24** Clarify revocation, rotation, and the scope of cryptographic trust
- **I25** A codec that is one implementation everywhere and faster than fflate
- **I26** Replace the unmaintained diff-match-patch
- **I27** Recover from a crashed CLI without anybody typing a command
- **I28** Decide whether the merge diff should be coarse on purpose
- **I29** A read-only headless client
- **I30** Let a person turn merging off
- **I31** Give markup the validity gate that JSON has


## What cannot be resolved, and was not resolvable before either

The `C`, `P` and `T` schemes are not here, and no longer in the code either.
Their definitions were never committed: they came from review rounds whose
documents stayed on the reviewer's machine, so about two hundred comments cited
a number that resolved to nothing and always had. Those citations have been
removed rather than indexed, and the sentences they sat beside were already
carrying the meaning.

Two collisions found while trying to index them anyway, both of which would have
made this file confidently wrong:

- The deleted `READINESS.md` used `C1` to `C6` for a design checklist for the
  displaced-version ledger, while code used `C1` to `C6` for review findings
  about landing races, case-only renames and slow links. Same numbers, unrelated
  subjects.
- The deleted `TODO.md` had headings `## P1: data, recovery, and integrity` and
  `## P2: stabilization and truthful behavior`. Those are priority tiers, and
  they collide with the `P1` and `P2` that code cited as findings.

`C0` and `C1` still appear once in `server/cmd/basaltd/service.go`, where they
are the Unicode control-character classes and have never had anything to do with
a review.

Recorded at 9f99b6a.
