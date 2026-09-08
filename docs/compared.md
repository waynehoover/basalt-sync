# Compared, and measured

[Back to the README](../README.md)

Four projects were read while building this one. What differs mechanically,
what was borrowed, where theirs is better, and the numbers behind every claim.

## Mechanisms, side by side

Every cell was read out of the shipped source at the version named below, so a
claim here can be checked rather than taken.

| | Obsidian Sync | LiveSync | Sync Engine | Fast Note Sync | Basalt |
|---|---|---|---|---|---|
| Unit on the wire | whole file | content chunks | whole file | whole file | content chunks |
| Boundary chosen by | n/a | Rabin-Karp, 48-byte window | n/a | n/a | rolling hash, 48-byte window |
| Chunk size | n/a | a setting | n/a | n/a | `sqrt(64 * size)`, clamped |
| One line into a 2 MiB note | 2 MiB | one chunk | 2 MiB | 2 MiB | 21.7 KiB |
| Identical content stored twice | yes | no, chunks are hash-named | yes, per-file random salt | yes | no, sealing is deterministic |
| Text merge | automatic | automatic for markdown | automatic | none | automatic when provably safe |
| Diff | not read here | diff-match-patch | own O(NP) | n/a | diff-match-patch |
| Granularity | not read here | character | word, script-aware | n/a | character |
| Ancestor merged from | `synchash` | conflicting revisions | the base text, stored | n/a | `synchash`, fetched by uid |
| When it will not merge | drops failed hunks | a diff pane, or newer wins | its own resolver | writes `xxx.remote.md` | writes a conflict copy |
| Content encryption | optional | optional | optional, a module | none | always |
| Backend | theirs | CouchDB, or S3 | WebDAV, S3, Google Drive | its own server | one Go binary |

Read on 2026-09-08: **LiveSync 1.0.27** (`dd280a4`), chunking in
`@vrtmrz/livesync-commonlib` 0.1.23 `string_and_binary/chunks.js`, merging in
`serviceFeatures/conflictResolution/operations.ts`; **Sync Engine 3.1.4**
(`edb9d42`), `packages/smart-merge/src/diff3/onp.ts`, `utils/splitters.ts` and
`resolver.ts`, and `packages/encryption/src`;
**Fast Note Sync 2.4.0** (`1bfb406`), `src/lib/storage/file_hash_manager.ts` and
`src/lib/sync/`. Obsidian Sync's rows come from reading the shipped app; its two
blanks are blank because nothing here established them, which is not the same as
knowing they are absent.

### Chunks instead of whole files

A note is cut at boundaries the content chooses, each piece named by its own
hash, and only the pieces the server lacks are sent. Insert a line and the
boundaries either side stay put, so one piece changes.

One line inserted, `cd client && bun run bench`:

| Note | Whole file | Basalt | of that, the entry | |
|---|---|---|---|---|
| 4 KiB | 4.4 KiB | 1.9 KiB | 624 B | 2x |
| 32 KiB | 32.4 KiB | 4.9 KiB | 1.3 KiB | 7x |
| 128 KiB | 128.4 KiB | 5.8 KiB | 2.7 KiB | 22x |
| 512 KiB | 512.4 KiB | 9.6 KiB | 4.8 KiB | 54x |
| 2 MiB | 2.0 MiB | 21.7 KiB | 9.0 KiB | 94x |

Both columns carry the entry, because both protocols send one. Ours names every
chunk of the new version, which is most of what a large note costs and what
bounds the gap: hence sizing by `sqrt(NAME_BYTES * size)` rather than by what
one edit costs alone.

One hash per file is not a mistake. It has fewer moving parts, cannot get a
boundary wrong, and for a vault of small notes the difference is small. It gets
expensive in one place, which happens to be the place people notice: a large
note edited often.

**LiveSync does this too, and first.** The 48-byte window here is theirs. What
differs is where the chunks go: theirs are CouchDB documents, which brings
replication and revision history for free and brings CouchDB.

### Deduplication

| | saves |
|---|---|
| Across different files | 0.11% |
| Across versions of one file | 73% to 90% |

