#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# smoke-public-tag (FR-DIST-8, UC-11; SPECIFICATIONS section 14 "Clean, for smoke-public-tag" items 1 to 6).
#   ci/smoke/smoke-public-tag.sh --data <dir> (--export <dir> | --tag <tag> --repo <url>) [--out <dir>] [--plant-image <ref>] [--plant-container-call | --plant-page-call]
# On the `linux` runner (item 1), against the docker engine the caller's DOCKER_HOST/DOCKER_CONTEXT names:
#   1  a throwaway Docker-in-Docker engine with no named volume (item 3), its self-check first (item 6, ci/engine-self-check.sh);
#   2  the source into an empty folder inside the engine (item 2): --export is a local export of scripts/publish.sh --dry-run (a
#      manual run); --tag clones only that tag of the public repo over the network. Nothing else of the private checkout goes in;
#   3  only the settings the README documents (item 4): the copy's own .env.example; with --export only, when the export has none,
#      ci/smoke/settings.env. With --tag the copy must have its own (F-1459): a tag without .env.example fails the job (exit 1) before
#      any engine starts. The leak check proves no secret of the job's environment is inside (ci/smoke/leak-check.sh);
#   4  install, with network: the images are built and pulled inside the engine;
#   5  outside hosts blocked by a network policy (item 5), proved by a probe that must fail; then the stack starts, setup writes the
#      world, and Playwright signs in as Maria Santos and finds her 10:00 AM to 12:00 PM Harold Jenkins job (ci/smoke/smoke.mjs).
#      A copy that calls an outside host at run time fails the job (FR-DIST-8, F-1450): the policy's DROP counters are zeroed after the
#      probe and read after the sign-in, any dropped packet fails; and smoke.mjs fails on any outside origin the page asks for.
# --data is the verified release data (street-list.json, maps/). The job stages them as data, in both modes (no token goes in): the
# copy's download from its public release (attached by scripts/publish.sh release) is not part of this job. Routing files are left out: the
# routing service waits for them and the legs are approximate, as for a copy that ran `setup:maps --no-routing`.
# The engine and the harness are removed at the end, pass or fail (a trap; the workflow's last step does it again).
# --plant-image <ref>: pulls that image into the engine first; the self-check must then fail the job before any install (item 6's proof).
# --plant-container-call: after the stack is up, a container of the copy (web) calls an outside host; the job must fail on the DROP counters.
# --plant-page-call: the page of the sign-in asks for an outside origin; the job must fail in smoke.mjs (FR-DIST-8's proof, F-1450).
#   exit 0 pass; 1 a check failed; 2 usage; 3 no usable docker.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
data=""
export_dir=""
tag=""
repo_url=""
out=""
plant=""
plant_container=0
plant_page=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data) data="${2:?}"; shift 2 ;;
    --export) export_dir="${2:?}"; shift 2 ;;
    --tag) tag="${2:?}"; shift 2 ;;
    --repo) repo_url="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --plant-image) plant="${2:?}"; shift 2 ;;
    --plant-container-call) plant_container=1; shift ;;
    --plant-page-call) plant_page=1; shift ;;
    *) echo "smoke: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$data" ] && [ -d "$data" ] || { echo "smoke: --data <dir> is required and must exist" >&2; exit 2; }
if [ -n "$export_dir" ] && [ -z "$tag" ]; then
  [ -d "$export_dir" ] || { echo "smoke: --export $export_dir is not a directory" >&2; exit 2; }
elif [ -n "$tag" ] && [ -n "$repo_url" ] && [ -z "$export_dir" ]; then
  :
else
  echo "smoke: give --export <dir>, or --tag <tag> with --repo <url>" >&2
  exit 2
fi

