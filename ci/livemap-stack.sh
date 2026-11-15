#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P5-LIVEMAP stack suite (BUILD_PLAN P5-LIVEMAP Acceptance; gate G-CI5 step 3): the customer's live map page SCR-CUS-04 and its ended page SCR-CUS-05 on
# Chromium and WebKit against the Compose stack at its default settings (infra/compose.yaml, no .env: real PostgreSQL 18, real handlers, pbs and the
# worker running, the release web image), set up by the setup service (`pnpm run setup` in the image: migrate, then the seeded world of D-3, the clock
# at Tue, Sep 15, 7:00 AM), through its proxy, outside-origin guard on. Same shape as ci/job-stack.sh: its own Compose project (bw-w27-livemap, free
# host ports), verified (db, pbs, proxy, web and worker running; PostgreSQL 18; every setting at its default), the sessions of
# ci/livemap-stack/fixture.sql (a dispatcher, a manager and every Columbus technician), then ci/livemap-stack/livemap.stack.ts: the live map from the real
# API while a technician is on the way, the arrival with the page open and WebKit and Chromium back and forward after it, and the office's cancel,
# reassign and reschedule of a trip in progress. Torn down on every exit path (a reaper outside the process group covers a kill). No docker: exit 3
# ("stack unavailable", a red). BW_LIVEMAP_PROJECT names a lane's own project: bw-w27-livemap or bw-w27-livemap-<x>, <x> starting with a lowercase letter or digit;
# any other name exits 2.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-w27-livemap(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "livemap-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "livemap-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
# The setup service reads the verified street list and the map files (F-164, F-362); fetch or verify them first.
node ci/data-assets.ts ensure
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps

project="${BW_LIVEMAP_PROJECT:-bw-w27-livemap}"
own_project "$project" || { echo "livemap-stack: FAIL project name '$project' is refused (bw-w27-livemap or bw-w27-livemap-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w27-livemap.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "livemap-$$-$RANDOM$RANDOM" >"$tmp/db.env"
compose() {
  BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" \
    BW_DATA_DIR="$root/.build/data" BW_MAPS_DIR="$root/.build/data/maps" docker compose -p "$project" -f infra/compose.yaml "$@"
}
reaper=""
cleanup() { stack_down "$project" "$image" "$tmp"; if [ -n "$reaper" ]; then kill "$reaper" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
reaper="$(node -e '
  const c = require("node:child_process").spawn("bash", process.argv.slice(1), { detached: true, stdio: "ignore" });
  c.unref();
  console.log(c.pid);
' "$0" --reap "$$" "$project" "$image" "$tmp")"
echo "livemap-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "livemap-stack: image built in $(( $(date +%s) - started )) s"
# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
rc=0
# The seed goes to setup only (as ci/import-stack.sh): web reads SAMPLE_PASSWORD_SEED too, and the stack stays at its defaults.
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "livemap-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "livemap-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "livemap-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "livemap-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "livemap-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "livemap-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "livemap-stack: stack set up and verified at $base in $(( $(date +%s) - started )) s"
web_mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(compose ps -q web)")"
echo "livemap-stack: web memory after start: $web_mem (used / the container limit, read from docker)"

token() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
keisha="$(token)"
dana="$(token)"
techseed="$(token)"
compose exec -T db psql -q -U brightwater -d brightwater -v keisha="$keisha" -v dana="$dana" -v techseed="$techseed" -f - \
  <ci/livemap-stack/fixture.sql >/dev/null
echo "livemap-stack: sessions loaded"

# F-1420: the suite paces its cases by the web container's log of API-116 calls (ci/livemap-stack/api116.ts), and the run's busiest window is printed after it.
BW_LIVEMAP_STACK_URL="$base" BW_LIVEMAP_DB_CONTAINER="$(compose ps -q db)" BW_LIVEMAP_WORKER_CONTAINER="$(compose ps -q worker)" \
  BW_LIVEMAP_WEB_CONTAINER="$(compose ps -q web)" BW_LIVEMAP_KEISHA="$keisha" BW_LIVEMAP_DANA="$dana" BW_LIVEMAP_TECHSEED="$techseed" \
  pnpm exec vitest run --config ci/livemap-stack/vitest.config.ts || suite=$?
web="$(compose ps -aq web)"
node ci/livemap-stack/api116.ts "$web" || echo "livemap-stack: the API-116 count could not be read" >&2
echo "livemap-stack: web after the suite: $(docker inspect -f '{{.State.Status}}, OOM killed {{.State.OOMKilled}}, restarts {{.RestartCount}}' "$web"), memory $(docker stats --no-stream --format '{{.MemUsage}}' "$web") (used / the container limit, read from docker)"
exit "${suite:-0}"
