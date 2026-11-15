#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The P7-E2E stack run (BUILD_PLAN P7-E2E; NFR-12, SC-07): the scripted 7-step happy path of REQUIREMENTS section 2 (ci/e2e-stack/e2e.stack.ts) on
# Chromium and WebKit against a local copy of the Compose stack whose network policy blocks every outside host after install, with the
# outside-origin guard on. Same shape as ci/booking-stack.sh: its own Compose project, free host ports, set up by the setup service (the seeded
# world, the clock at Tue, Sep 15, 7:00 AM), torn down on every exit path (a reaper outside the process group does it on a kill).
#
#   ci/e2e-stack.sh            the happy path; exit 0 only if it passes with the block proven before and after it
#   ci/e2e-stack.sh --plant    the planted request: the suite plants 1 request to an outside origin; exit 0 only if the run FAILS on the guard
#
# How the outside is blocked (infra: ci/e2e-stack/blocked.compose.yaml): all images are built and pulled first (the install), then the stack starts on
# an internal Docker network (no route out), the proxy's published ports ride a second bridge whose default route is removed. Proof, from inside
# each of the 6 services' network namespaces: a connect to 1.1.1.1:443 and a fetch by name both fail, before and after the suite; a control
# container on the ordinary bridge reaches 1.1.1.1 when this host has a network (said so when it has none: then the probe cannot tell).
# The suite takes its base URL from BW_E2E_BASE_URL and signs in with BW_E2E_SEED (or explicit passwords); it uses no docker and no SQL, so
# P9-SIGNOFF-RUNS runs the same file against the hosted demo.
# BW_E2E_PROJECT names the project (bw-p7-e2e or bw-p7-e2e-<x>), BW_E2E_HTTP_PORT and BW_E2E_HTTPS_PORT pin the host ports (default: free ports).
# No docker: exit 3 ("stack unavailable", a red). Runs with no host tools beyond docker, node, pnpm and curl.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

PROBE_IMAGE='alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f'

stack_down() {
  docker compose -p "$1" -f infra/compose.yaml -f ci/e2e-stack/blocked.compose.yaml --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$2" >/dev/null 2>&1 || true
  rm -rf "$3"
}
own_project() { [[ "$1" =~ ^bw-p7-e2e(-[a-z0-9][a-z0-9_-]*)?$ ]]; }

if [ "${1:-}" = "--reap" ]; then
  [ "$#" -eq 5 ] && own_project "$3" || { echo "e2e-stack --reap: refused (args)" >&2; exit 2; }
  while kill -0 "$2" 2>/dev/null; do sleep 1; done
  stack_down "$3" "$4" "$5"
  exit 0
fi

plant=0
case "${1:-}" in
  "") ;;
  --plant) plant=1 ;;
  *) echo "e2e-stack: usage: ci/e2e-stack.sh [--plant]" >&2; exit 2 ;;
esac

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "e2e-stack: FAIL stack unavailable: no usable docker here." >&2
  exit 3
fi
# The setup service reads the verified street list and the map files; fetch or verify them first (the install).
node ci/data-assets.ts ensure
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps

