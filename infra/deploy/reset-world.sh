#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P8-B9-SAMPLE-DATA (F-1801): reset the hosted world. Owner answer 5d88f9a6 (Nov 16, 2026, "Reset it at release"): the release
# recreates the hosted database and runs setup fresh. Same world, accounts and sign-ins come back. Visitor changes go, as at every
# nightly reset. Alert and health history starts over. Offline while setup runs.
# Why a reset and not a second setup: setup writes only a fresh world (packages/setup/src/pipeline.ts assertFresh, world_not_fresh),
# and the nightly reset refills the world from world_snapshot, so a world already set up never takes corrected sample rows any
# other way. Run by hand from this Mac, like infra/deploy/deploy.sh; P8-B9-RELEASE step (2) runs it after the release deploy.
#
#   bash infra/deploy/reset-world.sh             the hosted server (BW_HOST, from the environment or the owner's private file)
#   bash infra/deploy/reset-world.sh --local [--project <name>] [--env-file <file>]
#                                                 the same steps on a local stack started from infra/compose.yaml: Compose project
#                                                 <name> (default brightwater, the file's own name), settings from <file> (default
#                                                 infra/.env, the file Compose reads beside infra/compose.yaml)
# Env: BW_HOST, BW_KEY (default ~/.ssh/brightwater-lightsail.pem), as deploy.sh. BW_DEPLOY_LOG_DIR (default .build/deploy).
#
# Steps, each printed:
#   0. checks, before anything changes: the settings file holds a SAMPLE_PASSWORD_SEED line (16+ characters; never printed), and
#      the project has at most 1 database volume (its pgdata). A re-run after a failed step starts again here.
#   1. stops web, worker and pbs (the proxy stays up and answers for them; routing is not touched);
#   2. removes the db service and its database volume, then starts db again on a new, empty volume, as
#      infra/deploy/staging.sh world --again does;
#   3. runs the migrate one-shot (the schema; each process login's password from its own file, which stays);
#   4. runs setup with the sample password seed of the server's own .env (Compose reads it there; this script never reads, sends or
#      prints the value), so the same accounts and sign-ins come back; only setup's status lines are printed;
#   5. starts web, worker and pbs and waits for them to be healthy; on the hosted server, /healthz must answer 200;
#   6. names the next step, infra/backup/hosted-check.sh.
# It changes no setting in the .env (ROUTES stays as it is). The photos volume stays: photo files no row names go at the worker's
# hourly cleanup (apps/worker/src/clock/cleanup.ts).
# Log: <log dir>/<UTC stamp>-reset.log (--local: -reset-local.log; gitignored). Exit 0 only when every step succeeded.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

is_local=0 project="" env_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --local) is_local=1; shift ;;
    --project) project="${2:?--project <name>}"; shift 2 ;;
    --env-file) env_file="${2:?--env-file <file>}"; shift 2 ;;
    *) echo "usage: bash infra/deploy/reset-world.sh [--local [--project <name>] [--env-file <file>]]" >&2; exit 2 ;;
  esac
done
if [ "$is_local" = 0 ] && { [ -n "$project" ] || [ -n "$env_file" ]; }; then echo "--project and --env-file go with --local" >&2; exit 2; fi