ENGINE="${ENGINE:-bw-p7-smoke-$$}"
# The only containers this script removes carry these names (never anything else on a shared engine).
[[ "$ENGINE" =~ ^(bw-p7-smoke|smoke-engine)-[a-z0-9][a-z0-9-]*$ ]] || { echo "smoke: engine name '$ENGINE' is refused" >&2; exit 2; }
HARNESS="$ENGINE-pw"
DIND_IMAGE="${DIND_IMAGE:-docker:29.9.1-dind@sha256:3e5756e2b6dad6a5f1f5deacf0a19f9eaa2581b76ae092b2d4a118162e1d4d4e}"
PW_IMAGE="${PW_IMAGE:-mcr.microsoft.com/playwright@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f}"
PW_VERSION="1.64.1"

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "smoke: FAIL no usable docker here" >&2; exit 3; }
out="${out:-$(mktemp -d "${TMPDIR:-/tmp}/bw-smoke.XXXXXX")}"
mkdir -p "$out"
work="$(mktemp -d "${TMPDIR:-/tmp}/bw-smoke-src.XXXXXX")"
export COPYFILE_DISABLE=1 # macOS tar: no ._ files in the streams below

step() { echo "smoke: step $1: $2"; }
eng() { docker exec "$ENGINE" "$@"; }
engc() { eng docker compose -p smoke -f /work/copy/infra/compose.yaml --env-file /work/settings.env "$@"; }

