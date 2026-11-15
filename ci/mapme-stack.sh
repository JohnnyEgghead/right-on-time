#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P5-TWA-MAP-ME stack suite (BUILD_PLAN P5-TWA-MAP-ME Acceptance): the web technician app's Map tab, Directions, Parts, Me and install page on
# Chromium and WebKit at 520 x 980 against the Compose stack at its default settings (infra/compose.yaml, no .env: real PostgreSQL 18, real
# handlers, pbs and the worker running, the release web image), set up by the setup service (`pnpm run setup` in the image: migrate, then the
# seeded world of D-3, the clock at Tue, Sep 15, 7:00 AM), through its proxy, outside-origin guard on. Same shape as ci/mapme-stack.sh: its own
# Compose project (bw-w28-mapme, free host ports), verified (db, pbs, proxy, web and worker running; PostgreSQL 18; every setting at its
# default), the sessions of ci/mapme-stack/fixture.sql (Maria Santos, a dispatcher and a manager), then ci/mapme-stack/mapme.stack.ts; torn down
# on every exit path (a reaper outside the process group covers a kill). No docker: exit 3 ("stack unavailable", a red).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-w28-mapme(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "mapme-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "mapme-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
# The setup service reads the verified street list and the map files (F-164, F-362); fetch or verify them first.
node ci/data-assets.ts ensure
# P6-WEB-STEPS: Directions reads live routes (SD-49), so the stack runs the routing service too and the map folder needs its files (2.7 GB, once).
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps --with-routing

project="${BW_MAPME_PROJECT:-bw-w28-mapme}"
own_project "$project" || { echo "mapme-stack: FAIL project name '$project' is refused (bw-w28-mapme or bw-w28-mapme-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w28-mapme.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "inbox-$$-$RANDOM$RANDOM" >"$tmp/db.env"
# Exported, so the suite's own docker compose calls (it stops and starts the routing service) see the same project settings.
export BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" \
  BW_DATA_DIR="$root/.build/data" BW_MAPS_DIR="$root/.build/data/maps" BW_MAPME_PROJECT="$project"
compose() { docker compose -p "$project" -f infra/compose.yaml "$@"; }
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
echo "mapme-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "mapme-stack: image built in $(( $(date +%s) - started )) s"
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
rc=0
# The seed goes to setup only (as ci/import-stack.sh): web reads SAMPLE_PASSWORD_SEED too, and the stack stays at its defaults.
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "mapme-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "mapme-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "mapme-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "mapme-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "mapme-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "mapme-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "mapme-stack: stack set up and verified at $base in $(( $(date +%s) - started )) s"
web_mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(compose ps -q web)")"
echo "mapme-stack: web memory after start: $web_mem (used / the container limit, read from docker)"

token() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
maria="$(token)"
mariaout1="$(token)"
mariaout2="$(token)"
mariaout3="$(token)"
mariaout4="$(token)"
keisha="$(token)"
dana="$(token)"
compose exec -T db psql -q -U brightwater -d brightwater -v maria="$maria" -v mariaout1="$mariaout1" -v mariaout2="$mariaout2" -v mariaout3="$mariaout3" -v mariaout4="$mariaout4" -v keisha="$keisha" -v dana="$dana" -f - <ci/mapme-stack/fixture.sql >/dev/null
echo "mapme-stack: sessions loaded"

BW_MAPME_STACK_URL="$base" BW_MAPME_DB_CONTAINER="$(compose ps -q db)" BW_MAPME_MARIA="$maria" BW_MAPME_MARIAOUT1="$mariaout1" BW_MAPME_MARIAOUT2="$mariaout2" BW_MAPME_MARIAOUT3="$mariaout3" BW_MAPME_MARIAOUT4="$mariaout4" BW_MAPME_KEISHA="$keisha" BW_MAPME_DANA="$dana" \
  pnpm exec vitest run --config ci/mapme-stack/vitest.config.ts || suite=$?
web="$(compose ps -aq web)"
echo "mapme-stack: web after the suite: $(docker inspect -f '{{.State.Status}}, OOM killed {{.State.OOMKilled}}, restarts {{.RestartCount}}' "$web"), memory $(docker stats --no-stream --format '{{.MemUsage}}' "$web") (used / the container limit, read from docker)"
exit "${suite:-0}"
