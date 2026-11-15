#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P2-SHELL stack suite (BUILD_PLAN P2-SHELL Acceptance): Playwright on Chromium and WebKit against the Compose stack at
# its default settings (infra/compose.yaml, no .env: real PostgreSQL 18, real handlers, pbs running), through its proxy.
# Run by ci/gates/page-walkers.sh (step 3). Starts its own Compose project, verifies it as contract-gates.sh does
# (db, pbs, proxy, routing, web and worker running; PostgreSQL 18; every service setting at its default, ci/wave/stack-settings.ts),
# loads the suite's fixture rows (ci/shell-stack/fixture.sql: the clock row, a few rows to search, 1 office user and its
# session), runs ci/shell-stack/shell.stack.ts, then (P3-REPLAY) loads ci/clock-banner/fixture.sql and runs the clock
# banner suite ci/clock-banner/banner.stack.ts on the same stack, and tears the project down on every exit path.
# The web image is built with the build argument BW_WEB_PREVIEW=1 (the harness app: the shell preview routes); a build
# argument is not a setting, so every setting stays at its default.
# Isolation (as F-132): the project is named bw-shell-* and builds its own image tag <project>:local, never bw-app:local;
# a reaper outside the process group tears it down if this script is killed. No docker: exit 3 ("stack unavailable",
# a red, never a skip).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-shell-[a-z0-9][a-z0-9_-]*$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "shell-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "shell-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi

# The proxy serves the 3 map files map.stack.ts reads from .build/data/maps (a fresh worktree has none): fetch or verify them first (F-690).
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps >/dev/null

project="${BW_SHELL_PROJECT:-bw-shell-$$}"
own_project "$project" || { echo "shell-stack: FAIL project name '$project' is refused (bw-shell-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-shell.XXXXXX")"
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
echo "shell-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build --build-arg BW_WEB_PREVIEW=1 web >/dev/null
echo "shell-stack: image built in $(( $(date +%s) - started )) s"
# F-1415 (the F-1361 cause, class F-1367): routing is started too, as in the default stack. Every read that plans or times a day (API-31's
# right-now ETA, API-20, API-33's answer) asks it for a leg no stored track covers (SD-49). Left out, its name does not resolve, and where
# that lookup is slow (Spectre, about 3.9 s, F-643) each such read spent its whole 3 s live-route budget: the technicians suite's waits after
# a save then failed (nightly-p6-cp6b, WebKit). Running, it answers its name at once: with no routing files in the map folder it refuses the
# connection at once (approximate legs), and with them (the wave run's export) it routes.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "shell-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "shell-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "shell-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "shell-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "shell-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "shell-stack: stack verified at $base"
web_mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(compose ps -q web)")"
echo "shell-stack: web memory after start: $web_mem (used / the container limit, read from docker)"

token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
compose exec -T db psql -q -U brightwater -d brightwater -v token="$token" -f - <ci/shell-stack/fixture.sql >/dev/null
echo "shell-stack: fixture rows loaded"

BW_SHELL_STACK_URL="$base" BW_SHELL_STACK_SESSION="$token" pnpm exec vitest run --config ci/shell-stack/vitest.config.ts
# P4-JOBS: the Jobs list suite (ci/jobs-stack) on the same stack, after the shell suite and before the week board's: 2 technicians whose names
# sort last (the week suite's rows keep their places), customers, jobs numbered 26001 up, and a manager and a technician with sessions (./fixture.sql).
jobs_manager_token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
jobs_tech_token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
compose exec -T db psql -q -U brightwater -d brightwater -v token_manager="$jobs_manager_token" -v token_tech="$jobs_tech_token" -f - <ci/jobs-stack/fixture.sql >/dev/null
echo "shell-stack: jobs list fixture rows loaded"
BW_SHELL_STACK_URL="$base" BW_SHELL_STACK_SESSION="$token" BW_JOBS_STACK_MANAGER="$jobs_manager_token" BW_JOBS_STACK_TECH="$jobs_tech_token" \
  pnpm exec vitest run --config ci/jobs-stack/vitest.config.ts
