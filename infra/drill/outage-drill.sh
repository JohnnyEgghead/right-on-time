#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P8-OUTAGE-DRILL (NFR-11, SD-37): stop the hosted app for 12 minutes so the outside monitor (UptimeRobot) records an outage, start it
# again, and write the measured record. Run by hand from this Mac, unattended, after the owner grants it:
#
#   bash infra/drill/outage-drill.sh run            the drill (about 18 to 35 minutes: 12 minute stop, then wait for the monitor)
#   bash infra/drill/outage-drill.sh run --dry-run  prints every remote command and the whole plan; no ssh, no curl, no file written
#   bash infra/drill/outage-drill.sh restore        starts the app again by hand (idempotent), for a run that was killed hard
#   bash infra/drill/outage-drill.sh reread         reads the monitor's API again and rewrites the record (a slow monitor)
#
# What it touches on the hosted server: the web container of Compose project brightwater in /opt/brightwater, and nothing else.
#   stop:  cd /opt/brightwater && sudo docker compose stop web
#   start: cd /opt/brightwater && sudo docker compose start web   (then, only if /healthz is not 200 in time: up -d --no-deps web)
# F-45 (owner answer 2d9da4be, "Add it with the drill"): once the stop is confirmed, and before the wait, it runs the existing deploy path
#   bash infra/deploy/deploy.sh --host-files   (from the checked-out commit; any branch, clean tree)
# which copies setup.sh, certbot-renew.sh, renewal-status.sh and the whole systemd/ folder to /opt/brightwater (overwriting them, and removing
# files in the server's systemd/ folder that the stage lacks), installs only the 2 certbot units into /etc/systemd/system, reloads systemd, enables the renewal timer and
# seeds the renewal status file; it never builds an image, runs compose up or touches web. After the restart it reads the status file over http, creates (find-by-name first) the 2nd UptimeRobot monitor (keyword
# type, alerts when RENEWAL_OK is missing, same alert contacts as the first monitor) and reads that monitor's first check.
# The database, the volumes, .env, nginx, the certificate and the other containers are never written. Compose files are not re-read for
# any other service. Before the stop it reads (no write) that /healthz answers 200, that web is running, and that the monitor is up.
#
# It starts the app again on EVERY exit (trap on EXIT, INT, TERM, HUP): the stop is marked as done before the stop command is sent, so
# even a stop whose ssh dropped is followed by a start. Only SIGKILL or the Mac losing power skips the trap; then run the restore step.
# The key for UptimeRobot's API is read from the owner's key file (BW_UPTIMEROBOT_KEY, default ~/.uptimerobot/api_key) and is handed
# to curl on stdin (or read by uptimerobot.ts f45): it is never printed, logged, put on a command line, or saved. UptimeRobot is read
# (POST getMonitors is a read) except for the 1 newMonitor of the F-45 step.
#
# Env (defaults are the ones deploy.sh and P1-MONITOR use): BW_HOST, BW_KEY (as deploy.sh), BW_UPTIMEROBOT_KEY, BW_DRILL_URL,
# BW_DRILL_MONITOR, BW_DRILL_STOP_SECS (720), BW_DRILL_API_WAIT (1200 s bound for the monitor to list the outage), BW_DRILL_API_POLL (30),
# BW_DRILL_HEALTHZ_WAIT (180), BW_DRILL_DEPLOY_CMD (the F-45 deploy step), BW_DRILL_STATUS_URL, BW_DRILL_F45_WAIT (600), BW_DRILL_EVIDENCE, BW_DRILL_RECORD (the last 2 are the outputs; tests point them elsewhere).
# F-1605: BW_DRILL_MONITOR, BW_DRILL_EVIDENCE and BW_DRILL_RECORD are the owner's: read from the environment, else from the owner file
# (infra/drill/owner-env.sh: BW_OWNER_ENV, default the private infra/owner.env). No monitor id is written here: run, its dry run and
# reread refuse (exit 2) without one. Without the owner file the outputs go to drill-out/ (git-ignored); relative paths are under the repo.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=owner-env.sh
. "$here/owner-env.sh"
bw_owner_env "$root"

