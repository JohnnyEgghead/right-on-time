#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P6-ROUTE-BAKE stack suite (BUILD_PLAN P6-ROUTE-BAKE Acceptance; SPECIFICATIONS v0.13 SD-49, section 6.3 Directions, section 6.10): the baked
# turn-by-turn steps, API-104's steps and the routing service against the Compose stack at its default settings (infra/compose.yaml, no .env: real
# PostgreSQL 18, real handlers, pbs and the worker running, the release web image), set up by the setup service (`pnpm run setup` in the image:
# migrate, then the seeded world of D-3 with the tracks of the real map folder, the clock at Tue, Sep 15, 7:00 AM), through its proxy. Same shape as
# ci/mapme-stack.sh: its own Compose project (bw-w35-bake, free host ports), verified (db, pbs, proxy, web and worker running and routing not;
# PostgreSQL 18; every setting at its default), the sessions of ci/route-bake-stack/fixture.sql (Maria Santos and the manager Dana Ruiz), then
# ci/route-bake-stack/route.stack.ts, which starts and stops the routing service itself; torn down on every exit path (a reaper outside the process
# group covers a kill). No docker: exit 3 ("stack unavailable", a red).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-w35-bake(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "route-bake-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "route-bake-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
# The setup service reads the verified street list and the map files; the suite's routing service reads the routing files (SD-49), so the
# map folder is filled as `pnpm run setup:maps` fills it, routing files included (F-164, F-362).
node ci/data-assets.ts ensure
node packages/maps/src/cli.ts fetch --dir .build/data/maps

project="${BW_ROUTE_PROJECT:-bw-w35-bake}"
own_project "$project" || { echo "route-bake-stack: FAIL project name '$project' is refused (bw-w35-bake or bw-w35-bake-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w35-bake.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "route-$$-$RANDOM$RANDOM" >"$tmp/db.env"
# Exported, so the suite's own docker compose calls (it starts and stops the routing service) see the same project settings.
export BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" \
  BW_DATA_DIR="$root/.build/data" BW_MAPS_DIR="$root/.build/data/maps" BW_ROUTE_PROJECT="$project"
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
echo "route-bake-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "route-bake-stack: image built in $(( $(date +%s) - started )) s"
# The routing service is left out: the stack starts and answers with it stopped (P6-ROUTE-BAKE); the suite starts it later.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db
rc=0
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "route-bake-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "route-bake-stack: running services: $running"
for s in db pbs proxy web worker; do
  grep -qw "$s" <<<"$running" || { echo "route-bake-stack: FAIL service $s is not running" >&2; exit 1; }
done
if grep -qw routing <<<"$running"; then echo "route-bake-stack: FAIL the routing service runs before the suite starts it" >&2; exit 1; fi
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "route-bake-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "route-bake-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "route-bake-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "route-bake-stack: stack set up and verified at $base in $(( $(date +%s) - started )) s"

token() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
maria="$(token)"
dana="$(token)"
compose exec -T db psql -q -U brightwater -d brightwater -v maria="$maria" -v dana="$dana" -f - <ci/route-bake-stack/fixture.sql >/dev/null
echo "route-bake-stack: sessions loaded"

: >"$tmp/measured.txt"
BW_ROUTE_STACK_URL="$base" BW_ROUTE_DB_CONTAINER="$(compose ps -q db)" BW_ROUTE_MARIA="$maria" BW_ROUTE_DANA="$dana" BW_ROUTE_MEASURE_FILE="$tmp/measured.txt" \
  pnpm exec vitest run --config ci/route-bake-stack/vitest.config.ts || suite=$?
cat "$tmp/measured.txt"
web="$(compose ps -aq web)"
echo "route-bake-stack: web after the suite: $(docker inspect -f '{{.State.Status}}, OOM killed {{.State.OOMKilled}}, restarts {{.RestartCount}}' "$web")"
exit "${suite:-0}"
