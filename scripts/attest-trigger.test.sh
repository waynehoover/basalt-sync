#!/usr/bin/env bash
#
# The attestation workflow can actually be started (R29).
#
# It publishes the release as its last step, so the release has to exist as a
# draft before it runs, and a draft is exactly what GitHub will not tell it
# about: `created`, `edited` and `deleted` are documented as excluding draft
# releases, and `published` is the thing this workflow is supposed to do rather
# than hear about. A workflow listening for a release event therefore sat there
# with nothing running, on the documented flow, and looked fine.
#
# So it runs on `workflow_dispatch` and `release.sh` prints the command beside
# the one that makes the draft. This reads the shipped files and asserts both
# halves, because the tempting edit is to add the release trigger back for
# convenience, and the way that fails is silence.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$root/.github/workflows/attest.yml"
release="$root/scripts/release.sh"
fails=0

fail() {
  printf '  FAIL %s\n' "$1" >&2
  fails=$((fails + 1))
}
ok() { printf '  ok   %s\n' "$1"; }

echo "starting the attestation:"

# Settings only. Every one of these is quoted in the paragraph above it, so a
# plain grep would find the explanation with the setting itself deleted.
settings() { grep -v '^ *#' "$@"; }

if settings "$workflow" | grep -q "workflow_dispatch:"; then
  ok "it can be started by hand"
else
  fail "there is no workflow_dispatch, so a draft release starts nothing"
fi

if settings "$workflow" | grep -qE "^ *release:"; then
  fail "it listens for a release event, which a draft does not fire"
else
  ok "it does not wait for an event a draft will never send"
fi

# And nothing still reads the tag off an event that no longer arrives: those
# expressions evaluate to empty, which checks out the default branch and
# attests the wrong bytes rather than failing.
if settings "$workflow" | grep -q "github.event.release"; then
  fail "something still reads github.event.release, which is empty under a dispatch"
else
  ok "the tag comes from the dispatch input everywhere"
fi

if grep -q "gh workflow run attest.yml" "$release"; then
  ok "release.sh prints the command that starts it"
else
  fail "release.sh tells nobody to start the workflow, so the draft just sits there"
fi

# ---- and that its target is still private (R39) ----------------------------
#
# Both upload steps replace assets with `--clobber`, which is safe against a
# draft and against nothing else: a rerun against a published release swaps the
# bytes people are downloading, and a rebuild that differs or an upload that
# fails partway leaves a public release whose checksums describe files it does
# not have. Being draft-only was the whole of the ordering and nothing asked.
#
# The gate belongs in `checked`, which both upload jobs need, so it is asked
# once and asked before the first mutation. Asserted by job, because a check
# placed beside the upload instead would read the same to a grep of the file.
checked=$(
  awk '/^  checked:/ { inside = 1; next } inside && /^  [^ #]/ { inside = 0 } inside' "$workflow"
)
if printf '%s\n' "$checked" | settings | grep -q "isDraft"; then
  ok "it establishes the release is a draft before anything is uploaded"
else
  fail "nothing checks the draft state, so a rerun replaces a public release's files"
fi

# And that job can actually see a draft.
#
# The check above asks whether the step is there, which it was while the job
# could not read the thing it checks: GitHub shows a draft release only to a
# token with push access, so `contents: read` makes `gh release view` answer
# "release not found" and the whole gate fails closed on every release. That
# is a safe failure and a broken one, and it survived a review because the
# step existed and read correctly.
if printf '%s\n' "$checked" | grep -qE "^      contents: write"; then
  ok "and can read one, which needs write: a draft is hidden from a read-only token"
else
  fail "the checked job cannot see a draft release, so every release fails at the gate"
fi

# And two runs against one release do not interleave: one replacing assets
# while the other publishes is the same exposure by another route.
if settings "$workflow" | grep -q "group: attest-"; then
  ok "one run per release at a time"
else
  fail "two runs on one tag can clobber each other's assets while a third step publishes"
fi

if [ "$fails" != 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
