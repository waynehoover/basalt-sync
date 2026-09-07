# Product readiness recommendations

Written 2026-09-07, based on the findings through the seventh verification in
[FOLLOW_UP_REVIEW.md](FOLLOW_UP_REVIEW.md). This is a strategic recommendation,
not a new verification of subsequent implementation changes. The changes below
are proposals, not completed work.

**I would make a focused architectural simplification before shipping.** The
repeated findings justify rethinking a few mechanisms. I would keep the overall
product architecture: one Go server, a shared client engine, encryption, and
recoverable version history.

The review document records successive failures and repairs; it does **not**
mean there are 51 outstanding bugs.

Most findings fall into four groups:

| Class | Examples from these reviews | Underlying problem |
|---|---|---|
| Ownership and races | Two lock owners; edits arriving during replacement or deletion | Checking something does not reserve it for a later action |
| Interrupted operations | Preserved notes becoming hidden; incomplete credential handoffs | Recovery must survive interruption and remain understandable |
| Inconsistent contracts | Different write paths preserving edits differently; verification accepting data the reader rejects | Components disagree about what “safe” or “complete” means |
| Incorrect reporting | “Synced” after failure; recovery pointing at the wrong directory | Status is inferred separately from the actual outcome |

**The first three deserve design attention.** Reporting defects usually need
smaller integration fixes.

A revealing example is the design rule “copy, checksum both ends, then delete.”
That is insufficient if an editor can change the source between verification
and deletion. Another checksum merely moves the race. The operation needs
ownership of the exact version being deleted, or a mechanism that preserves
whatever it displaces.

Changing the security threat model would remove relatively little of this work.
Two processes starting together, a phone suspending, an editor saving during a
download, and a disk becoming unwritable are ordinary operating conditions. A
note-sync product needs to handle them.

You *can* narrow the adversary model. For an initial release, I would explicitly
support trusted devices and trust the server for ordering and availability,
while keeping content and filenames encrypted against the server. The
[design already documents](docs/design.md#what-the-server-can-and-cannot-do)
that authenticated old versions can be replayed. Complete protection against
malicious-server rollback would be a separate protocol project. That limitation
can be an explicit product decision; it cannot be advertised away as complete
protection against a hostile server.

Authentication, encrypted transport, authenticated content, path containment,
and resource limits should remain.

Here is what I would change.

1. **Make the first release’s supported environment much narrower.**

   Ship Obsidian on explicitly tested desktop and Android configurations. Keep
   iOS experimental until exercised. Support local filesystems, and exclude
   overlapping sync tools, nested mounts, and network filesystems initially.

   Allow one Basalt writer per local vault. Multiple devices remain supported,
   and editing while syncing remains essential.

   If Obsidian is the main product, I would keep the general-purpose writable
   CLI experimental. A headless mirror is a narrower initial use case than
   promising safe interaction with arbitrary editors and filesystem layouts.

2. **Replace the custom CLI lock takeover protocol.**

   This has repeatedly produced different versions of the same ownership
   failure. I would stop adding claim generations and tie-breaking rules.

   For supported platforms, use a tested OS-backed locking mechanism. The
   [server already uses that approach](server/internal/dirlock/dirlock.go).
   File-descriptor-based locks can release automatically when the owning
   process exits, avoiding a separate stale-owner election protocol. They still
   require correct integration and filesystem-specific testing.
   [Linux locking documentation](https://man7.org/linux/man-pages/man2/flock.2.html)

   A simpler POC alternative is exclusive acquisition with no automatic
   stale-lock takeover, followed by explicit recovery after writers are
   stopped. Less convenient, but substantially easier to reason about.

   These locks coordinate Basalt processes; they do not prevent an editor from
   saving.

3. **Make safe file replacement a required adapter contract.**

   The engine already has a shared preservation path. Strengthen that boundary:
   every writable adapter must implement the same guarantees for replacement,
   deletion, conflict creation, and restore. An adapter lacking those guarantees
   should refuse the operation.

   Define the outcome precisely: incoming content applied, both versions
   retained, or operation deferred. Any displaced edit must remain durable
   **and discoverable after restart**. Recovery listings and status should use
   the same records.

   For Obsidian text updates, investigate its documented `Vault.process()`
   primitive before relying further on inferred rename behavior. It supports
   checking current content inside an atomic read-modify-write operation. It
   does not solve binary files or an entire multi-step recovery transaction.
   [Obsidian Vault documentation](https://docs.obsidian.md/Plugins/Vault)

   Extend the existing journal where necessary to record unfinished operations.
   Adding another database by itself would not make filesystem operations
   atomic.

4. **Remove features that create disproportionate failure paths.**

   For the first release, I would defer:

   - Automatic irreversible history purging. Keep history, expose storage usage,
     and stop safely when capacity is exhausted.
   - Automatic filename normalization during scans. Report collisions and make
     renaming explicit.
   - Automatic merging, if necessary to stabilize release. Keeping both versions
     is a defensible initial experience.
   - Elaborate release-alias reconciliation. Prefer immutable versions and a
     straightforward promotion process.

   I would retain chunking and the existing encryption design unless evidence
   identifies them as the dominant problem. Rewriting the storage format or
   introducing a CRDT would expand this project substantially.

5. **Change the completion criterion from repaired examples to demonstrated
   guarantees.**

   The regression tests are valuable. However, fixing one ordering and testing
   that ordering has repeatedly left another ordering broken.

   Build a small fault-injection harness around locking and file application:
   pause between steps, introduce competing writes, fail operations, restart,
   and verify that every relevant edit remains recoverable. Exercise the actual
   platform adapters as well as mocks. SQLite’s practice of moving failure
   injection through successive operations is a useful model.
   [SQLite testing](https://sqlite.org/testing.html)

I would also prioritize findings more sharply. A defect admitting two writers
blocks shipping that writable client. A misleading recovery path deserves a
quick fix because recovery must be usable. An unusual corrupted-database
ordering case deserves correction, but it does not carry the same immediate
risk—particularly if destructive purge is unavailable.

For a public beta, my release gate would be: exclusive Basalt ownership,
recoverable interrupted writes, honest status, successful restoration from a
fresh installation, and testing on every advertised platform. Before making
strong security claims, I would also get an independent review of the
encryption and key-recovery protocol.

**The next implementation assignment should be to simplify ownership and
formalize the file-operation contract, with explicit acceptance guarantees.**
That would address the recurring causes and give the subsequent fixes a much
firmer foundation.
