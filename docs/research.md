# Engineering notes and measurements

[Developer documentation](development.md) · [Product comparison](compared.md)

This page records dated measurements and design evaluations. The historical
transfer tables were **not rerun for the September 8, 2026 documentation
review**; newer measurements state their own methods below. Do not present
these as a speed ranking against another product. The original transfer results
remain in `git show 573617c:docs/compared.md`.

## Reproduce before making a claim

From `client/`:

```bash
bun run bench          # chunking, sealing, transfer sizes
bun run bench:sync     # complete sync with latency and bandwidth controls
bun run bench:cadence  # saved-edit latency with production sync timers
bun run scale          # larger note collections
bun run dedup          # reuse across files and versions
```

Record the source commit, runtime, hardware, corpus, latency, bandwidth, and
byte-for-byte correctness alongside timings. Check that the proxy applies
back-pressure in both directions. The benchmark fixtures and their output are
the starting point; a past table is not a substitute for a new run.

## Interactive sync cadence

Measured after plugin 0.6.5 with Bun 1.4.2 on an Apple M4 Pro.
`bench:cadence` uses a real local Go server, real encryption, in-memory vaults,
and simulated Obsidian events. It verifies complete contents at both ends.
Five samples per case, in milliseconds:

| Saved edit → receiving client | Initial timing fix | No note cooldown |
|---|---:|---:|
| New note | 121–138 | 121–139 |
| Repeat edit, 100 ms after the preceding version arrived | 906–922 | 124–129 |
| Incoming update, sender forced to isolate reception | 70–75 | 73–76 |

An earlier 0.6.5 reproduction took 28.6 seconds for a repeat edit and 28.4
seconds for an incoming update, despite a 16 ms upload. It exposed an upload
cooldown applied to downloads and deferred work waiting for the 30-second poll.
The first fix reduced repeat-upload intervals to 1/2/5 seconds and scheduled
their deadlines. The follow-up removed that additional wait for notes and
other recognized text formats, including canvases, while keeping 50 ms event
batching at that stage. Binary attachments retain the size-based cooldown.

Regressions cover consecutive note and canvas uploads, attachment deadlines,
busy event streams, shutdown, idle clients, and simultaneous edits. A plugin
integration test saves sixty successive edits in three bursts, verifies every
paragraph on the peer, and checks that only three history versions were made.

The inspected Obsidian 1.13.7 code uses 10/20/30-second upload cooldowns and
keeps retrying while they expire. This is a scheduling comparison, not an
end-to-end benchmark against official Sync. The measurements start at a file
save; they exclude Obsidian's editor autosave delay. Phone storage, suspension,
network delay, and large vault scans are outside the loopback measurement.

A separate native acceptance check of the initial fix used Obsidian 1.13.7,
about 3,942 indexed files and folders, and the real self-hosted server. With
Obsidian in the foreground, a new note was acknowledged in 98 ms and three
repeat edits in 919–927 ms. Each saved version was fetched back and compared
byte for byte; the temporary note was trashed and its server deletion verified.
The same check in a hidden window reported about 3 seconds per upload with
Electron's background timer throttling enabled. Foreground and background
timings should be reported separately.

Repeating that native check after removing the note cooldown gave 118 ms for
a new note and **100–121 ms for five repeat edits**. These are saved-file to
server-acknowledgement times, not phone-delivery measurements. All six versions
were fetched back and matched exactly; the temporary note's deletion synced.

## Resume and attachment scheduling

The protocol 6 follow-up keeps the same note event batching. Resume now probes
an idle socket with a two-second timeout and interrupts reconnect backoff;
active transfers retain their normal progress deadlines. Simultaneous resume
and keepalive requests share one ping. Tests cover missed saves after resume,
wake-ups during connection teardown, and an active transfer during a probe.

A controlled `bench:cadence` case delays attachment reads by 500 ms while a
note is saved in the same event batch. With alphabetical processing, five note
deliveries took **623–644 ms**. Processing text first and flushing its transfer
queue before preparing attachments reduced that to **123–129 ms**. Every note
and attachment was verified. Ordinary repeat edits measured **122–126 ms**.
These use the same loopback setup as above, not a measured phone-storage delay.
An attachment already transferring still occupies the serial transport until
it completes; this change prioritizes work waiting to start.

Device delivery confirmation is separate from these transfer timings. A device
reports a completed checkpoint only after its files and index have been saved.
The server holds that receipt in memory, and an open visible panel refreshes
it once per second. Tests withhold confirmation during a blocked replacement,
a failed replacement, and a failed index save. A disconnected device is shown
as unconfirmed; receipt metadata is not a backup guarantee.

