#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P7-LOAD hosted mode (owner answer f3d84787, Nov 12, 2026, "Run it on my hosted server"): 1 real-speed load day on the hosted server
# itself (Lightsail brightwater-1, locked until P8-UNLOCK), for its full CPU credit, then the server put back as it was found, locked.
#
# How it leaves the hosted server as found: the load day never runs in the hosted stack. The hosted stack (Compose project brightwater,
# /opt/brightwater) is only stopped; its .env, its database volume and its certificate are never written. The load copy is the same
# bw-p4-load project temp-server.sh deploys on a temporary copy (/opt/bw-load, its own .env with the routes open, its own database
# and volumes), so the test world never touches the hosted world. restore removes the load copy, starts the hosted stack again the way
# server-deploy.sh does (docker compose up -d in /opt/brightwater, then an nginx reload), and puts the port rules back as recorded.
# The hosted world is not set up again: setup has never run on it (it waits for P8-UNLOCK; F-312, F-556), so restore proves its
# database volumes and world rows unchanged instead. Running setup there would make P8-UNLOCK's own setup stop with world_not_fresh.
#
# It reaches the server only as infra/deploy/deploy.sh does (BW_HOST as it reads it, BW_KEY's default; the host key must already be in
# ~/.ssh/known_hosts), and Lightsail only through aws_ls below: reads of brightwater-1 and put-instance-public-ports on brightwater-1,
# guarded so port 22 stays as recorded. It never deletes, stops, reboots or makes an instance, and never touches a key pair.
# temp-server.sh refuses create, install, delete and backstop in this state folder (its target file reads hosted).
#
#   BW_LOAD_DIR=<state folder outside the repo> BW_LOAD_IMAGE=<amd64 image> BW_LOAD_DATA=<folder> bash infra/load/hosted-day.sh run
#   BW_LOAD_DIR=<the same folder> bash infra/load/hosted-day.sh restore
# Progress: <state>/hosted-day.log. Verdict: <state>/VERDICT (written last, also by a failed or stopped run).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
INSTANCE=brightwater-1
ports_py="$here/hosted-ports.py"
LOAD_PROJECT=bw-p4-load