# P4-WEEK: the Week board suite (ci/week-stack) on the same stack, after the shell suite and before the clock banner suite, which
# jumps the clock it reads (Tue, Sep 15 is "today"): 12 technicians, their week of jobs and the 2 peak days (./fixture.sql).
compose exec -T db psql -q -U brightwater -d brightwater -f - <ci/week-stack/fixture.sql >/dev/null
echo "shell-stack: week board fixture rows loaded"
BW_SHELL_STACK_URL="$base" BW_SHELL_STACK_SESSION="$token" pnpm exec vitest run --config ci/week-stack/vitest.config.ts
# P4-CUSTOMERS: the customers suite (ci/customers-stack) on the same stack, after the week board suite: a manager with her own session,
# the streets and the 3 O'Brien customers (./fixture.sql), then the search, the Customers top-bar item for both roles, a new customer and
# the edits.
customers_manager="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
compose exec -T db psql -q -U brightwater -d brightwater -v token="$customers_manager" -f - <ci/customers-stack/fixture.sql >/dev/null
echo "shell-stack: customers fixture rows loaded"
BW_SHELL_STACK_URL="$base" BW_SHELL_STACK_SESSION="$token" BW_CUSTOMERS_MANAGER="$customers_manager" pnpm exec vitest run --config ci/customers-stack/vitest.config.ts
# P4-TECHNICIANS: the Technicians page suite (ci/technicians-stack) on the same stack, after the customers suite and before the clock banner suite, which
# jumps the clock it reads (Tue, Sep 15 is "today"): 2 technicians whose names sort last, a manager and the technician's own session (./fixture.sql), then the
# table's fields against API-31, the name in texts refusal, Add technician with its one-time invite link, time off over 2 booked jobs and Remove, and the top
# bar's Technicians item for both roles. It adds no stack bring-up and no image build: only its fixture and its own suite run here.
tech_manager="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
tech_own="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
tech_sync="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
compose exec -T db psql -q -U brightwater -d brightwater -v token_manager="$tech_manager" -v token_tech="$tech_own" -v token_sync="$tech_sync" -f - <ci/technicians-stack/fixture.sql >/dev/null
echo "shell-stack: technicians fixture rows loaded"
BW_SHELL_STACK_URL="$base" BW_SHELL_STACK_SESSION="$token" BW_TECHNICIANS_STACK_MANAGER="$tech_manager" BW_TECHNICIANS_STACK_TECH="$tech_own" BW_TECHNICIANS_STACK_SYNC="$tech_sync" \
  pnpm exec vitest run --config ci/technicians-stack/vitest.config.ts
# P5-BOOKING-PAGES: the booking site menu suite (ci/bookmenu-stack) on the same stack, after the technicians suite and before the clock banner suite:
# public pages, so no fixture and no session. Every menu item opens its page at 1440 x 900 and 520 x 980 with no outside link, the pages come in Spanish,
# and an unknown /book/ page name is SCR-SHR-02 answering 404 under the booking header. It adds no stack bring-up and no image build: only its own suite runs.
BW_SHELL_STACK_URL="$base" pnpm exec vitest run --config ci/bookmenu-stack/vitest.config.ts
# P3-REPLAY: the clock banner suite (ci/clock-banner) on the same stack, after the shell suite, since it jumps the shared
# clock: its manager and her session, then every open visitor's banner naming her after her jump (FR-DEMO-6).
manager_token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
compose exec -T db psql -q -U brightwater -d brightwater -v token="$manager_token" -f - <ci/clock-banner/fixture.sql >/dev/null
echo "shell-stack: clock banner fixture rows loaded"
BW_SHELL_STACK_URL="$base" BW_SHELL_STACK_SESSION="$token" BW_CLOCK_BANNER_MANAGER="$manager_token" \
  pnpm exec vitest run --config ci/clock-banner/vitest.config.ts
web_mem="$(docker stats --no-stream --format '{{.MemUsage}}' "$(compose ps -q web)")"
echo "shell-stack: web memory after the suite: $web_mem (used / the container limit, read from docker)"