The second is the point, and it is the wire saving above seen from the disk:
today's note is mostly yesterday's. A note edited twenty times stores 26 chunks
for 95 references when short, 41 for 410 when long.

It is also why sealing is deterministic here rather than salted per file, and
**the cost of that is not hidden: the server can tell when two chunks are
identical.** For one person's own machines that is worth it, and
`docs/design.md` says so where somebody deciding can see it.

### Merging

Everyone who merges markdown is doing a three-way merge against a common
ancestor. The differences are which ancestor, which diff, and what happens when
the result cannot be trusted.

- **The ancestor.** `synchash`, one hash per file recording the content as of
  the last sync, fetched by uid when a merge needs it. Obsidian Sync's idea, and
  why no version history is needed to merge. Sync Engine stores the base *text*
  instead: more storage, one fewer fetch, and either answer is defensible.
- **The diff.** Sync Engine wrote its own, an O(NP) comparison after Wu, Manber
  and Myers, over a script-aware splitter: words in English, `Intl.Segmenter`
  for Japanese, Chinese, Thai, Lao, Khmer, Burmese and Tibetan. LiveSync and
  Basalt both use diff-match-patch. So ours is not an unusual algorithm; it is
  **character-granular where theirs is word-granular**, and that cuts both ways.
  Characters merge two devices editing different arguments of one function call.
  Words with real segmentation beat a character diff written for English prose
  at CJK.
- **The four checks**, which are what differs most, and which follow from rule 1
  rather than from cleverness: do the changed regions overlap, do both merge
  orders agree, did every hunk apply, did every insertion survive. Any failure
  writes both versions into the vault. Basalt also merges a re-indented code
  block with a line appended into code that no longer runs, which a region
  splitter would not.

### Speed, and what these numbers do not say

| 2000 files, 400 ms round trip | up | down |
|---|---|---|
| Sync Engine, their machine, Nextcloud over WebDAV | 9.43 min | 5.87 min |
| Basalt, Apple M4 Pro, Go server behind a latency proxy | 3.00 min | 1.89 min |

18 round trips up and 27 down. 2000 arrived, 0 wrong. Their backend is Nextcloud
over WebDAV and ours a local Go process; their CPU is far slower; our latency is
injected on loopback with no jitter; their vault size is not published. Four
reasons the right column should win, none of them the client. **Read it as "tens
of round trips, not thousands", not as a ratio.**

The transfer table above is the speed claim that survives a change of machine,
because it counts bytes, and bytes are what a 400 ms link is short of.

## Where theirs is better

| | Better than Basalt at |
|---|---|
| Obsidian Sync | nothing to run, iOS, years of production finding the edge cases found here by reading code, and whole-file upload has fewer moving parts than chunking plus deterministic sealing plus compression |
| LiveSync | far broader scope, CouchDB replication and history for free, S3, an installed base |
| Sync Engine | storage you already pay for, word-granular diffing with real CJK segmentation, thousands of stars |
| Fast Note Sync | a listing in the community directory, an installed base |
| obsidian-headless | Windows, and a `--conflict-strategy` switch this client does not have |

Basalt has no installed base, no iOS, and does not sync plugins, themes or
config. That last one is still open.

## Against Obsidian Sync, on everything else

| | Obsidian Sync | Basalt |
|---|---|---|
| Where it runs | their servers | your box |
| Cost | subscription | electricity |
| Setup | sign in | run a binary, paste one string |
| A server forging a version | not tested here | refused; every entry is authenticated by its writer |
| Deleted here, changed there | propagates the delete | restores the file |
| Plugins, themes, config | synced | not synced, and still open |
| Mobile | iOS and Android | Android in daily use, iOS untested |
| Version history | in the app | in the app, and restoring never overwrites |
| Maturity | years in production | early |

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
400 ms at 2.6 MiB/s is their published environment.

**A whole vault.** 200 files, 17.8 MiB, Apple M4 Pro. 200 arrived, 0 wrong, on
every row.

