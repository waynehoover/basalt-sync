# Compared, and measured

[Back to the README](../README.md)

Basalt was built against four projects: Obsidian Sync, read out of the shipped
app, and three self-hosted plugins with public source. What differs, what was
learned, where theirs is better, and the numbers behind the claims.

The mechanical differences are first, because they are the ones that decide what
a sync costs. The per-project sections after them are about everything else.

## Mechanisms, side by side

How the five of them actually move a note. Every cell was read out of the
shipped source, and the version it was read at is named underneath, so a claim
here can be checked rather than taken.

| | Obsidian Sync | LiveSync | Sync Engine | Fast Note Sync | Basalt |
|---|---|---|---|---|---|
| Unit on the wire | whole file | content chunks | whole file | whole file | content chunks |
| How a boundary is chosen | n/a | Rabin-Karp, 48-byte window | n/a | n/a | rolling hash, 48-byte window |
| Chunk size | n/a | a setting | n/a | n/a | `sqrt(64 * size)`, clamped |
| One line into a 2 MiB note | 2 MiB | one chunk | 2 MiB | 2 MiB | 21.7 KiB |
| Identical content stored twice | yes | no, chunks are hash-named | yes, per-file random salt | yes | no, sealing is deterministic |
| Text merge | automatic | automatic for markdown | automatic | none | automatic when provably safe |
| Diff | not read here | diff-match-patch | own O(NP) | n/a | diff-match-patch |
| Granularity | not read here | character | word, script-aware | n/a | character |
| The ancestor it merges from | `synchash` | conflicting revisions | the base text, stored | n/a | `synchash`, fetched by uid |
| When it will not merge | drops failed hunks | a diff pane, or newer wins | its own conflict resolver | writes `xxx.remote.md` | writes a conflict copy |
| Content encryption | optional | optional | optional, a module | none | always |
| Backend | theirs | CouchDB, or S3 | WebDAV, S3, Google Drive | its own server | one Go binary |

Read on 2026-09-08, at these versions, in these files:

- **LiveSync 1.0.27** (`dd280a4`), chunking in `@vrtmrz/livesync-commonlib`
  0.1.23 `string_and_binary/chunks.js`, merging in the plugin's
  `serviceFeatures/conflictResolution/operations.ts`.
- **Sync Engine 3.1.4** (`edb9d42`), `packages/smart-merge/src/diff3/onp.ts`,
  `utils/splitters.ts`, `resolver.ts`, and `packages/encryption/src`.
- **Fast Note Sync 2.4.0** (`1bfb406`), `src/lib/storage/file_hash_manager.ts`
  and `src/lib/sync/`.

Obsidian Sync's rows come from reading the shipped app. Its two blanks are blank
because nothing here established them, which is not the same as knowing they are
absent.

### Chunks instead of whole files

A note is cut into pieces at boundaries the content chooses, each piece named by
its own hash, and only the pieces the server lacks are sent. Insert a line and
the boundaries either side of it stay where they were, so one piece changes and
the rest of the note is already up there.

The alternative is one hash per file: it changed, send it again. That is what
Obsidian Sync, Sync Engine and Fast Note Sync do, and it is not a mistake. It
has far fewer moving parts, it cannot get the boundaries wrong, and for a vault
of small notes the difference is small. It gets expensive in exactly one place,
which happens to be the place people notice: a large note edited often.

From `cd client && bun run bench`, one line inserted:

| Note | Whole file | Basalt | of that, the entry | |
|---|---|---|---|---|
| 4 KiB | 4.4 KiB | 1.9 KiB | 624 B | 2x |
| 32 KiB | 32.4 KiB | 4.9 KiB | 1.3 KiB | 7x |
| 128 KiB | 128.4 KiB | 5.8 KiB | 2.7 KiB | 22x |
| 512 KiB | 512.4 KiB | 9.6 KiB | 4.8 KiB | 54x |
| 2 MiB | 2.0 MiB | 21.7 KiB | 9.0 KiB | 94x |

