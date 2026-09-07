# Progress

Started fourth verification. Source hashes and previous review saved in /tmp/basalt-review-round4.

The live-tree check returned 24 passed, 1 failed (plugin/vault.test.ts), while another process edited plugin/vault.ts, its tests, and docs/design.md. Captured 09f6b68 plus current tracked changes in a separate detached worktree. Final validation will use this stable snapshot. Original application edits are not ours and must be preserved.

Corrected validation launch: first snapshot-check command inadvertently retained the root working directory. Stopped that owned check process tree after ~13 seconds; restarting from the snapshot workdir. Its partial log is superseded.

Workflow probe first hit macOS Bash 3.2 lacking lowercase substitution. Corrected only its fixed mock repository/image expression; production selection loop is unchanged. Re-running before treating results as evidence.

First isolated snapshot finished 24/1: new plugin regression hook ran before the move rather than after. Implementer subsequently added afterRename and corrected the test, added a final create existence check and CLI regressions. Captured final-worktree.patch against 09f6b68 and refreshed only the private snapshot. Running final complete gate there. Independent latest plugin probes all pass.
