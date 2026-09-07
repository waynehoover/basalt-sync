# Findings

Clean worktree at 09f6b68. Latest commits c51bd6a and 09f6b68 claim R32–R39 closed.

Initial change audit:
- R32: plugin rename failure returns landed:false if destination still exists or cannot be queried. No direct overwrite.
- R33: all adapters now preserve displaced files with no expected digest.
- R35: preserved.* from initial normalization rename; legacy keep/respell removed from reaper allowlist; status exposes stranded files.
- R36: each trash attempt chooses random unoccupied aside. R37: selects destination filesystem staging before move, puts original back on publication failure.
- R34: new eviction renames possibly live lock away, opening its normal name to a third contender; restoring occupied name discards old live lock. Need fresh three-contender repro; no clock boundary now required.
- R38: reconciles all Git stable tags, but selects highest before confirming image exists; failed newer build may prevent promoting newest successfully published image. Zero resolvable aliases incorrectly treats prerelease-only repository as failure.
- R39: whole-workflow per-tag concurrency plus draft guard in checked dependency.

Independent probes: R33 preserved new/unknown-baseline files; R35 current/legacy crash originals survive and are reported; R36 retry keeps A; R37 chooses nearby staging and restores original name on EIO. R34 still broken: stale A takes B's live lock, C acquires empty normal name, A discards B's lock and refuses; B/C both hold release functions.
Workflow probes: original backport case now repairs all aliases; failed newest Git tag keeps latest on older image although a newer valid image exists, and prerelease-only history errors with zero aliases. Draft/private/error gate cases behave correctly. All workflow tools mocked; no external mutation.
Installed Obsidian 1.13.7 desktop rename implementation does _exists(destination) then fsPromises.rename, not atomic no-clobber. Investigate queue scope before deciding whether latest uncommitted 'exclusive create' claim has another remaining runtime limitation.

Installed Obsidian desktop rename performs its existence check and native rename inside the adapter's queue. This serializes the app's own writes. Do not report an external-native-write race as an unqualified Obsidian-editor data-loss defect. Keep actual desktop/mobile acceptance limitation explicit; the new plugin publication uses create and latest tests now correctly hook after rename.