Both columns carry the entry, because both protocols send one. Ours names every
chunk of the new version, which is most of what a large note costs and what
bounds the gap: hence sizing chunks by `sqrt(NAME_BYTES * size)` rather than by
what one edit costs alone.

**LiveSync does this too**, and first. The 48-byte window here is theirs. What
differs is not the idea but where the chunks go: theirs are CouchDB documents,
which brings replication and revision history for free and brings CouchDB;
ours go to one static Go binary over one WebSocket.

### Deduplication, and what it is actually worth

Chunks are named by content, so a chunk the server already holds is not sent and
not stored twice. Measured on this vault shape, `bun run dedup`:

- **Across different files: 0.11%.** Two notes rarely share a paragraph. On its
  own this would not be worth the machinery.
- **Across versions of one file: 73% to 90%.** A note edited twenty times stores
  26 chunks for 95 references when short, 41 for 410 when long.

The second number is the whole point, and it is the same mechanism as the wire
saving above seen from the disk: today's note is mostly yesterday's. It is also
why deterministic sealing is not optional here. Sync Engine picks a fresh random
salt per file when its encryption module is enabled, which is the conventional
and more conservative choice, and it means the same paragraph encrypts
differently every time and can never be recognised as already stored.

**The cost of our choice is real and is not hidden: the server can tell when two
chunks are identical.** For one person's own machines that is a trade worth
making, and `docs/design.md` says so where somebody deciding can see it.

### Merging, and why the algorithm is the interesting part

Everyone who merges markdown automatically is doing a three-way merge against a
common ancestor. The differences are which ancestor, which diff, and what
happens when the merge cannot be trusted.

**The ancestor.** Basalt keeps `synchash`, one hash per file recording the
content as of the last sync, and fetches that version by uid when a merge needs
it. That idea is Obsidian Sync's and it is why no version history is needed to
merge. Sync Engine instead stores the base *text*, so it never has to fetch;
that costs storage and saves a round trip, and either answer is defensible.

**The diff.** Sync Engine wrote its own, an O(NP) sequence comparison after Wu,
Manber and Myers, over tokens produced by a script-aware splitter: words in
English, `Intl.Segmenter` for Japanese, Chinese, Thai, Lao, Khmer, Burmese and
Tibetan. LiveSync and Basalt both use diff-match-patch. So the honest statement
is not that our algorithm is unusual, it is that **ours is character-granular
where Sync Engine's is word-granular**, and that cuts both ways: character
granularity merges two devices editing different arguments of one function call,
and word granularity with real segmentation is better at CJK than a character
diff written for English prose.

**What happens when it cannot merge** is where this project differs most, and it
follows from the first rule rather than from any cleverness. Basalt adds four
checks around diff-match-patch: do the changed regions overlap, do both merge
orders agree, did every hunk apply, did every insertion survive. Any failure
means both versions are written into the vault as files. Obsidian Sync applies a
similar construction and drops the hunks that did not apply, which is the step
that was deliberately not copied. LiveSync falls back to a diff pane, or to
newer-wins if you ask it to, which resolves a conflict by deleting the losing
revision; the content stays in CouchDB's history, so it is recoverable, but it
is no longer in the vault. Fast Note Sync does not merge at all and writes the
server's copy to `xxx.remote.md`, which is a conservative answer and a
defensible one.

### Speed, and what these numbers do not say

Basalt moves 2000 files in tens of round trips rather than thousands, and a pass
over a settled vault costs 41 ms at ten thousand notes. Those are worth knowing.
What follows is not a benchmark against anybody:

| 2000 files, 400 ms round trip | up | down |
|---|---|---|
| Sync Engine, their machine, Nextcloud over WebDAV | 9.43 min | 5.87 min |
| Basalt, Apple M4 Pro, Go server behind a latency proxy | 3.00 min | 1.89 min |

