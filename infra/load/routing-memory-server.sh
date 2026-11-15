#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P6-ROUTING-MEMORY (OQ-42; owner rulings 95d77760 "Confirm on temp server" and d20c4c82 "Smallest that fits", Nov 10, 2026): the setting
# that works on the Mac, on a temporary Lightsail copy of 1 plan (infra/load/temp-server.sh), deleted on every way out. Per run: fresh
# sessions, the samplers, the route burst at the run's start beside 1 load-day run (packages/testkit/src/load/cli.ts), then collect.
# Stop rule (manager, Nov 10): when run 1's burst routes under 90% of its legs, or the routing service was killed for out of memory or
# restarted, run 1 is the result and the other runs are not made.
# W36-ROUTING-CAP adds BW_ROUTING_CAP (such as 320m; unset, uncapped) and a 3rd stop reason: run 1's route p95 over SD-49's 3 s.
#   BW_LOAD_DIR=<state folder outside the repo> BW_LOAD_IMAGE=<amd64 image> BW_LOAD_DATA=<data folder> BW_LOAD_PLAN=<bundle> \
#     [BW_ROUTING_CAP=<n>m] bash infra/load/routing-memory-server.sh <tag> <mmap|load> <runs> <run seconds>
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="${BW_LOAD_DIR:?set BW_LOAD_DIR}"
tag="$1" mode="$2" runs="$3" seconds="$4"
server() { bash "$root/infra/load/temp-server.sh" "$@"; }
gone() { server delete || echo 'routing-memory-server: DELETE FAILED, the instance may be alive'; }
trap gone EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
step() { echo "== $* $(date '+%-I:%M:%S %p %Z')"; server "$@" || { echo "routing-memory-server: step '$*' failed"; exit 1; }; }
step create
step install
step deploy
step world
step legs
step routing "$mode" "${BW_ROUTING_CAP:-uncapped}"
rc=0
for n in $(seq 1 "$runs"); do
  step sessions
  step sample
  server burst "$tag-$n" >"$dir/burst-$tag-$n.log" 2>&1 &
  bpid=$!
  NODE_EXTRA_CA_CERTS="$dir/tls-cert.pem" node "$root/packages/testkit/src/load/cli.ts" --origin "https://$(cat "$dir/ip")" --world "$dir/world.json" \
    --out "$dir/out" --instance-plan "${BW_LOAD_PLAN:-small_3_0}" --label "$tag" --first-run "$n" --runs 1 --run-seconds "$seconds" \
    --rest-seconds 0 --vans on --runs-required "$runs" || rc=$?
  wait "$bpid" || rc=$?
  cat "$dir/burst-$tag-$n.log"
  server collect "$tag-$n" || echo 'routing-memory-server: collect failed'
  server unsample || true
  if [ "$n" -eq 1 ]; then
    ok="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(b.routed * 10 < b.legs * 9 ? "under90" : !(b.ms?.p95 <= 3000) ? "p95over3s" : "ok")' "$dir/burst-$tag-1.json" 2>/dev/null || echo under90)"
    st="$(grep '^routing state' "$dir/collect-$tag-1/server-memory.txt" | grep -o 'oom=[a-z]* restarts=[0-9]*')"
    if [ "$ok" != ok ] || [ "$st" != 'oom=false restarts=0' ]; then
      echo "routing-memory-server: $tag stopped after run 1 (burst $ok, routing $st): the result is clear"
      echo "stopped after run 1: burst $ok, routing $st" >"$dir/stopped-$tag.txt"
      break
    fi
  fi
done
exit "$rc"
