#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P5-TWA-TODAY stack suite (BUILD_PLAN P5-TWA-TODAY Acceptance): the web technician app's sign-in, Today and confirm steps in Playwright on
# Chromium and WebKit at 520 x 980 against the Compose stack at its default settings (infra/compose.yaml: real PostgreSQL 18, real handlers, pbs
# running, the worker started by its real start-up; the web image is the release build), after a fresh setup from the image, through its proxy,
# with the outside-origin guard on. Same shape as ci/clock-ui-stack.sh (the https front, the named settings ACCESS_CODE_ON and DEMO_MODE, secrets
# made fresh for each run and never written to a file):
#   1. the stack, verified (every service running, PostgreSQL 18, every setting at its default but the named ones);
#   2. the fresh setup;
#   3. ci/today-stack/today.stack.ts on each engine of ci/pw-engines.ts: the technician signs in on SCR-TEC-01, Today lists the day with the van and
#      the progress, On my way sends the text only after the confirm step, a No one home visit ends and shows in the report, a reassigned job reads
#      Scheduled in the new technician's API-100, the header shows the demo time, the reviewer sample user meets an empty day, and the Today page
#      carries X-Bw-Server-State and is never kept by the service worker.
# Own Compose project (bw-w28-today or bw-w28-today-<lowercase>; BW_TODAY_PROJECT names another), its own image tag, a reaper outside the process
# group. No docker: exit 3 ("stack unavailable", a red).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-w28-today(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "today-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "today-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
command -v openssl >/dev/null 2>&1 || { echo "today-stack: FAIL no openssl here: the suite's https front needs a certificate" >&2; exit 1; }
node ci/data-assets.ts ensure >/dev/null
# Setup checks and loads the map files (MAPS_DIR, F-362), so they are fetched and verified as the wave run fetches them.
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps >/dev/null

project="${BW_TODAY_PROJECT:-bw-w28-today}"
own_project "$project" || { echo "today-stack: FAIL project name '$project' is refused (bw-w28-today or bw-w28-today-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w28-today.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
secret() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
port="$(freeport)"
https_port="$(freeport)"
access_code="$(secret)"
cookie_key="$(secret)"
sample_seed="$(secret)"
reviewer_pw="$(secret)"
# The suite recreates nothing, but it runs docker compose with this same environment (psql, the worker's log).
export BW_IMAGE="$image" DB_ENV_FILE="$tmp/no-db-env-file" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port"
export ACCESS_CODE_ON=on DEMO_MODE=on ACCESS_CODE="$access_code" ACCESS_COOKIE_KEY="$cookie_key" SAMPLE_PASSWORD_SEED="$sample_seed" REVIEWER_PASSWORD="$reviewer_pw"
export BW_DATA_DIR="$root/.build/data"
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
echo "today-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "today-stack: image built in $(( $(date +%s) - started )) s"
# 1. The stack at its default settings but the named ones.
# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
running="$(compose ps --status running --services | sort | tr '\n' ' ')"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "today-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
case "$pgv" in 18.*) ;; *) echo "today-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" ACCESS_CODE_ON=on DEMO_MODE=on 'ACCESS_CODE=*' 'ACCESS_COOKIE_KEY=*' 'SAMPLE_PASSWORD_SEED=*' \
  || { echo "today-stack: FAIL the stack is not at its default settings but for the named ones" >&2; exit 1; }
echo "today-stack: stack verified (PostgreSQL $pgv, default settings but the named ones)"

# 2. The fresh setup, from the image.
rc=0
compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(dry run done|setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "today-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

# 3. The https front's certificate and the suite.
mkdir -m 700 "$tmp/tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 \
  -keyout "$tmp/tls/key.pem" -out "$tmp/tls/cert.pem" 2>/dev/null
BW_TODAY_URL="http://127.0.0.1:$port" BW_TODAY_CODE="$access_code" BW_TODAY_SEED="$sample_seed" BW_TODAY_REVIEWER="$reviewer_pw" BW_TODAY_TLS="$tmp/tls" BW_TODAY_PROJECT="$project" \
  pnpm exec vitest run --config ci/today-stack/vitest.config.ts
