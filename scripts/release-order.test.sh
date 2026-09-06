#!/usr/bin/env bash
#
# The workflow decides which tags to move at the moment it moves them (R17).
#
# The failure this guards is an ordering, not a value. Release A starts while
# it is the newest and works out that it may take `latest`. Release B is
# tagged, builds, and promotes a newer version. A finishes last and applies the
# answer it worked out twenty minutes earlier, moving `latest` backward onto an
# older server. Both pass their own digest checks, because each is checking its
# own image.
#
# Two things stop it, and neither is visible from the tag script alone: a
# concurrency group so two promotions cannot overlap, and re-running the
# decision inside the promotion step so it cannot be stale by the time it is
# used. Both live in the workflow, so this reads the workflow.
#
# Asserted rather than trusted because the tempting edit is to hoist that
# `release-tags.sh` call back out of the promotion step into the earlier one,
# where it reads more tidily and is wrong.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$root/.github/workflows/release.yml"
fails=0

fail() {
  printf '  FAIL %s\n' "$1" >&2
  fails=$((fails + 1))
}
ok() { printf '  ok   %s\n' "$1"; }

echo "the image release:"

# One promotion at a time.
if grep -q "group: image-promotion" "$workflow"; then
  ok "promotion is serialised by a concurrency group"
else
  fail "the image job has no concurrency group, so two releases can promote at once"
fi

# And a queued one waits rather than being thrown away: an immutable version
# tag that never got published is a release that silently did not happen.
# Comment lines dropped first: the paragraph above the setting quotes it, so a
# plain grep finds the explanation even when the setting itself has been
# flipped, which is a check that cannot fail.
if grep -v '^ *#' "$workflow" | grep -A 3 "group: image-promotion" | grep -q "cancel-in-progress: false"; then
  ok "a queued release waits rather than being cancelled"
else
  fail "a queued release is cancelled, so its version tag is never published"
fi

# The decision is made inside the step that applies it.
promote=$(awk '/name: give the checked image its names/,/^      - name: the published/' "$workflow")
if printf '%s' "$promote" | grep -q "release-tags.sh"; then
  ok "the tags are worked out inside the promotion step"
else
  fail "the promotion step applies a decision made somewhere earlier, which can be stale"
fi
if printf '%s' "$promote" | grep -q "git fetch --tags"; then
  ok "it refreshes the tags before deciding"
else
  fail "it decides from whatever tags the checkout had, which predates any release that overtook it"
fi

# And nothing carries a precomputed list forward.
if grep -q "steps.tags.outputs.refs" "$workflow"; then
  fail "a precomputed tag list is still being used; that is the stale answer"
else
  ok "no precomputed tag list is carried past the build"
fi

if [ "$fails" != 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
