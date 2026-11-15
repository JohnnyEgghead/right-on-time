#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate schema-gates (P2-SCHEMA; SPECIFICATIONS section 3, invariant 4, SD-40): schema-doc-parity and
# schema-time-zone-check on a real PostgreSQL 18, plus @bw/db's database test set.
#   1. The database test set (packages/db/vitest.db.config.ts): migrations on an empty database rolled forward 3
#      times, the runner's re-run semantics, foreign keys and privileges as the real roles, the report_visit view,
#      1 repository per entity, and every planted known-bad in ci/gates/schema-gates/cases failing for its stated
#      reason (W-38: on every run, not once).
#   2. The real schema, once, through the gate CLI: its output is the record.
# PostgreSQL: BW_TEST_PG_URL when set, else the embedded 18.4 from the lockfile install (no Docker, no network), so it
# runs the same on this Mac, in the push CI container and in the wave container on Spectre.
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
pnpm exec vitest run --config packages/db/vitest.db.config.ts
# F-92 pattern: print the output before a failed run can abort the script; check it with here-strings, not a pipe.
rc=0
out="$(node ci/gates/schema-gates/cli.ts 2>&1)" || rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || exit "$rc"
for w in '^schema-doc-parity: ok \(PostgreSQL 18\.' '^schema-time-zone-check: ok \('; do
  grep -qE "$w" <<<"$out" || { echo "schema-gates: FAIL the real-schema record is missing: $w" >&2; exit 1; }
done
