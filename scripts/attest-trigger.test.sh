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
settings() { grep -v '^ *#' "$workflow"; }

if settings | grep -q "workflow_dispatch:"; then
  ok "it can be started by hand"
else
  fail "there is no workflow_dispatch, so a draft release starts nothing"
fi

if settings | grep -qE "^ *release:"; then
  fail "it listens for a release event, which a draft does not fire"
else
  ok "it does not wait for an event a draft will never send"
fi

# And nothing still reads the tag off an event that no longer arrives: those
# expressions evaluate to empty, which checks out the default branch and
# attests the wrong bytes rather than failing.
if settings | grep -q "github.event.release"; then
  fail "something still reads github.event.release, which is empty under a dispatch"
else
  ok "the tag comes from the dispatch input everywhere"
fi

if grep -q "gh workflow run attest.yml" "$release"; then
  ok "release.sh prints the command that starts it"
else
  fail "release.sh tells nobody to start the workflow, so the draft just sits there"
fi

if [ "$fails" != 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
