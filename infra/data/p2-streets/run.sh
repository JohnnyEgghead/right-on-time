#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P2-STREETS: build the street list. Run from anywhere:  bash infra/data/p2-streets/run.sh [IN_DIR] [OUT_DIR]
# Needs: docker (local; no remote host). IN_DIR holds the 4 pinned inputs (names and SHA-256 in docs/build/spikes/P2-STREETS.md):
#   streets.json  (gh release download s8-data-v3 -R JohnnyEgghead/Brightwater -p streets.json)
#   tl_2024_us_zcta520.zip, tl_2024_39_place.zip, tl_2024_39_cousub.zip  (https://www2.census.gov/geo/tiger/TIGER2024/...)
# build.py refuses unless every input matches its pinned SHA-256. Output: OUT_DIR/street-list.json and street-list.stats.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IN="${1:-$HOME/bw-data/p2streets/in}"
OUT="${2:-$HOME/bw-data/p2streets/out}"
PY=python@sha256:2d44738ebf4ce5f63b9d9ea871e9c7cfdc0426f7b0c97cac915fd88ded1d86bb # same image as infra/data/s8/run.sh
mkdir -p "$OUT"
docker run --rm \
  -v "$HERE:/job:ro" -v "$ROOT/infra/data/s8/boxes.json:/boxes.json:ro" -e BW_BOXES=/boxes.json -v "$ROOT/docs/build/spikes/P2-STREETS.md:/record.md:ro" -v "$IN:/in:ro" -v "$OUT:/out" \
  "$PY" sh -c 'pip install -q pyshp==3.0.2.post1 shapely==2.1.2 pyproj==3.7.2 >/dev/null 2>&1; python -I /job/build.py /record.md /in /out'
