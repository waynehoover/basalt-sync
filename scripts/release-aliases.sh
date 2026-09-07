#!/usr/bin/env bash
#
# Every moving image alias, and the version it should point at (R38).
#
# `release-tags.sh` answers "what may *this* release move", which is the right
# question while a release is being decided and the wrong one afterwards. The
# promotion job is serialised, GitHub keeps one pending run per group, and a
# third release arriving discards whatever was waiting. The comment beside that
# said the next promotion would repair the dropped one's aliases, and it is
# only true while releases march up one line: A running, B (0.5.0) pending and
# C (0.3.9) arriving discards B, and C is a backport that may move neither
# `latest` nor `0.5`. B's image exists under its own version tag for ever and
# nothing ever points `latest` at it.
#
# So the promotion reconciles instead of appending. It works out what every
# alias should be from the releases that exist, and sets the ones that are
# wrong. A dropped promotion then costs nothing at all: the next one, from any
# line, in any order, repairs it.
#
# Usage: release-aliases.sh [existing-tags-file]
#
# Prints "<alias> <version>" a line at a time. The argument is the tag list,
# one per line, and defaults to asking git; passing a file is how this is
# tested without a repository full of fixtures.
set -euo pipefail

if [ $# -ge 1 ]; then
  existing=$(cat "$1")
else
  existing=$(git tag --list 'server/v*')
fi

# Stable releases only, and exactly three numeric parts.
#
# A prerelease never holds a moving alias, on either side of the question: not
# as the version an alias points at, and not by keeping one away from the
# newest stable server. Anything that is not MAJOR.MINOR.PATCH is not a release
# this project makes, and guessing at what alias it deserves is how a tag
# nobody meant to publish moves `latest`.
stable=$(
  printf '%s\n' "$existing" \
    | sed -n 's|^server/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -u -V
)
[ -n "$stable" ] || exit 0

echo "latest $(printf '%s\n' "$stable" | tail -1)"

# One alias per minor line that has a stable release in it, pointing at the
# newest release in that line. A backport publishing 0.3.9 moves `0.3` and
# nothing else, and it says so here as well as in `release-tags.sh`.
printf '%s\n' "$stable" \
  | sed -n 's|^\([0-9][0-9]*\.[0-9][0-9]*\)\.[0-9][0-9]*$|\1|p' \
  | sort -u -V \
  | while IFS= read -r minor; do
      top=$(printf '%s\n' "$stable" | grep "^${minor//./\\.}\." | tail -1)
      echo "$minor $top"
    done
