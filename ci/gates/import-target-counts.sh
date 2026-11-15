#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate import-target-counts (P2-IMPORT; REQUIREMENTS FR-IMP-6, FR-IMP-3; SPECIFICATIONS section 6.7 "Target counts").
# Property: the import's dry run of the real generator output reports exactly every number of REQUIREMENTS.md's
# FR-IMP-6 table, and its exact and likely pair sets equal the committed planted-truth file
# (packages/generator/truth.json); 811 exact matches, or any other count, fails.
#   1. The export: the generator's real output from seed 20260915, checked byte for byte against
#      packages/generator/MANIFEST.json (generator-manifest), so the gate reads the export setup reads.
#   2. The import's database tests and the gate's own planted cases (ci/gates/import-target-counts/vitest.db.config.ts,
#      W-38: every run): the dry run leaves every table unchanged, the real run, merges and undo, re-runs, and a planted
#      truth file with 1 exact pair removed failing the pairs property (through the checker and through this CLI).
#   3. The real path, once, through the gate CLI: a fresh PostgreSQL 18 database, the dry run as bw_web, its report
#      read back from import_run; its output line is the record, with the OQ-19 match-stage time.
#   Step 2 also runs P2-SETUP's database tests (packages/setup: the fresh end-to-end `pnpm run setup` and its planted
#   known-bads; D-3: "a fresh setup end to end on every change").
#   4. (P2-SETUP) The Compose stack after a fresh setup: ci/setup-stack.sh (an own-copy stack with no database env file,
#      F-96; setup from the image; API-130 and the Call numbers). Needs docker (the wave run's own engine, F-126); no
#      docker is a red (exit 3), never a skip.
# PostgreSQL for steps 2 and 3: BW_TEST_PG_URL when set, else the embedded 18.4 from the lockfile install (no Docker).
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
node ci/data-assets.ts ensure
out=.build/data/generator/import-gate
rm -rf "$out"
node packages/generator/src/cli.ts generate --out "$out"
node packages/generator/src/cli.ts generator-manifest --dir "$out"
pnpm exec vitest run --config ci/gates/import-target-counts/vitest.db.config.ts
# F-92 pattern: print the output before a failed run can abort the script; check it with here-strings, not a pipe.
rc=0
res="$(node ci/gates/import-target-counts/cli.ts --dir "$out" --measure 2>&1)" || rc=$?
printf '%s\n' "$res"
[ "$rc" -eq 0 ] || exit "$rc"
grep -qE '^import-target-counts: ok \(PostgreSQL 18\.' <<<"$res" || { echo "import-target-counts: FAIL the record line is missing" >&2; exit 1; }
bash ci/setup-stack.sh
