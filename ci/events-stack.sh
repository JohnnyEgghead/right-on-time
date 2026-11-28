#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P3-EVENTS stack suite (BUILD_PLAN P3-EVENTS Acceptance): the event bus and the event stream (API-09) against the Compose
# stack at its default settings (infra/compose.yaml, no .env: real PostgreSQL 18, real handlers, pbs running), through its
# proxy. Same shape as ci/shell-stack.sh: its own Compose project (bw-w16-events, free host ports), verified (db, pbs, proxy,
# web and worker running; PostgreSQL 18; every setting at its default), the fixture rows of ci/shell-stack/fixture.sql, then
# ci/events-stack/events.stack.ts; torn down on every exit path (a reaper outside the process group covers a kill).
# The suite takes about 1 minute (P10-NIGHTLY-SPEED: no 30 s outage and no 15 s heartbeat wait now; those are unit tests). No docker: exit 3 ("stack unavailable", a red).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-w16-events(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "events-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "events-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi

project="${BW_EVENTS_PROJECT:-bw-w16-events}"
own_project "$project" || { echo "events-stack: FAIL project name '$project' is refused (bw-w16-events or bw-w16-events-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w16-events.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "shell-$$-$RANDOM$RANDOM" >"$tmp/db.env"
compose() { BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" docker compose -p "$project" -f infra/compose.yaml "$@"; }
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
echo "events-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "events-stack: image built in $(( $(date +%s) - started )) s"
# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "events-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "events-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "events-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "events-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "events-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "events-stack: stack verified at $base"
web_mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(compose ps -q web)")"
echo "events-stack: web memory after start: $web_mem (used / the container limit, read from docker)"

token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
compose exec -T db psql -q -U brightwater -d brightwater -v token="$token" -f - <ci/shell-stack/fixture.sql >/dev/null
echo "events-stack: fixture rows loaded"

BW_EVENTS_STACK_URL="$base" BW_EVENTS_STACK_SESSION="$token" BW_EVENTS_DB_CONTAINER="$(compose ps -q db)" pnpm exec vitest run --config ci/events-stack/vitest.config.ts
web_mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(compose ps -q web)")"
echo "events-stack: web memory after the suite: $web_mem (used / the container limit, read from docker)"