Native acceptance used the full plugin in a separate Obsidian 1.13.7 test vault
(320 existing files), a temporary protocol 6 server, and a second client with
an in-memory vault. In the final build, foreground saved-file delivery measured
130 ms for a new note and 133/140 ms for repeat edits. Suppressing the plugin's
file event and then dispatching the online signal delivered the missed edit in 86 ms.
Every version matched on both clients, the peer reported its applied checkpoint,
and the temporary note's deletion synced. This tests the desktop runtime and
resume wiring; it does not establish Android suspension behavior.

The full suite also exposed an acknowledgment-ordering defect: an upload could
be marked synced before a preceding peer update finished metadata verification.
The existing stale-upload check then missed the competing edit. A gated
two-client regression reproduced the loss of one working version. Uploads now
wait for already-received metadata to finish verification before committing
their local sync state. The preservation regression and all three upload reply
paths failed before the fix and pass with it; failed verification also refuses
the local commit. No extra network request or timer is involved.

Repeating the benchmark with that fix measured **123–126 ms** for ordinary
repeat edits and **123–128 ms** beside the delayed attachment, with exact
contents checked. These are development-tree results, not a published release
or evidence of an upgrade on the phone.

## Removing event-window latency

The next scheduling pass removed the fixed 50 ms wait at each client, using
the next event-loop turn to group saves. An arrival pass waits for its snapshot
of already-received metadata to finish verification. New frames cannot extend
that wait. Initial catch-up is now explicitly excluded from automatic arrival
passes; a regression reproduced premature reconciliation under the old timer.

With 2,000 unchanged notes, the same `bench:cadence` workload measured repeat
edits at **129–132 ms before** and **23–32 ms after**. Notes beside a delayed
attachment measured **23–33 ms after**. A 200-note event burst took 1.34 seconds
before and 1.27 seconds after; this small throughput difference is not a general
speed claim. The sender used one pass in both runs. The receiver used four
passes before and thirteen after: earlier delivery trades additional scans for
less batching. Every generated note and attachment matched exactly. These are
loopback measurements with memory vaults, not mobile network results.

Run `BASALT_BENCH_NOTES=2000 bun run bench:cadence` to repeat the larger-vault
workload; its output includes pass counts and content verification. The serial
queue still bounds active work and combines requests waiting to start. A second
transport, partial-vault scans, and interrupting an attachment already in flight
remain deferred; they need separate preservation tests and real-device profiles.

The accompanying UI changes make the offline sync action reconnect immediately,
combine repeated manual requests, and show sustained activity even when each
individual file finishes quickly. Fast automatic passes keep a steady status.

Native acceptance of this build used the same 320-file Obsidian test vault and
local memory peer. With the test window visibly foregrounded, delivery measured
18 ms for a new note, 11/17 ms for repeat edits, and 11 ms for a missed file
event followed by an online signal. Contents, peer checkpoints, and deletion of
the temporary note were verified. Background-window samples ranged from 9 to
36 ms and are separate from the foreground result. These small desktop samples
do not predict phone latency or suspended-app behavior.

## Transfer feedback

The panel now shows transfer direction, file or batch identity, and encrypted
body bytes moved. Counters exclude reused chunks and continue across split
downloads. They do not imply a saved file or a completed sync. Tests hold back
socket draining, later download bodies, and the index save to check those
boundaries; a three-file batch sharing two chunks verifies exact retained
content and counts each transferred chunk once.

With transfer callbacks enabled and 2,000 unchanged notes, `bench:cadence`
measured repeat edits at **22–31 ms**, compared with **23–32 ms** in the previous
run. Notes beside a delayed attachment took **21–31 ms**. The 200-note burst took
1.29 seconds with one sender pass and eighteen receiver passes. These are small
loopback samples; the differences do not establish a speedup or a regression.

Native Obsidian acceptance verified a random 2 MiB attachment at both ends,
the real upload counter, and cleanup. Foreground note delivery measured 35 ms
for a new note, 27/26 ms for repeat edits, and 21 ms after an online signal.
This sample was slower than the previous native sample; neither is a phone
measurement or a controlled comparison with official Sync. All test files and
the temporary plugin were removed through Obsidian.

The final local gate passed all 30 checks: 1,585 client tests, 15 panel checks,
and 24 stress tests. Native screenshots cover desktop and phone-width transfer
layouts; phone previews do not test the Android or iOS runtime.

