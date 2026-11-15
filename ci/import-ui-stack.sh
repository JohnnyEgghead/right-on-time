#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P4-ADMIN-IMPORT stack suite (BUILD_PLAN P4-ADMIN-IMPORT Acceptance): the import pages (SCR-OFC-13 to -15, -25, -26) in Playwright on
# Chromium and WebKit against the Compose stack at its default settings (infra/compose.yaml, no .env: real PostgreSQL 18, real handlers,
# pbs running, the worker started by its real start-up; the web image is the release build), after a fresh setup from the image, through
# its proxy, with the outside-origin guard on:
#   1. the stack (no database env file: the own-copy default, as ci/import-stack.sh), verified: every service running, PostgreSQL 18,
#      every setting at its default (ci/wave/stack-settings.ts);
#   2. the fresh setup (`docker compose --profile setup run --rm setup`): its real run is the world's, so Run the import is disabled;
#   3. 1 office session (Keisha Thompson, a seeded office user), then ci/import-ui-stack/import.ui.stack.ts on each engine of
#      ci/pw-engines.ts: the history lists setup's run; UC-08 (a dry run through the page changes no row count; the K key reviews a pair;
#      S skips, M merges, the keys act only with focus on the shown pair; Undo restores the customer); and, last, a world with no real
#      run, where Run the import is offered.
# Isolation as ci/import-stack.sh (F-132): project bw-impui-*, its own image tag, a reaper outside the process group.
# No docker: exit 3 ("stack unavailable", a red). Run by ci/gates/page-walkers-nightly.sh (step 5). The suite fetches the map files itself
# (setup needs MAPS_DIR).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-impui-[a-z0-9][a-z0-9_-]*$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "import-ui-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "import-ui-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
node ci/data-assets.ts ensure >/dev/null
# Setup checks and loads the map files (MAPS_DIR, F-362), so they are fetched and verified as the wave run fetches them.
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps >/dev/null

project="${BW_IMPORT_UI_PROJECT:-bw-impui-$$}"
own_project "$project" || { echo "import-ui-stack: FAIL project name '$project' is refused (bw-impui-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-impui.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
seed="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
# The suite recreates the worker (the planted case), so it runs docker compose with this same environment.
export BW_IMAGE="$image" DB_ENV_FILE="$tmp/no-db-env-file" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port"
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
echo "import-ui-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "import-ui-stack: image built in $(( $(date +%s) - started )) s"
# 1. The stack at its default settings.
# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
running="$(compose ps --status running --services | sort | tr '\n' ' ')"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "import-ui-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
case "$pgv" in 18.*) ;; *) echo "import-ui-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" || { echo "import-ui-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
echo "import-ui-stack: stack verified (PostgreSQL $pgv, default settings)"

# 2. The fresh setup, from the image.
rc=0
# The seed goes to setup only: web reads SAMPLE_PASSWORD_SEED too, and the stack stays at its default settings.
SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(dry run done|setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "import-ui-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

# 3. The office session and the suite.
token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
compose exec -T db psql -q -U brightwater -d brightwater -v ON_ERROR_STOP=1 -v token="$token" >/dev/null <<'SQL'
INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real)
SELECT sha256(convert_to(:'token', 'UTF8')), id, 'web', 'password', false, now(), now(), now() + interval '2 hours'
  FROM world."user" WHERE email = 'keisha.t@brightwater.example';
SQL
BW_IMPORT_UI_URL="http://127.0.0.1:$port" BW_IMPORT_UI_SESSION="$token" BW_IMPORT_UI_PROJECT="$project" \
  pnpm exec vitest run --config ci/import-ui-stack/vitest.config.ts
