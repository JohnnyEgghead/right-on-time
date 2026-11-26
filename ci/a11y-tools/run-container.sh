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
#   2. The container is the wave image of ci/wave-image/Dockerfile (Node, pnpm and its store, Chromium and WebKit with their libraries), tagged
#      bw-p8-a11y-ci:<key>, where <key> is the wave image's content key (ci/wave-image-key.ts over this tree, with the IMAGE, APT_PINS and PNPM_VERSION
#      that ci/wave-run.sh passes): the lockfile, every workspace package.json, the pnpm and Playwright versions and the recipe. F-1727: the fixed tag
#      bw-p8-a11y-ci:local went stale when the lockfile moved, and pnpm install --offline then failed deep in its supply-chain check. Now a lockfile
#      change selects a new tag, and a tag that is not there is built here first (`node ci/wave-image-key.ts stage <tree> <ctx>`, then docker build
#      with the wave build-args; the only step with network; log <out-dir>/image-build.log). BW_A11Y_IMAGE names another image; one whose
#      bw.ci.key label is not this tree's key is refused, never run. The run itself has --network none: pnpm install --frozen-lockfile --offline,
#      the harness app on a loopback port, the browsers headless.
#   3. The map files (.build/data/maps, from `node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps`) are mounted read-only.
# Never run on a developer's browser; refuses without Docker. The scratch folder is removed on exit.
set -euo pipefail
out="${1:?usage: run-container.sh <out-dir> [chromium|webkit ...]}"
shift || true
engines=("$@")
[ "${#engines[@]}" -gt 0 ] || engines=(chromium webkit)
root="$(cd "$(dirname "$0")/../.." && pwd)"
maps="$root/.build/data/maps"
[ -d "$maps" ] || { echo "run-container: no map files at $maps (node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps)" >&2; exit 2; }
mkdir -p "$out"
out="$(cd "$out" && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/bw-a11y-web.XXXXXX")"
ctx=""
trap 'rm -rf "$scratch"; [ -z "$ctx" ] || rm -rf "$ctx"' EXIT
# The wave build-args, read from ci/wave-run.sh (their one home), so this image and the wave image share one key for one tree.
wave_arg() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$root/ci/wave-run.sh"; }
base="$(wave_arg IMAGE)"
apt="$(wave_arg APT_PINS)"
pnpm_v="$(wave_arg PNPM_VERSION)"
[ -n "$base" ] && [ -n "$apt" ] && [ -n "$pnpm_v" ] || { echo "run-container: cannot read IMAGE, APT_PINS and PNPM_VERSION from ci/wave-run.sh" >&2; exit 2; }
key="$(node "$root/ci/wave-image-key.ts" key "$root" --base "$base" --apt "$apt" --pnpm "$pnpm_v")"
image="${BW_A11Y_IMAGE:-bw-p8-a11y-ci:$key}"
label="$(docker image inspect --format '{{index .Config.Labels "bw.ci.key"}}' "$image" 2>/dev/null || true)"
if [ "$label" != "$key" ]; then
  if [ -n "${BW_A11Y_IMAGE:-}" ]; then
    echo "run-container: $image was not built from this tree (its bw.ci.key is '${label:-none}', this tree's key is $key); unset BW_A11Y_IMAGE to build bw-p8-a11y-ci:$key" >&2
    exit 2
  fi
  echo "run-container: building $image (no image with key $key: the lockfile or another key input changed since the last build); log $out/image-build.log"
  ctx="$(mktemp -d "${TMPDIR:-/tmp}/bw-a11y-img.XXXXXX")"
  node "$root/ci/wave-image-key.ts" stage "$root" "$ctx"
  if ! docker build --progress=plain --build-arg "BASE=$base" --build-arg "APT_PINS=$apt" --build-arg "PNPM_VERSION=$pnpm_v" --build-arg "KEY=$key" \
       -f "$ctx/ci/wave-image/Dockerfile" -t "$image" "$ctx" >"$out/image-build.log" 2>&1; then
    tail -n 30 "$out/image-build.log" >&2
    echo "run-container: building $image failed (log: $out/image-build.log)" >&2
    exit 1
  fi
fi
rsync -a --exclude '.git' --exclude 'node_modules' --exclude '.build' --exclude '._*' --exclude '.DS_Store' "$root/" "$scratch/"
rc=0
for e in "${engines[@]}"; do
  echo "run-container: $e on image $image"
  docker run --rm --network none -v "$scratch:/work" -v "$maps:/work/.build/data/maps:ro" -v "$out:/out" -w /work \
    -e BW_WAVE_CONTAINER=1 -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright "$image" \
    bash -c "git init -q . && pnpm install --frozen-lockfile --offline --store-dir /root/.pnpm-store >/out/install-$e.log 2>&1 && node ci/a11y-tools/run-web.ts $e /out" 2>&1 | tee "$out/web-$e.log" || rc=1
done
exit "$rc"
