#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fetch and verify every git-ignored release-asset file into an export folder, on the host (gh), so the wave CI container
# (no gh, no GitHub token) receives verified files in the tar. Called by ci/wave-run.sh; usage: wave-fetch-assets.sh <export-dir>.
# The export's own copy of each script and manifest is used, so the data matches exactly the sha under test.
# A failed fetch or a bad hash is RED (exit 1), never a skip.
#   F-164 / F-195: the street-list data files (.build/data), then a no-fetch re-check that prints a line either way.
#   F-361:         the map files and the baked track set (packages/maps/MANIFEST.json, .build/data/maps), same two steps.
#   P6-ROUTE-BAKE: with the routing files of SD-49 (--with-routing), so the wave run's map folder holds every file the manifest names:
#                  the map-manifest gate checks them (its 1-changed-byte arm included) and a stack gate's routing service can read them.
set -euo pipefail
X="${1:?usage: wave-fetch-assets.sh <export-dir>}"
red() { echo "RED: $1" >&2; exit 1; }
node "$X/ci/data-assets.ts" ensure --dir "$X/.build/data" || red "fetching and verifying the release-asset data files failed (F-164)"
node "$X/ci/data-assets.ts" ensure --no-fetch --dir "$X/.build/data" || red "the export has no verified release-asset data files; not starting the container (F-195)"
node "$X/ci/data-assets.ts" ensure --with-routing --manifest "$X/packages/maps/MANIFEST.json" --dir "$X/.build/data/maps" || red "fetching and verifying the map files failed (F-361)"
node "$X/ci/data-assets.ts" ensure --no-fetch --with-routing --manifest "$X/packages/maps/MANIFEST.json" --dir "$X/.build/data/maps" || red "the export has no verified map files; not starting the container (F-361)"