## Pairing a populated vault

Inspected Obsidian 1.13.7's bundled Sync implementation on September 8, 2026.
Connecting a vault that contains files opens a merge confirmation with Continue
and Cancel. There is no first-sync strategy selector. After connecting, Sync
offers folder exclusions and a separate Start syncing action. Its
[onboarding for another device](https://obsidian.md/help/sync/setup) also offers
creating a new local vault from the remote vault.

Basalt uses the populated-vault confirmation and lets empty vaults proceed
directly. Its filesystem check runs before consuming an invite, including when
Obsidian's loaded-file cache is incomplete. Basalt still preserves divergent
versions according to its existing conflict rules; this UI change does not adopt
Sync's initial same-path resolution by modification time. An automatic
backup-and-replace workflow was deferred because it would need a separate,
resumable recovery design.

## Transfers and history

Historical transfer after inserting one line, including entry metadata in both
columns. The whole-file column is a baseline, not a measurement of a competing
service.

| Note size | Whole-file baseline | Basalt | Entry metadata within Basalt total |
|---|---|---|---|
| 4 KiB | 4.4 KiB | 1.9 KiB | 624 B |
| 32 KiB | 32.4 KiB | 4.9 KiB | 1.3 KiB |
| 128 KiB | 128.4 KiB | 5.8 KiB | 2.7 KiB |
| 512 KiB | 512.4 KiB | 9.6 KiB | 4.8 KiB |
| 2 MiB | 2.0 MiB | 21.7 KiB | 9.0 KiB |

Content-defined boundaries let most chunks survive a small edit. An entry still
lists every chunk in the new version, which limits the saving for large notes.
The chunk-size target balances that list against the changed content sent.

The recorded deduplication sample saved **0.11% across different files** and
**73–90% across versions of one file**. Repeated edits, rather than unrelated
notes containing the same text, motivated the design. Deterministic sealing
also reveals equality of chunks within a vault; see [the threat model](design.md).

## Whole-vault sync

Apple M4 Pro; 200 distinct files, 17.8 MiB plaintext and 10.8 MiB transferred
after compression. All 200 files arrived byte-identical on every row.

| Round trip / bandwidth | Initial upload | Initial download | 20 edited notes up | 20 edited notes down |
|---|---|---|---|---|
| Loopback | 11.9 s | 0.62 s | 0.24 s | 0.11 s |
| 20 ms | 12.7 s | 0.85 s | 0.29 s | 0.13 s |
| 100 ms | 12.6 s | 1.90 s | 0.44 s | 0.23 s |
| 400 ms / 2.6 MiB/s | 15.8 s | 10.1 s | 1.07 s | 0.63 s |

These runs predate the current handshake and exclude its connection cost. The
reported download figures incorporate a correction to the bandwidth proxy;
earlier figures did not enforce the download limit. Upload time was sensitive
to macOS flushing costs. Neither these measurements nor earlier Linux runs
establish current performance on a phone or across the public internet.

A separate real-vault run recorded 3,751 files and 91 MB: 54 seconds up,
22 seconds down on loopback, and 62.7 MiB transferred. All files matched;
`verify -deep` checked 11,762 chunk references with no faults. That is evidence
for that run, not a general durability guarantee.

## Scale and attachment memory

| Historical scale run | 1,000 notes | 10,000 notes |
|---|---|---|
| Local index | 0.6 MiB | 5.6 MiB |
| Unchanged pass | 7 ms | 41 ms |
| Twenty edited notes | 20 chunks / 8.0 KiB | 20 chunks / 8.0 KiB |

The attachment run used the **headless client**, which streams content:

| File | Peak process memory | Sync time |
|---|---|---|
| 16 MiB | 144 MB | 0.4 s |
| 64 MiB | 220 MB | 1.6 s |
| 256 MiB | 291 MB | 6.5 s |

These are not mobile memory bounds. Large files may be read whole by a plugin
adapter. The server defaults to 64 MiB per file; the 256 MiB run required a
higher limit.

## Client index

The old full-JSON rewrite was measured on a laptop SSD:

| Notes | Snapshot | Serialization | Durable write | Total |
|---|---|---|---|---|
| 1,000 | 0.6 MiB | 0.1 ms | 1.5 ms | 1.6 ms |
| 10,000 | 6.3 MiB | 1.9 ms | 2.1 ms | 4.0 ms |
| 50,000 | 31.6 MiB | 8.6 ms | 5.0 ms | 13.6 ms |

One cold write of the 50,000-note snapshot took 228 ms. The warm figures should
not be used to dismiss flush latency. Basalt now uses a [shared journal](index-journal.md)
to avoid rewriting the full snapshot on every changed pass. SQLite or IndexedDB
would require additional platform-specific storage integration.

## Evaluated alternatives

These record decisions at the time of evaluation. Revisit them when requirements
or measurements change, with compatibility and preservation tests.

| Alternative | Evaluation and tradeoff |
|---|---|
| Whole-file path for small notes | More transfer and history storage in the sample, plus a second write path. |
| Global authenticated history chain | Could strengthen completeness checks, but the evaluated design serialized concurrent writers. |
| One transaction per batch | SQL work improved about tenfold, but saved only 0.7% of the measured upload and changed acknowledgement boundaries. |
| Solid compression for initial sync | 57% versus 60% of plaintext in the sample; a second transfer path for a modest saving. |
| Different chunk boundaries | Changes chunk identities and causes existing content to be uploaded again. |
| Plaintext-derived chunk names | A keyed design decoupled some encoding choices but removed the server's ability to recompute names from stored bodies. Migration still required devices holding plaintext. |
| Local plaintext-to-name cache | Helped a parameter-change experiment but increased the index; little benefit without such a change. |
| `node-diff3` | Conflicted on five of eight cases that the existing merge handled in that evaluation. |
| CRDT text model | Convergence alone does not establish that combined edits preserve meaning. A different editing and recovery model would need separate evaluation. |
| Rename detection from content equality | Identical files and rename-plus-edit cases make equality alone ambiguous. |
| Streaming server import | The recorded first-sync cost did not justify another durable ingestion path; remeasure for larger vaults and real networks. |
| Alternative codec (I25) | Encoded bytes affect chunk identities. Require a measured benefit and a migration plan; see the historical review evidence. |
| Diff-match-patch fork (I26) | The evaluated fork produced different diffs and lacked equivalent line-mode/deadline behavior. A dependency swap would change merge results. |

Data-key epochs, re-encryption, and device signatures could strengthen access
revocation and author attribution. They also require key distribution, history
and backup compatibility, and migration work. They are outside the current
personal-device scope. The [design](design.md#what-the-server-can-and-cannot-do)
states the resulting limits; these mechanisms are not inherently impossible.

### Locking

Earlier file-lock recovery schemes repeatedly admitted two writers during stale
holder checks and removal. The historical findings are R03, R20, R34, R40,
R44, R49, and RR1 in the [findings index](findings.md).

The supported CLI now uses kernel-managed exclusion: `O_EXLOCK` on macOS and
an abstract Unix socket on Linux. Process death releases it. The accompanying
file records the holder. A foreign holder or unavailable mechanism still needs
manual handling; this does not add support for network filesystems.

The comparison with `obsidian-headless` 0.0.3 examined a timed lease. Basalt chose
kernel exclusion because a paused writer must not become a second active owner
when its heartbeat expires. That version-specific evaluation is preserved in
the original page, rather than presented as a claim about today's product.

## Credits and dependencies

These projects informed Basalt's design and regression cases:

| Project | Influence |
|---|---|
| [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | Content-defined chunking, the 48-byte window, a BOM-boundary regression, and text-merge approaches. |
| [Obsidian Sync](https://obsidian.md/sync) | Remembering the last synced content as a merge base; shipped-app behavior also informed protocol review. |
| [Sync Engine](https://github.com/hesprs/sync-engine) | Correctness checks beside benchmarks, corpus shape, latency scenarios, and trash behavior. |
| [Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync) | A regression involving a file/folder collision at the same path. |
| [obsidian-headless](https://github.com/obsidianmd/obsidian-headless) | Locking, read-only mirror, and conflict-policy evaluations. |

The old source comparison recorded LiveSync 1.0.27 (`dd280a4`), Sync Engine
3.1.4 (`edb9d42`), and Fast Note Sync 2.4.0 (`1bfb406`). Those observations are
historical, not a maintained feature matrix. Use the [product comparison](compared.md)
for current user-facing guidance.

The client uses `diff-match-patch` for merging and `fflate` for compression;
the server uses `modernc.org/sqlite` and `github.com/coder/websocket`. Exact
versions live in the package manifests and lockfiles. Changes that affect sealed
bytes or merge output need compatibility tests, even when the replacement API
looks equivalent.
