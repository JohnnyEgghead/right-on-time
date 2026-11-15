#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P4-BOARD stack suite (BUILD_PLAN P4-BOARD Acceptance): the day board on Chromium and WebKit against the Compose stack
# at its default settings (infra/compose.yaml, no .env: real PostgreSQL 18, real handlers, pbs running, the release web
# image), set up by the setup service (`pnpm run setup` in the image: migrate, then the seeded world of D-3, the clock at
# Tue, Sep 15, 7:00 AM), through its proxy, outside-origin guard on. Same shape as ci/events-stack.sh: its own Compose
# project (bw-w21-board, free host ports), verified (db, pbs, proxy, web and worker running; PostgreSQL 18; every setting
# at its default), the sessions of ci/board-stack/fixture.sql (2 dispatchers, a manager and a technician: the sign-in
# itself is P2-AUTH's suite), then ci/board-stack/board.stack.ts; torn down on every exit path (a reaper outside the
# process group covers a kill). No docker: exit 3 ("stack unavailable", a red). BW_BOARD_PROJECT names a lane's own project:
# bw-w21-board or bw-w21-board-<x>, <x> starting with a lowercase letter or digit; any other name exits 2.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-w21-board(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "board-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "board-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
# The setup service reads the verified street list and the map files (F-164, F-362); fetch or verify them first.
node ci/data-assets.ts ensure
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps

project="${BW_BOARD_PROJECT:-bw-w21-board}"
own_project "$project" || { echo "board-stack: FAIL project name '$project' is refused (bw-w21-board or bw-w21-board-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w21-board.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "board-$$-$RANDOM$RANDOM" >"$tmp/db.env"
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
echo "board-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "board-stack: image built in $(( $(date +%s) - started )) s"
# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
rc=0
# The seed goes to setup only (as ci/import-stack.sh): web reads SAMPLE_PASSWORD_SEED too, and the stack stays at its defaults.
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "board-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "board-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "board-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "board-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "board-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "board-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "board-stack: stack set up and verified at $base in $(( $(date +%s) - started )) s"
web_mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(compose ps -q web)")"
echo "board-stack: web memory after start: $web_mem (used / the container limit, read from docker)"

token() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
keisha="$(token)"
ana="$(token)"
dana="$(token)"
tech="$(token)"
compose exec -T db psql -q -U brightwater -d brightwater -v keisha="$keisha" -v ana="$ana" -v dana="$dana" -v tech="$tech" -f - \
  <ci/board-stack/fixture.sql >/dev/null
echo "board-stack: sessions loaded"

BW_BOARD_STACK_URL="$base" BW_BOARD_DB_CONTAINER="$(compose ps -q db)" \
  BW_BOARD_KEISHA="$keisha" BW_BOARD_ANA="$ana" BW_BOARD_DANA="$dana" BW_BOARD_TECH="$tech" \
  pnpm exec vitest run --config ci/board-stack/vitest.config.ts || suite=$?
web="$(compose ps -aq web)"
echo "board-stack: web after the suite: $(docker inspect -f '{{.State.Status}}, OOM killed {{.State.OOMKilled}}, restarts {{.RestartCount}}' "$web"), memory $(docker stats --no-stream --format '{{.MemUsage}}' "$web") (used / the container limit, read from docker)"
# F-819: memory.peak holds page cache, so it reads the 128 MiB limit on every run and cannot show a problem. What can: the
# anonymous memory the process holds now (memory.stat anon) and the kernel's OOM counters (memory.events oom, oom_kill).
echo "board-stack: web anon memory: $(docker exec "$web" sh -c "grep -E '^anon ' /sys/fs/cgroup/memory.stat" 2>/dev/null | cut -d' ' -f2 || true) bytes (cgroup memory.stat anon)"
echo "board-stack: web oom counters: $(docker exec "$web" sh -c "grep -E '^oom' /sys/fs/cgroup/memory.events" 2>/dev/null | tr '\n' ' ' || true)"
exit "${suite:-0}"
