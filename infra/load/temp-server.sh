#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P4-LOAD (P7-LOAD reuses it): the temporary copy of the hosted plan for a load day (REQUIREMENTS section 5.2, D16). It never names the
# locked server: it only ever talks to the 1 instance it created, by the name and address in its state folder.
#   BW_LOAD_DIR=<a folder outside the repo> bash infra/load/temp-server.sh <step>
#     create    the instance (BW_LOAD_PLAN, default small_3_0; Debian 13), tagged with its expiry; firewall 22 and 443 open to this Mac's address only;
#               its own key pair, made for it and deleted with it (F-899: never the account's default key, the hosted server's login); then
#               the backstop (F-900): a launchd job on this Mac that runs the delete step at the expiry, if nothing deleted it before.
#               BW_LOAD_BACKSTOP_HOURS (a whole number, 1 to 48; default 16) sets that expiry, the tag and the backstop alike: set 40 for
#               a credit-soaked day (about 24 hours idle, then the 11.8-hour real-speed day). collect's metric window follows it too.
#     install   Docker at the pins of infra/hosted/setup.sh
#     deploy    the release image (BW_LOAD_IMAGE, built for amd64), Compose project bw-p4-load: hosted.conf with a self-signed
#               certificate, routes open; every long-running service up, routing at the .env's 320m too (F-1440, D-21)
#     cap <n>m  send compose.yaml again and run web under another memory cap on this copy (no argument: the shipped cap)
#     world     setup, infra/load/fixture.sql, then the sessions into world.json
#     sessions  new sessions and world.json on the world already made
#     sample    start the host and container samplers on the server
#     collect [tag]  into collect-<tag>: the samplers' files, cgroup memory peaks and kills, web's heap limit, the board delay
#               samples (SD-43) and the instance's CPU and burst metrics
#     delete    delete the instance and its key pair, prove both with get-instances and get-key-pairs, and remove the backstop
#               (always safe to repeat)
#   P6-ROUTING-MEMORY (OQ-42) adds, after world:
#     legs      the load day's legs the bake does not cover (infra/load/routing-memory-legs.sql) into legs.json
#     routing <mmap|load> [<n>m|uncapped]  drop the kernel's page cache (so every page the service maps is charged to its own cgroup), then
#               start the routing service in that mode over the routing files deploy sent. No cap given: the .env's ROUTING_MEM_LIMIT (320m,
#               D-21), nothing in cap.yaml overrides it. A cap such as 600m goes into cap.yaml on this copy only; "uncapped" is 8g, the measuring run
#     burst <tag>  infra/load/route-burst.mjs over legs.json on the copy's Compose network, its file into burst-<tag>.json
#   P7-LOAD (F-1498) adds:
#     routing-arm <on|off>  the load day's 2 arms: on starts routing at the .env's 320m (D-21) if it is not up; off stops it (the stack
#               runs on, every leg not stored answers approximate). run-day.sh calls it from BW_LOAD_ROUTING before each chunk.
#   P8-RESTORE-DRILL (infra/drill/restore-drill.sh, 2 copies on 1 day) adds:
#     create reads BW_LOAD_NAME_TAG (1 to 12 lower-case letters or digits; the name ends -<tag>, so 2 copies made on 1 day differ) and
#               BW_LOAD_PURPOSE (the purpose tag of the instance and its key pair; default load-temporary)
#     fresh     setup only, on the fresh database: the sample world, no load fixture, no sessions. The seed goes into the state folder's
#               seed file (mode 600), so a sign-in on this copy (or on a copy restored from its backup) can derive the sample passwords
#     compose <args>  a docker compose command of this copy's project (bw-p4-load), as root
#     remote <command>  a command on this copy, its stdin passed through
#   These 3 never run in hosted mode.
# The state folder holds the SSH key and the world file's session tokens: it stays outside the repo and is removed after the run.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="${BW_LOAD_DIR:?set BW_LOAD_DIR to a state folder outside the repo}"
mkdir -p "$dir"
# The delete backstop's length in hours: whole number 1 to 48, checked before any cloud call. Only create and collect read it: the delete
# step is never refused over it (a backstop run or a clean-up must always go through).
backstop_hours="${BW_LOAD_BACKSTOP_HOURS:-16}"
case "${1:-}" in create | collect) ;; *) backstop_hours=16 ;; esac
[[ "$backstop_hours" =~ ^[0-9]+$ ]] && [ "${#backstop_hours}" -le 2 ] && [ "$((10#$backstop_hours))" -ge 1 ] && [ "$((10#$backstop_hours))" -le 48 ] || {
  echo "temp-server: BW_LOAD_BACKSTOP_HOURS must be a whole number from 1 to 48, got '$backstop_hours'" >&2
  exit 2
}
backstop_hours="$((10#$backstop_hours))"
# Times from epoch seconds: the expiry tag, the metric window and the backstop's fire time. BSD date on the owner's Mac, where the load
# day runs (D16); GNU date in the CI image, where these steps' tests run in every host zone (F-1548). Only the flag differs.
gnu_date() { date --version >/dev/null 2>&1; }
# at_epoch <seconds> [date arguments]: date at that moment
at_epoch() { local s="$1"; shift; if gnu_date; then date -d "@$s" "$@"; else date -r "$s" "$@"; fi; }
# epoch_of <UTC minute as create tags it, 2026-11-14T03:05Z>: its epoch seconds; any other form is refused
epoch_of() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$ ]] || { echo "temp-server: not an expiry as create tags it: '$1'" >&2; return 1; }
  if gnu_date; then date -u -d "${1:0:10} ${1:11:5}" +%s; else TZ=UTC date -j -f '%Y-%m-%dT%H:%MZ' "$1" '+%s'; fi
}
aws_ls() { aws --profile brightwater --region us-east-1 lightsail "$@"; }
name_file="$dir/instance-name"
key_name_file="$dir/key-pair-name"
remote() { ssh -i "$dir/key.pem" -o UserKnownHostsFile="$dir/known_hosts" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "admin@$(cat "$dir/ip")" "$@"; }
dc='sudo docker compose -p bw-p4-load --project-directory /opt/bw-load/infra -f /opt/bw-load/infra/compose.yaml -f /opt/bw-load/infra/cap.yaml --env-file /opt/bw-load/infra/.env'
# P7-LOAD hosted mode (owner answer f3d84787): infra/load/hosted-day.sh points this script at the hosted server by a state folder whose
# target file reads hosted. There the load copy is the bw-p4-load project beside the stopped hosted stack, and the steps that make or
# delete an instance or a key pair, install software or arm the delete backstop are refused before any call.
if [ "$(cat "$dir/target" 2>/dev/null)" = hosted ]; then
  case "${1:-}" in
    create | install | delete | backstop | fresh | compose | remote) echo "temp-server: refused: '$1' never runs on the hosted server (state folder target hosted)" >&2; exit 2 ;;
  esac