Their backend is Nextcloud over WebDAV and ours is a local Go process; their CPU
is far slower; our latency is injected on loopback with no jitter; their vault
size is not published. Four independent reasons the right-hand column should
win, none of which is the client. **Read it as "tens of round trips, not
thousands", and not as a ratio.**

The one speed claim here that does survive a change of machine is the transfer
table above, because it counts bytes rather than seconds, and bytes are what a
400 ms link is short of.

Everything else measured, including where the cost actually is (`fsync`, and
macOS pays four to six times what Linux does), is under [Measured](#measured).

## Against Obsidian Sync

| | Obsidian Sync | Basalt |
|---|---|---|
| Where it runs | their servers | your box |
| Cost | subscription | electricity |
| Setup | sign in | run a binary, paste one string |
| Editing one line of a 2 MiB note | 2 MiB | 21.7 KiB |
| Encryption | optional | always |
| A server forging a version | not tested here | refused; every entry is authenticated by its writer |
| Merge conflicts | merged silently, failed hunks dropped | merged when provably safe, both kept otherwise |
| Plugins, themes, config | synced | not synced, and that one is still open |
| Mobile | iOS and Android | Android in daily use, iOS untested |
| Version history | in the app | in the app, and restoring never overwrites |
| Maturity | years in production | early |

**Deletions lose to edits.** Deleted here and changed there, theirs propagates
the delete. Basalt restores the file.

**Where theirs is better**, not close in places: nothing to run, iOS, and years
of production finding edge cases found here by reading code. Whole-file upload
also has fewer moving parts than chunking plus deterministic sealing plus
compression.

## Against Sync Engine and Fast Note Sync

[Sync Engine](https://github.com/hesprs/sync-engine) and
[Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync). Both are
good, both are further along, and reading them found real defects here.

The mechanics are in [Mechanisms, side by side](#mechanisms-side-by-side): what
is worth adding here is that Basalt also merges a re-indented code block with a
line appended into code that no longer runs, which a region splitter would not,
and that reading both of these found real defects here.

**Where theirs is ahead:** hundreds and thousands of stars against a plugin
nobody has installed yet, storage you already pay for, and a listing in
Obsidian's community directory.

The published-numbers comparison, and why it is not a race, is under
[Speed](#speed-and-what-these-numbers-do-not-say). For the record: 18 round
trips up and 27 down for those 2000 files, 2000 arrived, 0 wrong.

## Measured

```bash
cd client
bun run bench:sync      # a whole vault over four wires, timed and checked
bun run bench           # chunking, sealing, bytes on the wire
bun run scale           # 1,000 and 10,000 notes
bun run dedup           # what deduplication saves
```

Correctness is reported beside the timings, Sync Engine's idea, and has caught
two real defects here. The vault shape is theirs: many small notes, some medium,
a few large, half the large ones incompressible, prose that does not repeat.
Latency is injected by a proxy; 400 ms at 2.6 MiB/s is Sync Engine's published
environment.

**A whole vault.** 200 files, 17.8 MiB, Apple M4 Pro. 200 arrived, 0 wrong, on
every row.

The figures predate the current handshake and still stand: `put`, `putmany`,
`get`, `fetch`, the chunker and the content key schedule have not been touched
since, and the golden vectors pinning sealed bytes still pass, so a chunk has
the same name and length it had here. What has changed is the cost of
connecting, which no row here measures.

| Round trip | Up | Down | 20 notes up | 20 notes down | Nothing changed |
|---|---|---|---|---|---|
| loopback | 11.9 s | 0.62 s | 0.24 s | 0.11 s | 0.00 s |
| 20 ms | 12.7 s | 0.85 s | 0.29 s | 0.13 s | 0.00 s |
| 100 ms | 12.6 s | 1.90 s | 0.44 s | 0.23 s | 0.00 s |
| 400 ms, 2.6 MiB/s | 15.8 s | 10.1 s | 1.07 s | 0.63 s | 0.01 s |

17.8 MiB crosses as 10.8 MiB from compression alone; dedup contributes nothing,
the notes being distinct. Four round trips each way at every latency, and a pass
over a settled vault is unmeasurable.

The download column is slower than this document used to claim, and the harness
is why, not the client. The proxy now applies real back-pressure in both
directions, which it did not before, so 2.6 MiB/s is enforced on the way down:
10.8 MiB cannot arrive in under about four seconds, and takes ten. The older
figure was measured against a link that was not really throttling, and should
not be compared with this one.

The upload cost is `fsync`, and macOS pays four to six times more of it than
Linux because Go issues `F_FULLFSYNC` there. Measured earlier,
the same 200 files uploaded in 2.8 s on Linux against 12.2 s here, and the
400 ms upload was close to link-bound, so there is no large win left in the
server for a vault of notes. Not repeated since, and quoted as the earlier
measurement it is.

**Scale.** Ten thousand notes of distinct prose, 21.1 MiB.

| | 1,000 notes | 10,000 notes |
|---|---|---|
| Chunks, of which distinct | 2,198 / 2,198 | 21,641 / 21,617 |
| Sealed bodies | 0.8 MiB | 8.1 MiB |
| Local index | 0.6 MiB | 5.6 MiB |
| A pass over an unchanged vault | 7 ms | 41 ms |
| Twenty notes edited | 20 chunks, 8.0 KiB | 20 chunks, 8.0 KiB |

Everything is linear in the note count, and editing twenty notes costs the same
at any vault size. Deduplication across files is worth 0.11%; across versions,
73% to 90%: a note edited twenty times stores 26 chunks for 95 references when
short and 41 for 410 when long. The machinery pays by noticing that today's note
is mostly yesterday's, which is what makes an edit cost one chunk on the wire.

**A large attachment**, whole sync, headless client, which streams:

| file | peak memory | time |
|---|---|---|
| 16 MiB | 144 MB | 0.4 s |
| 64 MiB | 220 MB | 1.6 s |
| 256 MiB | 291 MB | 6.5 s |

The plugin streams on desktop through the resource URL the webview already uses
for images. Mobile uses a different URL scheme, untested, and falls back to
reading the file whole, at roughly 210 MB plus 2.7 MB per MiB. That curve sets
the default 64 MiB file limit.

**A real vault.** The numbers above are a generated corpus. Run against a copy
of a real one, 3,751 files and 91 MB of notes and attachments, on loopback: the
first device uploaded it in 54 seconds as 11,307 chunks and 62.7 MiB on the
wire, 69% of the plaintext, and a second device joining by invite downloaded the
whole vault in 22 seconds. Every file arrived byte-identical, and the server's
own `verify -deep` checked 11,762 chunk references with 0 faults. An edit, a
rename, a merge, a two-device conflict and a deletion all behaved as documented,
and the vault's dot-prefixed folders stayed put.

**The entry authenticator** costs 2.2 microseconds per entry and 149 bytes on
the wire, about 2.7% of a first sync. A globally chained variant that would also
detect a withholding server was 12.7 microseconds, and was rejected for what it
does to concurrent writers, not for its arithmetic.

### Measured and deliberately not done

- **A whole-file fast path for small notes.** Considered because most vaults
  are thousands of notes under 64 KB. Chunk size already scales as
  `sqrt(64 * size)`, clamped to a 1 KiB average and a 512 byte floor: a 4 KiB
  note is about four chunks, an edit to it 1.9 KiB against 4.4 KiB whole. One
  chunk per small note would send more on every edit and store about a third
  more history, and inlining a body in the `put` would save one round trip
  batching already amortises, for a second code path through the most
  durability-critical part of the client. Kept as is, the sizing constants
  pinned by a test so the decision cannot drift into a re-chunk of every vault.
- **A global hash chain**, which would catch withholding. Serialises writers.
- **One transaction per batch.** 10x on the SQL, worth 0.7% of an upload, for
  making "an ack means durable" a per-batch argument.
- **A different deflate level or chunk-size targets.** Both are baked into the
  chunk name. Changing the targets re-chunks every vault in existence, because
  the boundaries move. Changing the level does not: it moves no boundary, so it
  re-names and re-uploads only the chunks whose compressed output differs, and
  the store holds both copies. Measured while spiking a way out of this in
  September 2026, along with the finding that naming by anything derived from
  the plaintext cannot decouple the targets either.
- **Larger chunks** to cut fsyncs. Trades back a size chosen by measurement.
- **Solid compression on a first sync.** 57% against 60% of plaintext, for a
  second code path through the most durability-critical part of the client.
- **node-diff3** for the merge. It conflicted on five of eight cases that merge
  cleanly here, including two devices appending to a daily note.
- **A CRDT for the text**, considered after fuzzing found four ways the merge
  could invent text. It guarantees every device converges, not that the text is
  what either person meant: two devices editing one line apart still interleave,
  deterministically, with nothing to flag it. Keeping both versions is the
  safety net the first rule needs, and a CRDT has no conflict to fall back to.
- **Resolving renames at scan time**, matching a vanished path to an appeared
  one by content hash instead of the `prev` chain. Identical files are ordinary
  in a vault, a rename plus an edit stops looking like a rename, and a delete
  then create becomes a false one. Tested state for an untested guess, in the
  path that has already produced bugs.
- **A server-side streaming import for a first sync.** 54 seconds up and 22
  down for the real 3,751 file vault, once per device. Not worth a second path
  through durable code. Re-measure over tailscale before reopening.
- **Merging the four "not acted on" maps** into one. Each came from its own
  incident and they carry different exit codes. The output was merged into one
  list with reasons; the model was left alone.
- **Naming a chunk by its plaintext rather than its ciphertext**, so encoding
  parameters stop being baked into the name. Spiked and refused. It decouples
  the deflate level and the sealing construction but not chunk size, because
  moving a boundary changes the plaintext: 0 names shared of 126. The server
  also stops being able to check itself, since a name it cannot compute takes
  put-time verification, frame matching, the bit-rot check and the deep verify.
  And nothing but a device holding the plaintext can map an old name to a new
  one, so migrating re-uploads the vault and doubles the store. The naive form,
  a plain hash, is worse than neutral: computable by anyone, identical in every
  vault, and for a small note a hash of the whole note. Keying it fixes that and
  costs nothing measurable. Kept on file for one case only, a construction
  change that is forced rather than chosen, where re-sealing under today's
  naming would rename every chunk and re-MAC all of history. Prototype and
  benchmark on `spike/hmac-chunk-names`.
- **A local map from plaintext to the name a chunk was uploaded under**, which
  would make a parameter change cost nothing on the wire: 2 chunks and 12.5 KiB
  against 43 and 156 KiB. Its benefit is zero until somebody retunes a
  parameter and it pays for itself the day they do, so it costs a quarter again
  on the index for nothing in the meantime.
- **A SQLite index on the client**, to replace rewriting the whole index as
  JSON on every change. Measured before believed:

  | notes | index | stringify | durable write | total |
  |---|---|---|---|---|
  | 1,000 | 0.6 MiB | 0.1 ms | 1.5 ms | 1.6 ms |
  | 10,000 | 6.3 MiB | 1.9 ms | 2.1 ms | 4.0 ms |
  | 50,000 | 31.6 MiB | 8.6 ms | 5.0 ms | 13.6 ms |

  Four milliseconds at ten thousand notes is not the cliff it was thought to
  be, against passes measured in tens. It would also cost a second storage path
  through the file the first rule is about, on a phone where SQLite is least
  certain to exist. Measured on a laptop SSD, and one cold run wrote the 50,000
  note index in 228 ms rather than 5, so the fsync cost is real when nothing is
  cached. A journal was built instead.

- **Data-key epochs, re-encryption, and per-device signatures.** Three
  separate things, refused together because they are asked for together, by
  the same reasoning about a hostile server. Epochs and re-encryption would
  make revocation forward-secret: a revoked device could not read ciphertext
  it obtained after the fact. Per-device signatures would make history say
  which device wrote a version rather than that a key holder did.

  What they cost is not subtle. A new data key breaks history recovery for a
  device that was offline across the epoch, invalidates deduplication either
  side of the boundary, makes every existing backup unreadable by the new
  client, and needs a migration that rewrites content the whole design is
  built on never rewriting. Per-device signatures mean a key per device in
  every entry, a revocation story for verification keys, and a rule for what
  a device does with an entry signed by a device it has never heard of.

  What they buy, here, is small. The deployment is one person's own machines
  on a private network, and the threats that actually lose notes are a
  filesystem, a crash and a race: of the twenty-eight defects the 2026-09-05
  review found, five involved distrusting the server, and every one of those
  five fires far more often for an honest reason. A replayed version is what a
  restored backup looks like. A malformed entry is a buggy client on another
  device. An unreadable frame is a proxy. The checks are worth keeping because
  they turn a silent wrong answer into a loud refusal; the machinery above is
  not, because it defends only against deliberate malice by somebody who
  already holds the box, and who can then watch the device, the traffic and
  the disk anyway.

  So the honest paragraph in docs/design.md is the deliverable rather than the
  mechanism. Revisit if the vault is ever served from a machine somebody else
  administers, which is the requirement that would change the answer.

## What was borrowed

None of their code. Ideas, parameters and bug reports, each credited where used.

**[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)** (MIT) is
the largest debt: content-defined chunking from `splitPiecesRabinKarp` with its
48-byte window, chunk sizes split by text or binary, a regression test for
U+FEFF on a boundary, and the conclusion that text merging is solved. Not taken:
base64 for binary chunks, whole files in memory, and one-way HMAC for paths, all
consequences of CouchDB, the last impossible here because a device restoring a
vault has to recover the real filename.

**Obsidian Sync** contributed `synchash`, one field per file remembering the
content as of the last sync, which turns a three-way merge into something
needing no version history. The merge construction is kept too, minus the step
discarding which hunks applied.

**Sync Engine** contributed reporting correctness beside speed, the benchmark
vault shape, and the 400 ms environment. Their issue 232, `rm` where the platform
should trash, was a live defect here too.

**Fast Note Sync** contributed issue 257: a path that is a file on one side and
a folder on the other, which Basalt retried forever one way and ignored the
other.

**obsidian-headless**, Obsidian's own command-line client, contributed the
comparison above: its lock is the lease design this project rejected, and
reading it turned that rejection from a judgement about a category into two
named failures in a specific implementation. It also settled two questions
about scope, in `IMPROVEMENTS.md` I29 and I30: it is fully bidirectional rather
than a mirror, and it offers a `--conflict-strategy` switch, which is a thing
this client does not have and arguably should.

## Libraries

**diff-match-patch** for the merge, unmaintained since 2020 and pinned to an
exact version. `@sanity/diff-match-patch` is a maintained TypeScript fork and
was evaluated in September 2026: it is better on every axis except the one that
decides it, which is that it cannot produce the same diffs this client
produces. It exports none of the line-mode internals used here, and it has no
way to express the expired deadline `merge.ts` passes -- its `timeout: 0` means
unlimited where dmp's `opt_deadline: 0` means expired. Merges would change, and
a merge that changes between releases is two devices disagreeing about one
note. IMPROVEMENTS.md I26. **fflate** for deflate. **modernc.org/sqlite**, so the server is
one static binary. **github.com/coder/websocket**.

Basalt is MIT, like LiveSync and like Obsidian's own plugin API declarations.

## Locking, and the five ways of getting it wrong first

The CLI's vault lock is the operating system's, and the file beside it only
says who. A crashed basalt releases the vault by dying, and the next one takes
it.

That is not where this started. Every hard part of a lock file is staleness: it
outlives the process that made it, so somebody has to decide when it is safe to
remove, and deciding is a read followed by an unlink with a gap in between. R03
was that gap, and closing it took five goes. All five are written down because
each looked finished, and four of them handed one vault to two writers.

An eviction marker, a second exclusive `link` naming the holder being evicted,
moved the problem rather than solving it: a marker whose own evictor died had
to be recovered by somebody, and recovering it was another read and another
unlink (R20). Bucketing that marker by a minute of the clock made the recovery
safe and left the boundary (R34). Taking the lock file with `rename` instead --
atomic, and unlike `rm` it hands back what it took -- meant a caller could
identify what it held, but it still removed a name it did not own, so a third
contender found the vault free while somebody was in it (R40). Numbering the
claims fixed that, until a release freed the numbers and a slow caller was
admitted beside the holder by aiming at one that had come back (R44, R49).
Generational claims with a fence, where a release marks rather than deletes so
the numbers never come round again, closed that one. It is 416 lines and it
might be right.

Five attempts is enough evidence that nobody here can tell. So the sixth answer
is not to decide.

The reason the decision cannot be made safely is not that the rule is subtle.
It is that "the holder is dead, so I may have it" is a conclusion drawn from an
observation, and between the observation and the act the holder can be alive
again: a recycled pid, a process that had not finished dying, a second
contender that read the same corpse. Nothing in POSIX offers a
compare-and-swap on a file to close that. Every one of the five attempts is a
different arrangement of the same missing primitive.

The standard answer is a lock the kernel releases when the process dies: no
staleness, no takeover, no protocol to get wrong. Every one of the five
attempts above was trying to synthesise that out of a file, and none of them
could, because "the holder is dead, so I may have it" is a conclusion and
acting on a conclusion is two steps.

It was believed unavailable, and that belief is what produced them. `flock(2)`
has no binding in Node; `fs-ext` provides one and is a native module, which
would mean a build step and a per-platform binary for a package whose whole
shape is "install it and run it"; the packed CLI runs under stock node.
`proper-lockfile` is the pure-JS convention and uses a directory plus an mtime
heartbeat, which is the same staleness problem in a different arrangement and
would not have prevented R03.

All true, and the conclusion drawn from it was wrong. Both supported platforms
already hand out a kernel-released exclusion from stock Node, and neither is
`flock` by that name:

- **macOS**: `open()` with `O_EXLOCK`, which takes a `flock`-style lock as part
  of the open. Node does not put the flag in `fs.constants`, so it is spelled
  as the number `<sys/fcntl.h>` gives it. A second open refuses with `EAGAIN`.
- **Linux**: an abstract Unix socket. Its name lives in a kernel namespace
  rather than on a filesystem, so a killed holder leaves nothing behind to be
  mistaken for a live one. A second bind refuses with `EADDRINUSE`.

Both were probed with a `SIGKILL`ed holder before anything was built on them,
and `scripts/kernel-lock.test.ts` kills one on every run of the gate, on Linux
in CI as well, because a property proven on one of two unrelated mechanisms is
proven for one of them.

So the lock file is a *record* now rather than a claim: holding the kernel's
exclusion establishes that no other basalt on this machine is inside the vault,
which makes whatever the file says either this vault's own debris or a holder
on another machine. Neither needs a liveness guess, and the whole class of
defect above has nothing left to attach to. Two things remain deliberately
unchanged: a holder on another machine is still believed, because a kernel
answers for one machine; and where the mechanism does not prove itself, which a
network mount is the likely case of, everything falls back to the file and to
`basalt unlock`, and says so on stderr rather than quietly.

The cost that is left is paid where it can be seen: on a filesystem where the
exclusion does not hold, a crashed sync wedges a cron job until somebody runs
one command, and both the warning and the refusal say exactly that.

`basalt unlock` had two windows of its own, and both are closed rather than
reported.

The first: taking a lock aside to decide about it frees the name for as long as
the decision takes, so a `sync` starting in that instant joins the holder. An
ordinary refusal -- the holder is running, or is on a machine this one cannot
ask -- therefore reads the lock and touches nothing at all, and only a lock
already read as abandoned is moved.

The second was subtler and was found by review rather than here. Two unlocks
overlapping admit two writers: U1 reads an abandoned lock and pauses, U2 clears
that same lock, a writer takes the free name legitimately, and U1 then renames
*that* writer's lock aside and a second writer walks in. Reporting it
afterwards is not an exclusion, so `unlock` now takes a recovery lock of its
own and a second one is refused. Nothing else can empty the lock file while an
unlock is deciding, because an acquirer meets the occupied name, so removing
concurrent unlocks removes the only way into that schedule.

What is left after both is a lock somebody deleted by hand at exactly the wrong
moment. The put-back uses `link` rather than `rename` so it cannot write over a
lock legitimately taken meanwhile, and where even that fails the command says
two processes may hold the vault and both should be stopped, because a race
that cannot be undone can at least be reported (rule 7).

The Go server has no part of this problem: `internal/dirlock` calls `flock`.

### What Obsidian's own headless client does

Read out of `obsidian-headless` 0.0.3 (`obsidianmd/obsidian-headless`, published
as `ob`), because it is the closest thing to a reference implementation of this
exact problem and it reached the opposite answer.

It takes a `.sync.lock` **directory** per vault, with a heartbeat:

```js
try { mkdirSync(lockPath) }                        // exclusive create
catch (r) {
  if (r.code !== "EEXIST") throw r;
  const n = statSync(lockPath).mtimeMs;
  if (Date.now() - n < 5000) throw new LockError(); // fresh: refuse
  // older than five seconds: fall through and take it
}
this.lockTime = now(); this.touch();
if (!this.verify()) throw new LockError();
setInterval(() => { this.lockTime = now(); this.touch() }, 1000);
```

`mkdir` is the atomic primitive, the holder stamps the directory's mtime every
second, and a contender treats a lock older than five seconds as abandoned.
After taking one over it writes its own mtime and re-reads it, so two
contenders that both found it stale should not both win.

This is the design this project evaluated and turned down, and having the
source rather than the package description makes the reason concrete rather
than theoretical. Two ways it hands one vault to two writers:

- **The lease.** A holder paused for more than five seconds -- a laptop
  suspended, a long garbage collection, a stalled disk, `SIGSTOP`, a virtual
  machine migrating, an `fsync` on a large attachment -- is declared abandoned
  while it is still running and still writing. `verify()` is called at acquire
  and at release and never in between, so the displaced holder never learns it
  has been displaced.
- **The tie-break's own fallback.** `verify()` accepts
  `Math.floor(e / 1000) === Math.floor(this.lockTime / 1000)`, which is there
  because many filesystems keep mtime to the second. Two contenders that both
  find a stale lock and both stamp it inside one wall-clock second therefore
  *both* verify, and both proceed. That is R03's shape with a stopwatch
  attached.

`touch()` also swallows every error, so a failed `utimes` stops the heartbeat
under a live holder and the lock goes stale while somebody is using it, with
nothing said.

Against that, what is here holds a lock the kernel drops when the process dies:
there is no lease to expire, no clock, and nothing to decide.
`scripts/kernel-lock.test.ts` establishes it by killing a holder, on macOS in
the gate and on Linux in CI.

Two caveats, because a comparison that only flatters is not worth writing down.
Obsidian Sync is a hosted service with server-side conflict handling and a
`--conflict-strategy` switch, so two writers cost them a conflict where they
would cost this project rule 1; their tolerance is reasonably different from
ours. And their client supports Windows, which neither mechanism here does, and
a lease is at least portable. The lease is the wrong answer for Basalt, not a
mistake in the abstract.

Prior art worth naming for the rest of it, because these were re-derived here
rather than invented: git's object write (temp, fsync, link, fsync the
directory) is the shape of the chunk store's publication barrier; RocksDB and
LevelDB withhold visibility until a manifest is durable, which is what the
unproven set does; Kubernetes' liveness and readiness probes are the
distinction `/health` draws; and restic and borg stamp a repository identifier
into a backup rather than trying to recognise it by its size, which is what
R14 came round to.
