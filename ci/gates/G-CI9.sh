#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI9, inv9-quiet-hours (P3-OUTBOX activates; P3-REPLAY adds the clock-jump case; SPECIFICATIONS section 14
# item 9, invariant 9; FR-TEXT-7; UC-14; NFR-08).
#   1. ci/gates/G-CI9/vitest.db.config.ts under each host zone of NFR-08's matrix (UTC, America/New_York,
#      America/Los_Angeles): TZ per run and BW_EXPECT_TZ naming it. The set: the NFR-08 DST suite with its host-zone
#      probe, every case file in ci/gates/G-CI9/ by glob (ci/gates/G-CI9/**/*.test.ts: deborah-lin-quiet-hours is this
#      lane's; a later lane adds its own file there and never edits this script), and every outbox test, unit and
#      database. The database tests run with the session TimeZone set to the host zone (F-178 part b), and a fresh
#      PostgreSQL 18 per run (initdb under that TZ) unless BW_TEST_PG_URL names one.
#      Reports: .build/ci/G-CI9/tz-<zone>.json.
#   2. The zone check of G-CI4 over the 3 reports: each zone ran with its probe passing, nothing failed or was skipped,
#      and the 3 runs passed the same tests.
# The known-bad (the try-time quiet-hours recheck removed) was planted once at acceptance (owner ruling cf3b79ea: no
# standing sabotage job); the record is .build/evidence/P3-OUTBOX/.
# Exit 0 only when every step holds; every step runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
out=".build/ci/G-CI9"
rm -rf "$out"
mkdir -p "$out"
rc=0

for zone in UTC America/New_York America/Los_Angeles; do
  slug="${zone//\//_}"
  echo "G-CI9 step 1: the quiet-hours set under TZ=$zone"
  TZ="$zone" BW_EXPECT_TZ="$zone" pnpm exec vitest run --config ci/gates/G-CI9/vitest.db.config.ts \
    --reporter=default --reporter=json ${BW_JUNIT_DIR:+--reporter=junit} --outputFile.json="$out/tz-$slug.json" || rc=1
done

echo "G-CI9 step 2: the 3 zone runs"
node ci/gates/G-CI4/cli.ts zones "$out" || rc=1
# F-373: UC-14's case (Deborah Lin's 7:29 AM Pacific booking text held to 8:00 AM) ran and passed in every zone, by its exact
# title, which must name exactly 1 test (F-636: the words "holds Deborah Lin" also name a quiet-hours unit test).
uc14="holds Deborah Lin's 10:29 AM EDT booking text to 8:00 AM Pacific (11:00 AM EDT) and sends it then"
for zone in UTC America/New_York America/Los_Angeles; do
  node ci/gates/G-CI4/cli.ts pinned "$out/tz-${zone//\//_}.json" "$uc14" || rc=1
done

[ "$rc" -eq 0 ] && echo "G-CI9: ok" || echo "G-CI9: FAIL" >&2
exit "$rc"
