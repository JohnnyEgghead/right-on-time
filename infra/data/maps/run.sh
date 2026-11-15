#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P3-MAPS-BAKE (SPECIFICATIONS section 6.10, D7): the build-time bake of the 3 per-branch PMTiles files and the baked track set.
# Run from anywhere:  bash infra/data/maps/run.sh
# Needs: node 24+, the pmtiles CLI 1.31.2, curl, shasum, the verified street list (node ci/data-assets.ts ensure), and a
# docker context (default "spectre", x86-64: the OSRM bake reproduces only on x86-64, so this script passes no --platform).
# Output goes to $OUT (default .build/data/maps): columbus.pmtiles, dayton.pmtiles, springfield.pmtiles, tracks.ndjson,
# the routing files ohio.osrm.* (P6-ROUTE-BAKE), legs.json, SHA256SUMS, timings.txt. Then:
#   node packages/maps/src/cli.ts write-manifest   (after an intended re-bake)
# TILES=0 skips step 1 (the 3 PMTiles cuts), for a re-bake of the tracks and routing files only: the map files stay the
# release files they are.
#
# P6-ROUTE-BAKE (SPECIFICATIONS v0.13 SD-49, section 6.10): every route request asks OSRM for its steps, mapped by
# packages/maps/src/steps.ts (shipped into the bake container with tracks.ts), and every .osrm* routing file of the same
# OSRM run (--algorithm mld) comes back for the routing service. Each routing file is checked against the per-file size
# gate (sizeGateBytes, 2 GiB, GitHub's release-asset limit, owner ruling be2d3f8a): a file over it stops the run, named
# with its size (BUILD_PLAN section 11 item 26: the extract is never re-cut and no file is split to fit).
#
# Differences from the S8 spike script it replaces (infra/data/s8/run.sh; F-17, F-18, F-19):
#   - the Geofabrik extract is compared with its pinned SHA-256 and the run stops on a difference; a cached file is
#     re-hashed, never trusted for being non-empty (F-17);
#   - 1 EXIT trap removes the container, network and volume, whatever step failed; every name is prefixed $NAME (F-17);
#   - the script waits for osrm-routed by asking it for a route, up to 120 s (bake.mjs), not a fixed sleep (F-17);
#   - the legs come from the seeded schedule (packages/maps/src/legs.ts), not a model with assumed technician counts (F-18);
#   - the bake runs in the repo's pinned node image; the python 3.13 and alpine 3.22 images, both under 14 days old, are
#     not used at all (F-19, docs/build/P1-REPO-pins.md);
#   - the S8 street source (streets.py) is not baked again: the street list is the P2-STREETS release asset.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/infra/data/maps"
OUT="${OUT:-$ROOT/.build/data/maps}"
IN="${IN:-$ROOT/.build/data/maps-src}"
NAME="${NAME:-bw-w16-maps}"
D="docker --context ${BW_DOCKER_CONTEXT:-spectre}"
PM_BUILD=20260811
OHIO=ohio-261001.osm.pbf
OHIO_URL="https://download.geofabrik.de/north-america/us/$OHIO"
OHIO_SHA=183e5129c8779663b53999d6ddd1c30b84b15bad1f0f4e20c1c7e25569ea1261 # docs/build/spikes/G-S8-DATA-SIZES.md "Ohio extract"
NODE=node@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c # 26.12.1-bookworm-slim (P1-REPO-pins.md)
OSRM=ghcr.io/project-osrm/osrm-backend@sha256:55dbfd47d984c2cacd64e32901b4321c86b5ec761438e69aa053dc78698a786f # tag v26.10.0-debian
VOL="$NAME-vol"
NET="$NAME-net"
CTR="$NAME-osrm"
TILES="${TILES:-1}"
GATE=2147483648 # packages/maps/MANIFEST.json sizeGateBytes
mkdir -p "$OUT" "$IN"
: > "$OUT/timings.txt"
timed() { local t0 label="$1"; shift; t0=$(date +%s); "$@"; echo "$label $(( $(date +%s) - t0 )) s" | tee -a "$OUT/timings.txt"; }