cleanup() {
  local rc=$?
  set +e
  docker rm -fv "$HARNESS" >/dev/null 2>&1
  docker rm -fv "$ENGINE" >/dev/null 2>&1
  rm -rf "$work"
  # F-1458: a failed docker ps is not an empty answer; say it could not confirm, and fail.
  local left
  if left="$(docker ps -aq --filter "name=^/($ENGINE|$HARNESS)\$" 2>/dev/null)"; then
    if [ -z "$left" ]; then
      echo "smoke: engine $ENGINE removed"
    else
      echo "smoke: FAIL engine $ENGINE could not be removed" >&2
      [ "$rc" -ne 0 ] || rc=1
    fi
  else
    echo "smoke: FAIL could not confirm engine $ENGINE was removed (docker ps failed)" >&2
    [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The source, on this host first (with --tag, only that tag of the public repo, over the network); step 2 copies it into the engine.
if [ -n "$tag" ]; then
  git clone --quiet --depth 1 --branch "$tag" "$repo_url" "$work/src"
  rm -rf "$work/src/.git"
  # F-1459: the copy's settings are its own; nothing of the job's private checkout stands in for them (Clean items 2 and 4).
  [ -f "$work/src/.env.example" ] || { echo "smoke: FAIL tag $tag of $repo_url has no .env.example (the settings the README documents)" >&2; exit 1; }
else
  mkdir "$work/src"
  tar --no-xattrs -C "$export_dir" -cf - . | tar -C "$work/src" -xf -
fi

# 1. The throwaway engine: --privileged for dockerd, no -v, so no named volume; the image's anonymous volume goes with `rm -v`.
# F-13: the engine listens on its unix socket only (the image's default adds an unauthenticated tcp 2375 that a container of the copy
# could drive); every step below reaches it through `docker exec`.
step 1 "engine $ENGINE (no named volume, unix socket only)"
docker run -d --privileged --name "$ENGINE" -e DOCKER_TLS_CERTDIR= "$DIND_IMAGE" dockerd --host=unix:///var/run/docker.sock >/dev/null
if [ -n "$plant" ]; then
  # The self-check's proof: the engine must not start clean, so the job must stop here.
  up=0
  for ((i = 0; i < 180; i++)); do
    if eng docker info >/dev/null 2>&1; then up=1; break; fi
    sleep 0.5
  done
  [ "$up" -eq 1 ] || { echo "smoke: FAIL the engine did not answer" >&2; exit 1; }
  eng docker pull "$plant" >/dev/null
  echo "smoke: planted a pre-pulled image ($plant)"
fi
ENGINE_WAIT_S="${ENGINE_WAIT_S:-90}" bash "$here/../engine-self-check.sh" "$ENGINE"
if eng wget -q -T 3 -O /dev/null http://127.0.0.1:2375/_ping >/dev/null 2>&1; then
  echo "smoke: FAIL the engine answers on tcp 2375 (it must listen on its unix socket only)" >&2
  exit 1
fi

# 2. The source, into an empty folder in the engine.
step 2 "source into /work/copy"
eng mkdir -p /work/copy
tar --no-xattrs -C "$work/src" -cf - . | docker cp - "$ENGINE:/work/copy"
# The staged release data, where the README's default puts it (.build/data, .build/data/maps), without the routing files.
mkdir -p "$work/data/maps"
cp "$data/street-list.json" "$work/data/"
for f in "$data"/maps/*; do
  case "$(basename "$f")" in ohio.osrm*) continue ;; esac
  [ -f "$f" ] && cp "$f" "$work/data/maps/"
done
eng mkdir -p /work/copy/.build/data
tar --no-xattrs -C "$work/data" -cf - . | docker cp - "$ENGINE:/work/copy/.build/data"
eng test -f /work/copy/.build/data/street-list.json

# 3. The documented settings only.
step 3 "settings and the leak check"
if [ -f "$work/src/.env.example" ]; then
  cp "$work/src/.env.example" "$work/settings.env"
elif [ -z "$tag" ]; then
  cp "$here/settings.env" "$work/settings.env"
else
  echo "smoke: FAIL the copy has no .env.example" >&2
  exit 1
fi
docker cp "$work/settings.env" "$ENGINE:/work/settings.env"
seed="$(grep -E '^SAMPLE_PASSWORD_SEED=' "$work/settings.env" | head -1 | cut -d= -f2-)"
[ "${#seed}" -ge 16 ] || { echo "smoke: FAIL the settings file holds no SAMPLE_PASSWORD_SEED of 16+ characters" >&2; exit 1; }
# F-1453: the leak check fails on 0 variables checked; a run outside the workflow (which sets this per run) makes its own made-up value.
export BW_SMOKE_PLANT_SECRET="${BW_SMOKE_PLANT_SECRET:-bw-smoke-plant-$(date +%s)-$RANDOM$RANDOM}"
bash "$here/leak-check.sh" "$ENGINE"

# 4. Install, with network: everything the copy runs is built or pulled here.
step 4 "install (build and pull inside the engine)"
t0=$(date +%s)
{ engc build web && engc pull --ignore-buildable; } >"$out/install.log" 2>&1 || { echo "smoke: FAIL install" >&2; tail -20 "$out/install.log" >&2; exit 1; }
echo "smoke: installed in $(( $(date +%s) - t0 )) s"
# The harness: its own container that shares the engine's network (the copy is at 127.0.0.1:8080), with the browser.
docker create --name "$HARNESS" --network "container:$ENGINE" --entrypoint sleep "$PW_IMAGE" infinity >/dev/null
docker start "$HARNESS" >/dev/null
docker exec "$HARNESS" sh -c "mkdir -p /h && cd /h && npm init -y >/dev/null && npm pkg set type=module >/dev/null && npm i --no-audit --no-fund --silent playwright@$PW_VERSION" >>"$out/install.log" 2>&1 \
  || { echo "smoke: FAIL harness install" >&2; tail -10 "$out/install.log" >&2; exit 1; }
docker cp "$here/smoke.mjs" "$HARNESS:/h/smoke.mjs"
# smoke.mjs opens its context through the outside-origin guard every Playwright file uses (F-40), copied from this checkout beside it.
docker cp "$here/../page-walkers/origin-guard.ts" "$HARNESS:/h/origin-guard.ts"
eng tar -C /work/copy/packages/db/src -cf - passwords.ts | docker cp - "$HARNESS:/h"

# 5. Outside hosts blocked: no new connection leaves the engine's networks (replies to the harness stay).
step 5 "network policy"
# F-1470: the same 2 rules for IPv6 (ip6tables has its own DOCKER-USER chain), so a v6 call is blocked and counted as a v4 one is.
for br in 'br+' 'docker0'; do
  eng iptables -I DOCKER-USER -i "$br" ! -o "$br" -m conntrack --ctstate NEW -j DROP
  eng ip6tables -I DOCKER-USER -i "$br" ! -o "$br" -m conntrack --ctstate NEW -j DROP
done
probe_rc=0
eng docker run --rm --entrypoint node bw-app:local -e \
  "fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(1),()=>process.exit(0))" >/dev/null 2>&1 || probe_rc=$?
[ "$probe_rc" -eq 0 ] || { echo "smoke: FAIL the network policy let a container reach an outside host" >&2; exit 1; }
echo "smoke: the policy blocks an outside host (probe)"
# F-1450: the probe's own dropped packets do not count; from here every dropped packet is a call a container of the copy made.
eng iptables -Z DOCKER-USER
eng ip6tables -Z DOCKER-USER
drops() {
  eng sh -c "(iptables -nvxL DOCKER-USER; ip6tables -nvxL DOCKER-USER) | awk '\$3==\"DROP\" {n++; s+=\$1} END {print n+0, s+0}'"
}
read -r drop_rules drop_pkts < <(drops) || true
[ "${drop_rules:-0}" -eq 4 ] && [ "${drop_pkts:-1}" -eq 0 ] || { echo "smoke: FAIL the policy is not 4 DROP rules (2 IPv4, 2 IPv6) with zeroed counters (rules=${drop_rules:-?}, packets=${drop_pkts:-?})" >&2; exit 1; }

step 6 "start, setup, sign in"
engc up -d --no-build --wait --wait-timeout 240 proxy web worker pbs db routing >"$out/start.log" 2>&1 || { echo "smoke: FAIL start" >&2; tail -20 "$out/start.log" >&2; engc logs --tail 20 >&2 || true; exit 1; }
engc --profile setup run --rm --no-deps setup >"$out/setup.log" 2>&1 || { echo "smoke: FAIL setup" >&2; tail -15 "$out/setup.log" >&2; exit 1; }
grep -E '"status":"setup done"' "$out/setup.log" | cut -c1-160 || true
smoke_rc=0
docker exec -e "SMOKE_SEED=$seed" -e "SMOKE_PLANT_PAGE_CALL=$plant_page" "$HARNESS" node /h/smoke.mjs >"$out/smoke.log" 2>&1 || smoke_rc=$?
cat "$out/smoke.log"
[ "$smoke_rc" -eq 0 ] || { echo "smoke: FAIL the sign-in check" >&2; exit 1; }
if [ "$plant_container" -eq 1 ]; then
  # The proof of the counters: a container of the copy calls an outside host; its packets are dropped and counted, so the job must fail below.
  engc exec -T web node -e "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).catch(()=>{})" >/dev/null 2>&1 || true
  echo "smoke: planted a call to an outside host from the web container"
fi
read -r drop_rules drop_pkts < <(drops) || true
if [ "${drop_rules:-0}" -ne 4 ] || [ "${drop_pkts:-1}" -ne 0 ]; then
  echo "smoke: FAIL the copy called an outside host at run time (the policy dropped ${drop_pkts:-?} packet(s); rules=${drop_rules:-?})" >&2
  eng iptables -nvxL DOCKER-USER >&2 || true
  eng ip6tables -nvxL DOCKER-USER >&2 || true
  exit 1
fi
echo "smoke: no outside host was called at run time (0 dropped packets)"
bash "$here/leak-check.sh" "$ENGINE"
echo "smoke: PASS (UC-11: Maria Santos's 10:00 AM to 12:00 PM Harold Jenkins job found on a clean engine, outside hosts blocked)"
