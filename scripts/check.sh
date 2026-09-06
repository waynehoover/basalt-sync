#!/usr/bin/env bash
#
# Everything CI runs, run here, in one command.
#
# This exists because of a shipped regression. `bun run test` is one of nine
# checks CI runs, and the stress suite is a separate command and a separate
# job. A release went out on a green `bun run test` while `bun run stress` had
# been failing the whole time, on this machine, catching exactly the bug that
# shipped. "The tests pass" was true and meant less than it sounded.
#
# So: one command, and a guard below that fails when CI grows a step this
# script does not know about. The two cannot drift, because drifting is itself
# a failure.
#
# Exit 0 means every check CI runs and this machine can run passed here.
# Nothing else means that. A check that could have run here and did not is a
# failure, not a footnote, because the whole lesson is that a partial pass
# reads exactly like a complete one. Pass --skip-docker to accept that one
# deliberately.
#
# The one exception is a check this platform cannot run at all, of which there
# is currently one: systemd's opinion of the unit, on a machine with no systemd.
# Those are listed at the end under "only in CI" and do not change the exit
# code, because a script that is amber for ever on the machine it is mostly run
# on is a script nobody reads the colour of. See `only_in_ci` below for the line
# between that and a skip.
set -uo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)
skip_docker=0
[ "${1:-}" = "--skip-docker" ] && skip_docker=1

pass=0 fail=0 skipped=0 elsewhere=0
failed_names=()
skipped_names=()
elsewhere_names=()

# Each entry is a CI step name, so the guard can compare against the workflow.
run() { # run <ci step name> <working dir> <command...>
  local name=$1 dir=$2; shift 2
  printf '\n\033[1m==> %s\033[0m (%s)\n' "$name" "${dir:-.}"
  if ( cd "$root/${dir:-.}" && "$@" ); then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); failed_names+=("$name")
  fi
}

skip() { # skip <ci step name> <why>
  printf '\n\033[1m==> %s\033[0m SKIPPED: %s\n' "$1" "$2"
  skipped=$((skipped + 1)); skipped_names+=("$1")
}

# only_in_ci is for a check this machine cannot run and never will (I20).
#
# Different from `skip`, and the difference is the point. A skip is a check that
# could have run here: no docker daemon today, one tomorrow, and the run is
# amber until it does. A macOS machine will not grow systemd, so counting that
# as a skip would make this script exit 2 for ever on the machine it is mostly
# run on, and a signal that is always amber is a signal nobody reads. That is
# the failure this whole script exists to prevent, arriving by another door.
#
# So it is reported, listed at the end, and does not change the exit code. What
# it must never be used for is a check that is merely inconvenient here: the
# test is whether this platform can run it at all.
only_in_ci() { # only_in_ci <ci step name> <why>
  printf '\n\033[1m==> %s\033[0m ONLY IN CI: %s\n' "$1" "$2"
  elsewhere=$((elsewhere + 1)); elsewhere_names+=("$1")
}

gofmt_clean() {
  local out; out=$(gofmt -l .)
  [ -z "$out" ] || { echo "not gofmt'd:"; echo "$out"; return 1; }
}

# ---- server ----------------------------------------------------------------
run "gofmt" server gofmt_clean
run "vet" server go vet ./...
run "test" server go test -race ./...
run "the systemd unit verifies" server go test -race -run 'TestService' ./cmd/basaltd/

# ---- systemd's own opinion of that unit -------------------------------------
#
# The test above checks the unit against what this project meant to write, which
# is this repository agreeing with itself. Whether systemd accepts it is a
# different question, and on a machine with no systemd it cannot be asked (I20).
# Skipped rather than passed, for the reason the whole script exists: "could not
# run" and "passed" are different sentences, and exit 2 says which.
systemd_accepts() {
  local unit; unit=$(mktemp)
  go -C "$root/server" build -o "$(dirname "$unit")/basaltd" ./cmd/basaltd
  "$(dirname "$unit")/basaltd" service -data /var/lib/basalt -addr 0.0.0.0:3003 \
    -vault default -user basalt -binary /usr/local/bin/basaltd -max-file 134217728 > "$unit"
  systemd-analyze verify "$unit"
}
if command -v systemd-analyze >/dev/null 2>&1; then
  run "systemd accepts the unit" "" systemd_accepts
else
  only_in_ci "systemd accepts the unit" "there is no systemd on this machine"
fi

# ---- the client suite on a filesystem of its own ----------------------------
#
# CI builds a loopback ext4 image, mounts it, and points TMPDIR at it, so every
# vault the suite makes lands on a filesystem that is not the runner's root
# (I20). That needs a mount and therefore root, and a check script that sudos is
# a check script nobody runs. So it is named here and executed only in CI, which
# is the honest version of both facts.
only_in_ci "a filesystem of its own, mounted" \
  "it needs a loopback mount, and this script does not ask for root"

# ---- the compose pin -------------------------------------------------------
run "the pinned image is not behind the newest server release" "" \
  bash "$root/scripts/pin-check.sh"

# ---- the publish gate ------------------------------------------------------
run "the publish gate refuses an unchecked commit" "" \
  bash "$root/scripts/ci-passed.test.sh"
