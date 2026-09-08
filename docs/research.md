# Engineering notes and measurements

[Developer documentation](development.md) · [Product comparison](compared.md)

These are historical measurements and design evaluations, condensed from the
former technical comparison page. They were **not rerun for the September 8,
2026 documentation review**. Do not present them as current-release benchmarks
or as a speed ranking against another product. The original methods and results
remain in `git show 573617c:docs/compared.md`.

## Reproduce before making a claim

From `client/`:

```bash
bun run bench          # chunking, sealing, transfer sizes
bun run bench:sync     # complete sync with latency and bandwidth controls
bun run scale          # larger note collections
bun run dedup          # reuse across files and versions
```

Record the source commit, runtime, hardware, corpus, latency, bandwidth, and
byte-for-byte correctness alongside timings. Check that the proxy applies
back-pressure in both directions. The benchmark fixtures and their output are
the starting point; a past table is not a substitute for a new run.

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
