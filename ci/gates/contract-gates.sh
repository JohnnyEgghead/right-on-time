#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate contract-gates (BUILD_PLAN P2-API-CORE; SPECIFICATIONS SD-4, section 7.1): contract-tests and contract-diff.
#   1. Offline proofs, every run (W-38): the @bw/api unit tests, including an answer missing its envelope labels failing its check.
#   2. contract-diff: the real rows pass against packages/api/contracts.baseline.json; the committed planted field rename
#      (ci/gates/contract-gates/cases/renamed-field.rows.ts) must fail with exit 1 and name the removed field.
#   3. contract-tests: every row's examples against the Compose stack at its default settings (infra/compose.yaml, no .env).
#      The stack is ours: BW_CONTRACT_BASE_URL unset -> this script starts its own Compose project (needs docker), verifies
#      it, runs the suite, and tears the project down. In the wave run, docker is the run's own engine (ci/wave-run.sh, F-126).
#      BW_CONTRACT_BASE_URL set -> use that already-running stack. It must name its Compose project (BW_CONTRACT_PROJECT)
#      and pass the same verification, or the gate fails: a stack that was not verified never passes (F-134).
#      Verification, both modes: db, pbs, proxy, web and worker running; PostgreSQL 18; every service setting at its
#      default (ci/wave/stack-settings.ts); the base URL is this project's proxy.
#      No docker -> exit 3, "stack unavailable": a red, never a skip and never a pass.
# Isolation (F-132): an own project is named bw-contract-* (BW_CONTRACT_PROJECT is refused otherwise, so down -v can never
# reach the own copy's "brightwater" project) and builds its own image tag <project>:local, never the shared bw-app:local.
# Teardown runs from the EXIT trap and, for a kill the trap cannot see (ci/run-gates.ts SIGKILLs the gate's process
# group at its cap), from a reaper outside that group that tears the project down once this script's process is gone.
# Settings: BW_CONTRACT_PROJECT (Compose project name; default bw-contract-<pid>; with BW_CONTRACT_BASE_URL, the
# project serving that URL).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && cd .. && pwd)"
cd "$root"

# stack_down <project> <image> <tmp>: idempotent; used by the EXIT trap and by the reaper.
stack_down() {
  docker compose -p "$1" -f infra/compose.yaml down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-contract-[a-z0-9][a-z0-9_-]*$ ]]; }

# Reaper mode (internal): started detached by this script, in its own session, so a process-group kill misses it.
if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "contract-gates --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

# Refusals first, before any work (F-132, F-134).
if [ -n "${BW_CONTRACT_BASE_URL:-}" ]; then
  if [ -z "${BW_CONTRACT_PROJECT:-}" ]; then
    echo "contract-gates: FAIL BW_CONTRACT_BASE_URL is set but BW_CONTRACT_PROJECT is not: the stack at that URL cannot be" >&2
    echo "  verified (PostgreSQL 18, the 5 services, default settings), and a stack that was not verified never passes." >&2
    exit 2
  fi
elif [ -n "${BW_CONTRACT_PROJECT:-}" ] && ! own_project "$BW_CONTRACT_PROJECT"; then
  echo "contract-gates: FAIL BW_CONTRACT_PROJECT '$BW_CONTRACT_PROJECT' is refused: a project this gate starts (and removes" >&2
  echo "  with down -v) must be named bw-contract-<lowercase letters, digits, - or _>." >&2
  exit 2
fi

echo "== contract-gates 1/3: @bw/api unit tests (envelope labels, mounting, paging, catalog, diff)"
pnpm exec vitest run packages/api

echo "== contract-gates 2/3: contract-diff"
node packages/api/src/cli.ts diff
rc=0
planted="$(node packages/api/src/cli.ts diff --rows ci/gates/contract-gates/cases/renamed-field.rows.ts 2>&1)" || rc=$?
if [ "$rc" -ne 1 ] || ! grep -q 'API-171 response.status: removed field' <<<"$planted"; then
  echo "contract-gates: FAIL the planted field rename was not flagged by contract-diff (exit $rc):" >&2
  echo "$planted" >&2
  exit 1
fi
echo "contract-diff: planted rename flagged (exit 1, removed field), as required"

echo "== contract-gates 3/3: contract-tests against the Compose stack"
suite() { BW_CONTRACT_BASE_URL="$1" pnpm exec vitest run --config ci/gates/contract-gates/vitest.config.ts; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "contract-gates: FAIL stack unavailable: no usable docker here." >&2
  echo "  contract-tests need the Compose stack (real PostgreSQL 18, pbs running), started here or verified here." >&2
  exit 3
fi

# verify_stack <project> <base url>: the same proof in both modes; any miss is a FAIL.
verify_stack() {
  local p="$1" url="$2" running pgv bound hostport
  running="$(docker compose -p "$p" -f infra/compose.yaml ps --status running --services | sort | tr '\n' ' ')"
  echo "running services ($p): $running"
  for s in db pbs proxy web worker; do
    grep -qw "$s" <<<"$running" || { echo "contract-gates: FAIL service $s is not running in project $p" >&2; exit 1; }
  done
  pgv="$(docker compose -p "$p" -f infra/compose.yaml exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
  echo "PostgreSQL server_version: $pgv"
  case "$pgv" in 18.*) ;; *) echo "contract-gates: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
  node ci/wave/stack-settings.ts "$p" || { echo "contract-gates: FAIL the stack is not at its default settings" >&2; exit 1; }
  bound="$(docker compose -p "$p" -f infra/compose.yaml port proxy 80)"
  hostport="${url#http://}"; hostport="${hostport%%/*}"; hostport="${hostport/#localhost:/127.0.0.1:}"
  [ "$hostport" = "$bound" ] || { echo "contract-gates: FAIL the base URL $url is not project $p's proxy (port 80 is published at $bound)" >&2; exit 1; }
  echo "stack verified: project $p at $url"
}

if [ -n "${BW_CONTRACT_BASE_URL:-}" ]; then
  verify_stack "$BW_CONTRACT_PROJECT" "$BW_CONTRACT_BASE_URL"
  suite "$BW_CONTRACT_BASE_URL"
  exit $?
fi

project="${BW_CONTRACT_PROJECT:-bw-contract-$$}"
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-contract.XXXXXX")"
port="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
https_port="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
# Only the database password is supplied (the image refuses to start without one); every other setting is the default, "all off".
printf 'POSTGRES_PASSWORD=%s\n' "contract-$$-$RANDOM$RANDOM" >"$tmp/db.env"
compose() { BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" docker compose -p "$project" -f infra/compose.yaml "$@"; }
reaper=""
cleanup() { stack_down "$project" "$image" "$tmp"; if [ -n "$reaper" ]; then kill "$reaper" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The reaper: its own session (node detached = setsid) and no stdio, so neither a group kill nor a closed pipe reaches it.
reaper="$(node -e '
  const c = require("node:child_process").spawn("bash", process.argv.slice(1), { detached: true, stdio: "ignore" });
  c.unref();
  console.log(c.pid);
' "$0" --reap "$$" "$project" "$image" "$tmp")"
echo "project $project, image $image, temp dir $tmp, reaper pid $reaper"

# F-1367 (cause: ci/shell-stack.sh, F-1415): routing is started too, as in the default stack, so reads that plan or time a day do not wait out the live-route budget.
compose up -d --build --wait --wait-timeout 180 proxy web worker pbs db routing
base="http://127.0.0.1:$port"
verify_stack "$project" "$base"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
suite "$base"