# Keep the Mac awake for the whole drill (a sleeping Mac would stretch the 12 minutes and could skip the restart).
if [ -z "${BW_DRILL_CAFF:-}" ] && command -v caffeinate >/dev/null 2>&1; then exec env BW_DRILL_CAFF=1 caffeinate -i bash "$0" "$@"; fi

# F-1609: the host is BW_HOST, from the environment or the owner's private file (bw_owner_env above); no committed file holds it. Never printed.
HOST="${BW_HOST:-}"
KEY="${BW_KEY:-$HOME/.ssh/brightwater-lightsail.pem}"
APIKEY_FILE="${BW_UPTIMEROBOT_KEY:-$HOME/.uptimerobot/api_key}"
URL="${BW_DRILL_URL:-https://bw.j7l.io/healthz}"
MONITOR="${BW_DRILL_MONITOR:-}"
STOP_SECS="${BW_DRILL_STOP_SECS:-720}"
API_WAIT="${BW_DRILL_API_WAIT:-1200}"
API_POLL="${BW_DRILL_API_POLL:-30}"
HEALTHZ_WAIT="${BW_DRILL_HEALTHZ_WAIT:-180}"
INTERVAL=300
EV="$(bw_root_path "$root" "${BW_DRILL_EVIDENCE:-drill-out/outage-drill}")"
RECORD="$(bw_root_path "$root" "${BW_DRILL_RECORD:-drill-out/outage-drill.md}")"
# The record names its evidence folder repo-relative when it is inside the checkout (no home path in the record).
case "$EV" in "$root"/*) EV_LABEL="${EV#"$root"/}" ;; *) EV_LABEL="$EV" ;; esac
API=https://api.uptimerobot.com/v2/getMonitors
# F-1686: an array, so a checkout path with a space stays 1 word; BW_DRILL_DEPLOY_CMD (a test hook) is split on spaces as before.
DEPLOY_CMD=(bash "$root/infra/deploy/deploy.sh" --host-files)
[ -z "${BW_DRILL_DEPLOY_CMD:-}" ] || read -r -a DEPLOY_CMD <<<"$BW_DRILL_DEPLOY_CMD"
STATUS_URL="${BW_DRILL_STATUS_URL:-http://bw.j7l.io/.well-known/acme-challenge/renewal-status.txt}"

R_STOP='cd /opt/brightwater && sudo docker compose stop web >/dev/null 2>&1; rc=$?; echo "$rc $(date +%s)"'
R_START='cd /opt/brightwater && sudo docker compose start web >/dev/null 2>&1; rc=$?; echo "$rc $(date +%s)"'
R_UP='cd /opt/brightwater && sudo docker compose up -d --no-deps web >/dev/null 2>&1; rc=$?; echo "$rc $(date +%s)"'
R_PS='cd /opt/brightwater && sudo docker compose ps --status running --services'

mode="${1:-}"
dry=0
[ "${2:-}" = "--dry-run" ] && dry=1
case "$mode" in run | restore | reread) ;; *)
  echo "usage: bash infra/drill/outage-drill.sh run [--dry-run] | restore | reread" >&2
  exit 2
  ;;
esac
if [ "$dry" = 1 ] && [ "$mode" != run ]; then echo "outage-drill: --dry-run belongs to run" >&2; exit 2; fi
if [ "$mode" != restore ] && ! [[ "$MONITOR" =~ ^[0-9]+$ ]]; then
  echo "outage-drill: no UptimeRobot monitor id: set BW_DRILL_MONITOR, or put it in the owner file (BW_OWNER_ENV, default infra/owner.env)" >&2
  exit 2
fi

say() { echo "[$(date '+%b %-d, %-I:%M:%S %p %Z')] $*"; }
log() { say "$*"; if [ "$dry" = 0 ] && [ -d "$EV" ]; then say "$*" >>"$EV/drill.log"; fi; }
ssh_() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }
healthz() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL" 2>/dev/null || true; }
# api_get <out file> <logs start epoch>: POST getMonitors (a read). The key goes to curl on stdin, never on a command line.
api_get() {
  local out="$1" from="$2" now
  now="$(date +%s)"
  printf 'data = "api_key=%s"\n' "$(tr -d '[:space:]' <"$APIKEY_FILE")" |
    curl -sS -m 30 -K - -X POST "$API" -d format=json -d "monitors=$MONITOR" -d logs=1 -d logs_limit=200 \
      -d "logs_start_date=$from" -d "logs_end_date=$((now + 3600))" >"$out" 2>/dev/null
}

stopped=0
restored=0
stop_server=0
stop_local=0
start_server=0
start_local=0
hz_ok_epoch=null
hz_ok_status=0
pre_hz=0
polls=0

write_facts() {
  printf '{"commit":"%s","preHealthz":%s,"stopServerEpoch":%s,"stopLocalEpoch":%s,"startServerEpoch":%s,"startLocalEpoch":%s,"healthzOkEpoch":%s,"healthzOkStatus":%s,"stopSecs":%s,"intervalSec":%s,"apiPolls":%s}\n' \
    "$(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)" "$pre_hz" "$stop_server" "$stop_local" "$start_server" "$start_local" \
    "$hz_ok_epoch" "$hz_ok_status" "$STOP_SECS" "$INTERVAL" "$polls" >"$EV/facts.json"
}

# wait_healthz: up to HEALTHZ_WAIT seconds for /healthz 200; sets hz_ok_epoch and hz_ok_status.
wait_healthz() {
  local deadline=$(($(date +%s) + HEALTHZ_WAIT)) code
  while :; do
    code="$(healthz)"
    hz_ok_status="${code:-0}"
    if [ "$code" = 200 ]; then hz_ok_epoch="$(date +%s)"; return 0; fi
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 3
  done
}

# start_app: the one restore path (main flow and trap). Sets restored=1 only when /healthz answers 200.
start_app() {
  local out rc epoch
  out="$(ssh_ "$R_START" 2>&1 | tail -n 1)"
  rc="${out%% *}"; epoch="${out##* }"
  [ "$start_local" = 0 ] && start_local="$(date +%s)"
  case "$epoch" in '' | *[!0-9]*) epoch=0 ;; esac
  [ "$start_server" = 0 ] && start_server="$epoch"
  log "start web: remote exit ${rc:-?}, server clock $epoch"
  if wait_healthz; then restored=1; log "/healthz 200 again"; return 0; fi
  log "/healthz is not 200 after start (last ${hz_ok_status}); trying up -d --no-deps web"
  ssh_ "$R_UP" 2>&1 | tail -n 1 | sed 's/^/  remote: /'
  if wait_healthz; then restored=1; log "/healthz 200 again (after up -d)"; return 0; fi
  log "DEMO MAY BE DOWN: /healthz is not 200. On the server run: cd /opt/brightwater && sudo docker compose up -d web"
  return 1
}

on_exit() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "$stopped" = 1 ] && [ "$restored" = 0 ]; then
    log "exit $rc with the app stopped: starting it again"
    start_app || rc=1
  fi
  exit "$rc"
}

finish_record() { # finish_record: build the record from facts.json and api-raw.json; prints the VERDICT line
  node "$here/uptimerobot.ts" finish --dir "$EV" --out "$RECORD" --evidence-label "$EV_LABEL"
}

if [ "$dry" = 1 ]; then
  echo "outage-drill DRY RUN: no ssh, no curl, no file is written. Every remote command below is printed, none is run."
  echo "  target host: \$BW_HOST (the environment or the owner's private file), key \$BW_KEY; web only, project brightwater in /opt/brightwater"
  echo "  1. preflight (reads): curl $URL expects 200; remote: $R_PS (expects web); GET getMonitors monitor $MONITOR (expects status 2)"
  echo "  2. WOULD RUN (remote, write): $R_STOP"
  echo "     (the stop is marked done before this is sent, so the exit trap starts the app even if ssh drops)"
  echo "  2b. F-45, once the stop is confirmed (exit 0): WOULD RUN (local command, remote writes): bash infra/deploy/deploy.sh --host-files"
  echo "     = scp the stage to /tmp/bw-deploy-stage; WOULD RUN (remote, write): sudo bash /tmp/bw-deploy-stage/server-deploy.sh /tmp/bw-deploy-stage --host-files"
  echo "       (installs brightwater-certbot-renew.service/.timer and certbot-renew.sh, renewal-status.sh under /opt/brightwater, systemctl daemon-reload,"
  echo "        enable the certbot timer, seeds renewal-status.txt in the acme volume only if absent; no image, no compose up, web untouched)"
  echo "     then WOULD RUN (remote, write): sudo rm -rf /tmp/bw-deploy-stage. A failed deploy is logged and the drill goes on."
  echo "  3. wait $STOP_SECS s from the moment the stop returns, with the app down"
  echo "  4. WOULD RUN (remote, write): $R_START"
  echo "     then poll curl $URL for 200 up to ${HEALTHZ_WAIT} s; only if not 200: WOULD RUN (remote, write): $R_UP"
  echo "  4b. F-45 after the restart: WOULD READ: curl $STATUS_URL (expects first line RENEWAL_OK);"
  echo "     WOULD READ: POST getMonitors search=<name> and monitors=$MONITOR alert_contacts=1 (the key on stdin of uptimerobot.ts f45, not curl)"
  echo "     WOULD WRITE (UptimeRobot account, only if no monitor of that name exists): POST newMonitor friendly_name='Brightwater certificate renewal' type=2 (keyword)"
  echo "       keyword_type=2 (not exists) keyword_value=RENEWAL_OK interval=300 alert_contacts=<the first monitor's contacts> url=$STATUS_URL"
  echo "     then WOULD READ: POST getMonitors for the new monitor every 30 s up to 600 s for its first check; result goes in $EV/f45.json"
  echo "  5. WOULD READ: POST $API (api_key from \$BW_UPTIMEROBOT_KEY file on curl stdin) monitors=$MONITOR logs=1 logs_limit=200,"
  echo "     every ${API_POLL} s for up to ${API_WAIT} s until the outage has its up log"
  echo "  6. WOULD WRITE: $RECORD (America/New_York times with zone label) and evidence in $EV (facts.json, api-raw.json, measured.json, f45.json, drill.log); the record gains an F-45 section"
  echo "  7. exit trap on EXIT/INT/TERM/HUP: if the app is stopped, WOULD RUN (remote, write): $R_START"
  echo "outage-drill DRY RUN done: 0 remote writes made."
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "outage-drill: node is needed" >&2; exit 2; }
[ -s "$APIKEY_FILE" ] || { echo "outage-drill: no UptimeRobot key file at the BW_UPTIMEROBOT_KEY path (default ~/.uptimerobot/api_key)" >&2; exit 2; }
[ -f "$KEY" ] || { echo "outage-drill: ssh key file $KEY not found" >&2; exit 2; }
[ -n "$HOST" ] || { echo "outage-drill: no host (BW_HOST: set it in the environment or in the owner's private file; F-1609)" >&2; exit 2; }

if [ "$mode" = restore ]; then
  mkdir -p "$EV"
  stopped=1
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  log "restore: starting web by hand"
  start_app
  exit $?
fi

if [ "$mode" = reread ]; then
  [ -f "$EV/facts.json" ] || { echo "outage-drill: no $EV/facts.json; run the drill first" >&2; exit 2; }
  t0="$(sed -n 's/.*"stopLocalEpoch":\([0-9]*\).*/\1/p' "$EV/facts.json")"
  api_get "$EV/api-raw.json" "$((t0 - 90 * 86400))" || { echo "outage-drill: API read failed" >&2; exit 1; }
  sed -i.bak -E 's/"apiPolls":[0-9]+/"apiPolls":'"$(($(sed -n 's/.*"apiPolls":\([0-9]*\).*/\1/p' "$EV/facts.json") + 1))"'/' "$EV/facts.json" && rm -f "$EV/facts.json.bak"
  finish_record
  exit $?
