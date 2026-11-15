#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI2, inv2-never-dropped (P3-OUTBOX activates; P3-BILLING adds the billing case; SPECIFICATIONS section 14
# item 2, invariant 2; FR-TEXT-12, FR-BILL-2, FR-BILL-7; UC-06, UC-07).
#   Runs ci/gates/G-CI2/vitest.db.config.ts on PostgreSQL 18 (BW_TEST_PG_URL when set, else the embedded 18.4):
#   - every case file in ci/gates/G-CI2/ by glob, ci/gates/G-CI2/**/*.test.ts. A lane adds its case as its own file
#     there and never edits this script or the config: texts-never-dropped.db.test.ts is the texts case ("All sends
#     fail": tries 1 to 5 at the scheduled demo times, then 1 call list row and 1 alert, never a 6th; Try now counts as
#     the next try); P3-BILLING's billing case (billing Down lists the job until Up) joins the same way;
#   - the outbox's own database tests: the try handler, the event dispatcher, Try now and reply intake.
#   - the JSON report of that run is read (F-373): the UC-06 case passed by name and no test was skipped.
# The known-bad (a retry cap of 3, FR-TEXT-12's own failing case) was planted once at acceptance (owner ruling cf3b79ea:
# no standing sabotage job); the record is .build/evidence/P3-OUTBOX/.
# Exit 0 only when every test passes.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0
echo "G-CI2: every case in ci/gates/G-CI2/ and the outbox database tests, on PostgreSQL 18"
out=".build/ci/G-CI2"
rm -rf "$out"
mkdir -p "$out"
pnpm exec vitest run --config ci/gates/G-CI2/vitest.db.config.ts --reporter=default --reporter=json ${BW_JUNIT_DIR:+--reporter=junit} --outputFile.json="$out/report.json" || rc=1
# F-373: the report is read, not only the exit code: the UC-06 case ran and passed (a deleted case would shrink the glob's set and
# leave the exit code 0), and nothing was skipped.
# The pin is the case's exact title, which must name exactly 1 test (F-636).
node ci/gates/G-CI4/cli.ts pinned "$out/report.json" "gives tries 1 to 5 at 0, 2, 4, 9 and 19 minutes, then 1 call list row and 1 alert, and no 6th try" || rc=1
[ "$rc" -eq 0 ] && echo "G-CI2: ok" || echo "G-CI2: FAIL" >&2
exit "$rc"
