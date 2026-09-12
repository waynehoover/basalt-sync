# Open work

Two things are known, deliberate, and not done. Both are recorded here rather
than in a comment because both are decisions somebody could reasonably make
differently, and each says what would change the answer.

## Downloads hold a whole copy of the file

`assemble` builds the entire plaintext in one buffer before anything is
written, and the inbox holds the sealed bodies until the file lands. So a
download peaks at roughly twice the file's size, on whichever device has the
least memory.

Uploads have not done this since `streamScan`: they cut and name a 256 MiB file
without ever holding it, and above 8 MiB `planUpload` keeps only offsets and
re-seals a chunk when the server asks for it. The asymmetry is the whole of why
the server's `-max-file` defaults to 64 MiB.

The fix is to stream the assembly: write each chunk into a staging file as it
is opened, verify, then rename into place. That removes both copies and makes
the ceiling a question about disks. It touches `land`, `writePreserving` and
both vault adapters, and it has to keep the preserving write exactly as it is,
which is why it is its own piece of work rather than a flag.

Ente Photos does exactly this, for the same reason, with libsodium's
`secretstream` in place of these chunks. Their scheme is not one to copy
wholesale: a chained stream makes every chunk's ciphertext depend on its
position, so nothing dedupes, which is fine for an archive of immutable photos
and wrong for a vault of notes people edit. The part worth copying is that they
never hold a file.

**Before changing the default:** the 2.7 MB per MiB in
[store.go](../server/internal/store/store.go) was measured before the
single-buffer assembly and the windowed sealing landed, so the number the
64 MiB default rests on is no longer true. Measure peak resident on a phone for
one large attachment first.

## A pass still re-decides the whole vault

Every pass rebuilds the combined path set, sorts it, visits every path and
copies the remote map, and the journal then compares every record to find what
changed. At ten thousand local and ten thousand remote records that is twenty
thousand comparisons to establish that a settled pass has nothing to write.

Driving reconciliation from a work set instead, dirty paths plus incoming paths
plus due retries, with derived indexes maintained in place and explicit
mutations handed to the journal, is the largest recurring saving available.

It is not done because the measurement does not yet justify the risk. An
unchanged pass at ten thousand notes is 33 ms with a healthy watcher
([research.md](research.md)), which is not a duration anybody feels, and the
change is a rewrite of the code that decides what happens to somebody's notes.
A work set that misses a path is a note that stops syncing and says nothing,
which is the failure rule 1 and most of the test suite exist to prevent.

**What would change the answer:** Android, at ten thousand and fifty thousand
notes, from a saved file to verified content on a peer, with listing,
reconciliation, journal comparison and filesystem time separated. If
reconciliation dominates there, it is worth doing. Until then it is a rewrite
justified by an estimate.
