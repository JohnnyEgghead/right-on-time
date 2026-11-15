#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S3 (G-S3-MAP-SAFARI): THROWAWAY. Curl proofs from this Mac: page 200, PMTiles range 206.
#   bash infra/spike/s3/curl-proof.sh <out-dir>
set -euo pipefail
out="${1:?out dir}"
exec > >(tee "$out/curl-proof.txt") 2>&1
U=https://bw.j7l.io/spike/s3/columbus.pmtiles
date '+%b %-d, %-I:%M:%S %p %Z'
echo "== curl -sI https://bw.j7l.io/spike/s3/"
curl -sI https://bw.j7l.io/spike/s3/
echo "== page body (first 5 lines)"
curl -s https://bw.j7l.io/spike/s3/ | head -5
echo "== range request, bytes=0-16383"
curl -s -o /dev/null -w 'status=%{http_code} downloaded=%{size_download}\n' -H 'Range: bytes=0-16383' "$U"
echo "== range request, bytes=1000000-1016383"
curl -s -o /dev/null -w 'status=%{http_code} downloaded=%{size_download}\n' -H 'Range: bytes=1000000-1016383' "$U"
echo "== response headers of a range request"
curl -s -D - -o /dev/null -H 'Range: bytes=0-16383' "$U" | grep -i -E '^(HTTP|content-range|accept-ranges|content-length)'
echo "== no Range header (control: whole file is 200, so 206 above is the Range at work)"
curl -s -o /dev/null -I -w 'status=%{http_code} content-length=%header{content-length}\n' "$U"
