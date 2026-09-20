#!/usr/bin/env bash
# Runs the remaining spike jobs one at a time. They are deliberately NOT
# parallel: two headless Chromium instances contend badly enough to move the
# per-step browser and latency numbers this whole evaluation is about.
#
#   op run --env-file=.env.baseline.op -- ./run-all.sh
set -u
cd "$(dirname "$0")"
LOG=~/jev-eval/runs
mkdir -p "$LOG"

step() {
  local name="$1"; shift
  echo "=== $(date +%H:%M:%S) START $name ===" >&2
  npx tsx src/main.ts "$@" > "$LOG/$name.log" 2>&1
  echo "=== $(date +%H:%M:%S) END $name (exit $?) ===" >&2
}

step capture        capture
step dataset        dataset
step phase2a        phase2a
step phase2a-text   phase2a-text
step phase1         phase1
step baseline-fixtures baseline-fixtures
step baseline-tasks    baseline-tasks
echo "=== $(date +%H:%M:%S) ALL DONE ===" >&2