fi

case "${1:-}" in
  create)
    plan="${BW_LOAD_PLAN:-small_3_0}"
    # P8-RESTORE-DRILL: both checked before any cloud call.
    tag="${BW_LOAD_NAME_TAG:-}"
    [[ -z "$tag" || "$tag" =~ ^[a-z0-9]{1,12}$ ]] || { echo "temp-server: BW_LOAD_NAME_TAG must be 1 to 12 lower-case letters or digits, got '$tag'" >&2; exit 2; }
    purpose="${BW_LOAD_PURPOSE:-load-temporary}"
    [[ "$purpose" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || { echo "temp-server: BW_LOAD_PURPOSE must be lower-case letters, digits and -, got '$purpose'" >&2; exit 2; }
    name="bw-load-p4-$(date +%Y%m%d)-${plan%%_*}${tag:+-$tag}"
    my_ip="$(curl -s -4 --max-time 10 https://checkip.amazonaws.com)"
    [[ "$my_ip" =~ ^[0-9.]+$ ]] || { echo "temp-server: no address for this Mac" >&2; exit 1; }
    # Calibration and 20 chunked runs take about 13 hours (F-883): the default 16. A credit-soaked day sets BW_LOAD_BACKSTOP_HOURS.
    expires="$(at_epoch "$(($(date +%s) + backstop_hours * 3600))" -u +%Y-%m-%dT%H:%MZ)"
    aws_ls get-instances --query 'instances[].[name,bundleId,state.name,publicIpAddress]' --output text >"$dir/aws-before-instances.txt"
    # F-899: a key pair of its own, so the throwaway copy never holds the hosted server's login key; the delete step deletes it.
    # Lightsail names are unique across resource types, so the key pair's name differs from the instance's (F-1442).
    key_name="$name-key"
    echo "$name" >"$name_file"
    echo "$key_name" >"$key_name_file"
    umask 077
    aws_ls create-key-pair --key-pair-name "$key_name" --tags "key=purpose,value=$purpose" --query privateKeyBase64 --output text >"$dir/key.pem"
    umask 022
    aws_ls create-instances --instance-names "$name" --availability-zone us-east-1a --blueprint-id debian_13 --bundle-id "$plan" --key-pair-name "$key_name" \
      --tags "key=expires,value=$expires" "key=purpose,value=$purpose" >"$dir/aws-create.json" || {
      # No leftover resource after a failed create: the key pair made a step ago goes now.
      echo "temp-server: create-instances failed; deleting key pair $key_name" >&2
      aws_ls delete-key-pair --key-pair-name "$key_name" >"$dir/aws-delete-key.json" 2>&1 || cat "$dir/aws-delete-key.json" >&2
      rm -f "$dir/key.pem" "$key_name_file"
      exit 1
    }
    bash "$0" backstop "$expires"
    for _ in $(seq 1 60); do
      state="$(aws_ls get-instance-state --instance-name "$name" --query state.name --output text)"
      [ "$state" = running ] && break
      sleep 5
    done
    [ "$state" = running ] || { echo "temp-server: $name is $state after 5 minutes" >&2; exit 1; }
    aws_ls put-instance-public-ports --instance-name "$name" --port-infos \
      "fromPort=22,toPort=22,protocol=tcp,cidrs=$my_ip/32" "fromPort=443,toPort=443,protocol=tcp,cidrs=$my_ip/32" >"$dir/aws-ports.json"
    aws_ls get-instance --instance-name "$name" --query instance.publicIpAddress --output text >"$dir/ip"
    aws_ls get-instance-port-states --instance-name "$name" --query 'portStates[].[fromPort,state,join(`,`,cidrs)]' --output text
    for _ in $(seq 1 60); do
      remote true 2>/dev/null && break
      sleep 5
    done
    remote true
    echo "temp-server: $name up at $(date '+%b %-d, %-I:%M:%S %p %Z'), expires tag $expires"
    ;;
  install)
    { echo 'set -euo pipefail'; sed -n '/^DOCKER_VERSION=/,/^systemctl enable --now docker/p' "$root/infra/hosted/setup.sh"; } >"$dir/install.sh"
    remote sudo bash -s <"$dir/install.sh" >"$dir/install.log" 2>&1
    remote sudo docker version --format '{{.Server.Version}}'
    remote sudo docker compose version --short
    ;;
  deploy)
    image="${BW_LOAD_IMAGE:?set BW_LOAD_IMAGE to the amd64 release image}"
    data="${BW_LOAD_DATA:?set BW_LOAD_DATA to the folder that holds street-list.json and maps/}"
    ip="$(cat "$dir/ip")"
    # An image the size of this one takes a minute or 2 over the wire; docker load prints its name.
    docker save "$image" | gzip -1 | remote sudo docker load
    remote sudo install -d -m 755 -o admin /opt/bw-load
    COPYFILE_DISABLE=1 tar -C "$root" -czf - infra/compose.yaml infra/nginx infra/placeholder infra/own-copy-db.env | remote tar -C /opt/bw-load -xzf -
    COPYFILE_DISABLE=1 tar -C "$data" -czf - street-list.json generator maps | remote 'mkdir -p /opt/bw-load/data && tar -C /opt/bw-load/data -xzf -'
    remote 'sudo install -d -m 700 /etc/bw-load && umask 077 && printf "POSTGRES_PASSWORD=%s\n" "$(head -c 32 /dev/urandom | base64 | tr -d "/+=" | head -c 32)" | sudo tee /etc/bw-load/db.env >/dev/null'
    {
      echo "BW_IMAGE=$image"
      echo 'DB_ENV_FILE=/etc/bw-load/db.env'
      echo 'PROXY_CONF=hosted.conf'
      echo 'ROUTES=open'
      echo 'HTTP_BIND=80'
      echo 'HTTPS_BIND=443'
      echo "APP_ORIGIN=https://$ip"
      echo 'RESET_COOLDOWN_SECONDS=0'
      echo 'BW_DATA_DIR=/opt/bw-load/data'
      echo 'BW_MAPS_DIR=/opt/bw-load/data/maps'
      # A Lightsail copy of the hosted plan: routing at the cap measured on small_3_0 (BUILD_PLAN D-21); the routing step governs it: with no cap argument it starts routing at this value, and only a cap given there overrides it.
      echo 'ROUTING_MEM_LIMIT=320m'
    } | remote 'cat > /opt/bw-load/infra/.env'
    # $dc reads cap.yaml, so it exists before the first compose call: empty, the shipped caps.
    echo 'services: {}' | remote 'cat > /opt/bw-load/infra/cap.yaml'
    # A self-signed certificate for the address, where hosted.conf looks; the load script trusts it by NODE_EXTRA_CA_CERTS.
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3 -subj '/CN=bw-load-temporary' \
      -addext "subjectAltName=IP:$ip" -keyout "$dir/tls-key.pem" -out "$dir/tls-cert.pem" 2>/dev/null
    COPYFILE_DISABLE=1 tar -C "$dir" -cf - tls-key.pem tls-cert.pem | remote 'mkdir -p /tmp/bw-tls && tar -C /tmp/bw-tls -xf -'
    remote "$dc --profile certbot run --rm --no-deps -v /tmp/bw-tls:/tls:ro --entrypoint sh certbot -c 'mkdir -p /etc/letsencrypt/live/bw.j7l.io && cp /tls/tls-cert.pem /etc/letsencrypt/live/bw.j7l.io/fullchain.pem && cp /tls/tls-key.pem /etc/letsencrypt/live/bw.j7l.io/privkey.pem'"
    remote 'rm -rf /tmp/bw-tls'
    # F-1440: routing too, at the .env's ROUTING_MEM_LIMIT (D-21); the list is the staging copy's (infra/deploy/staging.sh).
    remote "$dc up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing"
    ;;
  cap)
    # A memory cap to measure with, on this throwaway copy only: compose.yaml's caps are SD-3's, tuned by the load-day runs. No argument: the shipped cap.
    # It sends this checkout's compose.yaml again first, so a change to web's shipped settings (F-882) reaches the copy.
    remote 'cat > /opt/bw-load/infra/compose.yaml' <"$root/infra/compose.yaml"
    if [ -n "${2:-}" ]; then printf 'services:\n  web:\n    mem_limit: %s\n' "$2"; else echo 'services: {}'; fi | remote 'cat > /opt/bw-load/infra/cap.yaml'
    remote "$dc up -d --no-build --wait --wait-timeout 180 web"
    remote "sudo docker inspect -f 'web memory limit {{.HostConfig.Memory}}' bw-p4-load-web-1"
    remote "$dc exec -T web node -p '\"web heap_size_limit MiB \" + Math.round(require(\"node:v8\").getHeapStatistics().heap_size_limit / 1048576)'"
    ;;
  world)
    ip="$(cat "$dir/ip")"
    seed="$(openssl rand -hex 24)"
    # F-1054: the seed goes over ssh's stdin and is read inside the root shell, so neither the Mac's argv nor sudo's log holds it.
    printf '%s\n' "$seed" | remote "sudo sh -c 'read -r s; SAMPLE_PASSWORD_SEED=\"\$s\" ${dc#sudo } --profile setup run --rm --no-deps setup'" >"$dir/setup.log" 2>&1
    grep -E '"status":"setup (done|refused)"' "$dir/setup.log" | cut -c1-160
    remote "$dc exec -T db psql -q -U brightwater -d brightwater" <"$root/infra/load/fixture.sql"
    umask 077
    remote "$dc exec -T db psql -q -tA -U brightwater -d brightwater" <"$root/infra/load/sessions.sql" >"$dir/world.json"
    umask 022
    wc -c "$dir/world.json"
    curl -s -o /dev/null -w 'healthz %{http_code}\n' --cacert "$dir/tls-cert.pem" "https://$ip/healthz"
    ;;
  fresh)
    # P8-RESTORE-DRILL: the sample world of a fresh setup and nothing else. The seed is read inside the root shell from ssh's stdin (F-1054).
    ip="$(cat "$dir/ip")"
    umask 077
    openssl rand -hex 24 >"$dir/seed"
    umask 022
    rc=0
    remote "sudo sh -c 'read -r s; SAMPLE_PASSWORD_SEED=\"\$s\" ${dc#sudo } --profile setup run --rm --no-deps setup'" <"$dir/seed" >"$dir/setup.log" 2>&1 || rc=$?
    grep -E '"status":"setup (done|refused)"' "$dir/setup.log" | cut -c1-160 || true
    if [ "$rc" -ne 0 ] || ! grep -q '"status":"setup done"' "$dir/setup.log"; then echo "temp-server: setup did not finish (exit $rc)" >&2; exit 1; fi
    curl -s -o /dev/null -w 'healthz %{http_code}\n' --cacert "$dir/tls-cert.pem" "https://$ip/healthz"
    ;;
  compose)
    shift
    remote "$dc $*"
    ;;
  remote)
    shift
    remote "$@"
    ;;
  sessions)
    # New sessions and a new world file on the world already made (a session signed out by its idle limit, say).
    ip="$(cat "$dir/ip")"
    umask 077
    remote "$dc exec -T db psql -q -tA -U brightwater -d brightwater" <"$root/infra/load/sessions.sql" >"$dir/world.json"
    umask 022
    wc -c "$dir/world.json"
    curl -s -o /dev/null -w 'healthz %{http_code}\n' --cacert "$dir/tls-cert.pem" "https://$ip/healthz"
    ;;
  sample)
    remote "nohup sh -c 'vmstat -n -t 5 > /tmp/bw-vmstat.log' >/dev/null 2>&1 &"
    remote "nohup sh -c 'while :; do sudo docker stats --no-stream --format \"{{.Name}} {{.CPUPerc}} {{.MemUsage}}\" | sed \"s/^/\$(date -u +%H:%M:%S) /\"; sleep 15; done > /tmp/bw-stats.log' >/dev/null 2>&1 &"
    # P6-ROUTING-MEMORY: the cgroup sampler (every 2 s, each container's memory.current and memory.stat, and the host's used memory).
    remote 'cat > /tmp/bw-cgroup-sampler.sh' <"$root/infra/load/cgroup-sampler.sh"
    remote "sudo nohup sh /tmp/bw-cgroup-sampler.sh /tmp/bw-cgroup.log >/dev/null 2>&1 &"
    echo 'samplers started'
    ;;
  unsample)
    remote "sudo pkill -f '[b]w-cgroup-sampler.sh'; sudo pkill -f '[v]mstat -n -t 5'; sudo pkill -f 'while :; do sudo [d]ocker stats'; true"
    remote 'sudo rm -f /tmp/bw-cgroup.log /tmp/bw-vmstat.log /tmp/bw-stats.log'
    ;;
  legs)
    remote "$dc exec -T db psql -q -tA -U brightwater -d brightwater" <"$root/infra/load/routing-memory-legs.sql" >"$dir/legs.json"
    node -e 'console.log("legs " + JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$dir/legs.json"
    ;;
  routing)
    case "${2:-}" in mmap) flag='--mmap ' ;; load) flag='' ;; *) echo "temp-server: routing mmap|load [<n>m]" >&2; exit 2 ;; esac
    # P6-ROUTING-MEMORY capped run (W36-ROUTING-CAP): no cap given, routing keeps the .env's ROUTING_MEM_LIMIT (320m; F-1341); a cap
    # such as 600m overrides it; "uncapped" is the 8g of the measuring runs (they ask for it by name).
    limit="${3:-}"
    [ "$limit" = uncapped ] && limit=8g
    [[ -z "$limit" || "$limit" =~ ^[0-9]+[mg]$ ]] || { echo "temp-server: routing cap '$limit' is not <n>m, <n>g or uncapped" >&2; exit 2; }
    cap_line=''
    [ -n "$limit" ] && cap_line="    mem_limit: $limit"$'\n'
    printf 'services:\n  routing:\n%s    command:\n      - /bin/sh\n      - -c\n      - exec osrm-routed --algorithm mld %s--ip 0.0.0.0 --port 5000 /data/maps/ohio.osrm\n' "$cap_line" "$flag" \
      | remote 'cat > /opt/bw-load/infra/cap.yaml'
    remote "sudo sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'"
    remote "$dc up -d --no-build --force-recreate routing"
    remote "sudo docker inspect -f 'routing memory limit {{.HostConfig.Memory}} cmd {{.Config.Cmd}}' bw-p4-load-routing-1"
    ;;
  burst)
    tag="${2:?tag}"
    remote 'mkdir -p /opt/bw-load/burst && install -d -m 777 /tmp/bw-burst-out'
    remote 'cat > /opt/bw-load/burst/route-burst.mjs' <"$root/infra/load/route-burst.mjs"
    remote 'cat > /opt/bw-load/burst/legs.json' <"$dir/legs.json"
    img="$(remote 'grep ^BW_IMAGE= /opt/bw-load/infra/.env | cut -d= -f2')"
    rc=0
    remote "sudo docker run --rm --network bw-p4-load_default --user node -e BURST_CONCURRENCY=${BURST_CONCURRENCY:-8} -v /opt/bw-load/burst:/burst:ro -v /tmp/bw-burst-out:/out --entrypoint node $img /burst/route-burst.mjs /out/burst-$tag.json" || rc=$?
    remote "cat /tmp/bw-burst-out/burst-$tag.json" >"$dir/burst-$tag.json"
    exit "$rc"
    ;;
  routing-arm)
    case "${2:-}" in
      on) remote "$dc up -d --no-build --wait --wait-timeout 180 routing" ;;
      off) remote "$dc stop routing" ;;
      *) echo "temp-server: routing-arm on|off" >&2; exit 2 ;;
    esac
    remote "sudo docker inspect -f 'routing {{.State.Status}} memory limit {{.HostConfig.Memory}}' bw-p4-load-routing-1"
    ;;
  collect)
    # Into its own folder per call (collect-<tag>), so each chunk's snapshot is kept: the samplers' files so far, cgroup memory
    # peaks and out-of-memory kills, web's heap limit as its own Node reads it (F-882), and the instance's CPU and burst metrics.
    # F-1498: also the route signal's lines (F-1306's 'live route failed', web and worker, with docker's timestamps, so each arm's
    # window can be cut from them), the stored legs by kind (live rows against baked) and the whole of /proc/meminfo.
    name="$(cat "$name_file")"
    out="$dir/collect-${2:-now}"
    mkdir -p "$out"
    remote cat /tmp/bw-vmstat.log >"$out/server-vmstat.log"
    remote cat /tmp/bw-stats.log >"$out/server-stats.log"
    remote "$dc exec -T db psql -tA -U brightwater -d brightwater -c \"select count(*), percentile_disc(0.5) within group (order by ms), percentile_disc(0.95) within group (order by ms), max(ms) from system.delay_sample\"" >"$out/server-delay-samples.txt"
    routing_ids=$(remote "$dc ps -q routing") && grep -q . <<<"$routing_ids" && with_routing=routing || with_routing=''
    for s in web worker pbs db proxy $with_routing; do
      printf '%s memory.peak ' "$s"
      remote "$dc exec -T $s cat /sys/fs/cgroup/memory.peak" || echo unknown
      printf '%s memory.max ' "$s"
      remote "$dc exec -T $s cat /sys/fs/cgroup/memory.max" || echo unknown
      printf '%s memory.events ' "$s"
      remote "$dc exec -T $s cat /sys/fs/cgroup/memory.events" | tr '\n' ' ' || echo unknown
      echo
      printf '%s state ' "$s"
      remote "sudo docker inspect -f '{{.State.Status}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} started={{.State.StartedAt}}' bw-p4-load-$s-1"
    done >"$out/server-memory.txt"
    # P6-ROUTING-MEMORY: each container's memory.stat at collect, the cgroup sampler's file, the container ids, the host's memory and
    # the routing files' disk use.
    for s in web worker pbs db proxy $with_routing; do
      echo "$s memory.stat $(remote "$dc exec -T $s cat /sys/fs/cgroup/memory.stat" | awk '/^(anon|file|file_mapped|shmem|active_file|inactive_file) /{printf "%s=%s ",$1,$2}')"
    done >>"$out/server-memory.txt"
    remote 'cat /tmp/bw-cgroup.log 2>/dev/null' >"$out/server-cgroup.log" || true
    remote "sudo docker ps --no-trunc --format '{{.ID}} {{.Names}}'" >"$out/server-ids.txt"
    remote 'free -b; cat /proc/meminfo' >"$out/server-free.txt"
    remote "$dc logs --no-color --timestamps web worker 2>&1 | grep -F 'live route failed'" >"$out/server-route-signal.log" || true
    wc -l <"$out/server-route-signal.log" | tr -d ' ' | sed 's/^/route signal lines /' >>"$out/server-memory.txt"
    remote "$dc exec -T db psql -tA -U brightwater -d brightwater -c \"select case when build_id = 'live' then 'live' else 'baked' end, count(*) from world.van_track group by 1 order by 1\"" >"$out/server-legs.txt" || true
    remote 'du -sb /opt/bw-load/data/maps/ohio.osrm* | awk "{s+=\$1} END {print s}"; du -sk /opt/bw-load/data/maps | cut -f1; df -k /opt | tail -1' >"$out/server-disk.txt"
    printf 'web heap_size_limit MiB ' >>"$out/server-memory.txt"
    remote "$dc exec -T web node -p 'Math.round(require(\"node:v8\").getHeapStatistics().heap_size_limit / 1048576)'" >>"$out/server-memory.txt" || echo unknown >>"$out/server-memory.txt"
    # The metric window covers the instance's whole allowed life, so it follows the backstop length.
    start="$(at_epoch "$(($(date +%s) - backstop_hours * 3600))" -u +%Y-%m-%dT%H:%M:%SZ)"
    end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for m in CPUUtilization:Percent BurstCapacityPercentage:Percent BurstCapacityTime:Seconds; do
      aws_ls get-instance-metric-data --instance-name "$name" --metric-name "${m%%:*}" --period 300 --start-time "$start" --end-time "$end" --unit "${m##*:}" --statistics Average \
        --query 'metricData[].[timestamp,average]' --output text | sort >"$out/aws-metric-${m%%:*}.txt"
    done
    ;;
  backstop)
    # F-900: the delete when nothing else runs it (the job killed, the session ended): a launchd job of this user that runs this
    # script's delete step at the expiry (<UTC time>, as create tags it). launchd runs a missed calendar job when the Mac wakes. The
    # script is copied into the state folder, so the job does not need this checkout. The delete step removes the job.
    name="$(cat "$name_file")"
    at="$(epoch_of "${2:?expiry, as create tags it}")"
    local_at="$(at_epoch "$at" '+%m %d %H %M')"
    read -r mo dd hh mi <<<"$local_at"
    label="io.bw.load-backstop.$name"
    agents="$HOME/Library/LaunchAgents"
    mkdir -p "$agents"
    cp "$0" "$dir/temp-server.sh"
    plist="$agents/$label.plist"
    cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$dir/temp-server.sh</string><string>delete</string></array>
  <key>EnvironmentVariables</key><dict><key>BW_LOAD_DIR</key><string>$dir</string><key>PATH</key><string>$PATH</string></dict>
  <key>StartCalendarInterval</key><dict><key>Month</key><integer>$((10#$mo))</integer><key>Day</key><integer>$((10#$dd))</integer><key>Hour</key><integer>$((10#$hh))</integer><key>Minute</key><integer>$((10#$mi))</integer></dict>
  <key>StandardOutPath</key><string>$dir/backstop.log</string><key>StandardErrorPath</key><string>$dir/backstop.log</string>
</dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "$label" >"$dir/backstop-label"
    echo "temp-server: backstop $label deletes $name at $hh:$mi on $mo/$dd (this Mac's time) unless the delete step runs first"
    ;;
  delete)
    name="$(cat "$name_file")"
    case "$name" in bw-load-p4-*) ;; *) echo "temp-server: refused: '$name' is not a load instance" >&2; exit 2 ;; esac
    aws_ls delete-instance --instance-name "$name" >"$dir/aws-delete.json" 2>&1 || grep -q 'DoesNotExist\|does not exist' "$dir/aws-delete.json" || { cat "$dir/aws-delete.json" >&2; exit 1; }
    # F-899: its own key pair goes with it (a P4-LOAD-era instance made with the default key has none: not found is fine).
    # A state folder from the first version has no key-pair-name file: its key pair was named like the instance.
    key_name="$name"
    [ -f "$key_name_file" ] && key_name="$(cat "$key_name_file")"
    aws_ls delete-key-pair --key-pair-name "$key_name" >"$dir/aws-delete-key.json" 2>&1 || grep -q 'DoesNotExist\|does not exist\|NotFound' "$dir/aws-delete-key.json" || { cat "$dir/aws-delete-key.json" >&2; exit 1; }
    sleep "${BW_LOAD_DELETE_WAIT:-15}"
    aws_ls get-instances --query 'instances[].[name,bundleId,state.name,publicIpAddress]' --output text | tee "$dir/aws-after-instances.txt"
    if grep -q "$name" "$dir/aws-after-instances.txt"; then echo "temp-server: $name is still listed" >&2; exit 1; fi
    aws_ls get-key-pairs --query 'keyPairs[].name' --output text >"$dir/aws-after-key-pairs.txt"
    if grep -qxF "$key_name" < <(tr '\t' '\n' <"$dir/aws-after-key-pairs.txt"); then echo "temp-server: key pair $key_name is still listed" >&2; exit 1; fi
    rm -f "$dir/key.pem" "$key_name_file"
    echo "temp-server: $name and its key pair deleted at $(date '+%b %-d, %-I:%M:%S %p %Z')"
    # The backstop last: when it is the backstop that runs this step, bootout ends it, and nothing is left to do.
    if [ -f "$dir/backstop-label" ]; then
      label="$(cat "$dir/backstop-label")"
      rm -f "$HOME/Library/LaunchAgents/$label.plist" "$dir/backstop-label"
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    fi
    ;;
  *) echo "usage: temp-server.sh create|backstop|install|deploy|cap|world|fresh|compose|remote|sessions|sample|unsample|legs|routing|routing-arm|burst|collect|delete" >&2; exit 2 ;;
esac
