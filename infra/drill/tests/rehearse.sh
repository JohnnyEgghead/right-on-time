#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P8-RESTORE-DRILL local rehearsal: the drill's server half on this Mac's Docker, with 2 local Compose projects standing in for the
# 2 temporary copies, and every known-bad arm. No cloud call, no ssh. The server scripts run as on the copies, in the Debian 13 runner
# of the P3-BACKUP proofs (infra/backup/tests/runner.Dockerfile) with this engine's socket.
#   BW_DRILL_REHEARSE_IMAGE=<app image> bash infra/drill/tests/rehearse.sh <out dir>
# Arms, in order, each with its required exit code (a wrong one fails the rehearsal):
#   1 backup.sh on copy 1 (fresh setup, the sample world), target local                     0
#   2 restore-test.sh on a planted manifest (the restore test's own known-bad, first)      1
#   3 restore-test.sh on the good set                                                       0
#   4 restore-copy.sh restore on copy 2 while web runs (the procedure's guard)              2
#   5 restore-copy.sh restore on copy 2, web, worker and pbs stopped                        0
#   6 restore-copy.sh check on copy 2 against a planted manifest                            1
#   7 restore-copy.sh check on copy 2 after a planted row (1 row added to the restored data) 1
#   8 the planted row removed: restore-copy.sh check                                        0
#   9 restore-copy.sh check after a planted value outside a key (F-1579: 1 customer's texts_on flipped) 1
#  10 the value flipped back: restore-copy.sh check                                         0
#  11 the stack started on copy 2 and the smoke sign-in (ci/smoke/smoke.mjs) on the restored world 0
# Each arm's output is <out dir>/arm-<n>-<name>.log (JSON event lines); <out dir>/summary.txt has 1 line per arm.
# Both projects, their volumes and the runner image are removed at the end, pass or fail.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${1:?out dir}"
image="${BW_DRILL_REHEARSE_IMAGE:?set BW_DRILL_REHEARSE_IMAGE to an app image built from this tree}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
c1=bw-p8-drill-c1
c2=bw-p8-drill-c2
runner_image=bw-p8-drill-runner:local
state="$(mktemp -d "${TMPDIR:-/tmp}/bw-p8-rehearse.XXXXXX")"
: >"$out/summary.txt"
seed="$(openssl rand -hex 24)"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port2="$(freeport)"
compose() { # compose <project> <http port> <args>
  local p="$1" port="$2"
  shift 2
  BW_IMAGE="$image" DB_ENV_FILE="$state/no-db-env-file" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:0" APP_ORIGIN="http://127.0.0.1:$port" \
    SAMPLE_PASSWORD_SEED="$seed" BW_DATA_DIR="$root/.build/data" docker compose -p "$p" -f "$root/infra/compose.yaml" "$@"
}
# shellcheck disable=SC2329 # the EXIT trap runs it
cleanup() {
  local rc=$?
  set +e
  compose "$c1" 0 --profile setup down -v --remove-orphans >/dev/null 2>&1
  compose "$c2" 0 --profile setup down -v --remove-orphans >/dev/null 2>&1
  docker image rm -f "$runner_image" >/dev/null 2>&1
  docker run --rm -v "$state:/state" debian:trixie-20261005-slim rm -rf /state/t1 /state/t2 >/dev/null 2>&1
  rm -rf "$state"
  echo "rehearse: projects $c1 and $c2 removed"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# runner <project> <target dir> <env...> -- <script and args>: a script of /opt/bw-drill as root on that project's db.
runner() {
  local p="$1" t="$2"
  shift 2
  local envs=()
  while [ "$1" != -- ]; do envs+=(-e "$1"); shift; done
  shift
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$root/infra/backup:/opt/bw-drill/backup:ro" \
    -v "$root/infra/drill:/opt/bw-drill/drill:ro" -v "$t:/var/lib/bw-drill" -e "BW_PROJECT=$p" "${envs[@]}" "$runner_image" bash "$@"
}
# arm <n> <name> <want rc> <command...>
arm() {
  local n="$1" name="$2" want="$3" rc=0
  shift 3
  "$@" >"$out/arm-$n-$name.log" 2>&1 || rc=$?
  if [ "$rc" = "$want" ]; then
    echo "arm $n $name: exit $rc, as required" | tee -a "$out/summary.txt"
  else
    echo "arm $n $name: exit $rc, required $want: FAIL" | tee -a "$out/summary.txt"
    tail -5 "$out/arm-$n-$name.log" >&2
    exit 1
  fi
}

docker build -q -t "$runner_image" -f "$root/infra/backup/tests/runner.Dockerfile" "$root/infra/backup/tests" >/dev/null
install -d -m 700 "$state/t1" "$state/t2"

echo "rehearse: copy 1, a fresh setup"
compose "$c1" 0 up -d --no-build --wait --wait-timeout 240 proxy web worker pbs db >"$state/up1.log" 2>&1
compose "$c1" 0 --profile setup run --rm --no-deps setup >"$out/setup-copy1.log" 2>&1
grep -c '"status":"setup done"' "$out/setup-copy1.log" | sed 's/^/rehearse: setup done lines /'

arm 1 backup 0 runner "$c1" "$state/t1" BACKUP_TARGET=local BACKUP_LOCAL_DIR=/var/lib/bw-drill/target -- /opt/bw-drill/backup/backup.sh
stamp="$(sed -n 's/.*"event":"passed","msg":"backup \([0-9TZ]*\):.*/\1/p' "$out/arm-1-backup.log")"
[ -n "$stamp" ] || { echo "rehearse: no set stamp in the backup output" >&2; exit 1; }
echo "rehearse: set $stamp"
runner "$c1" "$state/t1" -- /opt/bw-drill/drill/restore-copy.sh plant "/var/lib/bw-drill/target/backups/$stamp" "/var/lib/bw-drill/planted/backups/$stamp" >"$out/plant-copy1.log"
arm 2 restore-test-planted 1 runner "$c1" "$state/t1" BACKUP_TARGET=local BACKUP_LOCAL_DIR=/var/lib/bw-drill/planted BACKUP_RECORD=off -- /opt/bw-drill/backup/restore-test.sh
arm 3 restore-test 0 runner "$c1" "$state/t1" BACKUP_TARGET=local BACKUP_LOCAL_DIR=/var/lib/bw-drill/target -- /opt/bw-drill/backup/restore-test.sh

echo "rehearse: copy 2, the stack on an empty database (as deploy leaves it), then the set copied in"
compose "$c2" "$port2" up -d --no-build --wait --wait-timeout 240 proxy web worker pbs db >"$state/up2.log" 2>&1
docker run --rm -v "$state:/state" debian:trixie-20261005-slim sh -c "mkdir -p /state/t2/target/backups && cp -a /state/t1/target/backups/$stamp /state/t2/target/backups/"
set2="/var/lib/bw-drill/target/backups/$stamp"
arm 4 restore-while-web-runs 2 runner "$c2" "$state/t2" -- /opt/bw-drill/drill/restore-copy.sh restore "$set2"
compose "$c2" "$port2" stop web worker pbs >/dev/null 2>&1
arm 5 restore 0 runner "$c2" "$state/t2" -- /opt/bw-drill/drill/restore-copy.sh restore "$set2"
runner "$c2" "$state/t2" -- /opt/bw-drill/drill/restore-copy.sh plant "$set2" "/var/lib/bw-drill/planted/backups/$stamp" >"$out/plant-copy2.log"
arm 6 check-planted-manifest 1 runner "$c2" "$state/t2" -- /opt/bw-drill/drill/restore-copy.sh check "/var/lib/bw-drill/planted/backups/$stamp"
db2="$(docker ps -q --filter "label=com.docker.compose.project=$c2" --filter label=com.docker.compose.service=db)"
psql2() { docker exec -i "$db2" psql -X -q -A -t -v ON_ERROR_STOP=1 -U brightwater -d brightwater -c "$1"; }
psql2 "INSERT INTO system.backup_record (kind, location, started_real, finished_real, result) VALUES ('restore_test', 'file:///planted-row', now(), now(), 'failed')" >/dev/null
arm 7 check-planted-row 1 runner "$c2" "$state/t2" -- /opt/bw-drill/drill/restore-copy.sh check "$set2"
psql2 "DELETE FROM system.backup_record WHERE location = 'file:///planted-row'" >/dev/null
arm 8 check-row-removed 0 runner "$c2" "$state/t2" -- /opt/bw-drill/drill/restore-copy.sh check "$set2"
# F-1579: 1 value outside the primary key (a boolean, so flipping it twice restores it exactly; world.customer has no trigger).
flip="UPDATE world.customer SET texts_on = NOT texts_on WHERE id = (SELECT id FROM world.customer ORDER BY id LIMIT 1) RETURNING 'flipped'"
[ "$(psql2 "$flip")" = flipped ] || { echo "rehearse: no customer row to plant a value in" >&2; exit 1; }
arm 9 check-planted-value 1 runner "$c2" "$state/t2" -- /opt/bw-drill/drill/restore-copy.sh check "$set2"
grep -m 1 '"event":"mismatch","msg":"world.customer: ' "$out/arm-9-check-planted-value.log" >/dev/null \
  || { echo "rehearse: arm 9 failed, but not on world.customer" >&2; exit 1; }
[ "$(psql2 "$flip")" = flipped ] || { echo "rehearse: the planted value was not flipped back" >&2; exit 1; }
arm 10 check-value-restored 0 runner "$c2" "$state/t2" -- /opt/bw-drill/drill/restore-copy.sh check "$set2"

echo "rehearse: copy 2 started on the restored data, then the smoke sign-in"
compose "$c2" "$port2" up -d --no-build --wait --wait-timeout 240 proxy web worker pbs db >"$state/up3.log" 2>&1
harness="$state/harness"
mkdir -p "$harness"
cp "$root/ci/smoke/smoke.mjs" "$root/ci/page-walkers/origin-guard.ts" "$root/packages/db/src/passwords.ts" "$harness/"
ln -s "$root/node_modules" "$harness/node_modules"
arm 11 smoke 0 env SMOKE_BASE="http://127.0.0.1:$port2" SMOKE_SEED="$seed" node "$harness/smoke.mjs"
echo "rehearse: PASS, every arm as required (set $stamp)" | tee -a "$out/summary.txt"
