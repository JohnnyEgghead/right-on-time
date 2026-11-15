#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P7-TRAINING stack run (BUILD_PLAN P7-TRAINING Acceptance; FR-DIST-10, SC-04): the 10-task dispatcher walkthrough of
# docs/public/walkthrough.md, run by ci/training-stack/training.stack.ts from the written steps, on Chromium and WebKit against the
# Compose stack at its default settings (infra/compose.yaml, no .env: real PostgreSQL 18, real handlers, pbs running, the release web
# image), set up by the setup service (the seeded world of D-3, the clock at Tue, Sep 15, 7:00 AM), through its proxy, outside-origin
# guard on. Same shape as ci/board-stack.sh: its own Compose project, free host ports, torn down on every exit path (a reaper outside
# the process group covers a kill). The suite signs in through the real sign-in page with the sample password the seed derives.
# No docker: exit 3 ("stack unavailable", a red). BW_TRAINING_PROJECT names a lane's own project: bw-p7-training or
# bw-p7-training-<x>, <x> starting with a lowercase letter or digit; any other name exits 2.
# BW_TRAINING_HOLD=<file> (a path for exploring the screens by hand): after the set-up the script writes the address and the seed to
# <file> and holds the stack up, with no suite run, until <file> is removed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-p7-training(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "training-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "training-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
# The setup service reads the verified street list and the map files (F-164, F-362); fetch or verify them first.
node ci/data-assets.ts ensure
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps

project="${BW_TRAINING_PROJECT:-bw-p7-training}"
own_project "$project" || { echo "training-stack: FAIL project name '$project' is refused (bw-p7-training or bw-p7-training-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-p7-training.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"
https_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "training-$$-$RANDOM$RANDOM" >"$tmp/db.env"
# APP_ORIGIN is the copy's own address (the setting every own copy sets, infra/README.md): a browser write carries it, as on e2e-stack.sh.
compose() {
  BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" APP_ORIGIN="http://127.0.0.1:$port" \
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
echo "training-stack: project $project, image $image, reaper pid $reaper"

started=$(date +%s)
compose build web >/dev/null
echo "training-stack: image built in $(( $(date +%s) - started )) s"
compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
rc=0
# The seed goes to setup only (as ci/board-stack.sh): web reads SAMPLE_PASSWORD_SEED too, and the stack stays at its defaults.
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "training-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }

running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "training-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "training-stack: FAIL service $s is not running" >&2; exit 1; }
done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
echo "training-stack: PostgreSQL server_version: $pgv"
case "$pgv" in 18.*) ;; *) echo "training-stack: FAIL the stack database is not PostgreSQL 18 ($pgv)" >&2; exit 1 ;; esac
node ci/wave/stack-settings.ts "$project" 'APP_ORIGIN=*' || { echo "training-stack: FAIL the stack is not at its default settings" >&2; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "training-stack: stack set up and verified at $base in $(( $(date +%s) - started )) s"

if [ -n "${BW_TRAINING_HOLD:-}" ]; then
  printf '%s %s\n' "$base" "$seed" >"$BW_TRAINING_HOLD"
  echo "training-stack: holding the stack until $BW_TRAINING_HOLD is removed"
  while [ -e "$BW_TRAINING_HOLD" ]; do sleep 2; done
  exit 0
fi

suite=0
BW_TRAINING_BASE_URL="$base" BW_TRAINING_SEED="$seed" \
  pnpm exec vitest run --config ci/training-stack/vitest.config.ts || suite=$?
echo "training-stack: done, exit $suite"
exit "$suite"
