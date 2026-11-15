#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P4-CLOCK stack suite (BUILD_PLAN P4-CLOCK Acceptance): UC-10 in Playwright on Chromium and WebKit against the Compose stack at its default
# settings (infra/compose.yaml: real PostgreSQL 18, real handlers, pbs running, the worker started by its real start-up; the web image is the
# release build), after a fresh setup from the image, through its proxy, with the outside-origin guard on. UC-10 starts at the access code, so the
# stack runs with the P2-AUTH stack's named settings on (ACCESS_CODE_ON, DEMO_MODE and the secrets), and the browsers reach it through the same
# https front (ci/auth-stack/tls-front.ts: bw_access is Secure, and WebKit keeps no Secure cookie over plain http):
#   1. the stack, verified: every service running, PostgreSQL 18, every setting at its default but the named ones (ci/wave/stack-settings.ts);
#   2. the fresh setup (`docker compose --profile setup run --rm setup`);
#   3. ci/clock-ui-stack/clock.ui.stack.ts on each engine of ci/pw-engines.ts, each on its own fresh world (steps 1 and 2 again between engines;
#      owner ruling Nov 10, 2026 item 4b: no wait for the 5-minute reset cool-down): the visitor enters the code, signs in as the sample
#      manager, jumps to the 6:00 PM reminder, the due reminders arrive in order, and every open page's banner names who moved the clock; the
#      Reset the demo world flow (confirm, cool-down) puts the world back to its start.
# Isolation as ci/import-ui-stack.sh (F-132): project bw-clkui-*, its own image tag, a reaper outside the process group. The access code, the
# cookie key and the sample password seed are made fresh for each run and handed to Compose and the suite through the environment: never written to
# a file in the repo, never printed. No docker: exit 3 ("stack unavailable", a red). Run by ci/gates/page-walkers-nightly.sh (step 6).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-clkui-[a-z0-9][a-z0-9_-]*$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "clock-ui-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "clock-ui-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
command -v openssl >/dev/null 2>&1 || { echo "clock-ui-stack: FAIL no openssl here: the suite's https front needs a certificate" >&2; exit 1; }
node ci/data-assets.ts ensure >/dev/null
# Setup checks and loads the map files (MAPS_DIR, F-362), so they are fetched and verified as the wave run fetches them.
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps >/dev/null

project="${BW_CLOCK_UI_PROJECT:-bw-clkui-$$}"
own_project "$project" || { echo "clock-ui-stack: FAIL project name '$project' is refused (bw-clkui-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-clkui.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
secret() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
port="$(freeport)"
https_port="$(freeport)"
access_code="$(secret)"
cookie_key="$(secret)"
sample_seed="$(secret)"
# The suite recreates nothing, but it runs docker compose with this same environment (psql, the worker's log).
export BW_IMAGE="$image" DB_ENV_FILE="$tmp/no-db-env-file" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port"
export ACCESS_CODE_ON=on DEMO_MODE=on ACCESS_CODE="$access_code" ACCESS_COOKIE_KEY="$cookie_key" SAMPLE_PASSWORD_SEED="$sample_seed"
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
echo "clock-ui-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "clock-ui-stack: image built in $(( $(date +%s) - started )) s"
# Ruling Nov 10, 2026 item 4b: each engine gets its own fresh world. The second engine used to start in the first engine's world and wait out the
# 5-minute reset cool-down (measured about 5 minutes a night); now the world is made again between engines. Setup starts a cool-down too, so the Reset
# flow and its cool-down are tested on the first engine's world only (BW_CLOCK_UI_RESET=0 for the others, whose world is clean at Sep 15, 7:00 AM).
# fresh_world <first: 1 for the first world>: steps 1 and 2. A later world first removes the stack's containers and volumes (the images stay).
fresh_world() {
  if [ "$1" != 1 ]; then
    compose --profile setup down -v --remove-orphans >/dev/null 2>&1 || { echo "clock-ui-stack: FAIL the previous world could not be removed" >&2; exit 1; }
  fi
  # 1. The stack at its default settings but the named ones.
  # F-1361: routing is started too (it has no routing files here, so it refuses a connection at once). Without it the worker's name for it,
  # routing, does not resolve, and a slow lookup makes every ETA sweep of the replay spend its 3 s live-route budget (SD-49 step 3 allows
  # that): the replay to Oct 31 then passes the suite's 120 s wait and the DST case fails (nightly 4a1c239f, both engines). Reproduced here
  # with a black-hole address for routing: the same error at 122 s; with routing running the case takes about 13 s.
  compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
  running="$(compose ps --status running --services | sort | tr '\n' ' ')"
  for s in db pbs proxy web worker; do
    grep -qw "$s" <<<"$running" || { echo "clock-ui-stack: FAIL service $s is not running" >&2; exit 1; }
  done
  pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
  case "$pgv" in 18.*) ;; *) echo "clock-ui-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
  node ci/wave/stack-settings.ts "$project" ACCESS_CODE_ON=on DEMO_MODE=on 'ACCESS_CODE=*' 'ACCESS_COOKIE_KEY=*' 'SAMPLE_PASSWORD_SEED=*' \
    || { echo "clock-ui-stack: FAIL the stack is not at its default settings but for the named ones" >&2; exit 1; }
  echo "clock-ui-stack: stack verified (PostgreSQL $pgv, default settings but the named ones)"

  # 2. The fresh setup, from the image.
  local src=0
  compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || src=$?
  grep -E '"status":"(dry run done|setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
  [ "$src" -eq 0 ] || { echo "clock-ui-stack: FAIL setup exited $src" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }
}

# 3. The https front's certificate and the suite, once per engine, each on its own fresh world. The engine list is BW_PW_ENGINES as
# ci/pw-engines.ts reads it (a narrowed list still needs its reason, F-39); the suite is told 1 engine at a time.
engine_list="$(node -e '
  import("./ci/pw-engine-names.ts").then((m) => {
    const r = m.resolveEngines(process.env.BW_PW_ENGINES, process.env.BW_PW_ENGINES_WHY);
    if (r.notice) console.error("pw-engines: " + r.notice);
    console.log(r.names.join(" "));
  }).catch((e) => { console.error(String(e.message)); process.exit(1); });
')" || { echo "clock-ui-stack: FAIL the engine list is refused" >&2; exit 1; }
mkdir -m 700 "$tmp/tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 \
  -keyout "$tmp/tls/key.pem" -out "$tmp/tls/cert.pem" 2>/dev/null
suite_rc=0
first=1
for engine in $engine_list; do
  world_t0=$(date +%s)
  fresh_world "$first"
  # The Reset flow and its 5-minute cool-down (setup starts one too) are tested on the first engine's world only (item 4b).
  reset_flow=$first
  echo "clock-ui-stack: fresh world for $engine ready in $(( $(date +%s) - world_t0 )) s"
  first=0
  BW_CLOCK_UI_RESET="$reset_flow" BW_PW_ENGINES="$engine" BW_PW_ENGINES_WHY="clock-ui-stack: 1 engine per fresh world (the other engine has its own world and its own run)" \
  BW_CLOCK_UI_URL="http://127.0.0.1:$port" BW_CLOCK_UI_CODE="$access_code" BW_CLOCK_UI_SEED="$sample_seed" BW_CLOCK_UI_TLS="$tmp/tls" BW_CLOCK_UI_PROJECT="$project" \
    pnpm exec vitest run --config ci/clock-ui-stack/vitest.config.ts || suite_rc=$?
done
exit "$suite_rc"