fi

# ---- run ----
[ ! -e "$RECORD" ] || { echo "outage-drill: $RECORD already exists; the drill runs once (use reread to refresh it)" >&2; exit 2; }
[ ! -e "$EV/facts.json" ] || { echo "outage-drill: $EV/facts.json already exists; the drill runs once" >&2; exit 2; }
mkdir -p "$EV"
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

log "== P8-OUTAGE-DRILL, commit $(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
log "preflight (reads only)"
pre_hz="$(healthz)"; pre_hz="${pre_hz:-0}"
[ "$pre_hz" = 200 ] || { log "REFUSED: /healthz answers $pre_hz before the stop, not 200"; exit 1; }
ps_out="$(ssh_ "$R_PS" 2>&1)" || { log "REFUSED: cannot read the server (ssh or docker compose ps failed)"; exit 1; }
grep -qx web <<<"$ps_out" || { log "REFUSED: web is not running on the server"; exit 1; }
api_get "$EV/api-pre.json" "$(($(date +%s) - 3600))" || { log "REFUSED: cannot read the UptimeRobot API"; exit 1; }
grep -q '"stat":"ok"' "$EV/api-pre.json" && grep -q '"status":2' "$EV/api-pre.json" || { log "REFUSED: the monitor is not up (status 2) or the API call failed"; exit 1; }
rm -f "$EV/api-pre.json"
log "preflight ok: /healthz 200, web running, monitor up"

