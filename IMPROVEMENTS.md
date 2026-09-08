# Improvements from the POC review

Reviewed **2026-09-05**, commit **8f95bfe56e11c8d458ecad5c6b26e599e9031f47**. The concrete defects and their regression criteria are in [TODO.md](TODO.md). This document records improvements to pursue after or alongside those fixes, without treating every possible production feature as a POC requirement.

I01 to I24 are from that review. I25 to I31 were added later, from measurements rather than from the review. **Everything here is now closed**: done, or evaluated and declined with the evidence kept. I25 (a WebAssembly codec) and I26 (a maintained diff-match-patch fork) are the two declined, and both are worth reading before anybody proposes them again. Add to this document rather than starting another list.

The current foundation is useful: one shared client engine, a small Go deployment, encrypted content-addressed chunks, metadata authentication, conservative conflict copies, explicit server limits, a journaled index, backup verification/rehearsal, and a substantial passing test suite. Preserve those properties while addressing the gaps.

## How to prioritize

| Horizon                      | Focus                                                                                                    | Suggested items           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| During fixes                 | Reuse lifecycle/protocol rules; make errors observable; turn reproduced failures into tests.             | I02–I04, I11, I19         |
| POC stabilization            | Bound work, exercise actual supported devices/filesystems, and make release/backup workflows dependable. | I05–I09, I12–I18, I20–I23 |
| When a measured need appears | Optimize serialization/storage, add deeper repair, or change cryptographic epochs.                       | I01, I07, I10, I14, I24   |
| Open, unscheduled            | Investigate when there is a reason to. None is work anybody is waiting on.                               | I25, I28                  |


“Small,” “medium,” and “large” below describe relative scope, not delivery estimates. Items are proposals, not claims of additional proven defects.

## Client architecture and shared behavior

### I01 — Split large modules along existing responsibilities

- [x] **Medium; incremental.** Extract code when touching its behavior rather than doing a broad rewrite first.

Done as the item asks, which is to say not as a rewrite. The success measure it
sets is that "a change to one credential or transfer rule has one main
implementation site and focused tests", and that is what the extractions were
for: `core/rotation.ts` is the whole of replacing a vault's secret and both
shells call it (I02), `core/outcome.ts` is the whole of what a pass came to and
four different readings became one (I04), `protocol-fixtures.json` is the whole
of what a well-formed entry is and both languages are held to it (I03), and the
repair path added since is one place in the engine, one in the transport and one
in the session (I14). Each was extracted while its behaviour was being changed,
and each is where the divergence it was hiding actually was.

The large files are still large, and that is a decision rather than an omission.
`engine.ts` is the reconciliation, and the comments in it are the incidents that
shaped each rule; a split along the seams this item suggests would move those
comments away from the code they explain, and the value of this project's tests
is that a fix without a test that failed first is not finished, which is harder
to hold across a boundary than within one. The rule stands: extract when
touching, and the next credential or transfer change is where the next
extraction comes from.

[engine.ts](client/src/core/engine.ts) combines reconciliation, hashing, transfer planning, conflict handling, recovery, retries, and persistence. [transport.ts](client/src/core/transport.ts) combines connection lifecycle, request matching, notifications, validation, transfer flow control, and administration. [plugin/main.ts](client/src/plugin/main.ts) mixes lifecycle, credentials, UI construction, and recovery. The Go [session](server/internal/server/session.go), [store](server/internal/store/store.go), and [CLI entrypoint](server/cmd/basaltd/main.go) have similar concentrations.

Useful boundaries are credential operations, protocol decoding, a sync-pass plan, conditional filesystem landing, index persistence, and UI presentation. Keep invariants and dependencies explicit, with narrow interfaces. Retain explanatory comments that justify durability/security choices; move lengthy historical narratives to design notes where they obscure the live control flow.

**Success measure:** a change to one credential or transfer rule has one main implementation site and focused tests, while CLI/plugin behavior remains aligned.

### I02 — Share credential-operation state machines between CLI and plugin

- [x] **Medium; high value during F02/F03/F23.** Model initial claim, registration, invitation redemption, rotation, and unlink as explicit stages with typed outcomes.

