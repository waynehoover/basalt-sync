# Compared, and measured

[Back to the README](../README.md)

Basalt was built against three projects: Obsidian Sync, read out of the shipped
app, and two self-hosted plugins with public source. What differs, what was
learned, where theirs is better, and the numbers behind the claims.

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

**Transfer is the real difference.** Theirs keeps one hash per file and sends
the whole body when it changes; Basalt chunks on a rolling hash and sends only
what the server lacks. One line inserted, from `cd client && bun run bench`:

| Note | Whole file | Basalt | of that, the entry | |
|---|---|---|---|---|
| 4 KiB | 4.4 KiB | 1.9 KiB | 624 B | 2x |
| 32 KiB | 32.4 KiB | 4.9 KiB | 1.3 KiB | 7x |
| 128 KiB | 128.4 KiB | 5.8 KiB | 2.7 KiB | 22x |
| 512 KiB | 512.4 KiB | 9.6 KiB | 4.8 KiB | 54x |
| 2 MiB | 2.0 MiB | 21.7 KiB | 9.0 KiB | 94x |

Both columns include the entry, because both protocols send one. Ours names
every chunk of the new version, most of what a large note costs and what bounds
the gap. Hence chunk size by `sqrt(NAME_BYTES * size)` rather than by what one
edit costs alone.

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

**Chunks against streaming encryption.** Sync Engine encrypts as a stream with a
per-file salt: conventional, never holds a whole file, cannot deduplicate.
Basalt seals deterministically, so an edit to a large note costs one chunk and a
version history 73% to 90% less storage. The cost: the server learns when two
chunks are identical.

**Refusing a merge against merging better.** Theirs is a real diff3, splitting
a document into regions first. Basalt applies diff-match-patch and adds four
checks: do the changed regions overlap, do both merge orders agree, did every
hunk apply, did every insertion survive. Ours is character-granular, so it
merges two devices editing different arguments of one function call. It also
merges a re-indented code block with a line appended into code that no longer
runs, which their region splitter would not.

**Where theirs is ahead:** hundreds and thousands of stars against a plugin
nobody has installed yet, storage you already pay for, and a listing in
Obsidian's community directory.

### Beside Sync Engine's published numbers, carefully

| 2000 files, 400 ms round trip | up | down |
|---|---|---|
| Sync Engine, their machine, Nextcloud over WebDAV | 9.43 min | 5.87 min |
| Basalt, Apple M4 Pro, Go server behind a latency proxy | 3.00 min | 1.89 min |

18 round trips up and 27 down, for 2000 files. 2000 arrived, 0 wrong. Not a
race: their backend is Nextcloud over WebDAV, their CPU is far slower, the
latency here is injected on loopback with no jitter, and their vault size is not
published. What survives all four: moving 2000 files takes tens of round trips
rather than thousands, and an edit to a large note costs one chunk here and the
whole file on any backend that stores files.

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

**obionesync**, the predecessor, is where every verified fact about Obsidian
Sync's protocol came from. Every bug found in it was silent, which is why unit
tests here are necessary and never sufficient.

## Libraries

**diff-match-patch** for the merge, unmaintained since 2020 and pinned to an
exact version. **fflate** for deflate. **modernc.org/sqlite**, so the server is
one static binary. **github.com/coder/websocket**.

Basalt is MIT, like LiveSync and like Obsidian's own plugin API declarations.

## Locking, and why this does not use `flock`

The CLI's vault lock is a file with a holder written into it, taken by `link`.
It is never taken over automatically. A lock left behind by a crash stays there
until somebody runs `basalt unlock`.

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

The standard answer is `flock(2)`, where the kernel does the whole decision
atomically and releases the lock when the process dies: no staleness, no
takeover, no protocol to get wrong. It is not available here. Node has no
binding for it; `fs-ext` provides one and is a native module, which would mean
a build step and a per-platform binary for a package whose whole shape is
"install it and run it"; the packed CLI runs under stock node; and the Obsidian
plugin could not load a native addon even if one were acceptable.
`proper-lockfile` is the pure-JS convention and uses a directory plus an mtime
heartbeat, which is the same staleness problem in a different arrangement and
would not have prevented R03.

So the cost is paid where it can be seen. A crashed sync wedges a cron job
until somebody runs one command, and the refusal says exactly that, naming the
process and what to type. The alternative was a mechanism nobody could
demonstrate the correctness of, standing between two writers and the rule this
project exists for.

`basalt unlock` has one window of its own and it is closed the same way: an
ordinary refusal, where the holder is running or is on another machine, reads
the lock and touches nothing at all. Only a lock already read as abandoned is
taken aside, and if it turns out to be held after all it goes back with `link`
rather than `rename`, so a lock somebody legitimately took in the meantime is
not written over. Where even that fails, the command says two processes may
hold the vault and both should be stopped, because a race that cannot be undone
can at least be reported (rule 7).

The Go server has no part of this problem: `internal/dirlock` calls `flock`.

Prior art worth naming for the rest of it, because these were re-derived here
rather than invented: git's object write (temp, fsync, link, fsync the
directory) is the shape of the chunk store's publication barrier; RocksDB and
LevelDB withhold visibility until a manifest is durable, which is what the
unproven set does; Kubernetes' liveness and readiness probes are the
distinction `/health` draws; and restic and borg stamp a repository identifier
into a backup rather than trying to recognise it by its size, which is what
R14 came round to.
