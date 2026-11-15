#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P6-LIVE-ROUTING stack suite (BUILD_PLAN P6-LIVE-ROUTING Acceptance; SPECIFICATIONS v0.13 SD-49, SD-15, SD-22, SD-12): SD-49's route source
# against the Compose stack at its default settings (infra/compose.yaml, no .env: real PostgreSQL 18, real handlers, pbs, the worker and the
# routing service running, the release web image), set up by the setup service (`pnpm run setup` in the image: migrate, then the seeded world of
# D-3 with the tracks of the real map folder, the clock at Tue, Sep 15, 7:00 AM), through its proxy. Same shape as ci/route-bake-stack.sh: its own
# Compose project (bw-w36lr, free host ports), verified (db, pbs, proxy, routing, web and worker running; PostgreSQL 18; every setting at its
# default), the sessions of ci/live-routing-stack/fixture.sql, then ci/live-routing-stack/live.stack.ts, which stops, pauses and starts the
# routing service itself; torn down on every exit path (a reaper outside the process group covers a kill). No docker: exit 3 ("stack
# unavailable", a red). The map folder needs the routing files: `pnpm run setup:maps` (about 2.7 GB from the private release).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-w36lr(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "live-routing-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "live-routing-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
maps="${BW_MAPS_DIR:-$root/.build/data/maps}"
node ci/data-assets.ts ensure
node packages/maps/src/cli.ts fetch --dir "$maps"

project="${BW_LR_PROJECT:-bw-w36lr}"
own_project "$project" || { echo "live-routing-stack: FAIL project name '$project' is refused (bw-w36lr or bw-w36lr-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w36lr.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "liveroute-$$-$RANDOM$RANDOM" >"$tmp/db.env"
# Exported, so the suite's own docker compose calls (it stops, pauses and starts the routing service) see the same project settings.
export BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" \
  BW_DATA_DIR="$root/.build/data" BW_MAPS_DIR="$maps" BW_LR_PROJECT="$project"
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
echo "live-routing-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "live-routing-stack: image built in $(( $(date +%s) - started )) s"
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
rc=0
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "live-routing-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "live-routing-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "live-routing-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "live-routing-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "live-routing-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "live-routing-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "live-routing-stack: stack set up and verified at $base in $(( $(date +%s) - started )) s"

token() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
keisha="$(token)"
dana="$(token)"
techseed="$(token)"
compose exec -T db psql -q -U brightwater -d brightwater -v keisha="$keisha" -v dana="$dana" -v techseed="$techseed" -f - \
  <ci/live-routing-stack/fixture.sql >/dev/null
echo "live-routing-stack: sessions loaded"

: >"$tmp/measured.txt"
BW_LR_STACK_URL="$base" BW_LR_DB_CONTAINER="$(compose ps -q db)" BW_LR_KEISHA="$keisha" BW_LR_DANA="$dana" BW_LR_TECHSEED="$techseed" \
  BW_LR_MEASURE_FILE="$tmp/measured.txt" pnpm exec vitest run --config ci/live-routing-stack/vitest.config.ts || suite=$?
cat "$tmp/measured.txt"
for s in web worker routing; do
  c="$(compose ps -aq "$s")"
  echo "live-routing-stack: $s after the suite: $(docker inspect -f '{{.State.Status}}, OOM killed {{.State.OOMKilled}}, restarts {{.RestartCount}}' "$c")"
done
exit "${suite:-0}"
