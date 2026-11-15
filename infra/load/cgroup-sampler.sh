#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# P6-ROUTING-MEMORY (OQ-42): the temporary server's cgroup sampler (infra/load/temp-server.sh sample). Every 2 s, 1 line per container
# cgroup (systemd driver: system.slice/docker-<id>.scope) and 1 for the host: "<epoch> <id|host> <memory.current> anon=.. file=.. ...",
# where the host line's figures are /proc/meminfo's MemTotal - MemAvailable (bytes), then total= and its parts (F-1498). Runs as root, appends to $1.
out="${1:?output file}"
while :; do
  t=$(date +%s)
  for d in /sys/fs/cgroup/system.slice/docker-*.scope; do
    [ -f "$d/memory.current" ] || continue
    id=${d##*/docker-}; id=${id%.scope}
    echo "$t $id $(cat "$d/memory.current") $(awk '/^(anon|file|file_mapped|shmem|active_file|inactive_file) /{printf "%s=%s ",$1,$2}' "$d/memory.stat")"
  done
  # F-1498: the host line carries /proc/meminfo's parts too (bytes), so a peak can be split into anon, shared, kernel and cache.
  awk -v t="$t" '/^MemTotal:/{m=$2} /^MemAvailable:/{a=$2}
    /^(MemFree|Buffers|Cached|SwapCached|AnonPages|Mapped|Shmem|KReclaimable|SReclaimable|SUnreclaim|KernelStack|PageTables):/{k=$1; sub(":", "", k); p=p sprintf(" %s=%.0f", k, $2*1024)}
    END{printf "%s host %d total=%d%s\n", t, (m-a)*1024, m*1024, p}' "${BW_SAMPLER_MEMINFO:-/proc/meminfo}"
  # A test reads 1 round from a meminfo file of its own (BW_SAMPLER_MEMINFO, BW_SAMPLER_ONCE); the server never sets either.
  [ -n "${BW_SAMPLER_ONCE:-}" ] && break
  sleep 2
done >>"$out"