usage() {
  cat <<'USAGE'
usage: BW_LOAD_DIR=<state folder> bash infra/load/hosted-day.sh <step>
  run        every step below in order, then restore (also on a failed step, a watchdog abort or a signal). Start it once, in the
             background; about 12.5 hours with the default day. Exit 0: the day finished and restore passed; 3: restore failed;
             else the failed step's or the day's code.
  prepare    (local) the state folder's target files: target (hosted), ip and known_hosts from BW_HOST, key.pem (a link to BW_KEY),
             instance-name (brightwater-1), domain
  record     the starting state into <state>/start: the instance (name, state, plan), its port rules (get-instance-port-states),
             the locked page and /healthz from this Mac, the hosted .env's checksum and non-secret values (ROUTES must read locked),
             a root-only copy of the .env on the server, the Compose projects, images, running services, volumes, world rows,
             the certificate renewal timer and the free disk. Refused when <state>/start exists.
  backstop   a launchd job on this Mac that runs restore at the expiry (BW_LOAD_BACKSTOP_HOURS, default 16), from copies of this
             script and hosted-ports.py in the state folder; a passed restore removes it
  ports      80 and 443 open to this Mac's address only; 22 and every other rule as recorded
  stop-hosted  the certificate renewal timer stopped (when it was active) and the hosted stack stopped (docker compose stop)
  deploy     temp-server.sh deploy: the load copy (bw-p4-load) with BW_LOAD_IMAGE and BW_LOAD_DATA, its routes open
  world      temp-server.sh world: setup, infra/load/fixture.sql and the sessions, into the load copy's own database
  sample     temp-server.sh sample
  day        run-day.sh (BW_LOAD_RELEASE=none: it collects, never deletes) with the steal watchdog (steal-watchdog.py --on-abort
             none: 2 windows over 5% steal, or burst credit 0 with CPU held at 20%, stops the day); collect is run-day's
             (collect-<label>-1, or collect-<label>-1-stopped), brightwater-1's CPU and burst metrics included
  unsample   temp-server.sh unsample: the samplers stopped and their files removed
  restore    always safe to repeat, never refused but for a missing or foreign state folder: the load copy, its image (when the
             server did not hold it), files and volumes removed; the .env put back if it differs from the record; the hosted stack
             started (compose up -d, nginx reload) with the recorded services running; the timer started again if it was active;
             the volumes and world rows checked against the record; the port rules put back exactly as recorded; then, from this
             Mac, the start page reads "This demo is not open yet" and /healthz answers 200. Passed: the backstop is removed.
  lightsail <subcommand> [args]  a Lightsail call through the guard (reads of brightwater-1, its port rules only)
Variables:
  BW_LOAD_DIR             the state folder (required; outside the repo; holds the world's session tokens and the record)
  BW_HOST, BW_KEY         the hosted server's login, as infra/deploy/deploy.sh reads them (BW_HOST from the environment or the
                          owner's private files, never a default; BW_KEY's same default); the user must be admin
  BW_LOAD_IMAGE           the amd64 release image to load (run, deploy); BW_LOAD_DATA the folder with street-list.json, generator/, maps/
  BW_LOAD_BACKSTOP_HOURS  whole hours 1 to 48 to the backstop's restore (default 16)
  BW_LOAD_LABEL           the day's label (default realspeed-hosted); BW_LOAD_RUN_SECONDS the day's length (default 42360)
  BW_LOAD_VANS            on|off (default on); BW_LOAD_ROUTING on|off (default on), as run-day.sh reads it
  BW_LOAD_TASK, BW_LOAD_PAGES, BW_LOAD_RUNS_REQUIRED, BW_LOAD_STOP_COLLECT_SECONDS  passed to run-day.sh (P7-LOAD, on, 1, 300)
  BW_DOMAIN               the hosted name the final checks read (default bw.j7l.io)
  BW_LOAD_HEALTH_WAIT     seconds restore waits for the hosted stack and the checks (default 180)
  BW_LOAD_PORT_WAIT       seconds between the port rule reads after a put (default 5; up to 6 reads)
  Set by day for run-day.sh, not by hand: BW_LOAD_RELEASE=none, BW_LOAD_SERVER_KIND (the output file's server line),
  BW_LOAD_PLAN (the recorded plan)
USAGE
}

step="${1:-}"
case "$step" in -h | --help | help) usage; exit 0 ;; '') usage >&2; exit 2 ;; esac
case "$step" in
  run | prepare | record | backstop | ports | stop-hosted | deploy | world | sample | day | unsample | restore | lightsail) ;;
  *) echo "hosted-day: unknown step '$step'" >&2; usage >&2; exit 2 ;;
esac

