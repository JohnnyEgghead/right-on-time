#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate restore-test (P3-BACKUP; BUILD_PLAN D-15 gate map; SPECIFICATIONS 11.7; NFR-07, NFR-10, OQ-12). Wave gate, critical.
# The local proofs of backup.sh, restore-test.sh, retention.sh and hosted-check-server.sh (infra/backup/tests/backup.stack.test.ts,
# 8 tests), against the backup stack of infra/backup/tests/stack.sh: real PostgreSQL 18 with the seeded world, and an
# S3-compatible server for the lightsail target. The hosted half is the manager's hosted check (infra/backup/hosted-check.sh), never this gate.
#   1. Stack up under the gate's own Compose project, bw-gate-backup (BW_RESTORE_GATE_PROJECT may add a suffix:
#      bw-gate-backup-<lowercase>), so it never meets a lane's bw-w16-backup or a review's bw-w16-backup-rev. A stack left
#      by an earlier killed run of the same project is removed first.
#   2. The stack suite (infra/backup/tests/vitest.stack.config.ts), with a JSON report.
#   3. The report: every test passed, 0 skipped and 0 todo (a skip is a switched-off proof, F-387), and at least 8 tests
#      (the 8 proofs; a shrink is red).
# Exit: the stack's own exit code when it cannot start (3: no docker), else the suite's own exit code, else 1 when the report
# check fails, else 0.
# Torn down on every exit path: a trap on EXIT (INT and TERM exit through it), and a reaper outside the process group for
# the SIGKILL ci/run-gates.ts sends to the whole group at the gate's cap (the shape of ci/events-stack.sh, F-132).
# The stack's state (bucket folder, S3 keys, mode 600) lives under .build/ci/restore-test/ (git-ignored, inside the tree),
# not in $TMPDIR: the runner container bind-mounts it, and in the wave run's layout only /work is shared by the CI container
# and the engine (F-126), so a /tmp path would resolve on the engine's own disk.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root" || exit 2

own_project() { [[ "$1" =~ ^bw-gate-backup(-[a-z0-9][a-z0-9-]*)?$ ]]; }
work="$root/.build/ci/restore-test"
stack_down() { BW_BACKUP_PROJECT="$1" TMPDIR="$work" bash infra/backup/tests/stack.sh down >/dev/null 2>&1 || true; }

if [ "${1:-}" = "--reap" ]; then
  if [ "$#" -ne 3 ] || ! own_project "$3"; then echo "restore-test --reap: refused (args)" >&2; exit 2; fi
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3"
  exit 0
fi

project="${BW_RESTORE_GATE_PROJECT:-bw-gate-backup}"
own_project "$project" || { echo "restore-test: FAIL project name '$project' is refused (bw-gate-backup or bw-gate-backup-<lowercase>)" >&2; exit 2; }
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "restore-test: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
mkdir -p "$work"
report="$work/$project-report.json"
rm -f "$report"

reaper=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  stack_down "$project"
  echo "restore-test: stack $project down"
  if [ -n "$reaper" ]; then kill "$reaper" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
reaper="$(node -e '
  const c = require("node:child_process").spawn("bash", process.argv.slice(1), { detached: true, stdio: "ignore" });
  c.unref();
  console.log(c.pid);
' "$0" --reap "$$" "$project")"
echo "restore-test: project $project, state $work/$project, reaper pid $reaper"

stack_down "$project"
t0=$(date +%s)
up_rc=0
BW_BACKUP_PROJECT="$project" TMPDIR="$work" bash infra/backup/tests/stack.sh up || up_rc=$?
if [ "$up_rc" -ne 0 ]; then
  echo "restore-test: FAIL the backup stack did not start (stack.sh up exited $up_rc)" >&2
  exit "$up_rc"
fi
echo "restore-test: stack up in $(( $(date +%s) - t0 )) s"

t0=$(date +%s)
suite_rc=0
BW_BACKUP_PROJECT="$project" BW_PROOF_STATE="$work/$project" \
  pnpm exec vitest run --config infra/backup/tests/vitest.stack.config.ts --reporter=default --reporter=json ${BW_JUNIT_DIR:+--reporter=junit} --outputFile.json="$report" || suite_rc=$?
echo "restore-test: suite exited $suite_rc in $(( $(date +%s) - t0 )) s"
[ "$suite_rc" -eq 0 ] || { echo "restore-test: FAIL the stack suite exited $suite_rc" >&2; exit "$suite_rc"; }

# shellcheck disable=SC2016 # a JavaScript program, not shell
node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const tests = r.testResults.flatMap((f) => f.assertionResults);
  const by = (s) => tests.filter((t) => t.status === s).length;
  const passed = by("passed"), skipped = by("skipped") + by("pending") + by("disabled"), todo = by("todo");
  console.log(`restore-test: report: ${tests.length} tests, ${passed} passed, ${skipped} skipped, ${todo} todo, ${r.numFailedTests} failed`);
  for (const t of tests) console.log(`  ${t.status} ${t.fullName}`);
  const bad = [];
  if (passed !== tests.length || r.numPassedTests !== r.numTotalTests) bad.push("not every test passed");
  if (skipped + todo + r.numPendingTests + r.numTodoTests > 0) bad.push("a skipped or todo test is a switched-off proof");
  if (tests.length < 8) bad.push(`${tests.length} tests, fewer than the 8 proofs`);
  if (bad.length) { console.error(`restore-test: FAIL ${bad.join("; ")}`); process.exit(1); }
' "$report" || exit 1
echo "restore-test: ok"
exit 0
