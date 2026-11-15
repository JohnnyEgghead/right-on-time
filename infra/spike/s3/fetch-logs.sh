#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S3 (G-S3-MAP-SAFARI): THROWAWAY. Copies the server's nginx access lines for /spike/s3/ to this Mac.
#   bash infra/spike/s3/fetch-logs.sh <out-dir>
# Writes proxy-access.txt (the brightwater proxy container log, /spike/s3/ lines only) and
# spike-access.txt (the spike file server's own log, with the Range header). Run it BEFORE teardown:
# teardown recreates the proxy container (its log restarts) and deletes the spike directory.
set -euo pipefail
out="${1:?out dir}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
KEY="$HOME/.ssh/brightwater-lightsail.pem"
. "$root/infra/drill/owner-env.sh"; bw_need_host "$root" || exit 2
HOST="$BW_HOST"
ssh -i "$KEY" "$HOST" 'sudo docker logs brightwater-proxy-1 2>&1 | grep "/spike/s3/"' > "$out/proxy-access.txt" || true
ssh -i "$KEY" "$HOST" 'sudo cat /opt/brightwater-spike-s3/logs/access.log' > "$out/spike-access.txt"
echo "proxy lines: $(wc -l < "$out/proxy-access.txt")  spike lines: $(wc -l < "$out/spike-access.txt")"
echo "206 in proxy log: $(grep -c ' 206 ' "$out/proxy-access.txt" || true)  206 in spike log: $(grep -c ' 206 ' "$out/spike-access.txt" || true)"