| Round trip | Up | Down | 20 notes up | 20 notes down | Nothing changed |
|---|---|---|---|---|---|
| loopback | 11.9 s | 0.62 s | 0.24 s | 0.11 s | 0.00 s |
| 20 ms | 12.7 s | 0.85 s | 0.29 s | 0.13 s | 0.00 s |
| 100 ms | 12.6 s | 1.90 s | 0.44 s | 0.23 s | 0.00 s |
| 400 ms, 2.6 MiB/s | 15.8 s | 10.1 s | 1.07 s | 0.63 s | 0.01 s |

17.8 MiB crosses as 10.8 MiB from compression alone; dedup contributes nothing,
the notes being distinct. Four round trips each way at every latency, and a pass
over a settled vault is unmeasurable.

Three caveats, all of which make the numbers worse rather than better:

- These predate the current handshake. `put`, `putmany`, `get`, `fetch`, the
  chunker and the content key schedule are untouched since, and the golden
  vectors pinning sealed bytes still pass, so a chunk has the same name and
  length it had here. What changed is the cost of connecting, which no row
  measures.
- The download column is slower than this document used to claim, and the
  harness is why. The proxy now applies real back-pressure both ways, so
  2.6 MiB/s is enforced downward: 10.8 MiB cannot arrive in under about four
  seconds and takes ten. The old figure was measured against a link that was
  not really throttling.
- The upload cost is `fsync`, and macOS pays four to six times what Linux does
  because Go issues `F_FULLFSYNC` there. Measured earlier: the same 200 files
  uploaded in 2.8 s on Linux against 12.2 s here, and the 400 ms upload was
  close to link-bound, so there is no large win left in the server for a vault
  of notes. Not repeated since, and quoted as the earlier measurement it is.

**Scale.** Ten thousand notes of distinct prose, 21.1 MiB.

| | 1,000 notes | 10,000 notes |
|---|---|---|
| Chunks, of which distinct | 2,198 / 2,198 | 21,641 / 21,617 |
| Sealed bodies | 0.8 MiB | 8.1 MiB |
| Local index | 0.6 MiB | 5.6 MiB |
| A pass over an unchanged vault | 7 ms | 41 ms |
| Twenty notes edited | 20 chunks, 8.0 KiB | 20 chunks, 8.0 KiB |

Linear in the note count, and editing twenty notes costs the same at any vault
size.

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

**A real vault**, not a generated corpus: 3,751 files, 91 MB, on loopback.

| | |
|---|---|
| First device up | 54 s, 11,307 chunks, 62.7 MiB on the wire (69% of plaintext) |
| Second device down, by invite | 22 s, whole vault |
| Files byte-identical | all of them |
| `verify -deep` | 11,762 chunk references, 0 faults |

An edit, a rename, a merge, a two-device conflict and a deletion all behaved as
documented, and the vault's dot-prefixed folders stayed put.

**The entry authenticator** costs 2.2 microseconds per entry and 149 bytes on
the wire, about 2.7% of a first sync. A globally chained variant that would also
detect a withholding server was 12.7 microseconds, and was rejected for what it
does to concurrent writers, not for its arithmetic.

## Measured and refused

Each of these was built or benchmarked before being turned down.