cleanup() {
  $D rm -f "$CTR" >/dev/null 2>&1 || true
  $D network rm "$NET" >/dev/null 2>&1 || true
  $D volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# 1. Map files: 3 branch cuts, zoom 0 to 15, from the pinned Protomaps build (HTTP range requests; map data, outside the
#    14-day rule, owner ruling 9c0e9264). The boxes are infra/data/s8/boxes.json (the one table).
SRC="https://build.protomaps.com/$PM_BUILD.pmtiles"
box() { node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).boxes[process.argv[2]];console.log(b.join(","))' "$ROOT/infra/data/s8/boxes.json" "$1"; }
if [ "$TILES" = 1 ]; then
  for f in columbus dayton springfield; do
    pmtiles extract "$SRC" "$OUT/$f.pmtiles" --bbox="$(box "$f")" --maxzoom=15
    pmtiles verify "$OUT/$f.pmtiles"
  done
fi

# 2. Ohio extract: dated Geofabrik file. A cached copy is used only when its SHA-256 equals the pin (F-17).
if [ ! -s "$IN/$OHIO" ] || [ "$(sha "$IN/$OHIO")" != "$OHIO_SHA" ]; then
  rm -f "$IN/$OHIO.part"
  curl -fsSL -o "$IN/$OHIO.part" "$OHIO_URL"
  mv "$IN/$OHIO.part" "$IN/$OHIO"
fi
GOT="$(sha "$IN/$OHIO")"
if [ "$GOT" != "$OHIO_SHA" ]; then
  echo "maps-bake: FAIL $OHIO sha256 $GOT, pinned $OHIO_SHA" >&2
  exit 1
fi
echo "maps-bake: $OHIO sha256 equals the pin"

# 3. Legs of the seeded schedule (FR-MAP-5).
node "$ROOT/packages/maps/src/cli.ts" legs --out "$OUT/legs.json"

# 4. Remote: volume, extract, OSRM prepare, route every leg. Inputs go through stdin (a bind mount of a local path would
#    name a path on the remote host).
$D volume create "$VOL" >/dev/null
$D run --rm -i -v "$VOL:/d" "$NODE" sh -c 'cat > /d/ohio.osm.pbf' < "$IN/$OHIO"
$D run --rm -i -v "$VOL:/d" "$NODE" sh -c 'cat > /d/legs.json' < "$OUT/legs.json"
# The step mapping and the polyline decoder, the same files the server and the live client import (SD-49: 1 code).
COPYFILE_DISABLE=1 tar -C "$ROOT/packages/maps/src" -cf - steps.ts tracks.ts | $D run --rm -i -v "$VOL:/d" "$NODE" sh -c 'mkdir -p /d/lib && tar -x --no-same-owner -C /d/lib'
for step in "osrm-extract -p /opt/car.lua /d/ohio.osm.pbf" "osrm-partition /d/ohio.osrm" "osrm-customize /d/ohio.osrm"; do
  # shellcheck disable=SC2086
  timed "${step%% *}" $D run --rm -v "$VOL:/d" "$OSRM" $step
done
# The routing files come back before the legs are routed, so a bake the step mapping refuses still leaves them in $OUT to inspect.
rm -f "$OUT"/ohio.osrm*
copy_routing() { $D run --rm -v "$VOL:/d" "$NODE" sh -c 'cd /d && tar -cf - ohio.osrm*' | tar -x -C "$OUT"; }
timed routing-files-copy copy_routing
$D network create "$NET" >/dev/null
$D run -d --name "$CTR" --network "$NET" -v "$VOL:/d" "$OSRM" osrm-routed --algorithm mld /d/ohio.osrm >/dev/null
# shellcheck disable=SC2086
timed bake $D run --rm -i --network "$NET" -v "$VOL:/d" -e "OSRM_URL=http://$CTR:5000" "$NODE" node --input-type=module - < "$HERE/bake.mjs"

# 5. Bring the track set back, then hash everything (the trap removes the container, network and volume).
$D run --rm -v "$VOL:/d" "$NODE" cat /d/out/tracks.ndjson > "$OUT/tracks.ndjson"
cd "$OUT"
ROUTING=(ohio.osrm*)
FILES=(tracks.ndjson legs.json "${ROUTING[@]}")
[ "$TILES" = 1 ] && FILES=(columbus.pmtiles dayton.pmtiles springfield.pmtiles "${FILES[@]}")
over=0
for f in "${ROUTING[@]}"; do
  n="$(wc -c < "$f" | tr -d ' ')"
  if [ "$n" -gt "$GATE" ]; then echo "maps-bake: STOP $f is $n bytes, over the $GATE byte per-file gate (BUILD_PLAN section 11 item 26)" >&2; over=1; fi
done
shasum -a 256 "${FILES[@]}" | tee SHA256SUMS
wc -c "${FILES[@]}"
[ "$over" = 0 ] || exit 1
