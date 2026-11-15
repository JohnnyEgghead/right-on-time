#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P2-AUTH stack suite (BUILD_PLAN P2-AUTH Acceptance): Playwright on Chromium and WebKit against the Compose stack (infra/compose.yaml:
# real PostgreSQL 18, real handlers, pbs running), through its proxy, with ACCESS_CODE_ON=on. 1 Compose project, 2 phases:
#   1. DEMO_MODE=off: ci/auth-stack/nodemo.stack.ts on every engine (no Sign in as list, no sample sign-ins, even after the code);
#      the web log holds no "demo mode on" line.
#   2. DEMO_MODE=on (Compose recreates web, worker and pbs with it; db and its rows stay): ci/auth-stack/auth.stack.ts once per engine
#      (every route answers the gate before the code, the Sign in as list appears only after it, a password sign-in works without
#      it, sign-out, the "/" shortcut); after each, the web log holds exactly 1 "demo mode on" line.
# Sign-in is rate limited by address, 10 a minute (SPECIFICATIONS 7.1), every browser reaches the proxy from the same address, and 1
# engine's run signs in 7 times. The counters live in the web process (packages/api-server/src/kernel/rate-limit.ts), so each engine's
# run starts on a fresh web process: recreated, as every deploy recreates it, and checked to be a new container. No sleep (F-290), except the suite's bounded wait for the sign-in window (auth.stack.ts roomForSignIns, F-1243).
# The browsers reach the proxy through the suites' https front (ci/auth-stack/tls-front.ts, F-290): bw_access is Secure over https only, as the product sets it, and
# WebKit neither keeps nor sends a Secure cookie over plain http. Its key and self-signed certificate are made here with openssl.
# Run by ci/gates/page-walkers.sh (step 4). Starts its own Compose project, verifies it as shell-stack.sh does (db, pbs, proxy, web
# and worker running; PostgreSQL 18; every service setting at its default except the named ones, ci/wave/stack-settings.ts) at
# each phase and after each fresh web process, loads ci/auth-stack/fixture.ts's rows (the clock row, 1 branch, the users the screens
# list), and tears the project down on every exit path. The access code, the cookie key, the sample password seed and the reviewer
# password are made fresh for each run and handed to Compose and the suite through the environment: never written to a file in the
# repo, never printed. The image is the release build (no BW_WEB_PREVIEW). No docker: exit 3 ("stack unavailable", a red, never a skip).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-auth-[a-z0-9][a-z0-9_-]*$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "auth-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

