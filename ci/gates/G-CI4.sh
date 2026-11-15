#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI4, inv4-one-clock-zoned-times (P2-TIME; SPECIFICATIONS section 14 item 4; invariant 4; FR-DEMO-2, NFR-08).
#   1. The committed cases (ci/gates/G-CI4/cases, W-38: every run): no-system-clock with the repo's eslint.config.mjs
#      must fail each planted clock read (the acceptance plant: Date.now() in apps/web) and pass the clean ones; the
#      realNow call-site listing must fail each planted bad call (the acceptance plant: an unlisted tag); the zone check
#      must fail a report with no probe, a failure, or nothing passed; the use tags equal sections 4.2 and 11.3.
#   2. The real tree: no clock read outside packages/time/src/real.ts (inline config off, so an eslint-disable comment
#      cannot hide one), and the listing of every realNow call site with its tag.
#   3. The time package (packages/time, the DST suite of NFR-08 among it) under host zones UTC, America/New_York and
#      America/Los_Angeles: TZ per run, BW_EXPECT_TZ naming it, and the host-zone probe in packages/time/src/dst.test.ts
#      must pass in each report, so a run that never changed zone fails. Reports: .build/ci/G-CI4/tz-<zone>.json.
#      This is the push half (P3-CI-CADENCE, owner ruling Nov 2, 2026, "Daily + phase close": "At the wave: the time
#      package under 3 zones"). Every merge-set test under 3 zones is the nightly gate G-CI4-nightly (ci/gates/G-CI4-nightly.sh).
#   4. DbClock on the real system.demo_clock (PostgreSQL 18).
#   5. schema-time-zone-check on the real migrated schema (section 14 item 4 names it in this gate too).
# Exit 0 only when every step holds; every step runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
out=".build/ci/G-CI4"
rm -rf "$out"
mkdir -p "$out"
rc=0

echo "G-CI4 step 1: committed cases"
pnpm exec vitest run ci/gates/G-CI4/cases.test.ts || rc=1

echo "G-CI4 step 2: the real tree"
node ci/gates/G-CI4/cli.ts tree || rc=1

for zone in UTC America/New_York America/Los_Angeles; do
  slug="${zone//\//_}"
  echo "G-CI4 step 3: the time package under TZ=$zone"
  # --project unit: the root config's one project, named so the run reads the merge set of packages/time only.
  TZ="$zone" BW_EXPECT_TZ="$zone" pnpm exec vitest run --project unit packages/time --reporter=json ${BW_JUNIT_DIR:+--reporter=junit} --outputFile.json="$out/tz-$slug.json" >"$out/tz-$slug.log" 2>&1 || rc=1
done
node ci/gates/G-CI4/cli.ts zones "$out" || rc=1

echo "G-CI4 step 4: DbClock on the real clock row"
pnpm exec vitest run --config ci/gates/G-CI4/vitest.db.config.ts || rc=1

echo "G-CI4 step 5: schema-time-zone-check"
tzrc=0
tzout="$(node ci/gates/schema-gates/cli.ts --only tz 2>&1)" || tzrc=$?
printf '%s\n' "$tzout"
if [ "$tzrc" -ne 0 ] || ! grep -qE '^schema-time-zone-check: ok \(' <<<"$tzout"; then
  echo "G-CI4: FAIL schema-time-zone-check did not report ok" >&2
  rc=1
fi

[ "$rc" -eq 0 ] && echo "G-CI4: ok" || echo "G-CI4: FAIL" >&2
exit "$rc"