# The state folder: checked before any remote call. run and prepare may make it; every other step needs one prepare made.
dir="${BW_LOAD_DIR:-}"
refuse() { echo "hosted-day: refused: $*" >&2; exit 2; }
[ -n "$dir" ] || refuse 'set BW_LOAD_DIR to a state folder outside the repo'
case "$dir" in /*) ;; *) refuse "BW_LOAD_DIR must be an absolute path" ;; esac
if [ "$step" = run ] || [ "$step" = prepare ]; then
  # Checked by name before the folder is made, and by its real path after.
  case "$dir/" in "$root/"* | "$(cd "$root" && pwd -P)/"*) refuse "BW_LOAD_DIR is inside the repo ($root); it holds session tokens" ;; esac
  mkdir -p "$dir"
  case "$(cd "$dir" && pwd -P)/" in "$(cd "$root" && pwd -P)/"*) refuse "BW_LOAD_DIR is inside the repo ($root); it holds session tokens" ;; esac
else
  [ -d "$dir" ] || refuse "no state folder at $dir"
  [ "$(cat "$dir/target" 2>/dev/null)" = hosted ] || refuse "$dir is not a hosted-day state folder (no target file reading hosted)"
  for f in ip known_hosts key.pem instance-name domain; do [ -e "$dir/$f" ] || refuse "the state folder has no $f"; done
  [ "$(cat "$dir/instance-name")" = "$INSTANCE" ] || refuse "the state folder names another instance"
fi
start="$dir/start"

# The 1 way to Lightsail. Allowed: reads, and the port rules, of brightwater-1 only; a port rule write must keep port 22 as recorded.
aws_ls() {
  local sub="${1:-}" a prev='' n=0 infos=''
  case "$sub" in
    get-instance | get-instance-port-states | get-instance-metric-data | put-instance-public-ports) ;;
    *) echo "hosted-day: refused: lightsail $sub (allowed: reads and the port rules of $INSTANCE)" >&2; return 2 ;;
  esac
  for a in "$@"; do
    case "$a" in --instance-name=* | --port-infos=* | --cli-input-json* | --instance-names*) echo "hosted-day: refused: lightsail argument ${a%%=*}" >&2; return 2 ;; esac
    if [ "$prev" = --instance-name ]; then
      [ "$a" = "$INSTANCE" ] || { echo "hosted-day: refused: lightsail $sub on an instance other than $INSTANCE" >&2; return 2; }
      n=$((n + 1))
    fi
    [ "$prev" = --port-infos ] && infos="$a"
    prev="$a"
  done
  [ "$n" = 1 ] || { echo "hosted-day: refused: lightsail $sub without exactly 1 --instance-name $INSTANCE" >&2; return 2; }
  if [ "$sub" = put-instance-public-ports ]; then
    case "$infos" in file://*) ;; *) echo 'hosted-day: refused: port rules only as --port-infos file://<file>' >&2; return 2 ;; esac
    [ -f "$start/ports.json" ] || { echo 'hosted-day: refused: no recorded port rules to guard port 22 with' >&2; return 2; }
    python3 -I "$ports_py" guard "$start/ports.json" "${infos#file://}" || return 2
  fi
  aws --profile brightwater --region us-east-1 lightsail "$@"
}

remote() {
  ssh -i "$dir/key.pem" -o UserKnownHostsFile="$dir/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20 \
    -o ServerAliveInterval=30 "admin@$(cat "$dir/ip")" "$@"
}
hdc='cd /opt/brightwater && sudo docker compose'
now() { date '+%b %-d, %-I:%M:%S %p %Z'; }
# at_epoch <seconds> [date arguments]: date at that moment. BSD date on the owner's Mac, where the load day runs (D16); GNU date in the
# CI image, where the backstop's tests run in every host zone (F-1548). Only the flag differs.
at_epoch() { local s="$1"; shift; if date --version >/dev/null 2>&1; then date -d "@$s" "$@"; else date -r "$s" "$@"; fi; }
say() { echo "hosted-day: $* ($(now))"; }
server() { bash "$root/infra/load/temp-server.sh" "$@"; }
domain() { cat "$dir/domain"; }
# The locked page and /healthz from this Mac: "locked 200" when both hold.
mac_check() {
  local d body code
  d="$(domain)"
  body="$(curl -s --max-time 15 "https://$d/" || true)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$d/healthz" || true)"
  case "$body" in *'This demo is not open yet'*) printf 'locked %s\n' "$code" ;; *) printf 'open %s\n' "$code" ;; esac
}
running_services() { remote "$hdc ps --status running --format '{{.Service}}'" | sort; }
volumes() { remote "sudo docker volume ls -q --filter label=com.docker.compose.project=brightwater | sort | xargs -r sudo docker volume inspect -f '{{.Name}} {{.CreatedAt}}'"; }
world_rows() { remote "$hdc exec -T db psql -tA -U brightwater -d brightwater -c 'select count(*) from world.customer'" 2>/dev/null || echo unknown; }

prepare() {
  local host key user ip
  # F-1623: BW_HOST as infra/deploy/deploy.sh reads it (the environment, else the owner's private files), or a refusal before any ssh.
  . "$root/infra/drill/owner-env.sh"
  bw_need_host "$root" || exit 2
  host="$BW_HOST"
  key="${BW_KEY:-$HOME/.ssh/brightwater-lightsail.pem}"
  user="${host%@*}" ip="${host#*@}"
  [ "$user" = admin ] || refuse 'BW_HOST must log in as admin (the load copy steps run as admin)'
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse 'BW_HOST must be admin@<IPv4 address>'
  [ -f "$key" ] || refuse 'no key file at BW_KEY'
  ssh-keygen -F "$ip" -f "$HOME/.ssh/known_hosts" 2>/dev/null | grep -v '^#' >"$dir/known_hosts.new" || true
  [ -s "$dir/known_hosts.new" ] || { rm -f "$dir/known_hosts.new"; refuse "the hosted server's host key is not in ~/.ssh/known_hosts (log in once by deploy.sh first)"; }
  mv "$dir/known_hosts.new" "$dir/known_hosts"
  echo "$ip" >"$dir/ip"
  ln -sfn "$key" "$dir/key.pem"
  echo "$INSTANCE" >"$dir/instance-name"
  echo "${BW_DOMAIN:-bw.j7l.io}" >"$dir/domain"
  echo hosted >"$dir/target"
}

record() {
  local t="$dir/start.partial" name state plan pub roots
  [ ! -e "$start" ] || refuse "$start exists: this folder recorded a run already (restore it, then use a new folder)"
  rm -rf "$t"
  mkdir -p "$t"
  read -r name state plan pub < <(aws_ls get-instance --instance-name "$INSTANCE" --query 'instance.[name,state.name,bundleId,publicIpAddress]' --output text)
  [ "$name" = "$INSTANCE" ] && [ "$state" = running ] || refuse "$INSTANCE is not running"
  [ "$pub" = "$(cat "$dir/ip")" ] || refuse "BW_HOST is not $INSTANCE's public address"
  printf '%s %s %s\n' "$name" "$state" "$plan" >"$t/instance.txt"
  echo "$plan" >"$t/plan"
  aws_ls get-instance-port-states --instance-name "$INSTANCE" --output json >"$t/ports.json"
  python3 -I "$ports_py" limit "$t/ports.json" 192.0.2.1 >/dev/null || refuse 'the recorded port rules cannot be limited safely'
  mac_check >"$t/mac-check.txt"
  [ "$(cat "$t/mac-check.txt")" = 'locked 200' ] || refuse "the hosted server is not locked and healthy at the start ($(cat "$t/mac-check.txt"))"
  roots="$(remote "sudo docker compose ls -a -q" | sort | tr '\n' ' ')"
  [ "$roots" = 'brightwater ' ] || refuse "the server runs Compose projects other than brightwater ($roots); run restore if a load copy is left"
  remote "sudo sha256sum /opt/brightwater/.env | cut -d' ' -f1" >"$t/env.sha256"
  remote "sudo grep -E '^(ROUTES|BW_IMAGE|PROXY_CONF|HTTP_BIND|HTTPS_BIND)=' /opt/brightwater/.env" >"$t/env-values.txt"
  grep -qx 'ROUTES=locked' "$t/env-values.txt" || refuse 'the hosted .env does not read ROUTES=locked'
  remote "sudo docker image ls --format '{{.Repository}}:{{.Tag}}'" | sort >"$t/images.txt"
  running_services >"$t/services.txt"
  [ -s "$t/services.txt" ] || refuse 'no hosted service is running'
  volumes >"$t/volumes.txt"
  world_rows >"$t/world-rows.txt"
  remote 'systemctl is-active brightwater-certbot-renew.timer || true' >"$t/certbot-timer.txt"
  remote "df -Pk /opt | tail -1 | awk '{print \$4}'" >"$t/disk-avail-kb.txt"
  local need=$(( $(du -sk "${BW_LOAD_DATA:?set BW_LOAD_DATA}" | cut -f1) + 4194304 ))
  [ "$(cat "$t/disk-avail-kb.txt")" -ge "$need" ] || refuse "the server has $(cat "$t/disk-avail-kb.txt") KiB free, the load copy needs $need"
  mv "$t" "$start"
  # The .env holds secrets: its copy stays on the server, root-only; restore puts it back only if the .env changed.
  remote 'sudo install -d -m 700 /var/lib/bw-load-keep && sudo cp -p /opt/brightwater/.env /var/lib/bw-load-keep/env.start'
  say "recorded the start: $(cat "$start/instance.txt"), $(wc -l <"$start/services.txt" | tr -d ' ') services running, world rows $(cat "$start/world-rows.txt")"
}

backstop() {
  local hours="${BW_LOAD_BACKSTOP_HOURS:-16}" expires at mo dd hh mi label agents plist
  [[ "$hours" =~ ^[0-9]+$ ]] && [ "${#hours}" -le 2 ] && [ "$((10#$hours))" -ge 1 ] && [ "$((10#$hours))" -le 48 ] || refuse "BW_LOAD_BACKSTOP_HOURS must be a whole number from 1 to 48, got '$hours'"
  # The tag and the fire time read the same moment, so both name the same minute (UTC there, this Mac's time here).
  at=$(($(date +%s) + 10#$hours * 3600))
  expires="$(at_epoch "$at" -u +%Y-%m-%dT%H:%MZ)"
  read -r mo dd hh mi <<<"$(at_epoch "$at" '+%m %d %H %M')"
  label="io.bw.load-hosted-restore.$INSTANCE"
  agents="$HOME/Library/LaunchAgents"
  mkdir -p "$agents"
  # Copies, so the job needs no checkout; a restore needs nothing else (the record and the target files are in the state folder).
  cp "$0" "$dir/hosted-day.sh"
  cp "$ports_py" "$dir/hosted-ports.py"
  plist="$agents/$label.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo "  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$dir/hosted-day.sh</string><string>restore</string></array>"
    echo "  <key>EnvironmentVariables</key><dict><key>BW_LOAD_DIR</key><string>$dir</string><key>PATH</key><string>$PATH</string></dict>"
    echo "  <key>StartCalendarInterval</key><dict><key>Month</key><integer>$((10#$mo))</integer><key>Day</key><integer>$((10#$dd))</integer><key>Hour</key><integer>$((10#$hh))</integer><key>Minute</key><integer>$((10#$mi))</integer></dict>"
    echo "  <key>StandardOutPath</key><string>$dir/backstop.log</string><key>StandardErrorPath</key><string>$dir/backstop.log</string>"
    echo '</dict></plist>'
  } >"$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "$label" >"$dir/backstop-label"
  echo "$expires" >"$dir/backstop-expires"
  say "backstop $label restores the hosted server at $hh:$mi on $mo/$dd (this Mac's time) unless a restore passes first"
}

remove_backstop() {
  [ -f "$dir/backstop-label" ] || return 0
  local label
  label="$(cat "$dir/backstop-label")"
  rm -f "$HOME/Library/LaunchAgents/$label.plist" "$dir/backstop-label"
  # Last: when the backstop itself runs this, bootout ends it.
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
}

ports_equal() { # <want file>: up to 6 reads, 5 s apart, until the instance's rules equal it
  local i
  for i in 1 2 3 4 5 6; do
    aws_ls get-instance-port-states --instance-name "$INSTANCE" --output json >"$dir/ports-now.json" && python3 -I "$ports_py" same "$dir/ports-now.json" "$1" 2>/dev/null && return 0
    [ "$i" = 6 ] || sleep "${BW_LOAD_PORT_WAIT:-5}"
  done
  python3 -I "$ports_py" same "$dir/ports-now.json" "$1"
}

ports() {
  [ -f "$start/ports.json" ] || refuse 'no recorded port rules (record first)'
  local my_ip
  my_ip="$(curl -s -4 --max-time 10 https://checkip.amazonaws.com)"
  [[ "$my_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'hosted-day: no address for this Mac' >&2; exit 1; }
  python3 -I "$ports_py" limit "$start/ports.json" "$my_ip" >"$dir/ports-limited.json"
  echo limited >"$dir/ports-state"
  aws_ls put-instance-public-ports --instance-name "$INSTANCE" --port-infos "file://$dir/ports-limited.json" >"$dir/aws-ports-limit.json"
  ports_equal "$dir/ports-limited.json"
  say 'ports 80 and 443 open to this Mac only; 22 as recorded'
}

stop_hosted() {
  [ -d "$start" ] || refuse 'no record (record first)'
  echo stopping >"$dir/hosted-state"
  if [ "$(cat "$start/certbot-timer.txt")" = active ]; then remote 'sudo systemctl stop brightwater-certbot-renew.timer'; fi
  remote "$hdc stop"
  echo stopped >"$dir/hosted-state"
  say 'hosted stack stopped (its containers, volumes and .env kept)'
}

deploy() {
  [ "$(cat "$dir/hosted-state" 2>/dev/null)" = stopped ] || refuse 'the hosted stack is not stopped (stop-hosted first)'
  echo "${BW_LOAD_IMAGE:?set BW_LOAD_IMAGE}" >"$dir/load-image"
  server deploy
}

# The day and its watchdog. Globals, so run's signal trap can stop them.
rd_pid='' wd_pid=''
day() {
  local label="${BW_LOAD_LABEL:-realspeed-hosted}" seconds="${BW_LOAD_RUN_SECONDS:-42360}" vans="${BW_LOAD_VANS:-on}" rc=0
  rm -f "$dir/ABORTED" "$dir/watchdog-ended"
  BW_LOAD_RELEASE=none BW_LOAD_SERVER_KIND="the hosted server ($INSTANCE), locked demo stopped for the day" \
    BW_LOAD_PLAN="$(cat "$start/plan")" BW_LOAD_TASK="${BW_LOAD_TASK:-P7-LOAD}" BW_LOAD_PAGES="${BW_LOAD_PAGES:-on}" \
    BW_LOAD_RUNS_REQUIRED="${BW_LOAD_RUNS_REQUIRED:-1}" BW_LOAD_STOP_COLLECT_SECONDS="${BW_LOAD_STOP_COLLECT_SECONDS:-300}" \
    bash "$root/infra/load/run-day.sh" "$label" 1 1 "$seconds" 0 "$vans" </dev/null &
  rd_pid=$!
  echo "$rd_pid" >"$dir/run.pid"
  python3 -I "$root/infra/load/steal-watchdog.py" "$dir" "$root" --on-abort none </dev/null >"$dir/watchdog.out" 2>&1 &
  wd_pid=$!
  say "day started: run-day pid $rd_pid, label $label, $seconds s; watchdog pid $wd_pid (log watchdog.log)"
  wait "$rd_pid" || rc=$?
  rd_pid=''
  # The watchdog ends by itself once the run is gone (within a tick) or after its abort.
  local i
  for i in $(seq 1 60); do kill -0 "$wd_pid" 2>/dev/null || break; sleep 1; done
  kill "$wd_pid" 2>/dev/null || true
  wd_pid=''
  if [ -f "$dir/ABORTED" ]; then say "day ABORTED by the watchdog: $(sed -n 2p "$dir/ABORTED")"; else say "day ended, run-day exit $rc"; fi
  return "$rc"
}

restore() {
  set +e
  local fail='' i got sha want img d
  # 1 restore at a time (the run's trap and a hand call or the backstop may meet); a repeat after it is safe.
  for i in $(seq 1 900); do
    mkdir "$dir/restore.lock" 2>/dev/null && break
    if ! kill -0 "$(cat "$dir/restore.lock/pid" 2>/dev/null || echo 0)" 2>/dev/null; then rm -rf "$dir/restore.lock"; continue; fi
    sleep 1
  done
  echo $$ >"$dir/restore.lock/pid"
  say 'restore begins'
  if [ ! -f "$start/ports.json" ]; then
    say 'restore: nothing was recorded in this folder, so nothing on the hosted server or its port rules was changed'
    remove_backstop
    rm -rf "$dir/restore.lock"
    return 0
  fi
  # 1. The load copy: samplers, containers, volumes, network, files and the image the start did not hold.
  remote "sudo pkill -f '[b]w-cgroup-sampler.sh'; sudo pkill -f '[v]mstat -n -t 5'; sudo pkill -f 'while :; do sudo [d]ocker stats'; true" || fail+=' samplers'
  remote "if [ -f /opt/bw-load/infra/compose.yaml ]; then sudo docker compose -p $LOAD_PROJECT --project-directory /opt/bw-load/infra -f /opt/bw-load/infra/compose.yaml down -v --remove-orphans; fi; true"
  remote "sudo docker ps -aq --filter label=com.docker.compose.project=$LOAD_PROJECT | xargs -r sudo docker rm -f >/dev/null; sudo docker volume ls -q --filter label=com.docker.compose.project=$LOAD_PROJECT | xargs -r sudo docker volume rm >/dev/null; sudo docker network ls -q --filter label=com.docker.compose.project=$LOAD_PROJECT | xargs -r sudo docker network rm >/dev/null; true"
  got="$(remote "sudo docker ps -aq --filter label=com.docker.compose.project=$LOAD_PROJECT; sudo docker volume ls -q --filter label=com.docker.compose.project=$LOAD_PROJECT")" || fail+=' load-copy'
  [ -z "$got" ] || fail+=' load-copy-left'
  remote 'sudo rm -rf /opt/bw-load /etc/bw-load /tmp/bw-burst-out /tmp/bw-tls /tmp/bw-cgroup-sampler.sh /tmp/bw-vmstat.log /tmp/bw-stats.log /tmp/bw-cgroup.log' || fail+=' files'
  img="$(cat "$dir/load-image" 2>/dev/null)"
  if [ -n "$img" ] && ! grep -qxF "$img" "$start/images.txt"; then
    remote "sudo docker image inspect '$img' >/dev/null 2>&1 && sudo docker image rm '$img' >/dev/null; true" || fail+=' image'
  fi
  # 2. The hosted .env: only when it differs from the record, from the server's own root-only copy.
  want="$(cat "$start/env.sha256")"
  sha="$(remote "sudo sha256sum /opt/brightwater/.env | cut -d' ' -f1")"
  if [ "$sha" != "$want" ]; then
    say 'restore: the hosted .env differs from the record; putting the recorded copy back'
    remote 'sudo install -m 600 -o root -g root /var/lib/bw-load-keep/env.start /opt/brightwater/.env' || fail+=' env'
    sha="$(remote "sudo sha256sum /opt/brightwater/.env | cut -d' ' -f1")"
  fi
  [ "$sha" = "$want" ] || fail+=' env-checksum'
  # 3. The hosted stack as server-deploy.sh starts it, then the recorded services running and /healthz 200 on the server.
  remote "$hdc up -d" || fail+=' compose-up'
  remote "$hdc exec -T proxy sh -c 'nginx -t -q && nginx -s reload'" || true
  local wait_s="${BW_LOAD_HEALTH_WAIT:-180}" t0 ok=''
  d="$(domain)"
  t0=$(date +%s)
  # At least 1 check, then again until the wait is spent: a test of the time first skipped every check when the clock's
  # second turned between t0 and that test with a wait of 0 (F-1548, seen on a loaded Mac).
  while :; do
    if [ "$(remote "curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve $d:443:127.0.0.1 https://$d/healthz")" = 200 ] \
      && [ "$(running_services)" = "$(cat "$start/services.txt")" ]; then ok=1; break; fi
    [ $(($(date +%s) - t0)) -lt "$wait_s" ] || break
    sleep 5
  done
  [ -n "$ok" ] || fail+=' hosted-stack'
  if [ "$(cat "$start/certbot-timer.txt")" = active ]; then
    remote 'sudo systemctl start brightwater-certbot-renew.timer' || fail+=' timer'
    [ "$(remote 'systemctl is-active brightwater-certbot-renew.timer')" = active ] || fail+=' timer-state'
  fi
  [ "$(volumes)" = "$(cat "$start/volumes.txt")" ] || fail+=' volumes'
  [ "$(world_rows)" = "$(cat "$start/world-rows.txt")" ] || fail+=' world-rows'
  [ "$(remote 'sudo docker compose ls -a -q' | sort | tr '\n' ' ')" = 'brightwater ' ] || fail+=' projects'
  # 4. The port rules exactly as recorded (Lightsail replaces the whole set).
  python3 -I "$ports_py" infos "$start/ports.json" >"$dir/ports-restore.json" || fail+=' ports-file'
  if aws_ls put-instance-public-ports --instance-name "$INSTANCE" --port-infos "file://$dir/ports-restore.json" >"$dir/aws-ports-restore.json"; then
    if ports_equal "$start/ports.json"; then echo recorded >"$dir/ports-state"; else fail+=' ports-check'; fi
  else
    fail+=' ports'
  fi
  # 5. From this Mac, through the restored rules: the locked page and /healthz.
  t0=$(date +%s)
  until [ "$(mac_check)" = 'locked 200' ] || [ $(($(date +%s) - t0)) -gt "$wait_s" ]; do sleep 5; done
  got="$(mac_check)"
  echo "$got" >"$dir/mac-check-after.txt"
  [ "$got" = 'locked 200' ] || fail+=' mac-check'
  if [ -z "$fail" ]; then
    remote 'sudo rm -rf /var/lib/bw-load-keep' || true
    echo restored >"$dir/hosted-state"
    echo "RESTORED at $(now)" >"$dir/RESTORED"
    say 'RESTORE PASSED: load copy gone, hosted stack up and locked, .env and volumes as recorded, port rules as recorded'
    rm -rf "$dir/restore.lock"
    remove_backstop
    return 0
  fi
  say "RESTORE FAILED:$fail (the backstop stays; run restore again)"
  rm -rf "$dir/restore.lock"
  return 1
}

run() {
  # Local checks before any remote call.
  [ ! -e "$start" ] || refuse "$start exists: this folder recorded a run already (restore it, then use a new folder)"
  [ -n "${BW_LOAD_IMAGE:-}" ] || refuse 'set BW_LOAD_IMAGE to the amd64 release image'
  docker image inspect "$BW_LOAD_IMAGE" >/dev/null 2>&1 || refuse "no local image $BW_LOAD_IMAGE"
  local data="${BW_LOAD_DATA:-}"
  [ -n "$data" ] && [ -f "$data/street-list.json" ] && [ -d "$data/generator" ] && [ -d "$data/maps" ] || refuse 'BW_LOAD_DATA must hold street-list.json, generator/ and maps/'
  for t in aws ssh ssh-keygen curl python3 docker launchctl; do command -v "$t" >/dev/null || refuse "no $t on PATH"; done
  # A background job: no ssh may read (and swallow) whatever stdin it was started with.
  exec </dev/null > >(tee -a "$dir/hosted-day.log") 2>&1
  say "run begins (state folder $dir)"
  rm -f "$dir/VERDICT"
  prepare
  record
  local stage='' rc=0 day_rc='' restored=''
  finish() {
    local why="$1" rrc=0
    trap - EXIT INT TERM HUP
    if [ -n "$rd_pid" ] && kill -0 "$rd_pid" 2>/dev/null; then
      kill -TERM "$rd_pid" 2>/dev/null
      local i
      for i in $(seq 1 $(( ${BW_LOAD_STOP_COLLECT_SECONDS:-300} + 30 ))); do kill -0 "$rd_pid" 2>/dev/null || break; sleep 1; done
    fi
    [ -z "$wd_pid" ] || kill "$wd_pid" 2>/dev/null || true
    [ -n "$restored" ] || { restore; rrc=$?; }
    local verdict="day ${day_rc:-not run}"
    [ -f "$dir/ABORTED" ] && verdict="day ABORTED by the watchdog ($(sed -n 2p "$dir/ABORTED"))"
    [ -z "$why" ] || verdict="$verdict; stopped: $why"
    if [ "$rrc" = 0 ]; then verdict="$verdict; restore PASSED"; else verdict="$verdict; restore FAILED (run: BW_LOAD_DIR=$dir bash $here/hosted-day.sh restore)"; fi
    echo "hosted-day RESULT: $verdict ($(now))" | tee "$dir/VERDICT"
    [ "$rrc" = 0 ] || exit 3
    exit "${2:-1}"
  }
  trap 'finish "signal TERM" 143' TERM
  trap 'finish "signal INT" 130' INT
  trap 'finish "signal HUP" 129' HUP
  trap 'finish "exit during ${stage:-run}" 1' EXIT
  # Each step in its own shell, so set -e stops it at its first failed command (a function called under || would not stop).
  for stage in backstop ports stop-hosted deploy world sample; do
    say "== $stage"
    bash "$here/hosted-day.sh" "$stage" || finish "step $stage failed" 1
  done
  stage=day
  say '== day'
  day || rc=$?
  day_rc="exit $rc"
  stage=unsample
  say '== unsample'
  server unsample || say 'unsample failed (restore stops the samplers too)'
  stage=restore
  say '== restore'
  local rrc=0
  restore || rrc=$?
  restored=1
  trap - EXIT INT TERM HUP
  local verdict="day $day_rc"
  [ -f "$dir/ABORTED" ] && verdict="day ABORTED by the watchdog ($(sed -n 2p "$dir/ABORTED"))"
  if [ "$rrc" = 0 ]; then verdict="$verdict; restore PASSED"; else verdict="$verdict; restore FAILED (run: BW_LOAD_DIR=$dir bash $here/hosted-day.sh restore)"; fi
  echo "hosted-day RESULT: $verdict ($(now))" | tee "$dir/VERDICT"
  [ "$rrc" = 0 ] || exit 3
  exit "$rc"
}

case "$step" in
  run) run ;;
  prepare) prepare ;;
  record) record ;;
  backstop) backstop ;;
  ports) ports ;;
  stop-hosted) stop_hosted ;;
  deploy) deploy ;;
  world | sample | unsample) server "$step" ;;
  day) day ;;
  restore) restore ;;
  lightsail) shift; aws_ls "$@" ;;
esac