DEST=/opt/brightwater
DOMAIN=bw.j7l.io
if [ "$is_local" = 1 ]; then
  project="${project:-brightwater}"
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "--project takes a Compose project name (lowercase letters, digits, - and _)" >&2; exit 2; }
  env_file="${env_file:-$root/infra/.env}"
  case "$env_file" in /*) ;; *) env_file="$root/$env_file" ;; esac
  [ -f "$env_file" ] || { echo "no settings file $env_file (it holds the stack's SAMPLE_PASSWORD_SEED)" >&2; exit 2; }
  # The settings file is the only source of the seed, as the server's .env is there: a value in this shell would win over the file.
  unset SAMPLE_PASSWORD_SEED REVIEWER_PASSWORD
  mode=reset-local
else
  . "$root/infra/drill/owner-env.sh"; bw_need_host "$root" || exit 2
  HOST="$BW_HOST"
  KEY="${BW_KEY:-$HOME/.ssh/brightwater-lightsail.pem}"
  project=brightwater # compose.yaml's own name; the server runs it from $DEST with $DEST/.env
  mode=reset
fi

log_dir="${BW_DEPLOY_LOG_DIR:-$root/.build/deploy}"
mkdir -p "$log_dir"
log_file="$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-$mode.log"
exec > >(tee "$log_file") 2>&1
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*"; }
ssh_() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }
# dc: docker compose for the stack; dk: plain docker on the same machine. On the server both run as root from $DEST.
if [ "$is_local" = 1 ]; then
  dc() { docker compose -p "$project" -f "$root/infra/compose.yaml" --env-file "$env_file" "$@"; }
  dk() { docker "$@"; }
  seed_lines() { grep -c -E '^SAMPLE_PASSWORD_SEED=.{16,}' "$env_file" || true; }
else
  dc() { ssh_ "cd $DEST && sudo docker compose $(printf '%q ' "$@")"; }
  dk() { ssh_ "sudo docker $(printf '%q ' "$@")"; }
  seed_lines() { ssh_ "sudo grep -c -E '^SAMPLE_PASSWORD_SEED=.{16,}' $DEST/.env" || true; }
fi
step=0
on_exit() {
  local rc=$?
  [ "$rc" = 0 ] && return 0
  if [ "$step" = 0 ]; then log "FAILED at the checks (exit $rc): nothing was changed"
  else log "FAILED at step $step (exit $rc): the world may be down; fix the cause and run this script again (it starts again at the checks)"; fi
}
trap on_exit EXIT

if [ "$is_local" = 1 ]; then log "== reset-world.sh --local on the local Compose project $project (log $log_file)"
else log "== reset-world.sh on the hosted server $DOMAIN (log $log_file)"; fi

log "== step 0: checks (nothing changes yet)"
n="$(seed_lines)"
if [ "$n" != 1 ]; then log "STOP: the settings file needs exactly 1 SAMPLE_PASSWORD_SEED line of 16+ characters (found $n); setup could not bring the same sign-ins back"; exit 2; fi
log "the settings file holds 1 SAMPLE_PASSWORD_SEED line (value not read)"
vols="$(dk volume ls -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.volume=pgdata)"
nvol=0; [ -z "$vols" ] || nvol="$(printf '%s\n' "$vols" | wc -l | tr -d ' ')"
if [ "$nvol" -gt 1 ]; then log "STOP: $nvol database volumes are labeled for project $project; expected at most 1"; exit 2; fi
jobs="$(dc exec -T db psql -U brightwater -d brightwater -tAc 'SELECT count(*) FROM world.job' 2>/dev/null || echo 'no answer')"
log "database volume: ${vols:-none}; jobs in the world now: $jobs"
# F-1818: a world that answers on a volume the labels do not name would be reused by name at step 2 and stop setup at step 4, with the web stopped.
if [ "$nvol" = 0 ] && [ "$jobs" != "no answer" ]; then log "STOP: the database answered ($jobs jobs) but no database volume is labeled for project $project; the script cannot name the volume to replace, so nothing was changed"; exit 2; fi
dc ps -a --format '  {{.Service}} {{.Image}} {{.Status}}'
# F-1817: the new world must start above the old one (open pages and phones holding unsent items read a lower epoch as stale, so no reset
# notice would show and the items would be flagged); step 4b raises the epochs to this number. No answer (no world yet) leaves setup's epoch 1.
old_epoch="$(dc exec -T db psql -U brightwater -d brightwater -tAc 'SELECT greatest(world_epoch, pbs_epoch) FROM system.demo_clock WHERE id = 1' 2>/dev/null || true)"
old_epoch="$(printf '%s' "$old_epoch" | tr -d '[:space:]')"
old_epoch_live="$old_epoch"
# F-1824: step 2 replaces the old database, so a re-run after a failed step 3, 4 or 5 would read the NEW world's epoch (1, or the raised one) here.
# The old epoch is kept in a file beside the log, written before step 1 and removed only when the reset ends OK; a re-run takes it from there.
epoch_file="$log_dir/reset-old-epoch-$mode-$project"
if [ -s "$epoch_file" ] && [[ "$(tr -d '[:space:]' <"$epoch_file")" =~ ^[0-9]+$ ]]; then
  # F-1828: the saved number can be stale (the world came back another way and later resets raised it), so it never goes below the live one.
  saved_epoch="$(tr -d '[:space:]' <"$epoch_file")"
  if [[ "$old_epoch" =~ ^[0-9]+$ ]] && [ "$old_epoch" -gt "$saved_epoch" ]; then
    log "a re-run: the live world's epoch $old_epoch is above the saved $saved_epoch in $epoch_file; the live epoch is used"
    printf '%s\n' "$old_epoch" >"$epoch_file"
  else
    old_epoch="$saved_epoch"; log "a re-run: the old world's epoch $old_epoch is taken from $epoch_file (the live epoch is ${old_epoch_live:-none}, not above it)"
  fi
elif [[ "$old_epoch" =~ ^[0-9]+$ ]]; then printf '%s\n' "$old_epoch" >"$epoch_file"; fi
new_epoch=1
if [[ "$old_epoch" =~ ^[0-9]+$ ]]; then new_epoch=$((old_epoch + 1)); fi
log "world epoch now: ${old_epoch:-none}; the new world starts at epoch $new_epoch"

step=1; log "== step 1: stop web, worker and pbs"
dc stop web worker pbs

step=2; log "== step 2: remove the db service and its database volume, start db on a new volume"
dc rm -sf db
if [ -n "$vols" ]; then dk volume rm "$vols"; log "removed volume $vols"; else log "no database volume to remove"; fi
dc up -d --no-build --wait --wait-timeout 180 db

out="$(mktemp)"
step=3; log "== step 3: migrate"
mrc=0; dc run --rm --no-deps -T migrate >"$out" 2>&1 || mrc=$?
grep -o -E '"status":"[^"]*"' "$out" | sed 's/^/  /' || true
if [ "$mrc" != 0 ]; then log "STOP: migrate failed (exit $mrc); its last 15 lines:"; tail -n 15 "$out" | cut -c1-300 | sed 's/^/  /'; rm -f "$out"; exit 1; fi

step=4; log "== step 4: setup (the seed of the settings file; only status lines are printed)"
src=0; dc --profile setup run --rm --no-deps -T setup >"$out" 2>&1 || src=$?
grep -E '"status":"setup (done|refused)"' "$out" | cut -c1-200 | sed 's/^/  /' || true
done_line="$(grep -c '"status":"setup done"' "$out" || true)"
if [ "$src" != 0 ] || [ "$done_line" != 1 ]; then
  log "STOP: setup failed (exit $src); its last 15 lines:"; tail -n 15 "$out" | cut -c1-300 | sed 's/^/  /'; rm -f "$out"; exit 1
fi
rm -f "$out"
log "setup done"

# F-1817, step 4b: setup starts at epoch 1 (snapshot.ts); raise world_epoch, pbs_epoch (kept 1 below, unconfirmed as after every reset)
# and setup's reset row together, in 1 statement batch, before any service starts. Nothing to do when the old world was at epoch 0 or none.
if [ "$new_epoch" -gt 1 ]; then
  dc exec -T db psql -U brightwater -d brightwater -v ON_ERROR_STOP=1 -tA -c "UPDATE system.demo_clock SET world_epoch = $new_epoch, pbs_epoch = $((new_epoch - 1)) WHERE id = 1; UPDATE system.clock_move SET world_epoch = $new_epoch WHERE world_epoch = 1 AND kind = 'reset';" >/dev/null
  log "world epoch raised to $new_epoch (pbs_epoch $((new_epoch - 1)), unconfirmed until the worker's confirmer runs)"
fi

step=5; log "== step 5: start web, worker and pbs"
dc up -d --no-build --wait --wait-timeout 180 web worker pbs
dc ps --format '  {{.Service}} {{.Image}} {{.Status}}'
jobs="$(dc exec -T db psql -U brightwater -d brightwater -tAc 'SELECT count(*) FROM world.job')"
log "jobs in the new world: $jobs"
if [ "$is_local" = 0 ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/healthz" || true)"
  log "https://$DOMAIN/healthz answers $code"
  [ "$code" = 200 ] || { log "STOP: /healthz did not answer 200"; exit 1; }
fi

rm -f "$epoch_file"
step=6
log "== done: the world is reset. Next step: bash infra/backup/hosted-check.sh"