[ "$#" -eq 0 ] || { echo "auth-stack: usage: auth-stack.sh (no arguments; both DEMO_MODE phases run in 1 project)" >&2; exit 2; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "auth-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
command -v openssl >/dev/null 2>&1 || { echo "auth-stack: FAIL no openssl here: the suites' https front needs a certificate" >&2; exit 1; }

# The engines every Playwright proof runs on, from the 1 list (ci/pw-engine-names.ts; BW_PW_ENGINES narrows a local run, with a reason).
engine_list="$(node --input-type=module -e '
  import { resolveEngines } from "./ci/pw-engine-names.ts";
  console.log(resolveEngines(process.env.BW_PW_ENGINES, process.env.BW_PW_ENGINES_WHY).names.join(" "));
')"

project="${BW_AUTH_PROJECT:-bw-auth-$$}"
own_project "$project" || { echo "auth-stack: FAIL project name '$project' is refused (bw-auth-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-auth.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
secret() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
printf 'POSTGRES_PASSWORD=%s\n' "auth-$$-$RANDOM$RANDOM" >"$tmp/db.env"
access_code="$(secret)"
cookie_key="$(secret)"
sample_seed="$(secret)"
reviewer_password="$(secret)"
demo_mode=off
compose() {
  BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" \
    ACCESS_CODE_ON=on DEMO_MODE="$demo_mode" ACCESS_CODE="$access_code" ACCESS_COOKIE_KEY="$cookie_key" SAMPLE_PASSWORD_SEED="$sample_seed" \
    docker compose -p "$project" -f infra/compose.yaml "$@"
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
echo "auth-stack: project $project, image $image, engines $engine_list, reaper pid $reaper"

t0=$(date +%s)
compose build web >/dev/null
echo "auth-stack: image built in $(( $(date +%s) - t0 )) s"

base="http://127.0.0.1:$port"
# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
up() { compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing; }
# The 5 services run and every setting is at its default but the named ones (DEMO_MODE as this phase sets it); the secrets are
# checked set, never read out (KEY=*). Then the proxy answers.
verify() {
  local running s
  running="$(compose ps --status running --services | sort | tr '\n' ' ')"
  echo "auth-stack: running services: $running"
  for s in db pbs proxy routing web worker; do
    grep -qw "$s" <<<"$running" || { echo "auth-stack: FAIL service $s is not running" >&2; exit 1; }
  done
  node ci/wave/stack-settings.ts "$project" ACCESS_CODE_ON=on "DEMO_MODE=$demo_mode" 'ACCESS_CODE=*' 'ACCESS_COOKIE_KEY=*' 'SAMPLE_PASSWORD_SEED=*' \
    || { echo "auth-stack: FAIL the stack is not at its default settings but for the named ones" >&2; exit 1; }
  curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
}
# C10: the web process's log holds the demo line once with DEMO_MODE=on, and never with it off.
log_check() {
  local lines
  lines="$(compose logs --no-log-prefix web 2>/dev/null | grep -c 'demo mode on' || true)"
  echo "auth-stack: 'demo mode on' lines in the web log: $lines (want $1)"
  [ "$lines" = "$1" ] || { echo "auth-stack: FAIL the demo mode log line count is $lines, want $1" >&2; return 1; }
}
suite() {
  BW_AUTH_STACK_URL="$base" BW_AUTH_STACK_CODE="$access_code" BW_AUTH_STACK_SEED="$sample_seed" BW_AUTH_STACK_TLS="$tmp/tls" \
    pnpm exec vitest run --config ci/auth-stack/vitest.config.ts "$@"
}

up
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "auth-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "auth-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
verify
echo "auth-stack: stack verified at $base in $(( $(date +%s) - t0 )) s"
BW_AUTH_STACK_SEED="$sample_seed" BW_AUTH_STACK_REVIEWER="$reviewer_password" node ci/auth-stack/fixture.ts \
  | compose exec -T db psql -q -U brightwater -d brightwater -f - >/dev/null
echo "auth-stack: fixture rows loaded"
mkdir -m 700 "$tmp/tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 \
  -keyout "$tmp/tls/key.pem" -out "$tmp/tls/cert.pem" 2>/dev/null
echo "auth-stack: https front certificate made"

# FR-AUTH-8 (P4-ACCOUNTS, F-614): what this checks is narrower than "no email leaves the app", and the words say so. Two checks:
#  1. the running web image (the release image built from this tree) holds none of 6 mail programs and no package whose name starts
#     with one of 6 mail-package prefixes, in /app/node_modules/.pnpm and /app/apps/web/node_modules; each directory must exist and
#     list at least its floor of entries (measured 78 and 9 on the image), so a moved node_modules fails instead of passing on nothing.
#  2. the product source (apps and packages, tests and the testing helpers left out) opens no socket of its own (node:net, node:tls)
#     and names no SMTP scheme, a port named 25, 465 or 587, or a mail-API host. @bw/testkit (packages/testkit, the load-day script)
#     is left out too: it is not product, the image's .dockerignore leaves its source out, and check 1 fails if the web image holds
#     a copy (F-1550: its page probe times a TCP connect with node:net).
# Not seen: a mail send through fetch to a host this list does not name. The outside-origin guard covers the browser side; nothing here
# runs web on a network with no outside route.
mail_rc=0
compose exec -T web sh -c 'for b in sendmail ssmtp msmtp postfix exim exim4; do command -v "$b" && exit 1; done
  for d in /app/node_modules/.pnpm:40 /app/apps/web/node_modules:5; do
    dir="${d%:*}"; floor="${d#*:}"
    [ -d "$dir" ] || exit 2
    [ "$(ls "$dir" | wc -l)" -ge "$floor" ] || exit 2
    ls "$dir" | grep -iE "^(nodemailer|emailjs|smtp|@sendgrid|mailgun|postmark)" && exit 1
  done
  [ -d /app/packages/api/src ] || exit 2
  [ -e /app/packages/testkit/src ] && exit 3
  exit 0' >/dev/null || mail_rc=$?
if [ "$mail_rc" -eq 2 ]; then
  echo "auth-stack: FAIL the mail-transport check saw too few entries in the web image (the node_modules or /app/packages moved?)" >&2
  exit 1
elif [ "$mail_rc" -eq 3 ]; then
  echo "auth-stack: FAIL the web image holds packages/testkit/src, which the product-source scan leaves out as not shipped" >&2
  exit 1
elif [ "$mail_rc" -ne 0 ]; then
  echo "auth-stack: FAIL the web image holds a mail transport" >&2
  exit 1
fi
mail_src="$(grep -rEIl "from ['\"](node:)?(net|tls)['\"]|smtps?:|smtp\.|port['\"]?[ ]*[:=][ ]*(25|465|587)([^0-9]|$)|mailgun|sendgrid|postmarkapp|sparkpost|api\.resend|mandrillapp" \
  apps/web/app apps/web/src apps/worker/src apps/pbs/src packages/*/src 2>/dev/null | grep -vE '\.test\.ts$|/testing/|^packages/testkit/' || true)"
if [ -n "$mail_src" ]; then
  echo "auth-stack: FAIL product source opens a socket or names a mail host: $mail_src" >&2
  exit 1
fi
echo "auth-stack: no mail transport in the web image, and no socket or mail host in the product source"

rc=0
t=$(date +%s)
echo "auth-stack: phase 1, DEMO_MODE=off: nodemo.stack.ts on $engine_list"
suite ci/auth-stack/nodemo.stack.ts || rc=$?
# P4-ACCOUNTS: UC-19 and the one-time link with demo mode off (RESET_PROTECTION unset, OI-29), every engine in 1 run.
BW_ACCOUNTS_PHASE=nodemo suite ci/auth-stack/accounts.stack.ts || rc=$?
log_check 0 || rc=1
echo "auth-stack: phase 1 took $(( $(date +%s) - t )) s"

demo_mode=on
first=1
for engine in $engine_list; do
  t=$(date +%s)
  before="$(compose ps -q web)"
  if [ "$first" = 1 ]; then
    up
  else
    compose up -d --no-build --no-deps --force-recreate --wait --wait-timeout 120 web
  fi
  first=0
  after="$(compose ps -q web)"
  [ -n "$after" ] && [ "$after" != "$before" ] || { echo "auth-stack: FAIL web is not a fresh container before the $engine run" >&2; exit 1; }
  verify
  echo "auth-stack: phase 2, DEMO_MODE=on, $engine on a fresh web process (ready in $(( $(date +%s) - t )) s)"
  BW_AUTH_STACK_ENGINE="$engine" suite ci/auth-stack/auth.stack.ts || rc=$?
  log_check 1 || rc=1
  # P4-ACCOUNTS: owner ruling 5a554f12 (F-333) and UC-18, on their own fresh web process (the sign-in limit counts per process).
  before="$(compose ps -q web)"
  compose up -d --no-build --no-deps --force-recreate --wait --wait-timeout 120 web
  after="$(compose ps -q web)"
  [ -n "$after" ] && [ "$after" != "$before" ] || { echo "auth-stack: FAIL web is not a fresh container before the $engine accounts run" >&2; exit 1; }
  verify
  BW_ACCOUNTS_PHASE=demo BW_AUTH_STACK_ENGINE="$engine" suite ci/auth-stack/accounts.stack.ts || rc=$?
  echo "auth-stack: phase 2 on $engine took $(( $(date +%s) - t )) s"
done
echo "auth-stack: done in $(( $(date +%s) - t0 )) s, exit $rc"
exit "$rc"