[core/client.ts](client/src/core/client.ts#L1005) already shares low-level registration, but [CLI](client/src/cli/cli.ts#L972) and [plugin](client/src/plugin/main.ts#L1309) independently handle persistence, uncertain outcomes, and recovery messages. That duplication is where the reviewed key-handoff and lifecycle behaviors diverge.

Return outcomes such as prepared, committed, definitely refused, and unknown, with the exact recoverable state that must be retained. Let each surface decide how to display or securely export it. Put generation/cancellation and persistence obligations into the shared contract rather than relying on every caller to remember them.

### I03 — Make protocol contracts executable across TypeScript and Go

- [x] **Medium.** Establish one documented field contract and shared valid/invalid wire fixtures.

[TypeScript transport](client/src/core/transport.ts) and [Go wire types](server/internal/wire/wire.go) represent the same protocol separately. Define required fields, canonical encodings, safe numeric ranges, reply identity, authentication coverage, per-message byte limits, and valid state transitions. Keep the deliberate policy that device clocks are not trusted for ordering.

Start with golden JSON fixtures consumed by both suites; schema generation is optional if it reduces maintenance. Include protocol-version compatibility and malformed-message cases. This supports F10/F17/F19/F20/F28 without introducing a heavyweight RPC stack.

### I04 — Use one failure/outcome vocabulary from core to UI and automation

- [x] **Medium; high value during F15/F16/F26/F27.** Define connection failure, whole-pass failure, retrying path, permanent refusal, conflict preserved, and fully synchronized as distinct outcomes.

[SyncReport](client/src/core/engine.ts), [Client.sync](client/src/core/client.ts#L396), [CLI renderReport](client/src/cli/cli.ts#L1611), and [plugin announcements](client/src/plugin/main.ts#L685) currently expose different slices of the result. Prefer structured causes/codes and path context over consumers parsing prose or treating “resolved promise” as “all work succeeded.”

Document stable CLI exit codes and JSON/JSON-lines events, including partial completion and offline state. Keep secrets and plaintext note contents out of routine diagnostics. Test that the same underlying failure produces compatible explanations in both surfaces.

## Performance and responsiveness

### I05 — Coalesce queued passes and make waiting cancellable

- [x] **Medium.** Bound queued work as well as active work.

[Client.serial](client/src/core/client.ts#L186) queues requests; multiple external triggers can enqueue redundant sync passes. [runForever](client/src/core/client.ts#L928) waits through its backoff delay without an abort signal. The engine's internal coalescing does not automatically eliminate passes already serialized above it.

Use a single pending-sync indication where equivalent triggers can be combined. Propagate an abort/lifecycle signal through reconnect waits, backlog waits, socket requests, and expensive background work. Define how administration/history requests share the connection without starvation.

**Measure:** event storms create bounded pending work, and unload/shutdown ends waiting tasks promptly even during the maximum reconnect delay.

### I06 — Limit filesystem scan concurrency

- [x] **Small to medium.** Replace whole-directory/tree `Promise.all` fan-out with a bounded work queue in [NodeVault.list](client/src/cli/vault.ts#L663).

Keep scans fast on ordinary vaults while avoiding large numbers of concurrent stats/recursive walks on large or network-backed folders. Make the bound internal initially; add a user setting only if measurements justify one. Preserve existing disappeared-file and ambiguous-name handling.

**Measured.** 2,880 files, 12 by 12 by 20, five runs, median of each:

| scan | wall clock | peak stats at once |
|---|---|---|
| unbounded, as it was | 6 ms | 280 |
| a gate on the stats | 7 ms | 64 |
| bounded recursion instead | 16 ms | 64 |

The third row is the first thing I tried and the measurement is what rejected
it. Walking subdirectories one at a time bounds the tree correctly and costs
nearly three times the wall clock, which is not worth paying when the
descriptors were never the recursion's to exhaust: a `readdir` per directory
is one handle, and the stats are what run to hundreds.

### I07 — Reduce CPU and allocations on unchanged or lightly changed passes

- [x] **Medium; measure before changing.** Track dirty paths or immutable revisions instead of repeatedly rebuilding the entire index representation.

Measured first, in [bench-pass.ts](client/bench-pass.ts), and the answer was not the one this item guessed at. Rebuilding the index representation is not what a quiet pass spends its time on: `case "nothing"` called `synced`, which stamped `synctime` with the clock, so every entry differed from the last pass by one field and the whole index was journalled every time. A settled vault of 4,000 notes appended 155 KiB per watch tick and periodically rewrote the 1.8 MiB snapshot, to record that nothing had happened. Now it writes nothing, and the pass costs 17 ms rather than 40. A dirty-path scheme was not needed and was not built: it would have meant a mutation flag at twenty sites, where one missed site loses an index update silently.

[Engine.save](client/src/core/engine.ts#L2757) packs all local/remote entries; [journal delta construction](client/src/core/index-journal-store.ts) compares full shapes. The journal reduces disk writes but does not by itself eliminate full-map traversal, serialization, and retained copies. Incoming chunk-reuse planning is another place to profile repeated vault-wide work.

Benchmark unchanged, one-note-changed, rename-heavy, and catch-up workloads at increasing vault sizes. Prefer targeted improvements with identical recovery semantics. Treat a new on-disk index format as a separate migration decision, not a prerequisite for fixing F09/F14.

### I08 — Budget merge/diff work and keep the Obsidian UI responsive

- [x] **Medium.** Add time/input/work budgets and safe fallbacks for synchronous merge, preview diff, and compression/decompression.

[bench-merge.ts](client/bench-merge.ts) on the commonest merge shape, both devices editing the same note in places spread through it: 45 ms at a thousand lines, 1.2 s at five thousand, 23 s at twenty thousand, all of it synchronous and on Obsidian's UI thread. Bounded by work rather than by time, because a clock would let two devices compute different merges from the same three texts. 23 s is now 38 ms; a note too tangled to afford keeps both versions, which is two files rather than half a minute of a frozen editor.

[merge-regions.ts](client/src/core/merge-regions.ts#L77) disables the diff timeout; [merge.ts](client/src/core/merge.ts) performs several comparisons and span cross-products; [history diff](client/src/plugin/history.ts#L374) runs on the UI path. Valid but repetitive or heavily rewritten notes can consume disproportionate CPU even below file-size ceilings.

Benchmark adversarial text shapes, not just random inputs. Where supported, move costly work into a worker; otherwise yield or stop within a budget and preserve a conflict copy. Include cancellation and output equivalence tests. F28 covers memory safety; this item covers responsive handling of valid workloads.

### I28 — Decide whether the merge diff should be coarse on purpose

- [x] **Done, and not as proposed.** The coarse diff turned out to be I08's fix rather than an oversight. The ceiling keeps both.

`merge.ts` passes `0` as `diff_main`'s fourth argument, which is an absolute
deadline and is therefore already expired: any region needing a bisect returns
a whole-block delete and insert instead of a fine-grained diff. Every other
call site in this client spells "no limit" the other way, as
`dmp.Diff_Timeout = 0`, and the same number means the opposite in the two
places. Nothing says which was meant here.

Both are deterministic, which is the property that matters most: neither
consults a clock, so two devices compute the same merge. What differs is
granularity, and granularity decides how often two edits look like they overlap.

Measured over 300 two-sided edits on 20-70 line notes:

| | clean merges | kept both | time |
|---|---|---|---|
| as it is, expired deadline | 145 | 155 | 57 ms |
| `Diff_Timeout = 0`, exact  | 196 | 104 | 77 ms |

So the current behaviour produces about a third more conflict copies for 20 ms
across 300 merges. Nothing is lost either way -- keeping both versions is the
safe direction and is what this project prefers when unsure -- but a person
reading "Conflicted copy" on a note they could have had merged is paying for it.

**What measuring it changed.** The proposal was to make the diff exact, and
that would have reverted I08. On a note with two fifths of its lines rewritten,
exact against expired is 291 ms against 1 ms at 500 lines, 6.7 s against 9 ms
at eight thousand, and **22.4 s against 21 ms at twenty thousand**, on
Obsidian's UI thread. Those are I08's own before-numbers, near enough to
identify: 45 ms, 1.2 s and 23 s at one, five and twenty thousand lines. The
`0` is that fix. Nothing said so, which is why it needed measuring rather than
reading, but it was never an oversight.

So neither answer was right and the choice is made by size. Under 8 KiB the
diff is exact, over it the deadline stays expired. The ceiling was measured
rather than picked: worst case 6.6 ms at 2 KiB, 28 ms at 10 KiB, 82 ms at
20 KiB, 248 ms at 50 KiB, and a merge runs two diffs, so 8 KiB sits near I08's
38 ms budget and covers an ordinary note of about 1,300 words.

Decided from `.length` and never from a clock, so two devices handed the same
three texts make the same choice and compute the same merge. That is what makes
this safe to do at all, and it is the property `fitsExactDiff` exists to make
testable.

Measured after: 300 two-sided edits on ordinary notes merge 196 cleanly where
they merged 145, and a twenty-thousand-line tangled note now conflicts in 42 ms
rather than taking 22 seconds.

**And markup does not get it**, which had to be found rather than reasoned out.
`.svg` is not on the `stillValid` list because it was *measured* not to produce
markup a reader refuses, and that was measured with the coarse diff. Making the
diff exact took `markup.test.ts` from zero malformed merges in 20,923 to one:
the corpus doing exactly the job it exists for, and a reminder that "measured
safe" is only safe under the conditions it was measured in. A finer diff merges
more, and merging more is only safe where a broken result would be noticed, so
markup keeps the coarse path.

Four mutations, all caught: always-coarse loses the finer merges, always-exact
blows the large-note test's timeout, a ceiling that looks at only one of the
three texts fails the decision test, and letting markup through fails both the
decision test and the fuzz corpus. The last of those matters because the
merge diffs the ancestor against each of the other two and the dear one sets
the cost.

The existing test `never returns a character merge that has lost a local
insertion` mirrored the implementation's call rather than pinning it, so it was
not evidence either way, and it now asks the same way the merge does.
`unguardedMerge` deliberately does not: it demonstrates what the library makes
of the shapes that produced those fuzz cases, all of which were found coarse.

### I31 — Give markup the validity gate that JSON has

- [x] **Done.** `core/markup.ts`, and markup merges as finely as prose.

`stillValid` is asked of `.canvas` and `.json` because a line-wise merge can
apply cleanly and leave a file Obsidian refuses to open, and only the caller
knows how to judge that. `.svg`, `.xml` and `.csv` are not on the list because
they were measured not to have that failure -- under the coarse diff, which
I28 has now made conditional.

Under an exact diff they do have it: one malformed merge in 20,923. I28's
answer was to withhold the finer diff from markup, which keeps the measured
zero and costs those files the third fewer conflict copies that prose gained.

The better answer is a gate. `wellFormedMarkup` already exists, in
`markup.test.ts`, and is the checker that corpus judges against: a hand-written
scanner with no dependency and nothing platform-specific about it. Moving it
into core, asking it of the markup extensions the way `parsesAsJson` is asked
of JSON, and then letting `fitsExactDiff` stop caring what the text looks like
would give those files both properties at once.

**Done.** `wellFormedMarkup` is in `core/markup.ts`, `markup.test.ts` imports
it from there so the corpus judges with the instrument the engine gates with,
and `fitsExactDiff` no longer cares what the text looks like.

Two things came out of doing it.

The corpus was measuring the wrong thing once the gate existed. Its runner
called `mergeText` with no `stillValid` on purpose -- its comment said "the
question is what the merge produces with nothing checking it, which is exactly
the situation `.svg` is in" -- and that premise stopped being true. It now runs
both arms: ungated is the evidence the gate is needed, gated is whether it
works. It deliberately does not assert that the gate refused something, because
only one of the three SVG writings reaches the failure and it reaches it once
in twenty thousand; a floor on that is a test a harmless change to the
generator breaks. The gate rejecting a malformed merge is asserted from one
hand-built case instead.

And the wiring was untested. Unwiring the gate from the engine passed the whole
suite, because every test that could see it went through `mergeText` directly.
The selection is now `validityGateFor`, out where a test can reach it, and that
test fails when markup is dropped from it. That is the third time this session
a guard has existed, read correctly, and been asked of nothing.

### I09 — Reduce duplicate chunk I/O without weakening verification

- [x] **Medium; measurement-driven.** Profile the server fetch path and client byte copies before changing caching.

`BenchmarkFetch` in [chunks](server/internal/chunks/fetch_bench_test.go) put a number on it: exactly twice the work, 17.9 ms and 34.7 MB of garbage for a 16 MiB fetch against 9.0 ms and 17.4 MB. The verify pass now keeps its bodies while they fit in 8 MiB and the send reuses them, which leaves the guarantee untouched (every body verified before the header) and does not trade a cost that is paid for 64 MiB held per session.

[Session fetch](server/internal/server/session.go#L1988) checks requested chunks and later reads them again to send. Client receive/decrypt/assemble paths can retain encrypted, framed, and plaintext buffers at the same time. Batching improves latency, but can multiply peak memory.

Consider verified reads with bounded retention or streaming within the protocol's existing ordering requirements. Preserve the rule that a named ciphertext body is verified, and do not replace safe re-reading with an unbounded plaintext/ciphertext cache. Record throughput, disk reads, allocations, and peak RSS on repeated attachments and poor links.

### I10 — Profile SQLite queries and startup work against large histories

- [x] **Medium; when data warrants it.** Use query plans and representative databases before adding indexes or denormalization.

`BenchmarkHistory` in [store](server/internal/store/history_bench_test.go) builds three vault shapes and times the four queries. No index was added, because none of them warranted one: history of a path is 48 to 227 us, a batch from the cursor is 0.7 ms, and the two that are slower (deletions at 2.6 to 9.8 ms, stats at 11 to 16 ms) are commands a person runs and not the sync path. What did warrant a change was the startup summary, which walked the chunk tree before the socket existed, so a device reconnecting during a restart of a large vault got connection refused for as long as the walk took.

[History/deletions](server/internal/store/store.go#L839), [chunk attachment](server/internal/store/store.go#L997), [stats](server/internal/store/store.go#L1141), and [startup reporting](server/cmd/basaltd/main.go#L570) scale with entries, chunk references, or on-disk files. Large chunk lists and unbounded history growth are different workloads from many small current notes.

Measure startup latency, deletion-page queries, backup/verify duration, and sync tail latency with large version histories. Keep health/startup status clear if an expensive scan runs before listening. Add indexes only when a demonstrated query plan benefits, accounting for append and backup costs.

### I25 — A codec that is one implementation everywhere and faster than fflate

- [x] **Declined.** Not a WebAssembly blob inside an Obsidian plugin.

Compression is the slowest step in sealing, by some way. Measured on 1 KiB text
chunks: `compress (fflate) 31 MiB/s`, `encrypt (WebCrypto) 85 MiB/s`,
`name (WebCrypto) 91 MiB/s`, so deflate is about sixty per cent of the cost and
the two crypto calls together are the rest. Chunking is not in it at 494 MiB/s.

The obvious swap is the platform codec, and it is not available. `node:zlib` is
2.3x faster than fflate on the same input **and produces different bytes**:
over 200 text samples the two agreed on zero, both emitting a raw deflate
stream that begins the same way and then chooses different matches. Chunks are
named by their sealed bytes, so a desktop on `node:zlib` and a phone on fflate
would name the same chunk differently, which is deduplication quietly ending
and every note re-uploading. `sealChunk` used to claim the two were
byte-identical; that comment is now the measurement instead.

WebAssembly is the only route that keeps one implementation on every platform,
because a `.wasm` is not a native addon and loads on Obsidian mobile, unlike
`fs-ext`, napi-rs bindings, or anything in the shape of
[simdutf](https://simdutf.github.io/simdutf/). Note that simdutf itself would
not help whatever it were compiled to: UTF-8 validation and transcoding appear
nowhere in the profile above.

**Declined, on the plugin.** The whole value of the WASM route is that it is
one implementation everywhere, which means shipping the blob inside the
Obsidian plugin as well as the CLI. That is a binary artifact in a community
plugin: larger downloads on a phone, something a directory reviewer has to take
on trust, and a supply-chain surface with no good story for how a reader of the
repository checks that the `.wasm` is the source next to it. None of that is
worth a compression speedup on a step that is already fast enough for the
vaults this syncs.

The measurement stands and is worth keeping: compression is about sixty per
cent of the cost of sealing a chunk, and `node:zlib` is 2.3x faster than fflate
and produces different bytes. If sealing throughput ever becomes somebody's
actual problem, the thing to revisit first is whether the plugin and the CLI
have to use the same codec at all -- which they do today only because chunk
names are derived from the sealed bytes.

The rest of this item is kept because it is the reasoning, not because it is a
plan:

Treat this as a protocol change, not a dependency swap. It needs a format
marker, both codecs readable during a migration, `compression-golden` extended
to cover the new one, and a measurement showing the win survives the WASM
boundary on a phone. Do not start it for the 2.3x; start it only if sealing
throughput is shown to matter to somebody.

### I27 — Recover from a crashed CLI without anybody typing a command

- [x] **Done.** Two small platform paths, one protocol above them, and the claim protocol was not revived.

`basalt unlock` exists because automatic stale-lock takeover was wrong five
times (R03, R20, R34, R40, R44/R49), and it is a conservative fallback rather
than the destination: a crashed sync wedges a cron job until a person types
something. The way out is not a better staleness protocol. It is not having
staleness, which is what an OS-managed lock gives: the kernel releases it when
the process dies, so nobody has to decide whether a holder is gone.

`docs/compared.md` used to say this had to wait for "the day Node grows a
portable file lock". Measured on 2026-09-07, that turns out not to be true.
Both supported CLI platforms already have one reachable from stock Node with no
native addon and no build step:

| Platform | Mechanism | Contention | After `SIGKILL` |
|---|---|---|---|
| macOS | `open()` with `O_EXLOCK`, the raw flag `0x20`, which Node does not name in `fs.constants` but does pass through | `EAGAIN` | the kernel releases it, verified with a killed child |
| Linux | an abstract Unix socket, a `\0`-prefixed `net.Server` path, which has no filesystem entry to go stale | `EADDRINUSE` | the kernel releases it, verified in `node:22-alpine` |

Both were probed rather than assumed, including the killed-holder case, which
is the only property that matters and the one every previous attempt failed.

What to be careful of, because this is not a drop-in:

- **Two mechanisms, not one.** That is the objection raised against native
  bindings, and it applies here too. The mitigation is that neither has a
  staleness protocol, and staleness was the whole source of the five failures;
  each path is a handful of lines with nothing to reason about.
- **`O_EXLOCK` is spelled as a number.** Node does not expose the constant, so
  the value comes from macOS's `<sys/fcntl.h>`. It needs a startup assertion
  that the flag really excludes -- open twice and expect a refusal -- and a
  refusal to run rather than a silent downgrade if it does not.
- **The abstract socket is a kernel-wide namespace, not a path.** Derive the
  name from the vault's *resolved* path so a symlinked vault collides with
  itself, and note that it is per network namespace: two containers sharing one
  volume would not exclude each other. That is already an unsupported layout.
- **Neither covers a second machine.** The current lock refuses a holder on
  another host, which no local kernel lock can do. So the lock file stays, for
  naming the holder and for the cross-host case, and the kernel lock sits in
  front of it. That hybrid is where the bugs would be, and it is the part to
  design carefully rather than the part to write quickly.
- **`unlock` does not go away.** It stays for the cross-host case and for
  clearing a lock file nothing holds. What it stops being is the thing standing
  between a crashed cron job and the next run.

**Done, and here is what it cost.** `cli/exclusion.ts` is the two mechanisms
behind one interface; `cli/lock.ts` is one protocol above them. Holding the
exclusion establishes that no other basalt on this machine is inside the vault,
so the lock file became a record rather than a claim and the staleness question
has nothing left to attach to.

Everything the item warned about was real:

- The self-test named its probe after the pid, so two acquisitions in one
  process probed the same name at once, the second concluded the filesystem
  does not lock, both fell back to the file, and two callers came back holding
  one vault. The check for the defect reintroduced the defect. Fixed with a
  random probe name and one cached answer per state folder.
- Locking the holder file itself leaves it briefly empty, because `O_CREAT`
  creates before anything is written -- a window this module had already been
  wrong in once. The kernel's file is `lock.excl` and nothing ever reads it.
- The lock's lifetime was tied to a JS object being reachable. A `FileHandle`
  is closed by a finalizer, so an exclusion whose only reference was a closure
  the caller discarded could be *collected*, dropping the lock while the holder
  still ran. Bun's own warning found it. Live exclusions are now held in a
  module-level set.
- A live local pid in a file this process holds the exclusion for is a
  contradiction, and the code refuses rather than believing either side. That
  is the backstop for an exclusion that reports success without excluding.

A code review afterwards found a fifth, of the same family as the first: the
comment said the Linux socket was named from the vault's *resolved* path and
the code used whatever string the caller passed. A symlink to a vault, and the
same path with a trailing slash, each got their own name and each admitted a
second writer. macOS was immune because a `flock` is on an inode, so this was a
fix present on one adapter and absent on the other. Two smaller things came
with it: two places releasing one exclusion, and a staging copy left behind on
a failed publish in a directory nothing sweeps.

A fourth thing came out of testing the third. The garbage-collection defect is
not reproducible by waiting, so the check forces a collection, and until it did
the guard against it was passing for no reason -- an untested guard, which is
the shape this project keeps finding. It fails now if the strong reference goes
away.

Verified rather than assumed: `scripts/kernel-lock.test.ts` spawns a holder,
kills it with `SIGKILL`, and checks the next basalt takes the vault with
nothing typed. It runs in `scripts/check.sh` on macOS and in a CI job on Linux,
because the two mechanisms are unrelated and one passing says nothing about the
other. The plugin needs none of it: Obsidian is one process per vault, and
neither mechanism exists on mobile.

What stayed manual, deliberately: a holder on another machine, which no kernel
can see, and any filesystem where the self-test fails.

#### The alternative: a tiny Rust core behind napi-rs

Considered, and it is a real option rather than a straw man. `fd-lock` or
`fs2` give `flock` and `LockFileEx` behind one API, napi-rs ships prebuilt
binaries as optional dependencies so users need no toolchain, and the result
would be **one** mechanism instead of two, with Windows included.

Not now, for reasons that are about this package rather than about Rust:

- **The two mechanisms above cost nothing.** They are stock Node, about twenty
  lines each, and both were measured working today. Replacing them with a
  native dependency is a larger change than the thing being replaced.
- **The published CLI is two files**, `dist/basalt.mjs` and `README.md`, in a
  70 KB tarball. napi-rs turns that into a family: darwin-arm64, darwin-x64,
  linux-x64-gnu, linux-arm64-gnu, and, because this project's own server image
  is Alpine, linux-x64-musl and linux-arm64-musl. Six artifacts to build, sign
  and keep in step with every release, plus the musl-versus-glibc resolution
  bug that catches everybody once.
- **"Verify against the shipped artifact" gets six times harder.** The gate
  proves the packed CLI installs and runs under node, on one machine. With
  per-triple binaries that check only means something if it runs on each
  triple, and it currently cannot.
- **It buys the plugin nothing.** Obsidian mobile cannot load a native addon,
  and the plugin needs no lock anyway.

What would change the answer:

- **Windows.** The two mechanisms above have nothing for it. If the headless
  client is ever meant to run there, a Rust core stops being the expensive
  option and becomes the only one.
- **A shared volume between containers.** `flock` is per inode and would
  exclude two containers holding one volume; an abstract socket is per network
  namespace and would not. That layout is on the unsupported list today, and
  this is the honest argument against the Linux path rather than a detail.
- **A second thing needing native code.** One native dependency amortises
  differently from none. Note that I25's codec question wants WebAssembly
  rather than a native addon, so it does not combine with this.

## User-facing behavior and operations

### I11 — Extend existing diagnostics with durable, actionable failure context

- [x] **Small to medium.** Build on the existing status/progress UI and operational guidance rather than adding a second dashboard.

Expose the last completed pass time, its unresolved paths, the last successful server acknowledgement, and whether the current local scan is fresh. Give each actionable refusal a next step: rename a collision, reduce an oversized file, repair an index, resolve lost server history, or retry a transient failure.

Make a local diagnostic export explicitly redact recovery/device credentials, note contents, and filenames by default. Keep errors available after reconnect so a transient green status does not erase the explanation for a still-unsynchronized path. Coordinate with F16/F27.

**Done.** Each refusal carries its next step, beside the codes rather than in
either shell, and nothing is invented for a code with no general answer: a
made-up next step sends somebody to do something that will not help.

Two parts of this were already true and are recorded rather than reimplemented.
A written-off path is re-reported on every pass, because `reconcile` consults
the `skipped` map and its fingerprint each time, so a green pass does not erase
the explanation for a path that is still stuck. Scan freshness is F27's
`unsent`, and per-path outstanding work is F15's `retryingPaths`.

**Not done, deliberately.** The last completed pass time and the last server
acknowledgement are not persisted. The panel already shows both from memory;
the CLI would need them written into the index, which is a stored-format change
for two timestamps that answer a question `status` already answers better by
looking at the disk. A diagnostic export does not exist to redact, and building
one to give it a redaction policy would be inventing the thing the policy is
about.

### I29 — A read-only headless client

- [x] **Done.** `--read-only`, recorded in the config so a cron line cannot lose it.

`basalt sync --read-only`: apply everything the server has, send nothing. The
vault is still written, because that is what a mirror is; what stops is this
device ever originating an upload, a deletion or a conflict copy.

It is this client declining to write rather than the server refusing it. A
read-only device holds an ordinary credential and the server would accept
anything it sent. That is the right shape for a machine you own and the wrong
shape for one you do not trust; a server-enforced read-only credential is a
separate feature and a separate threat model.

The case for it is blast radius, and it is a real one. A headless client on a
NAS exists to hold a copy. Today a bad scan on that machine -- a mount that came
up empty, a path typo, a half-restored disk -- is an ordinary local change, and
ordinary local changes propagate: the mirror can delete notes everywhere. There
is nothing wrong with the code that would do it; it would be doing its job. A
device that cannot push is a device that cannot make that mistake, and no
amount of care in the sync engine substitutes for not having the capability.

**It does not simplify the client, and an earlier version of this item claimed
it would.** The thought was that a read-only mode makes the preservation
machinery in `cli/vault.ts` unnecessary and deletes most of it. It does not:
`Engine.land` applies every download through `writePreserving`, because the
bytes still land on a local disk that a person may have edited and rule 1 still
applies. Read-only removes the *upload* path, which is not where the defects
were. The 2,900 lines stay.

The only version that would remove them is a client told that nothing else ever
writes this vault, so an incoming version can be written without moving
anything aside first. That is a promise a person cannot reliably make, and
being wrong about it loses a note, so it is not on the table.

Done, and the points it listed were settled this way. Local changes are
applied and reported rather than refused, as `heldBack`, which is out of the
exit code for the same reason `ignored` is: the device was told not to send and
did not. It is in the config as well as being a flag, written by `init`,
`pair` and pairing with an invite, and there is no flag that turns it off; a
mirror that becomes writable when a cron line loses an argument has been made
conditional rather than safe.

Two things worth recording from building it. The guard belongs at `upload()`
rather than at the `upload` action in the decision switch: that method has four
callers and the first attempt guarded one of them, so a conflict copy went up
anyway. And the config is written in *three* places -- `init`, pairing with a
recovery key, and pairing with an invite -- and the first two patches missed
the third, which is the one a mirror actually uses. The test for stickiness is
what caught it; the spread that set the field bypasses TypeScript's
excess-property check, so nothing else would have.

### I30 — Let a person turn merging off

- [x] **Done.** `--no-merge`.

Merging is the only thing this client does that produces content neither device
wrote. It is careful -- it refuses anything it cannot do safely and keeps both
versions instead -- and it has produced exactly one finding in sixty. But
somebody who does not want it has no way to say so, and
[PRODUCT_READINESS.md](PRODUCT_READINESS.md) reached for exactly this when it
suggested deferring automatic merging, with "keeping both versions is a
defensible initial experience".

The answer to that suggestion was to keep merging, because removing a feature
that is not producing failures buys no safety and costs the product. A switch
is the version of the suggestion that does not cost the product anything.

It pairs with I28. That item is stuck because making the merge diff finer
changes what merges cleanly, and two devices on different releases would then
disagree; a person who has turned merging off is not exposed to that at all.

Two devices set differently converge on content but not on shape: one merges
and uploads the merged note, the other keeps both and uploads a conflict copy.
Nothing is lost, and the vault ends up with both outcomes, which is untidy and
is said out loud in `client/README.md`. Local to the device, like `--ignore`.

Done as one flag rather than Obsidian's `--conflict-strategy merge|conflict`,
because a two-valued enum is a boolean spelled at greater length, and this
project's flags are plain words.

### I12 — Support secret input without shell history or process arguments

- [x] **Small.** Offer explicit stdin/file input for recovery and invite material in [CLI argument handling](client/src/cli/cli.ts#L1739), with documented restrictive file permissions.

Current positional-key workflows are convenient but expose secrets to command history and process inspection. Keep existing interactive convenience if appropriate, and offer a deliberate secure export destination for newly generated recovery keys. Never silently send a secret to a log stream, pager, or diagnostic export. Test JSON output and piping so errors do not accidentally discard the only generated key.

### I13 — Align custom-vault setup and command examples

- [x] **Small.** Either make the non-default vault flow complete across server, setup payload, CLI, plugin, and generated service instructions, or clearly constrain the POC UI to `default`.

The server accepts `-vault`; [plugin first pairing](client/src/plugin/main.ts#L907) hardcodes `default`, while the setup string carries address/token rather than the selected vault. [Generated service purge guidance](server/cmd/basaltd/service.go#L161) includes `-confirm` but omits the custom `-vault`. Review argument handling too: reject unsupported command flags/extra positional arguments rather than silently ignoring meaningful input.

Use executable examples for default and non-default names, including spaces where names support them. Avoid advertising a supported configuration whose onboarding path cannot express it.

### I14 — Add an explicit repair path for quarantined/missing server bodies

- [x] **Medium to large; after durability fixes.** Define how an operator can repopulate damaged server chunks from a healthy device without manufacturing arbitrary note edits.

`resend` is a put with no entry: the client names chunks, the server says which
of them it actually lacks, the bodies arrive, and no uid is allocated, no entry
is written and no authenticator is touched. `basalt repair` drives it from
whatever this device holds. The alternative, which is what the purge output used
to be waiting for, was to edit a note so reconciliation would upload it, which
writes a version nobody typed into the history of a vault that is already
damaged.

Two rules make it safe to let a device write bodies with no entry behind them: a
body is content-addressed, so the server refuses anything that is not the body
its name claims, and a name no committed entry refers to is refused outright,
because correct bytes under an unreferenced name are a paired device filling the
disk.

The honest part is what it does not claim. A body belonging to a version this
device never had is not on its disk and not in its index, so nothing here could
notice it is gone; a count of "history I could not reach" would be a number that
reads like assurance and means nothing. So repair reports what it did, and both
shells point at `basaltd verify` on the server for what remains. The test for
that case asserts exactly that: a clean run, and a server that still knows.

[Chunk integrity checks](server/internal/chunks/chunks.go) can detect/quarantine bad content, and [purge output](server/cmd/basaltd/main.go#L1009) says it is waiting for devices to resend. Ordinary reconciliation may consider an unchanged local note already synchronized and never upload its missing body.

A repair operation could inventory required chunk names, verify matching local content, and resend only recoverable bodies. Require a backup first when changing metadata, report irrecoverable history distinctly, and preserve UID/authentication semantics. Test with one corrupted current chunk, one historical-only chunk, and a healthy second device.

### I15 — Separate read-only inspection from database creation and migration

- [x] **Medium.** Add explicit create/open-existing/read-only modes and a supported schema-version check.

Nothing recorded a schema version at all, and that is the half that could lose a
note: `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
so an older basaltd opened a newer database without a word, read the columns it
happened to know and wrote rows missing the rest. `PRAGMA user_version` now
carries it, a database from the future is refused in every mode including
read-only, and the refusal names both numbers. Zero is accepted, because every
database written so far has one and refusing them would mean an upgrade that
cannot open the store it is upgrading.

`Create`, `Existing` and `ReadOnly` say what opening a store may do to it.
`verify` and `stats` take the read-only path, where SQLite refuses the write
rather than this package remembering not to make one; `backup` does not, because
`VACUUM INTO` is a write statement whatever its effect on the source, and
`purge` writes by definition. Both exceptions are written down where somebody
would otherwise 'fix' them.

[Store.OpenWithSync](server/internal/store/store.go#L509) creates directories, runs migrations, and executes schema setup. Administrative inspection and backup coverage currently use that general opening path. A diagnostic command should have a clear contract about whether it can alter the store it is inspecting.

Refuse a future incompatible schema instead of allowing an older binary to proceed on assumptions. Take consistent read snapshots for related stats/verification queries when concurrent writes matter. Test inspection on read-only backups and downgrade/future-schema refusal without modification.

### I16 — Strengthen backup identity, retention, and restore verification

- [x] **Medium; alongside F04/F06.** Bind backup metadata to a specific database generation and make retention preserve usable database-and-body sets.

The sidecar was stamped with the database's size, which survives a `cp -r` and
is why it was chosen, and which two snapshots of one store share about as often
as not: an hour's worth of notes is usually the same number of pages. So a
database republished into a backup directory left coverage that went on looking
plausible while describing a snapshot that no longer existed. SQLite's file
change counter, four bytes at offset 24 of the header, moves on every
transaction that modifies the database and is inside the file, so it survives a
copy exactly as the size does. Recorded and checked; zero means "not recorded"
rather than "zero", so every backup taken before this still reads.

The rehearsal now goes all the way. `rehearsal_test.go` executes the runbook and
proves the server serves what the backup held, and that is as far as it can get:
the server holds no key and has never seen a plaintext, so "every body came
back" is its whole vocabulary. Whether any of it decrypts to the note somebody
wrote is a question only a client can answer, and that is the gap a backup
exists to close. `client/src/restore-rehearsal.test.ts` writes notes whose
plaintext hashes are known, backs up, destroys the live directory, starts a
server on the backup, pairs a device that has never existed using the recovery
key alone, and compares every note by hash. A second case does the same from a
backup taken before a purge, and reads the history the purge would have dropped,
which is the argument for keeping one and had never been executed.

[Backup metadata](server/internal/store/backup.go) is useful operational context; file size alone does not establish that a sidecar belongs to a database. A changed database of the same size can leave plausible stale coverage information. Record/check a durable generation identifier or equivalent binding, and distinguish successful completion from a partially staged attempt.

The existing [restore rehearsal](server/cmd/basaltd/rehearsal_test.go) validates server-side rows/bodies. Add a periodic end-to-end rehearsal that starts from a retained backup, pairs a fresh TypeScript client with the recovery material, decrypts known notes/attachments, and compares plaintext hashes. Include an older backup followed by the documented rebase flow, and a backup taken after purge. Document retention of independent usable generations, not only leftover bodies.

### I17 — Make operational health and shutdown limits observable

- [x] **Small to medium.** Build on existing `health`, stats, and alert guidance with machine-readable reasons and bounded operational behavior.

`/health` wrote `ok` from a handler that touched nothing, so a full disk, a
database gone read-only and a chunk directory whose volume had unmounted all
looked exactly like a healthy server until somebody tried to save a note. It
now does one indexed read and one `statfs`, and answers 200 or 503 with one
word from a fixed vocabulary: `store-unreadable`, `disk-full`,
`chunks-unreachable`, `shutting-down`. No path, no vault name, no number, no
version, because the endpoint needs no credential and behind a tunnel the port
is on the internet; the figures are in `basaltd stats`, run on the machine.
Draining reports 503 deliberately, because the use of a health check during a
restart is to stop devices being sent to a server that is about to refuse them.

The shutdown budget is two halves of five seconds plus closing the store, and
the deadlines that can kill the process now all outlast it. `TimeoutStopSec=30`
was already in the systemd unit; compose had nothing, so Docker's ten-second
default applied, which is both halves and nothing at all for the store close.
`TestEveryStopDeadlineOutlastsTheShutdownBudget` keeps the three numbers in
step, since they live in three files in two languages and the easiest one to
change is the one in Go.

Distinguish process responsiveness from ability to persist a note, disk exhaustion, slow fsync/SQLite operations, and a failed last backup. Do not put expensive deep verification on every health probe. Record sync refusal counts, queue saturation, and storage failure counts without high-cardinality filenames or secrets.

[Server shutdown](server/internal/server/server.go) drains sessions, while service/container managers impose their own deadlines. Document the interaction, propagate cancellation into cancellable database work, and test slow/stuck operations. Preserve durable acknowledgements rather than abandoning an in-progress commit merely to make shutdown appear fast.

### I18 — Document filesystem and device support as an explicit matrix

- [x] **Small documentation work; medium validation.** State which guarantees have been exercised on macOS/Linux, case-sensitive/insensitive volumes, mounted subdirectories, network filesystems, Obsidian desktop, and mobile adapters.

The table is in [docs/server.md](docs/server.md), and it says what a machine has
actually executed rather than what is expected to work, which made one entry
embarrassing enough to fix on the spot: a dozen tests ask the disk whether it
folds case and skip when it does not, every runner was Linux, so the behaviour
F01 was about had been checked in CI exactly never. There is a macOS job now,
and it asserts the runner really does fold case before running, because a job
that silently skips the only thing it exists for is the failure it was added to
end. `scripts/check.sh` says which kind of disk it just ran on, for the same
reason.

The blanket `catch` on the directory flush after a removal is gone. A filesystem
with no directory fsync and a disk returning EIO were the same silence, and the
second one means an unlink may not survive a power cut: the config comes back,
and with it a vault that reads as paired to a server it was told to forget,
which is exactly what C38 added the flush to prevent. It is now reported rather
than thrown, because by the time it runs the pairing is already gone and only
its durability is in question.

[CLI durability helpers](client/src/cli/vault.ts), [Obsidian adapter](client/src/plugin/vault.ts), and [server fsync](server/internal/fsync/fsync.go) depend on different filesystem capabilities. Distinguish atomic visibility, readback verification, and persistence across power loss. Review blanket directory-sync error suppression in [config removal](client/src/cli/config.ts#L102): an unsupported operation and an actual I/O failure should not become the same success.

This can begin as a short tested/untested/unsupported table with exact test commands. Keep unusual filesystem support conditional on demonstrated need, while fixing destructive failures on the configurations already accepted.

## Tests, release integrity, and maintenance

### I19 — Turn the review probes into an invariant-focused failure suite

- [x] **Medium; incremental with each TODO fix.** Prefer tests at durability and ownership boundaries over tests that merely mirror implementation branches.

The suite already has fake sockets, adapters, race tests, stress/fuzz cases, and server rehearsals. Extend those helpers with named pause/failure points: before/after durable publication, after a config save, before an editor-overwriting write, during journal repair, and during uncertain remote commits.

Assert properties: every acknowledged version is readable after restart; a newer local edit survives; only one writer owns a vault; recovery material survives an uncertain result; failed input does not advance a cursor; read operations do not mutate. Use process kill/restart and targeted fault injection where timing matters. Do not add broad low-value snapshot tests for every UI wording change.

### I20 — Add representative real-runtime and filesystem coverage

- [x] **Medium.** Keep fast stub tests, and supplement them with a small acceptance matrix using actual supported environments.

Four of the six named here are now jobs. The packaged CLI is installed from its
own tarball and run under node, which is the runtime it claims and the one
nothing else used (I21). The client suite runs on a case-folding filesystem, so
the dozen tests that ask the disk and skip stop only ever running on a
maintainer's laptop (I18). It also runs with its vaults on a loopback ext4
image, reached through a mount point, which is the "mounted subdirectory" the
matrix said had never been tried; `TMPDIR` is the whole of the change, because
every test already asks the OS where temporary files go. And systemd is finally
asked what it thinks of the unit `basaltd service` writes: `TestService` checks
that text against what this project meant to write, which is the repository
agreeing with itself, and a directive systemd refuses produces a unit that fails
five seconds after somebody installs it.

Both new filesystem jobs assert their own premise before running, because a
mount that silently did not happen, or a runner that stopped folding case, is a
job that passes while testing nothing and says so to nobody.

`scripts/check.sh` grew a third category for this. A skip is a check that could
have run here and did not, and it makes the run amber; systemd on macOS is a
check that never can, and counting it as a skip would leave the script amber for
ever on the machine it is mostly run on, which is a signal nobody reads. Those
are listed as "only in CI" and do not change the exit code.

What is left is Obsidian itself, desktop and mobile, and it is left because no
runner has Obsidian on it. docs/server.md says so in the matrix rather than
leaving a reader to assume otherwise.

[Plugin tests](client/src/plugin/main.test.ts) explicitly use an Obsidian runtime stub. Panel rendering tests cannot establish actual adapter semantics, event order, unload timing, mobile suspension, or editor-save interaction. [The check script](scripts/check.sh) also cannot execute systemd validation on a macOS host.

Prioritize real Obsidian desktop editing-during-fetch, mobile suspend/resume and large attachment recovery, Linux systemd execution, and Node runtime behavior distinct from Bun. Include case-sensitive and case-insensitive filesystem jobs, a mounted-directory case, and an end-to-end packaged CLI smoke test. Keep expensive scenarios separate from the quick development loop.

### I21 — Gate published artifacts on validation of the same commit

- [x] **Medium.** Require successful checks before npm/container/release assets become public, and test the artifact that will actually ship.

[npm publishing](.github/workflows/npm-publish.yml), [container release](.github/workflows/release.yml), and [release attestation](.github/workflows/attest.yml) build artifacts but do not depend on this repository's checks for that exact commit. Running CI elsewhere is useful only if publication cannot race ahead of a failed or missing run.

Use reusable validation jobs or an explicit successful-check gate. Test the packed npm CLI, both supported container architectures where practical, and the exact plugin bundle. Prefer draft/staged releases followed by promotion after verification, so provenance rebuilding does not expose one set of bytes and later replace it unnoticed.

### I22 — Pin the build environment and schedule dependency checks

- [x] **Small to medium.** Pin action revisions and reproducible tool versions; update them deliberately through a tested workflow.

Workflows use mutable action tags, `bun-version: latest`, and `npm@latest`; the Docker base and build environment also influence outputs. Keep lockfiles and the existing compression golden check, and record the versions used for released artifacts. Changes to compression bytes can affect deduplication and protocol assumptions, so retain cross-runtime compatibility checks when updating libraries.

Add scheduled JavaScript and Go dependency advisory checks with actionable ownership and an update policy. This review did not query vulnerability databases, so it makes no claim that the locked dependency set is vulnerability-free. An advisory result should be triaged for affected code paths, not treated as automatic proof of exploitability.

### I26 — Replace the unmaintained diff-match-patch

- [x] **Evaluated, and no.** Not because the fork is worse. Because it cannot reproduce this client's merges, and a merge that changes between releases is two devices disagreeing about one note.

`diff-match-patch` 1.0.5 is pinned to an exact version and has been
unmaintained since 2020, which `docs/compared.md` already records.
`@sanity/diff-match-patch` is a maintained TypeScript fork of the same
algorithm and is the obvious candidate.

Not a performance item: merge is not in the sealing path, and I08 already
bounded the pathological cases. The reason to do it is that an unmaintained
dependency in the one component that decides what a merged note says is a
standing risk with no owner, and it pairs with the scheduled advisory checks in
I22.

The acceptance criterion is that merge output does not change. Two devices
running different releases must produce the same merge from the same three
texts, so a fork that improves the diff would be a compatibility break, not an
improvement.

**Measured, 2026-09-07.** On maintenance the fork wins outright: 3.2.0 published
in April 2026 against 1.0.5 last touched in 2022, a real TypeScript rewrite, a
cleaner functional API. It still fails on both of the things that decide it.

It is not a drop-in. There is no `diff_match_patch` class and none of the
internals this client uses are exported: `diff_linesToChars_` and
`diff_charsToLines_` are the whole basis of line mode in `merge-regions.ts`,
`merge.ts` and `plugin/history.ts`, and the fork has no equivalent.

And it cannot produce the same diffs. `merge.ts` calls
`diff_main(base, mine, true, 0)`, where that `0` is an **already-expired
deadline**: dmp treats an explicit `opt_deadline` as an absolute time, so the
bisect gives up immediately and returns a coarser diff. The fork has no
deadline parameter at all, only `timeout`, and its `timeout: 0` means the
opposite -- `createDeadLine` maps anything `<= 0` to `Number.MAX_VALUE`. There
is no way to ask it for the behaviour this client has.

The two agree exactly, 300 of 300, on inputs that only add text. On a corpus
that also deletes lines they disagree on about half, raw and after each cleanup
stage alike, because that is where a bisect is needed and where the expired
deadline bites. So adopting it would silently change what merges cleanly, which
is the criterion above.

Worth writing down that the first run of this comparison reported the fork as
differing everywhere and the second reported it as identical everywhere. Both
were wrong: the first had mismatched settings, the second had quietly dropped
deletions from its corpus. The number that stands is from a corpus fixed once
and shared by every arm.

**And I28 closed the door rather than opening it.** The thought was that once
nobody is relying on merge output staying still, the compatibility objection
disappears and the fork becomes possible. Measuring I28 showed the expired
deadline is load-bearing for performance, not just for history: without it a
twenty-thousand-line note takes 22 seconds on the UI thread. The fork has no
deadline parameter at all and its `timeout: 0` means unlimited, so it cannot
express the one thing that keeps a large merge affordable. That is a permanent
technical blocker rather than a scheduling one, and it stands whoever is or is
not using this.

That leaves the unmaintained dependency where it was, which I22's scheduled
advisory checks are the answer to rather than this.

### I23 — Make release channels, checksums, and version preparation consistent

- [x] **Small to medium.** Define stable/prerelease/backport behavior before relying on automated moving tags.

[Container release](.github/workflows/release.yml) always requests `latest` for matching server tags. Explicitly decide whether a prerelease or an older maintenance release may move that tag or a minor alias. Validate full tag syntax and the version printed by the published image before promotion.

[release.sh](scripts/release.sh) builds from a clean tracked tree and then updates `versions.json`; move version-map preparation into an explicit pre-release step that is committed before final artifacts are built/tagged. Review untracked build inputs as part of source cleanliness. Align checksum file paths with the downloadable assets and automate final checksum/provenance verification across CLI, plugin, binary, and image channels.

## Security model and scope

### I24 — Clarify revocation, rotation, and the scope of cryptographic trust

- [x] **Small documentation work; large only if requirements change.** Explain the guarantees in terms of credentials, retained data keys, and ciphertext access.

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
