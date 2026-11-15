#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S2 (G-S2-TWA-OFFLINE): THROWAWAY deploy from this Mac to the locked server brightwater-1.
#   bash infra/spike/s2/deploy.sh <out-dir>
# Stages the shell, the receiver, the nginx include and the 2 Compose files, copies them with scp
# (the server has no rsync), runs server-install.sh there, then probes the public URLs.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${1:?out dir}"
exec > >(tee "$out/deploy.txt") 2>&1
KEY="$HOME/.ssh/brightwater-lightsail.pem"
. "$root/infra/drill/owner-env.sh"; bw_need_host "$root" || exit 2
HOST="$BW_HOST"
stage="$(mktemp -d)/spike-s2-stage"
mkdir -p "$stage/app/public" "$stage/nginx"
cp "$root/apps/web/spike/s2/server.mjs" "$stage/app/"
cp "$root"/apps/web/spike/s2/public/* "$stage/app/public/"
cp "$root"/infra/spike/s2/nginx/default.conf "$root"/infra/spike/s2/nginx/locations.conf "$stage/nginx/"
cp "$root"/infra/spike/s2/compose.yaml "$root"/infra/spike/s2/proxy-override.yaml \
   "$root"/infra/spike/s2/server-install.sh "$root"/infra/spike/s2/server-teardown.sh "$stage/"
echo "== deploy started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
ssh -i "$KEY" "$HOST" 'rm -rf /tmp/spike-s2-stage'
scp -q -r -i "$KEY" "$stage" "$HOST:/tmp/"
ssh -i "$KEY" "$HOST" 'sudo bash /tmp/spike-s2-stage/server-install.sh'
echo "== public probes"
for u in https://bw.j7l.io/healthz https://bw.j7l.io/ https://bw.j7l.io/spike/s2/ https://bw.j7l.io/spike/s2/sw.js \
         https://bw.j7l.io/spike/s2/manifest.webmanifest https://bw.j7l.io/spike/s2/api/health; do
  echo "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$u") $u"
done
echo "== deploy finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