project="${BW_E2E_PROJECT:-bw-p7-e2e}"
own_project "$project" || { echo "e2e-stack: FAIL project name '$project' is refused (bw-p7-e2e or bw-p7-e2e-<lowercase>)" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-p7-e2e.XXXXXX")"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="${BW_E2E_HTTP_PORT:-$(freeport)}"
https_port="${BW_E2E_HTTPS_PORT:-$(freeport)}"
base="http://127.0.0.1:$port"
printf 'POSTGRES_PASSWORD=%s\n' "e2e-$$-$RANDOM$RANDOM" >"$tmp/db.env"
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
# APP_ORIGIN is the copy's own address (the setting every own copy sets, infra/README.md): a browser write carries it, so the suite resends nothing.
compose() {
  BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" APP_ORIGIN="$base" SAMPLE_PASSWORD_SEED="$seed" \
    BW_DATA_DIR="$root/.build/data" BW_MAPS_DIR="$root/.build/data/maps" \
    docker compose -p "$project" -f infra/compose.yaml -f ci/e2e-stack/blocked.compose.yaml "$@"
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
echo "e2e-stack: project $project, image $image, $base, reaper pid $reaper"

# 1. Install: everything that needs the network happens here, before the policy applies.
started=$(date +%s)
compose build web >/dev/null
compose --profile setup pull --quiet --ignore-buildable >/dev/null 2>&1 || echo "e2e-stack: note: image pull skipped (offline or all images present); the start below never pulls"
docker image inspect "$PROBE_IMAGE" >/dev/null 2>&1 || docker pull -q "$PROBE_IMAGE" >/dev/null
echo "e2e-stack: install done in $(( $(date +%s) - started )) s; from here no container may reach an outside host"

# 2. The policy: the internal network and the proxy's routeless second bridge.
compose up -d --no-build --pull never --wait --wait-timeout 180 proxy web worker pbs db routing
proxy_id="$(compose ps -q proxy)"
drop_proxy_route() {
  docker run --rm --net "container:$proxy_id" --cap-add NET_ADMIN "$PROBE_IMAGE" sh -c 'ip route del default 2>/dev/null; ip route | grep -c "^default" || true' | grep -qx 0
}
drop_proxy_route || { echo "e2e-stack: FAIL the proxy still has a default route" >&2; exit 1; }

# 3. Proof: from inside each service's network namespace, an outside address and an outside name are unreachable.
probe_one() { # $1 = container id; prints REACHED or BLOCKED
  docker run --rm --net "container:$1" "$PROBE_IMAGE" sh -c '
    if nc -w 3 1.1.1.1 443 </dev/null >/dev/null 2>&1; then echo REACHED; exit 0; fi
    if wget -q -T 3 -O /dev/null http://example.com/ >/dev/null 2>&1; then echo REACHED; exit 0; fi
    echo BLOCKED' 2>/dev/null | tail -1
}
prove_blocked() { # $1 = label
  local s id v
  for s in proxy web worker pbs db routing; do
    id="$(compose ps -q "$s")"
    [ -n "$id" ] || { echo "e2e-stack: FAIL service $s has no container ($1)" >&2; return 1; }
    v="$(probe_one "$id")"
    echo "e2e-stack: outside probe ($1) $s: $v"
    [ "$v" = "BLOCKED" ] || { echo "e2e-stack: FAIL $s reaches an outside host ($1)" >&2; return 1; }
  done
}
for n in $(docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}'); do
  echo "e2e-stack: network $n internal=$(docker network inspect -f '{{.Internal}}' "$n")"
done
ctl="$(docker run --rm "$PROBE_IMAGE" sh -c 'nc -w 3 1.1.1.1 443 </dev/null >/dev/null 2>&1 && echo REACHED || echo BLOCKED' 2>/dev/null | tail -1)"
if [ "$ctl" = "REACHED" ]; then
  echo "e2e-stack: control: a container on the ordinary bridge reaches 1.1.1.1:443, so BLOCKED above is the policy"
else
  echo "e2e-stack: WARNING control: an ordinary container cannot reach 1.1.1.1:443 either (this host has no outside network); BLOCKED does not discriminate"
fi
prove_blocked "before the suite"

# 4. Setup (no network needed) and the sessions' passwords: the sample people's derive from the seed.
rc=0
compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || rc=$?
grep -E '"status":"(setup done|setup refused)"|^setup: ' "$tmp/setup.log" || true
[ "$rc" -eq 0 ] || { echo "e2e-stack: FAIL setup exited $rc" >&2; tail -5 "$tmp/setup.log" >&2; exit 1; }
running="$(compose ps --status running --services | sort | tr '\n' ' ')"
echo "e2e-stack: running services: $running"
for s in db pbs proxy routing web worker; do
  grep -qw "$s" <<<"$running" || { echo "e2e-stack: FAIL service $s is not running" >&2; exit 1; }
done
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
echo "e2e-stack: stack set up and verified at $base in $(( $(date +%s) - started )) s"

# 5. The suite.
suite=0
if [ "$plant" = 1 ]; then
  BW_E2E_BASE_URL="$base" BW_E2E_SEED="$seed" BW_E2E_PLANT=1 pnpm exec vitest run --config ci/e2e-stack/vitest.config.ts >"$tmp/plant.log" 2>&1 || suite=$?
  tail -n 40 "$tmp/plant.log"
  if [ "$suite" -ne 0 ] && grep -q 'outside-origin-guard: request(s) to another origin: https://planted.example.invalid/' "$tmp/plant.log"; then
    echo "e2e-stack: PLANT OK: the run failed on the planted outside request (exit $suite)"
    exit 0
  fi
  echo "e2e-stack: PLANT FAIL: the planted outside request did not fail the run on the guard (exit $suite)" >&2
  exit 1
fi
BW_E2E_BASE_URL="$base" BW_E2E_SEED="$seed" pnpm exec vitest run --config ci/e2e-stack/vitest.config.ts || suite=$?

# 6. The block still held after the run (a restarted proxy would have its route back).
prove_blocked "after the suite" || suite=1

# 7. P7-SCANS, the privacy scan (SPECIFICATIONS 11.4, G-CI6), only when BW_E2E_PRIVACY_SCAN=1 (ci/gates/G-CI6.sh sets it). It reads, after the full
# run and before the teardown: the log of every container of this project (every service, and the migrate and setup runs whose containers are
# gone: setup.log), every customer's phone and address from the database, and every issued link (link tokens, inbox and booking tokens,
# alert link targets, links in text bodies). The collected files hold customer values, so they live in $tmp, which the teardown removes.
if [ "${BW_E2E_PRIVACY_SCAN:-}" = 1 ]; then
  pdir="$tmp/privacy"
  mkdir -p "$pdir/logs"
  while read -r cid svc; do
    [ -n "$cid" ] && docker logs "$cid" >"$pdir/logs/$svc.log" 2>&1
  done < <(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}} {{.Label "com.docker.compose.service"}}')
  cp "$tmp/setup.log" "$pdir/logs/setup.log"
  psql_tsv() { compose exec -T db psql -U brightwater -d brightwater -X -At -F $'\t' -c "$1"; }
  psql_tsv "select coalesce(c.mobile,''), coalesce(c.home_phone,''), s.name, c.house_number from world.customer c join world.street s on s.id = c.street_id" >"$pdir/customers.tsv"
  psql_tsv "select 'token', token from world.link_token union all select 'token', inbox_token from world.customer union all select 'token', booking_token from world.job where booking_token is not null union all select 'target', link_target from world.alert union all select 'text', replace(body, E'\n', ' ') from world.outbox_text" >"$pdir/links.tsv"
  priv=0
  node ci/privacy-scan/scan.ts scan --dir "$pdir" || priv=$?
  [ "$priv" -eq 0 ] || suite=1
fi
echo "e2e-stack: done, exit $suite"
exit "$suite"
