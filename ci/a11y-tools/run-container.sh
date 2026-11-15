#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# why-file: NFR-06 (P8-A11Y-TOOLS, F-1629: the web walk can be re-run from the record)
# Runs the web accessibility checks (ci/a11y-tools/run-web.ts) in the CI browser image on the Mac's local Docker, headless, no network:
#   bash ci/a11y-tools/run-container.sh <out-dir> [chromium|webkit ...]     (from the repo root; both engines, one after the other, by default)
# Writes <out-dir>/web-<engine>.json (raw rows: every finding message of every state) and <out-dir>/web-<engine>.log. Then:
#   python3 ci/a11y-tools/summarize-web.py <out-dir> [<out-dir>/summary.json]     (counts per check, row ids, written next to the raw JSON)
# What it does, and why it is built this way (F-1629):
#   1. The tree is copied to a scratch folder on the Mac (rsync: no .git, no node_modules, no .build, no macOS ._ files), never into a Docker volume.
#      The Mac's node_modules cannot build Next.js on Linux, so the container installs its own from the image's pnpm store.
#   2. The container is the image bw-p8-a11y-ci:local (BW_A11Y_IMAGE): the wave image of ci/wave-image/Dockerfile (Node, pnpm and its store, Chromium
#      and WebKit with their libraries), built by `node ci/wave-image-key.ts stage <tree> <ctx>` then docker build with the build-args ci/wave-run.sh
#      passes. It runs with --network none: pnpm install --frozen-lockfile --offline, the harness app on a loopback port, the browsers headless.
#   3. The map files (.build/data/maps, from `node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps`) are mounted read-only.
# Never run on a developer's browser; refuses without Docker. The scratch folder is removed on exit.
set -euo pipefail
out="${1:?usage: run-container.sh <out-dir> [chromium|webkit ...]}"
shift || true
engines=("$@")
[ "${#engines[@]}" -gt 0 ] || engines=(chromium webkit)
root="$(cd "$(dirname "$0")/../.." && pwd)"
image="${BW_A11Y_IMAGE:-bw-p8-a11y-ci:local}"
maps="$root/.build/data/maps"
[ -d "$maps" ] || { echo "run-container: no map files at $maps (node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps)" >&2; exit 2; }
mkdir -p "$out"
out="$(cd "$out" && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/bw-a11y-web.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
rsync -a --exclude '.git' --exclude 'node_modules' --exclude '.build' --exclude '._*' --exclude '.DS_Store' "$root/" "$scratch/"
rc=0
for e in "${engines[@]}"; do
  echo "run-container: $e on image $image"
  docker run --rm --network none -v "$scratch:/work" -v "$maps:/work/.build/data/maps:ro" -v "$out:/out" -w /work \
    -e BW_WAVE_CONTAINER=1 -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright "$image" \
    bash -c "git init -q . && pnpm install --frozen-lockfile --offline --store-dir /root/.pnpm-store >/out/install-$e.log 2>&1 && node ci/a11y-tools/run-web.ts $e /out" 2>&1 | tee "$out/web-$e.log" || rc=1
done
exit "$rc"
