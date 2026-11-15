#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P6-ROUTING-MEMORY (OQ-42; SPECIFICATIONS v0.13 SD-3, SD-49; NFR-13): the routing service's memory with the full stack, on this Mac's Docker,
# shaped as the hosted plan: every service of the Compose project bw-w36mem runs inside 1 parent cgroup (/bw-w36mem) whose memory.max is
# small_3_0's memory as `free -m` reads it there (1936 MiB, docs/build/spikes/P4-LOAD.md) and whose cpu.max is its 2 vCPUs, so the stack's
# total is read from 1 kernel counter (the parent's memory.peak) and page cache competes for the plan's memory, as it would there. Each
# service keeps its compose.yaml cap; `routing` runs uncapped inside the parent (or at the cap given), so its own peak is its need, not its cap.
# The routing files sit in a Docker volume on the VM's own disk (as on the server's disk), not a bind mount from macOS, and the kernel's
# page cache is dropped before each mode starts, so every page the routing service maps is charged to its own cgroup (a page already
# cached by the copy would be charged to the copier and hide the service's real use).
#   BW_RM_DIR=<state folder outside the repo> bash infra/load/routing-memory.sh <step>
#     build              the release image (bw-w36mem:local) from this checkout
#     volume             the routing files of <maps> into the volume bw-w36mem-maps (once)
#     world              stack up (no parent), setup, infra/load/fixture.sql, the sessions (world.json) and the burst's legs (legs.json):
#                        the world's legs (routing-memory-legs.sql) must be the committed list's (BW_RM_LEGS, default
#                        .build/evidence/W36-ROUTING-LEGS/legs.json.gz, the list both small_3_0 runs were judged against; F-1327), key
#                        for key and point for point, and legs.json is that list's own bytes, so every burst carries its SHA-256
#     up <mmap|load> [routing cap] [plan|none]  the stack again inside a fresh parent cgroup, caches dropped, osrm-routed in that mode
#     sample <tag> | unsample   the cgroup sampler (every 2 s: memory.current and memory.stat of the parent and each service)
#     burst <tag>        infra/load/route-burst.mjs over legs.json on the Compose network
#     collect <tag>      memory.peak, memory.events, memory.stat of the parent and each service, container states, the files' disk use
#     day <tag> <runs> <run seconds>  per run: the burst at its start, 1 load-day run (packages/testkit/src/load/cli.ts), then collect;
#                        every Compose project on this Docker is listed at each run's start and end (projects-<tag>-<n>.txt), since
#                        another lane's stack may share the machine
#     unrouted <tag> [reads]  routing stopped: API-104 reads of 1 pair no row covers, timed beside reads of a baked pair of the same
#                        technician (infra/load/route-unrouted.mjs, F-1305), then routing started again
#     down               everything this script made: the project and its volumes, the routing volume, the sampler, the image, the cgroup
# The state folder holds world.json's session tokens and the database password: it stays outside the repo and is removed after.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="${BW_RM_DIR:?set BW_RM_DIR to a state folder outside the repo}"
mkdir -p "$dir/out"
project=bw-w36mem
image="$project:local"
cg="/sys/fs/cgroup/$project"
osrm='ghcr.io/project-osrm/osrm-backend@sha256:55dbfd47d984c2cacd64e32901b4321c86b5ec761438e69aa053dc78698a786f'
maps="${BW_RM_MAPS:-$root/.build/data/maps}"
legs_list="${BW_RM_LEGS:-$root/.build/evidence/W36-ROUTING-LEGS/legs.json.gz}"
port=18736
[ -f "$dir/db.env" ] || { umask 077; printf 'POSTGRES_PASSWORD=%s\n' "rm-$(openssl rand -hex 16)" >"$dir/db.env"; umask 022; }
[ -f "$dir/override.yaml" ] || echo 'services: {}' >"$dir/override.yaml"
export BW_IMAGE="$image" DB_ENV_FILE="$dir/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$((port + 1))" APP_ORIGIN="http://127.0.0.1:$port" \
  RESET_COOLDOWN_SECONDS=0 BW_DATA_DIR="$root/.build/data" BW_MAPS_DIR="$maps"