stopped=1 # before the stop is sent: a stop whose ssh drops is still followed by a start
out="$(ssh_ "$R_STOP" 2>&1 | tail -n 1)"
stop_local="$(date +%s)"
rc="${out%% *}"; stop_server="${out##* }"
case "$stop_server" in '' | *[!0-9]*) stop_server=0 ;; esac
log "stop web: remote exit ${rc:-?}, server clock $stop_server"
if [ "${rc:-1}" != 0 ]; then log "ABORT: the stop did not report success; starting the app again"; exit 1; fi

# F-45: the server change goes in while web is down, through the existing deploy path. Its failure never blocks the restart.
log "F-45: running the deploy path inside the stop window: ${DEPLOY_CMD[*]}"
f45_deploy_rc=0
"${DEPLOY_CMD[@]}" >"$EV/f45-deploy.log" 2>&1 || f45_deploy_rc=$?
log "F-45: deploy exit $f45_deploy_rc (output in $EV/f45-deploy.log)"

log "app is down; waiting ${STOP_SECS} s from the stop"
while :; do
  left=$((stop_local + STOP_SECS - $(date +%s)))
  [ "$left" -le 0 ] && break
  sleep "$((left < 10 ? left : 10))"
done

start_app || { write_facts; finish_record; exit 1; }
# F-45 after the restart: status file, 2nd monitor, its first check. Writes $EV/f45.json; a FAIL there does not stop the outage record.
f45_line="$(node "$here/uptimerobot.ts" f45 --dir "$EV" --key-file "$APIKEY_FILE" --existing "$MONITOR" --status-url "$STATUS_URL" --deploy-rc "$f45_deploy_rc" 2>&1)" || true
log "$f45_line"
polls=0
api_start=$(($(date +%s)))
while :; do
  polls=$((polls + 1))
  if api_get "$EV/api-raw.json" "$((stop_local - 90 * 86400))"; then
    write_facts
    verdict_line="$(finish_record 2>&1)"
    log "API read $polls: $verdict_line"
    case "$verdict_line" in *'lists 0 outages'* | *'no up log'* | *'outage-drill:'*) ;; *) break ;; esac
  else
    log "API read $polls failed (network); retrying"
  fi
  [ "$(($(date +%s) - api_start))" -ge "$API_WAIT" ] && { log "bound of ${API_WAIT} s reached waiting for the monitor"; break; }
  sleep "$API_POLL"
done
[ -s "$EV/api-raw.json" ] || { log "no API answer saved; no record written"; exit 1; }
write_facts
final="$(finish_record 2>&1)"; frc=$?
log "record: $RECORD"
log "$final"
echo "web history half: still a human look (see the record's last section)."
exit "$frc"
