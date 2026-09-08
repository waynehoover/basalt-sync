# Documentation editorial pass

Goal: make Basalt's README and user documentation useful to prospective users and operators, with concise, credible marketing and accurate setup instructions.

## Phases
- [complete] Audit every tracked Markdown document, current product behavior, navigation, and comparison claims.
- [in_progress] Rewrite README, comparison, plugin and CLI guides; separate server setup, operations, and reference.
- [pending] Organize engineering material and record a concise editorial audit.
- [pending] Check commands against source, links/anchors/assets, document size, and final diff.

## Decisions
- Preserve useful engineering evidence in clearly labeled maintainer/reference pages.
- Avoid unsupported superiority, speed, security, and platform claims.
- No application logic changes or broad application tests for prose. User additionally authorized the chosen subtitle across product metadata and GitHub About; no release publishing.
- Planning files are temporary working notes and will be removed after completion.

## Errors
- Initial combined document read exceeded output budget; use bounded individual reads.
- apply_patch rejects delete/add of the same path; use literal heredocs to replace whole documents.
- Obsidian's old help URL returned a not-found page; official current sources are under obsidian.md/help and obsidian.md/sync.
- Search used a nonexistent server/internal/protocol directory; the package is server/internal/wire.