| | Measured | Why not |
|---|---|---|
| A whole-file fast path for small notes | chunk size already scales as `sqrt(64 * size)`, clamped to a 1 KiB average and a 512 byte floor, so a 4 KiB note is about four chunks and an edit to it 1.9 KiB against 4.4 KiB whole | sends more on every edit, stores about a third more history, and adds a second path through the most durability-critical code. Sizing constants are pinned by a test so the decision cannot drift into a re-chunk |
| A global hash chain | would catch a withholding server | serialises writers |
| One transaction per batch | 10x on the SQL, worth 0.7% of an upload | makes "an ack means durable" a per-batch argument |
| A different deflate level | re-names and re-uploads only the chunks whose compressed output differs | moves no boundary, so it is possible; kept for when it is worth it |
| Different chunk-size targets | boundaries move, so every vault in existence re-chunks | baked into the chunk name |
| Larger chunks, to cut fsyncs | | trades back a size chosen by measurement |
| Solid compression on a first sync | 57% against 60% of plaintext | a second code path through durability-critical client code |
| node-diff3 for the merge | conflicted on 5 of 8 cases that merge cleanly here, including two devices appending to a daily note | worse where it matters |
| A CRDT for the text | considered after fuzzing found four ways the merge could invent text | guarantees convergence, not meaning: two devices editing one line apart still interleave, deterministically, with nothing to flag. Keeping both versions is the safety net rule 1 needs, and a CRDT has no conflict to fall back to |
| Resolving renames at scan time by content hash, instead of the `prev` chain | | identical files are ordinary, a rename plus an edit stops looking like a rename, and delete-then-create becomes a false one. Tested state for an untested guess |
| A server-side streaming import for a first sync | 54 s up and 22 s down for the real vault, once per device | not worth a second path through durable code. Re-measure over tailscale before reopening |
| Merging the four "not acted on" maps | | each came from its own incident and they carry different exit codes. The output was merged into one list with reasons; the model was left alone |
| Naming a chunk by its plaintext | 0 names shared of 126 | see below |
| A local plaintext-to-name map | 2 chunks and 12.5 KiB against 43 and 156 KiB after a parameter change | benefit is zero until somebody retunes a parameter, and it costs a quarter again on the index meanwhile |
| A SQLite index on the client | see below | four milliseconds at ten thousand notes is not a cliff, against passes measured in tens |
| Data-key epochs, re-encryption, per-device signatures | | see below |

**Naming a chunk by its plaintext**, so encoding parameters stop being baked
into the name. Spiked and refused on `spike/hmac-chunk-names`. It decouples the
deflate level and the sealing construction but not chunk size, because moving a
boundary changes the plaintext. The server also stops being able to check
itself, since a name it cannot compute takes put-time verification, frame
matching, the bit-rot check and the deep verify. And nothing but a device
holding the plaintext can map an old name to a new one, so migrating re-uploads
the vault and doubles the store. The naive form, a plain hash, is worse than
neutral: computable by anyone, identical in every vault, and for a small note a
hash of the whole note. Keying it fixes that and costs nothing measurable. Kept
on file for one case only, a construction change that is forced rather than
chosen, where re-sealing under today's naming would rename every chunk and
re-MAC all of history.

**A SQLite index on the client**, to replace rewriting the whole index as JSON:

| notes | index | stringify | durable write | total |
|---|---|---|---|---|
| 1,000 | 0.6 MiB | 0.1 ms | 1.5 ms | 1.6 ms |
| 10,000 | 6.3 MiB | 1.9 ms | 2.1 ms | 4.0 ms |
| 50,000 | 31.6 MiB | 8.6 ms | 5.0 ms | 13.6 ms |

It would also cost a second storage path through the file rule 1 is about, on a
phone where SQLite is least certain to exist. Measured on a laptop SSD, and one
cold run wrote the 50,000 note index in 228 ms rather than 5, so the fsync cost
is real when nothing is cached. A journal was built instead.

**Data-key epochs, re-encryption and per-device signatures** are three things
refused together, because they are asked for together by the same reasoning
about a hostile server. Epochs and re-encryption would make revocation
forward-secret; per-device signatures would make history say which device wrote
a version rather than that a key holder did. The cost is not subtle: a new data
key breaks history recovery for a device that was offline across the epoch,
invalidates deduplication either side of the boundary, makes every existing
backup unreadable by the new client, and needs a migration that rewrites content
the whole design is built on never rewriting. What they buy here is small. The
deployment is one person's machines on a private network, and of the twenty-eight
defects the 2026-09-05 review found, five involved distrusting the server and
every one of those five fires far more often for an honest reason: a replayed
version is what a restored backup looks like, a malformed entry is a buggy client
on another device, an unreadable frame is a proxy. The checks are worth keeping
because they turn a silent wrong answer into a loud refusal; the machinery is
not. Revisit if the vault is ever served from a machine somebody else
administers, which is the requirement that would change the answer.

## What was borrowed

None of their code. Ideas, parameters and bug reports.

