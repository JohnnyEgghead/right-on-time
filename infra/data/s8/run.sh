#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# SUPERSEDED by infra/data/maps/run.sh (P3-MAPS-BAKE; F-17, F-18, F-19): kept as the record of the S8 measurement. It does
# not compare the Geofabrik SHA-256 with its pin, has no cleanup trap, waits a fixed sleep for osrm-routed, and bakes a
# modeled schedule. Do not use it for a release asset.
# Spike S8 (G-S8-DATA-SIZES) measurement, repeatable from a clean checkout.
# Run from the repo root:  bash infra/data/s8/run.sh
# Needs: pmtiles CLI 1.31.2, curl, shasum, and docker with a context named "spectre" (a remote Linux host that runs
# x86-64, linux/amd64: the track bake reproduces only on x86-64; this script passes no --platform).
# Everything heavy runs on Spectre in 1 volume (bw-s8v2) and 1 network; both are removed at the end.
# Output goes to $OUT (default ~/bw-data/s8v2/out): 3 .pmtiles, tracks.ndjson, streets.json, SHA256SUMS.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
OUT="${OUT:-$HOME/bw-data/s8v2/out}"
IN="${IN:-$HOME/bw-data/s8v2/in}"
D="docker --context spectre"
PM_BUILD=20260811
OHIO=ohio-261001.osm.pbf
OHIO_URL="https://download.geofabrik.de/north-america/us/$OHIO"
PY=python@sha256:2d44738ebf4ce5f63b9d9ea871e9c7cfdc0426f7b0c97cac915fd88ded1d86bb
OSRM=ghcr.io/project-osrm/osrm-backend@sha256:55dbfd47d984c2cacd64e32901b4321c86b5ec761438e69aa053dc78698a786f # tag v26.10.0-debian
mkdir -p "$OUT" "$IN"

# 1. Map files: 3 branch cuts, zoom 0 to 15, from the pinned Protomaps build (HTTP range requests).
#    The boxes come from the one table, boxes.json (F-15); streets.py and p2-streets/build.py read it too.
#    Columbus is the R5 line 38 box (docs/planning/round-1/research/R5-maps-hosting.md; the box behind A3's 45.0 MiB figure).
#    Dayton and Springfield: this spike's rectangles; A1-ANALYST.md line 84 (K12) gives different ones (see the S8 record).
SRC="https://build.protomaps.com/$PM_BUILD.pmtiles"
box() { python3 -I -c 'import json,sys; print(",".join(str(v) for v in json.load(open(sys.argv[1]))["boxes"][sys.argv[2]]))' "$HERE/boxes.json" "$1"; }
for f in columbus dayton springfield; do
  pmtiles extract "$SRC" "$OUT/$f.pmtiles" --bbox="$(box "$f")" --maxzoom=15
done
for f in columbus dayton springfield; do pmtiles verify "$OUT/$f.pmtiles"; done

# 2. Ohio extract: dated Geofabrik file (first-of-month, fixed), SHA-256 printed for the record.
[ -s "$IN/$OHIO" ] || curl -fsSL -o "$IN/$OHIO" "$OHIO_URL"
shasum -a 256 "$IN/$OHIO"

# 3. Spectre: volume, load the extract, street source, OSRM prepare, track bake.
$D volume create bw-s8v2 >/dev/null
$D run --rm -i -v bw-s8v2:/d "$PY" sh -c 'cat > /d/ohio.osm.pbf' < "$IN/$OHIO"
$D run --rm -i -v bw-s8v2:/d -v "$HERE/boxes.json:/boxes.json:ro" "$PY" sh -c 'apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq libexpat1 >/dev/null 2>&1; pip install -q osmium==4.3.1 >/dev/null 2>&1; python -I -' < "$HERE/streets.py"
for step in "osrm-extract -p /opt/car.lua /d/ohio.osm.pbf" "osrm-partition /d/ohio.osrm" "osrm-customize /d/ohio.osrm"; do
  $D run --rm -v bw-s8v2:/d "$OSRM" $step
done
$D network create bw-s8v2-net >/dev/null
$D run -d --rm --name bw-osrm --network bw-s8v2-net -v bw-s8v2:/d "$OSRM" osrm-routed --algorithm mld /d/ohio.osrm >/dev/null
sleep 20
$D run --rm -i --network bw-s8v2-net -v bw-s8v2:/d "$PY" python -I - < "$HERE/tracks.py"
$D stop bw-osrm >/dev/null || true

# 4. Bring the 2 text files back, clean up Spectre, hash everything.
for f in tracks.ndjson streets.json; do
  $D run --rm -v bw-s8v2:/d "$PY" cat "/d/out/$f" > "$OUT/$f"
done
$D network rm bw-s8v2-net >/dev/null || true
$D volume rm bw-s8v2 >/dev/null || true
cd "$OUT"
shasum -a 256 columbus.pmtiles dayton.pmtiles springfield.pmtiles tracks.ndjson streets.json | tee SHA256SUMS
wc -c columbus.pmtiles dayton.pmtiles springfield.pmtiles tracks.ndjson streets.json
