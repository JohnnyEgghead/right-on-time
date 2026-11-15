#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S2 (THROWAWAY): local smoke test of the receiver (plain Node, no browser), on this Mac.
# Starts apps/web/spike/s2/server.mjs on a free port with a temp data dir, then checks: shell files,
# first store, sequential duplicate, 5 concurrent duplicates of a new key, bad key, listing count.
#   bash infra/spike/s2/smoke-local.sh <out-dir>
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${1:?out dir}"
exec > >(tee "$out/smoke-local.txt") 2>&1
data="$(mktemp -d)"
port=18082
PORT=$port DATA_DIR="$data" node "$root/apps/web/spike/s2/server.mjs" >"$out/smoke-server.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$data"' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -sf "http://127.0.0.1:$port/spike/s2/api/health" >/dev/null && break; sleep 0.3; done
B="http://127.0.0.1:$port/spike/s2"
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1: got $2 want $3"; fail=1; fi; }
for f in "" index.html app.js sw.js manifest.webmanifest icon-192.png icon-512.png; do
  check "GET /$f" "$(curl -s -o /dev/null -w '%{http_code}' "$B/$f")" 200
done
check "GET unknown file" "$(curl -s -o /dev/null -w '%{http_code}' "$B/../server.mjs")" 404
post() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "Idempotency-Key: $1" -H "X-Item-Kind: $2" -H 'Content-Type: text/plain' --data-binary "$3" "$B/api/items"; }
check "first store" "$(post smoke-key-0001 note hello)" 201
check "duplicate"   "$(post smoke-key-0001 note hello)" 200
check "bad key"     "$(post 'x' note hello)" 400
check "bad kind"    "$(post smoke-key-0002 video hello)" 400
pids=()
for _ in 1 2 3 4 5; do post smoke-key-0003 photo burst >>"$data/burst.txt" & pids+=($!); done
wait "${pids[@]}"
codes="$(fold -w3 "$data/burst.txt" | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
check "5 concurrent duplicates -> one 201" "$(fold -w3 "$data/burst.txt" | grep -c 201)" 1
echo "     burst codes: $codes"
check "items stored" "$(curl -s "$B/api/items" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items.length))')" 2
check "first-store log lines" "$(grep -c '"result":"first-store"' "$data/receive.log")" 2
check "duplicate log lines" "$(grep -c '"result":"duplicate"' "$data/receive.log")" 5
exit $fail