compose() { docker compose -p "$project" -f "$root/infra/compose.yaml" -f "$dir/override.yaml" "$@"; }
# A root shell in the Docker VM's own namespaces (cgroups and /proc/sys), from the pinned OSRM image already on the machine.
vm() { docker run --rm --privileged --cgroupns=host --pid=host -v /sys/fs/cgroup:/sys/fs/cgroup "$osrm" sh -c "$1"; }
services='proxy web worker pbs db routing'

case "${1:-}" in
  build)
    compose build web
    ;;
  volume)
    docker volume create "$project-maps" >/dev/null
    docker run --rm -v "$project-maps:/dst" -v "$maps:/src:ro" "$osrm" sh -c 'cp /src/ohio.osrm* /dst/ && du -sb /dst && ls /dst | wc -l'
    ;;
  world)
    echo 'services: {}' >"$dir/override.yaml"
    compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db
    seed="$(openssl rand -hex 24)"
    SAMPLE_PASSWORD_SEED="$seed" compose --profile setup run --rm --no-deps setup >"$dir/setup.log" 2>&1
    grep -E '"status":"setup (done|refused)"' "$dir/setup.log" | cut -c1-160
    compose exec -T db psql -q -U brightwater -d brightwater <"$root/infra/load/fixture.sql"
    umask 077
    compose exec -T db psql -q -tA -U brightwater -d brightwater <"$root/infra/load/sessions.sql" >"$dir/world.json"
    umask 022
    compose exec -T db psql -q -tA -U brightwater -d brightwater <"$root/infra/load/routing-memory-legs.sql" >"$dir/legs-world.json"
    # F-1327: the burst is judged against the committed list, so the world must make exactly that list, and the burst reads its bytes.
    gunzip -c "$legs_list" >"$dir/legs.json"
    node -e 'const fs=require("fs"); const [w,l]=process.argv.slice(1).map((f)=>JSON.parse(fs.readFileSync(f,"utf8")));
      const k=(x)=>JSON.stringify([x.branch,x.fromRef,x.toRef,x.from,x.to]); const a=new Set(w.map(k)), b=new Set(l.map(k));
      const same=a.size===w.length && b.size===l.length && a.size===b.size && [...a].every((x)=>b.has(x));
      console.log("legs world " + w.length + " list " + l.length + (same ? " same set" : " DIFFERENT")); process.exit(same ? 0 : 1)' "$dir/legs-world.json" "$dir/legs.json"
    shasum -a 256 "$dir/legs.json" | cut -d' ' -f1
    wc -c "$dir/world.json"
    ;;
  up)
    mode="${2:?mmap or load}" cap="${3:-8g}" plan="${4:-plan}"
    case "$mode" in mmap) flag='--mmap ' ;; load) flag='' ;; *) echo "routing-memory: mode is mmap or load" >&2; exit 2 ;; esac
    case "$plan" in plan) mem=$((1936 * 1048576)) ;; none) mem=max ;; *) echo "routing-memory: plan or none" >&2; exit 2 ;; esac
    compose rm -sf >/dev/null 2>&1 || true
    {
      echo 'services:'
      for s in proxy web worker pbs db migrate; do echo "  $s:"; echo "    cgroup_parent: /$project"; done
      echo '  routing:'
      echo "    cgroup_parent: /$project"
      echo "    mem_limit: $cap"
      echo '    volumes: !override'
      echo "      - $project-maps:/data/maps:ro"
      echo '    command:'
      echo '      - /bin/sh'
      echo '      - -c'
      echo "      - exec osrm-routed --algorithm mld ${flag}--ip 0.0.0.0 --port 5000 /data/maps/ohio.osrm"
      echo 'volumes:'
      echo "  $project-maps:"
      echo '    external: true'
    } >"$dir/override.yaml"
    vm "set -e; [ -d $cg ] && rmdir $cg 2>/dev/null || true; mkdir -p $cg; echo '+memory +cpu' > $cg/cgroup.subtree_control 2>/dev/null || true;
        echo $mem > $cg/memory.max; echo '200000 100000' > $cg/cpu.max; echo 0 > $cg/memory.swap.max 2>/dev/null || true; sync; echo 3 > /proc/sys/vm/drop_caches;
        echo parent memory.max \$(cat $cg/memory.max) cpu.max \$(cat $cg/cpu.max)"
    compose up -d --no-build --wait --wait-timeout 300 $services
    echo "mode=$mode cap=$cap plan=$plan up=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$dir/out/mode.txt"
    # F-1343: the ids file is per cap (c320, c1280: the tag the summarizer is given), not per mode, so a second up in the same mode keeps the first's ids.
    for s in $services; do echo "$(docker inspect -f '{{.Id}}' "$project-$s-1") $s"; done >"$dir/out/ids-c${cap%m}.txt"
    cat "$dir/out/mode.txt"
    ;;
  sample)
    tag="${2:?tag}"
    docker rm -f "$project-sampler" >/dev/null 2>&1 || true
    docker run -d --name "$project-sampler" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:ro -v "$dir/out:/out" "$osrm" sh -c "
      cd $cg; while :; do t=\$(date +%s); for d in . */; do d=\${d%/}; [ -f \$d/memory.current ] || continue;
        echo \"\$t \$d \$(cat \$d/memory.current) \$(awk '/^(anon|file|file_mapped|shmem|active_file|inactive_file) /{printf \"%s=%s \",\$1,\$2}' \$d/memory.stat)\";
      done; sleep 2; done >> /out/samples-$tag.log" >/dev/null
    echo "sampler started ($tag)"
    ;;
  unsample)
    docker rm -f "$project-sampler" >/dev/null 2>&1 || true
    ;;
  burst)
    tag="${2:?tag}"
    docker run --rm --network "${project}_default" --user node -e BURST_CONCURRENCY="${BURST_CONCURRENCY:-8}" \
      -v "$root/infra/load/route-burst.mjs:/burst/route-burst.mjs:ro" -v "$dir/legs.json:/burst/legs.json:ro" -v "$dir/out:/out" \
      --entrypoint node "$image" /burst/route-burst.mjs "/out/burst-$tag.json"
    ;;
  collect)
    tag="${2:?tag}"
    {
      echo "collected $(date -u +%Y-%m-%dT%H:%M:%SZ) $(cat "$dir/out/mode.txt")"
      vm "cd $cg; echo parent memory.peak \$(cat memory.peak) memory.max \$(cat memory.max); echo parent memory.events \$(cat memory.events | tr '\n' ' ');
          for d in */; do d=\${d%/}; echo \"\$d memory.peak \$(cat \$d/memory.peak) memory.max \$(cat \$d/memory.max)\"; echo \"\$d memory.events \$(cat \$d/memory.events | tr '\n' ' ')\";
            echo \"\$d memory.stat \$(awk '/^(anon|file|file_mapped|shmem|active_file|inactive_file) /{printf \"%s=%s \",\$1,\$2}' \$d/memory.stat)\"; done"
      for s in $services; do echo "$s state $(docker inspect -f '{{.State.Status}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} started={{.State.StartedAt}} id={{.Id}}' "$project-$s-1")"; done
      echo "routing files disk use $(docker run --rm -v "$project-maps:/m:ro" "$osrm" sh -c 'du -sb /m | cut -f1; du -sk /m | cut -f1' | tr '\n' ' ')(bytes, KiB allocated)"
    } >"$dir/out/collect-$tag.txt"
    tail -n +1 "$dir/out/collect-$tag.txt" | cut -c1-220
    ;;
  day)
    tag="${2:?tag}" runs="${3:?runs}" seconds="${4:?run seconds}"
    rc=0
    for n in $(seq 1 "$runs"); do
      # Fresh sessions before each run: a run that waits behind a slow one finds its sessions signed out by their idle limit (P4-LOAD).
      umask 077
      compose exec -T db psql -q -tA -U brightwater -d brightwater <"$root/infra/load/sessions.sql" >"$dir/world.json"
      umask 022
      { echo "start $(date -u +%Y-%m-%dT%H:%M:%SZ)"; docker compose ls -a; } >"$dir/out/projects-$tag-$n.txt"
      bash "$0" sample "$tag-$n"
      bash "$0" burst "$tag-$n" >"$dir/out/burst-$tag-$n.log" 2>&1 &
      bpid=$!
      node "$root/packages/testkit/src/load/cli.ts" --origin "http://127.0.0.1:$port" --world "$dir/world.json" --out "$dir/out/load-$tag" \
        --instance-plan small_3_0 --label "$tag" --first-run "$n" --runs 1 --run-seconds "$seconds" --rest-seconds 0 --vans on --runs-required "$runs" || rc=$?
      wait "$bpid" || rc=$?
      cat "$dir/out/burst-$tag-$n.log"
      bash "$0" unsample
      bash "$0" collect "$tag-$n" >/dev/null
      { echo "end $(date -u +%Y-%m-%dT%H:%M:%SZ)"; docker compose ls -a; } >>"$dir/out/projects-$tag-$n.txt"
      # Stop rule (manager, Nov 10, 2026; P6-ROUTING-MEMORY closing cycle): a setting whose run 1 misses the pass line (every leg routed,
      # route p95 within SD-49's 3 s, routing never killed for out of memory or restarted) has its result; its other runs would only
      # repeat it. Only a setting that works gets every run.
      if [ "$n" -eq 1 ]; then
        routed="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(b.routed < b.legs ? "unrouted" : !(b.ms?.p95 <= 3000) ? "p95over3s" : "ok")' "$dir/out/burst-$tag-1.json" 2>/dev/null || echo unrouted)"
        oom="$(docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' "$project-routing-1")"
        if [ "$routed" != ok ] || grep -q 'oom_kill [1-9]' <(grep -A0 "$(docker inspect -f '{{.Id}}' "$project-routing-1") memory.events" "$dir/out/collect-$tag-1.txt") || [ "$oom" != 'false 0' ]; then
          echo "routing-memory: $tag stopped after run 1 (burst $routed, routing oom/restarts: $oom): the result is clear"
          echo "stopped after run 1: burst $routed, routing oom/restarts $oom" >"$dir/out/stopped-$tag.txt"
          break
        fi
      fi
    done
    exit "$rc"
    ;;
  unrouted)
    tag="${2:?tag}" reads="${3:-5}"
    umask 077
    compose exec -T db psql -q -tA -U brightwater -d brightwater <"$root/infra/load/sessions.sql" >"$dir/world.json"
    read -r tech from to bfrom bto < <(compose exec -T db psql -q -tA -F ' ' -U brightwater -d brightwater <"$root/infra/load/route-unrouted.sql")
    node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const t=w.technicians.find((x)=>x.id===process.argv[2]);
      if (!t) process.exit(1); process.stdout.write(t.token)' "$dir/world.json" "$tech" >"$dir/tech-token"
    umask 022
    echo "technician $tech unrouted $from->$to baked $bfrom->$bto"
    compose stop routing
    rc=0
    node "$root/infra/load/route-unrouted.mjs" "http://127.0.0.1:$port" "$dir/tech-token" "$from" "$to" "$bfrom" "$bto" "$reads" >"$dir/out/unrouted-$tag.json" || rc=$?
    compose start routing
    node -e 'const u=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(`unrouted ${u.unroutedMs.join(" ")} ms; baked ${u.bakedMs.join(" ")} ms; limit ${u.limitMs} ms; pass ${u.pass}`)' "$dir/out/unrouted-$tag.json"
    exit "$rc"
    ;;
  down)
    docker rm -f "$project-sampler" >/dev/null 2>&1 || true
    compose --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
    docker volume rm -f "$project-maps" >/dev/null 2>&1 || true
    docker image rm -f "$image" >/dev/null 2>&1 || true
    vm "rmdir $cg 2>/dev/null || true; [ -d $cg ] && echo 'cgroup still there' || echo 'cgroup removed'"
    docker ps -a --filter "name=$project" --format '{{.Names}}'
    docker volume ls --filter "name=$project" --format '{{.Name}}'
    ;;
  *) echo "usage: routing-memory.sh build|volume|world|up|sample|unsample|burst|collect|day|unrouted|down" >&2; exit 2 ;;
esac
