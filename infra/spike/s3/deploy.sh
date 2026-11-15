#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S3 (G-S3-MAP-SAFARI): THROWAWAY deploy from this Mac to the locked server brightwater-1.
#   bash infra/spike/s3/deploy.sh <out-dir> <path-to-columbus.pmtiles>
# Vendors maplibre-gl and pmtiles from the lockfile (npm ci), checks the PMTiles sha256 against the
# S8 pin, stages the page, the libraries, the file and the configs, copies them with scp (the server
# has no rsync), runs server-install.sh there, then probes the public URLs.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${1:?out dir}"
pm="${2:?columbus.pmtiles path}"
exec > >(tee "$out/deploy.txt") 2>&1
KEY="$HOME/.ssh/brightwater-lightsail.pem"
. "$root/infra/drill/owner-env.sh"; bw_need_host "$root" || exit 2
HOST="$BW_HOST"
PM_SHA=722bef6b5bb715bacb692613b63a8d96826eb672e5d674b83e4145da7ca8c6cc
[ "$(shasum -a 256 "$pm" | cut -d' ' -f1)" = "$PM_SHA" ] || { echo "STOP: columbus.pmtiles sha256 is not the S8 pin"; exit 1; }
(cd "$root/infra/spike/s3/vendor" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
nm="$root/infra/spike/s3/vendor/node_modules"
stage="$(mktemp -d)/spike-s3-stage"
mkdir -p "$stage/site/vendor" "$stage/nginx"
cp "$root"/infra/spike/s3/site/index.html "$root"/infra/spike/s3/site/app.js "$stage/site/"
cp "$pm" "$stage/site/columbus.pmtiles"
cp "$nm"/maplibre-gl/dist/maplibre-gl.mjs "$nm"/maplibre-gl/dist/maplibre-gl-worker.mjs \
   "$nm"/maplibre-gl/dist/maplibre-gl-shared.mjs "$nm"/maplibre-gl/dist/maplibre-gl.css \
   "$nm"/pmtiles/dist/pmtiles.js "$stage/site/vendor/"
cp "$root"/infra/spike/s3/nginx/default.conf "$root"/infra/spike/s3/nginx/locations.conf \
   "$root"/infra/spike/s3/nginx/spike.conf "$stage/nginx/"
cp "$root"/infra/spike/s3/compose.yaml "$root"/infra/spike/s3/proxy-override.yaml \
   "$root"/infra/spike/s3/server-install.sh "$root"/infra/spike/s3/server-teardown.sh "$stage/"
echo "== deploy started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
ssh -i "$KEY" "$HOST" 'rm -rf /tmp/spike-s3-stage'
scp -q -r -i "$KEY" "$stage" "$HOST:/tmp/"
ssh -i "$KEY" "$HOST" 'sudo bash /tmp/spike-s3-stage/server-install.sh'
echo "== public probes"
for u in https://bw.j7l.io/healthz https://bw.j7l.io/ https://bw.j7l.io/spike/s3/ https://bw.j7l.io/spike/s3/app.js \
         https://bw.j7l.io/spike/s3/vendor/maplibre-gl.mjs https://bw.j7l.io/spike/s3/vendor/pmtiles.js; do
  echo "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$u") $u"
done
echo "== deploy finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
