#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Nightly gate G-CI4-nightly (P3-CI-CADENCE; BUILD_PLAN section 3 D-15; SPECIFICATIONS section 14 item 4; invariant 4; NFR-08).
# The nightly half of G-CI4 (ci/gates/G-CI4.sh runs the committed cases, the real tree, DbClock and schema-time-zone-check, and
# the time package under 3 zones). Owner ruling Nov 2, 2026, "Daily + phase close": "At nightly: every merge-set test under 3 zones."
#   Every merge-set test (the root vitest.config.ts: the unit project) under host
#   zones UTC, America/New_York and America/Los_Angeles: TZ per run, BW_EXPECT_TZ naming it, and the host-zone probe in
#   packages/time/src/dst.test.ts must pass in each report, so a run that never changed zone fails. The 3 zones must pass the same
#   tests. Reports: .build/ci/G-CI4-nightly/tz-<zone>.json (its own folder: the push half's G-CI4 folder is left alone).
# A merge-set test that passes only under one zone is red here and green in the push run's G-CI4.
# A skipped or todo test is red, except the 2 Mac-only tests named in ci/gates/G-CI4/accepted-skips.ts (F-1422, owner ruling
# 341a9f4e, "Gate accepts the 2 named"); the zone check names each accepted skip, and a stale entry there is red.
# Exit 0 only when every zone held; every zone runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
out=".build/ci/G-CI4-nightly"
rm -rf "$out"
mkdir -p "$out"
rc=0

for zone in UTC America/New_York America/Los_Angeles; do
  slug="${zone//\//_}"
  echo "G-CI4-nightly: every merge-set test under TZ=$zone"
  TZ="$zone" BW_EXPECT_TZ="$zone" pnpm exec vitest run --reporter=json ${BW_JUNIT_DIR:+--reporter=junit} --outputFile.json="$out/tz-$slug.json" >"$out/tz-$slug.log" 2>&1 || rc=1
done
node ci/gates/G-CI4/cli.ts zones "$out" || rc=1

[ "$rc" -eq 0 ] && echo "G-CI4-nightly: ok" || echo "G-CI4-nightly: FAIL" >&2
exit "$rc"
