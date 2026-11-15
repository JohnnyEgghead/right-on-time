#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The web technician app's job screens (P5-TWA-JOB; BUILD_PLAN P5-TWA-JOB Acceptance: Playwright on WebKit and Chromium at 520 x 980
# against the Compose stack at its default settings: infra/compose.yaml, no .env: real PostgreSQL 18, real handlers, pbs and the worker
# running, the release web image), set up by the setup service (the seeded world of D-3, the clock at Tue, Sep 15, 7:00 AM), through its
# proxy, outside-origin guard on. Same shape as ci/outbox-stack.sh: its own Compose project (bw-w28-job, free host ports), verified (db,
# pbs, proxy, web and worker running; PostgreSQL 18; every setting at its default), the rows of ci/tech-job-stack/fixture.sql (the sessions
# of Maria Santos, a technician, and the dispatcher Keisha Thompson; Harold Jenkins's Oct 20 visit with Maria), then
# ci/tech-job-stack/tech-job.stack.ts. Torn down on every exit path (a reaper outside the process group covers a kill). No docker: exit 3
# ("stack unavailable", a red). BW_TECH_JOB_PROJECT names a lane's own project: bw-w28-job or bw-w28-job-<x>.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-w28-job(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "tech-job-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "tech-job-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
# The setup service reads the verified street list and the map files (F-164, F-362); fetch or verify them first.
node ci/data-assets.ts ensure
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps

project="${BW_TECH_JOB_PROJECT:-bw-w28-job}"
own_project "$project" || { echo "tech-job-stack: FAIL project name '$project' is refused (bw-w28-job or bw-w28-job-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w28-job.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "techjob-$$-$RANDOM$RANDOM" >"$tmp/db.env"
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
echo "tech-job-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "tech-job-stack: image built in $(( $(date +%s) - started )) s"
# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
rc=0
# The seed goes to setup only (as ci/import-stack.sh): web reads SAMPLE_PASSWORD_SEED too, and the stack stays at its defaults.
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "tech-job-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "tech-job-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "tech-job-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "tech-job-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "tech-job-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "tech-job-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "tech-job-stack: stack set up and verified at $base in $(( $(date +%s) - started )) s"
web_mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(compose ps -q web)")"
echo "tech-job-stack: web memory after start: $web_mem (used / the container limit, read from docker)"

token() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
keisha="$(token)"
maria="$(token)"
dana="$(token)"
kevin="$(token)"
compose exec -T db psql -q -U brightwater -d brightwater -v keisha="$keisha" -v maria="$maria" -v dana="$dana" -v kevin="$kevin" -f - <ci/tech-job-stack/fixture.sql >/dev/null
echo "tech-job-stack: sessions loaded"

suite_started=$(date +%s)
BW_TECH_JOB_STACK_URL="$base" BW_TECH_JOB_DB_CONTAINER="$(compose ps -q db)" BW_TECH_JOB_WEB_CONTAINER="$(compose ps -q web)" BW_TECH_JOB_KEISHA="$keisha" BW_TECH_JOB_MARIA="$maria" BW_TECH_JOB_DANA="$dana" BW_TECH_JOB_KEVIN="$kevin" \
  pnpm exec vitest run --config ci/tech-job-stack/vitest.config.ts --reporter=verbose || suite=$?
echo "tech-job-stack: suite ran in $(( $(date +%s) - suite_started )) s"
web="$(compose ps -aq web)"
echo "tech-job-stack: web after the suite: $(docker inspect -f '{{.State.Status}}, OOM killed {{.State.OOMKilled}}, restarts {{.RestartCount}}' "$web"), memory $(docker stats --no-stream --format '{{.MemUsage}}' "$web") (used / the container limit, read from docker)"
exit "${suite:-0}"
