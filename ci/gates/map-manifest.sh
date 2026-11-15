#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate map-manifest (P3-MAPS-BAKE; SPECIFICATIONS section 6.10, section 14 "Data"): FR-MAP-4, FR-MAP-1, FR-MAP-5, C6.
#   1. The street list (the seeded schedule's points come from it): node ci/data-assets.ts ensure.
#   2. `pnpm run setup:maps`: download each file packages/maps/MANIFEST.json names from its release into .build/data/maps
#      (a copy that already verifies is kept), the routing files of SD-49 included (P6-ROUTE-BAKE), then check size gate,
#      size, SHA-256, bounding box and zoom range of every file. A difference stops with MAP_HASH_MISMATCH <file> (exit 1).
#   3. Coverage: the real track set has a track for every job leg of the demo week and every Sep 15 same-branch pair.
#   4. The real-file tests (packages/maps/vitest.maps.config.ts): the planted 1-byte change stops the check and setup
#      (MAP_HASH_MISMATCH columbus.pmtiles, and over the new files: the tracks file and each routing file), the coverage,
#      the baked steps of every track (SD-49's guarantees, and every step worded in English and Spanish), and the real
#      nginx answering 206 to a range request for each map file and serving no routing file.
#   5. (P6-ROUTE-BAKE) The baked steps, API-104 and the routing service against the Compose stack: ci/route-bake-stack.sh
#      (setup loads the steps, API-104 answers them with the routing service stopped and from the van's position, a world
#      reset keeps them, and the routing service answers the baked route on the Compose network only).
# Steps 1 and 2 stop the gate at once (no verified files, nothing after them means anything); steps 3 to 5 each run to the
# end, and the gate is red when any step was.
# The planted known-bad (1 changed byte in a copy of a map file) fails on every run in step 4; its record for the first
# green run is .build/evidence/P3-MAPS-BAKE/. The files are release downloads, never git (D7).
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
node ci/data-assets.ts ensure || exit 1
node packages/maps/src/cli.ts fetch || exit 1
rc=0
node packages/maps/src/cli.ts coverage || rc=1
pnpm exec vitest run --config packages/maps/vitest.maps.config.ts || rc=1
bash ci/route-bake-stack.sh || rc=1
exit "$rc"
