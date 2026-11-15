#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate generator-gates (P2-GENERATOR; SPECIFICATIONS section 6.7, section 14 "Data"): generator-manifest (FR-IMP-5)
# and phone-range-scan (FR-IMP-7), with the checks the generator's acceptance names.
#   1. 2 full generations from seed 20260915 into separate folders, compared byte for byte (the 3 CSVs, the fixture
#      and the truth file).
#   2. generator-manifest: each file's SHA-256 and size equal packages/generator/MANIFEST.json.
#   3. phone-range-scan: no other 555 or real-looking number in any generated file.
#   4. share-none: no fixture customer is in a truth-file pair, and each resolves to exactly 1 customers.csv row (R-BP1).
#   5. truth-check and target-counts: the truth file's pairs and the planted problem rows equal FR-IMP-6's table, and
#      the generated truth file equals the committed one.
#   6. rates: SD-25's before and after periods and the Sep 8 to 14 rate (OI-25).
#   7. booking-windows: no Columbus window is over FR-BOOK-6's 12, 12, 11, 11, 10 bookings (F-201).
# The planted known-bads (a 1-byte change, a sort-order change, a 555-0200 number, a fixture row naming a pair
# customer, a truth file with 811 exact pairs) fail on every run in packages/generator/src/generator.test.ts.
# The generated files live in .build/data/generator (git-ignored; D7: data files are never in git).
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
node ci/data-assets.ts ensure
out=.build/data/generator
rm -rf "$out/gate-run-1" "$out/gate-run-2"
node packages/generator/src/cli.ts generate --out "$out/gate-run-1"
node packages/generator/src/cli.ts generate --out "$out/gate-run-2"
for f in customers.csv visits.csv equipment.csv fixture.json truth.json; do
  cmp "$out/gate-run-1/$f" "$out/gate-run-2/$f" || { echo "generator-gates: FAIL $f differs between 2 runs" >&2; exit 1; }
done
echo "generator-gates: 2 runs byte-identical (customers.csv, visits.csv, equipment.csv, fixture.json, truth.json)"
rc=0
for check in generator-manifest phone-range-scan share-none truth-check target-counts rates booking-windows; do
  node packages/generator/src/cli.ts "$check" --dir "$out/gate-run-1" || rc=1
done
exit "$rc"
