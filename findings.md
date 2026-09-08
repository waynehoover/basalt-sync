# Editorial working notes

Initial inventory: 10 tracked Markdown documents, 40,510 words. README 1,039; comparison 4,935; plugin 4,393; CLI 4,868; server 7,986; design 5,795; protocol 7,452; index journal 1,953; findings 1,398; CLAUDE 691.

Public pages mix acquisition, operating tasks, implementation history, benchmark methods, and internal bug IDs. README leads into wire protocol and security internals; comparison is an engineering notebook. CLI README mixes package instructions with contributor guidance. Server guide needs progressive disclosure, not deletion of recovery precautions.

Engineering reference pages should retain technical specificity; reader intent and navigation must make their audience clear. Working tree clean at start.

Verified current manifest 0.6.0, minimum Obsidian 1.7.2, protocol 5, Node >=22. User docs wrongly say protocol 4. EntryFacts excludes the device label, contrary to design's attribution paragraph. CLI supports --key-file, stdin '-', and --key-out; read-only sync still permits explicit repair uploads. Default examples omitted --read-only despite positioning the CLI as a mirror. Backups retain stale bodies but replace their database snapshot, so preserve a separate pre-purge directory to retain usable history. Avoid separate timed rsync that can race a still-running backup.

Primary sources checked: Obsidian's Sync page/help; LiveSync README and settings. Comparison will focus on hosting, setup, file scope, fit and cost model, with no speed rankings from unlike environments.