| From | Taken | Not taken |
|---|---|---|
| **[LiveSync](https://github.com/vrtmrz/obsidian-livesync)** (MIT), the largest debt | content-defined chunking from `splitPiecesRabinKarp` with its 48-byte window, chunk sizes split by text or binary, a regression test for U+FEFF on a boundary, and the conclusion that text merging is solved | base64 for binary chunks, whole files in memory, and one-way HMAC for paths, all consequences of CouchDB, the last impossible here because a device restoring a vault has to recover the real filename |
| **Obsidian Sync** | `synchash`, one field per file remembering the content as of the last sync, which turns a three-way merge into something needing no version history; and the merge construction | the step discarding which hunks applied |
| **[Sync Engine](https://github.com/hesprs/sync-engine)** | reporting correctness beside speed, the benchmark vault shape, the 400 ms environment, and their issue 232 (`rm` where the platform should trash), a live defect here too | |
| **[Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync)** | issue 257: a path that is a file on one side and a folder on the other, which Basalt retried forever one way and ignored the other | |
| **obsidian-headless** | the lock comparison below, and two settled scope questions (`IMPROVEMENTS.md` I29 and I30): it is fully bidirectional rather than a mirror, and it offers a `--conflict-strategy` switch this client does not have and arguably should | its lease |

Prior art re-derived here rather than invented: git's object write (temp, fsync,
link, fsync the directory) is the shape of the chunk store's publication
barrier; RocksDB and LevelDB withhold visibility until a manifest is durable,
which is what the unproven set does; Kubernetes' liveness and readiness probes
are the distinction `/health` draws; and restic and borg stamp a repository
identifier into a backup rather than recognising it by size, which is what R14
came round to.

## Libraries

| | |
|---|---|
| **diff-match-patch** | the merge. Unmaintained since 2020, pinned to an exact version. `@sanity/diff-match-patch` is a maintained TypeScript fork, evaluated September 2026: better on every axis except the one that decides it, which is that it cannot produce the same diffs. It exports none of the line-mode internals used here, and cannot express the expired deadline `merge.ts` passes, since its `timeout: 0` means unlimited where dmp's `opt_deadline: 0` means expired. Merges would change, and a merge that changes between releases is two devices disagreeing about one note. `IMPROVEMENTS.md` I26 |
| **fflate** | deflate |
| **modernc.org/sqlite** | so the server is one static binary |
| **github.com/coder/websocket** | the transport |

Basalt is MIT, like LiveSync and like Obsidian's own plugin API declarations.

## Locking: five ways of getting it wrong, and the lease we turned down

The CLI's vault lock is the operating system's, and the file beside it only
records who. A crashed basalt releases the vault by dying, and the next one
takes it. The Go server has no part of this problem: `internal/dirlock` calls
`flock`.

That is not where this started. Every hard part of a lock file is staleness: it
outlives the process that made it, so somebody has to decide when it is safe to
remove, and deciding is a read followed by an unlink with a gap in between.

| Attempt | How it handed one vault to two writers | Finding |
|---|---|---|
| Read the lock, then unlink it | the gap between deciding and acting | R03 |
| An eviction marker, a second exclusive `link` naming the holder being evicted | a marker whose own evictor died had to be recovered, which is another read and another unlink | R20 |
| Bucket that marker by a minute of the clock | recovery became safe and left the boundary | R34 |
| Take the lock with `rename`, which unlike `rm` hands back what it took | a caller could identify what it held, but it still removed a name it did not own, so a third contender found the vault free while somebody was in it | R40 |
| Number the claims | a release freed the numbers, and a slow caller was admitted beside the holder by aiming at one that had come back | R44, R49 |
| Generational claims with a fence, where a release marks rather than deletes | 416 lines, and it might be right | |

Five attempts is enough evidence that nobody here can tell. So the sixth answer
is not to decide.

The reason is not that the rule is subtle. "The holder is dead, so I may have
it" is a conclusion drawn from an observation, and between the observation and
the act the holder can be alive again: a recycled pid, a process that had not
finished dying, a second contender reading the same corpse. Nothing in POSIX
offers a compare-and-swap on a file to close that. All five attempts are
different arrangements of the same missing primitive.

The standard answer is a lock the kernel releases when the process dies. It was
believed unavailable, and that belief produced them: `flock(2)` has no binding
in Node, `fs-ext` is a native module and so a build step and a per-platform
binary for a package whose whole shape is "install it and run it", and
`proper-lockfile` uses a directory plus an mtime heartbeat, which is the same
staleness problem rearranged and would not have prevented R03. All true, and the
conclusion drawn from it was wrong. Both supported platforms hand out a
kernel-released exclusion from stock Node:

| | Mechanism | A second attempt gets |
|---|---|---|
| macOS | `open()` with `O_EXLOCK`, spelled as the number `<sys/fcntl.h>` gives it because Node omits it from `fs.constants` | `EAGAIN` |
| Linux | an abstract Unix socket, whose name lives in a kernel namespace rather than on a filesystem, so a killed holder leaves nothing to mistake for a live one | `EADDRINUSE` |

Both were probed with a `SIGKILL`ed holder before anything was built on them,
and `scripts/kernel-lock.test.ts` kills one on every run of the gate, on Linux
in CI too, because a property proven on one of two unrelated mechanisms is
proven for one of them.

So the lock file is a *record* now rather than a claim, and the whole class of
defect above has nothing left to attach to. Three things are deliberately
unchanged: a holder on another machine is still believed, because a kernel
answers for one machine; where the mechanism does not prove itself, a network
mount being the likely case, everything falls back to the file and to
`basalt unlock` and says so on stderr rather than quietly; and on such a
filesystem a crashed sync wedges a cron job until somebody runs one command,
which both the warning and the refusal say exactly.

`basalt unlock` had two windows of its own, both closed rather than reported:

- Taking a lock aside to decide about it frees the name for as long as the
  decision takes, so a `sync` starting in that instant joins the holder. An
  ordinary refusal now reads the lock and touches nothing at all, and only a
  lock already read as abandoned is moved.
- Two overlapping unlocks admit two writers: U1 reads an abandoned lock and
  pauses, U2 clears it, a writer takes the free name legitimately, and U1 then
  renames *that* writer's lock aside. Found by review rather than here.
  `unlock` takes a recovery lock of its own now and a second is refused.

What is left is a lock somebody deleted by hand at exactly the wrong moment. The
put-back uses `link` rather than `rename` so it cannot write over a lock
legitimately taken meanwhile, and where even that fails the command says two
processes may hold the vault and both should be stopped, because a race that
cannot be undone can at least be reported (rule 7).

### The lease, from obsidian-headless 0.0.3

Read out of `obsidianmd/obsidian-headless`, published as `ob`, because it is the
closest thing to a reference implementation of this exact problem and it reached
the opposite answer. It takes a `.sync.lock` **directory** per vault, with a
heartbeat:

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

`mkdir` is the atomic primitive, the holder stamps mtime every second, and a
contender treats a lock older than five seconds as abandoned. Having the source
rather than the package description makes the reason for turning it down
concrete:

| | What goes wrong |
|---|---|
| The lease | a holder paused for more than five seconds (a suspended laptop, a long GC, a stalled disk, `SIGSTOP`, a VM migrating, an `fsync` on a large attachment) is declared abandoned while still running and still writing. `verify()` is called at acquire and at release and never in between, so the displaced holder never learns it was displaced |
| The tie-break's own fallback | `verify()` accepts `Math.floor(e / 1000) === Math.floor(this.lockTime / 1000)`, because many filesystems keep mtime to the second. Two contenders that both find a stale lock and both stamp it inside one wall-clock second therefore both verify, and both proceed. R03's shape with a stopwatch attached |
| `touch()` swallowing every error | a failed `utimes` stops the heartbeat under a live holder, and the lock goes stale while somebody is using it, with nothing said |

Two caveats, because a comparison that only flatters is not worth writing down.
Obsidian Sync is a hosted service with server-side conflict handling and a
`--conflict-strategy` switch, so two writers cost them a conflict where they
would cost this project rule 1; their tolerance is reasonably different from
ours. And their client supports Windows, which neither mechanism here does, and
a lease is at least portable. The lease is the wrong answer for Basalt, not a
mistake in the abstract.