run "the tags a release may move are the right ones" "" \
  bash "$root/scripts/release-tags.test.sh"
run "the image release promotes in order" "" \
  bash "$root/scripts/release-order.test.sh"
run "every action is pinned to a commit" "" \
  bash "$root/scripts/actions-pinned.sh"

# ---- the restore rehearsal -------------------------------------------------
#
# Behind a build tag, so it is not one of the six hundred tests above that a
# -run filter can skip without saying so, and run here for the same reason the
# stress suite is: a recovery path tested only in docs is a rumour, and the
# runbook it executes is the one nobody finds out is wrong until the day the
# live directory is gone.
run "the backup restores, verifies and serves what it held" server \
  go test -tags rehearsal -run TestRestoreRehearsal -count=1 ./cmd/basaltd/

# ---- client ----------------------------------------------------------------
# ---- the filesystem this is running on --------------------------------------
#
# CI runs the client suite twice, on Linux and on macOS, because a dozen tests
# ask the disk whether it folds case and skip when it does not (I18). Here it
# runs once, on whatever this machine is, and says which kind that was: a green
# run on a case-sensitive box has skipped the case-folding half, and a green run
# on a case-folding one has skipped the other, and neither says so by itself.
folds_case() {
  local d; d=$(mktemp -d)
  printf 'probe' > "$d/CaseProbe.tmp"
  if [ -f "$d/caseprobe.tmp" ]; then
    echo "this filesystem folds case, so the case-folding tests ran here"
  else
    echo "this filesystem is case-sensitive, so the case-folding tests skipped here."
    echo "CI runs them on macOS; see the client-case-folding job."
  fi
  rm -rf "$d"
}
run "this runner folds case" "" folds_case

run "install" client bun install --frozen-lockfile
run "format" client bun run format:check
run "typecheck" client bun run typecheck
run "test" client bun run test
run "compression golden, under bun" client bun run src/core/compression-golden.run.ts
run "build" client bun run build
run "the packed CLI installs and runs under node" "" \
  bash "$root/scripts/pack-check.sh"

# ---- the panel states ------------------------------------------------------
#
# The walk that writes client/panel-shots/, which CI uploads as an artifact.
# Run here as well, and not only because the guard below insists: the artifact
# is the thing somebody looks at when a layout bug is suspected, and a walk
# that has stopped working is worth finding on the machine where the panel is
# being changed rather than after the push.
#
# Already inside `bun run test` above. Run again by name for the same reason
# `compression golden, under bun` is: the CI job it mirrors runs exactly this
# and nothing else, and a step this script covered only incidentally is a step
# it would stop covering the day the other command changed.
run "capture every panel state" client bunx vitest run src/plugin/panel-shots.test.ts

# The one that was missed. Its own command, its own job, and not part of
# `bun run test`.
run "stress" client bun run stress

# ---- docker ----------------------------------------------------------------
if [ "$skip_docker" = 1 ]; then
  skip "build the image" "asked to"
  skip "it runs" "asked to"
  skip "the compose file is valid" "asked to"
elif ! docker info >/dev/null 2>&1; then
  skip "build the image" "no docker daemon"
  skip "it runs" "no docker daemon"
  skip "the compose file is valid" "no docker daemon"
else
  run "build the image" "" docker build -t basalt:ci .
  run "it runs" "" docker run --rm basalt:ci version
  run "the compose file is valid" "" docker compose -f compose.yaml config -q
fi

# ---- the guard: CI must not grow a step this script does not know about ----
#
# Matching on step names rather than on commands, because three CI steps are
# inline shell blocks and comparing those textually would break on whitespace.
printf '\n\033[1m==> every CI step is covered here\033[0m\n'
missing=()
while IFS= read -r name; do
  grep -qF "\"$name\"" "$root/scripts/check.sh" || missing+=("$name")
done < <(sed -n 's/^ *- name: *//p' "$root/.github/workflows/ci.yml")
if [ ${#missing[@]} -gt 0 ]; then
  echo "CI runs steps this script does not:"
  printf '  %s\n' "${missing[@]}"
  echo "Add them above, or this command means less than it says."
  fail=$((fail + 1)); failed_names+=("every CI step is covered here")
else
  echo "ok"
  pass=$((pass + 1))
fi

# ---- what actually happened ------------------------------------------------
printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$pass" "$fail" "$skipped"
# One per line. These names have commas in them, so a comma-joined list reads
# as more entries than there are.
if [ ${#elsewhere_names[@]} -gt 0 ]; then
  printf 'only in CI:\n'
  printf '  %s\n' "${elsewhere_names[@]}"
fi
[ ${#failed_names[@]} -eq 0 ] || printf 'failed:  %s\n' "$(IFS=', '; echo "${failed_names[*]}")"
[ ${#skipped_names[@]} -eq 0 ] || printf 'skipped: %s\n' "$(IFS=', '; echo "${skipped_names[*]}")"

if [ "$fail" -gt 0 ]; then exit 1; fi
if [ "$skipped" -gt 0 ]; then
  echo
  echo "Not everything CI runs ran here, so this is not a green run."
  exit 2
fi
echo
echo "Everything CI runs passed here."
