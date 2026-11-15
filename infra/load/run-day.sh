#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P4-LOAD (P7-LOAD reuses it): 1 chunk of load-day runs on the temporary server deploy made (F-883: a chunk of 4 or 5 runs per job,
# so a stopped job loses only its own runs; the summary pools every run file of the label). After the chunk: collect into
# <state>/collect-<label>-<first run>. The instance is billable, so a stop by signal collects and deletes it (trap), and the last
# chunk ("final") deletes it on every way out. Exit code: the load script's (0: every run of the chunk finished).
# F-900: on a signal the collect is cut at BW_LOAD_STOP_COLLECT_SECONDS (60) so the delete runs inside a supervisor's grace period;
# a SIGKILL, a sleeping Mac or an ended session is the backstop's (temp-server.sh backstop, made by create).
# P7-LOAD: BW_LOAD_TASK names the output file's task; BW_LOAD_PAGES=on probes the office pages (NFR-02) with the server's certificate.
# BW_LOAD_RUNS_REQUIRED: the run count the verdict needs (20, section 5.2; P4-LOAD's is 5 by owner ruling b6666cfd).
# F-1498: BW_LOAD_ROUTING=on|off (default on) is the arm: the routing service is started or stopped (temp-server.sh routing-arm) before
# the chunk, and the load script records the arm in each run's shape, so a label holds 1 arm only.
# Hosted mode (owner answer f3d84787, hosted-day.sh): BW_LOAD_RELEASE=none (default delete) makes the stop path and "final" collect
# only, never delete: the hosted server is not a temporary copy, and hosted-day.sh's own trap restores it. BW_LOAD_SERVER_KIND names
# the server in the output file (default: temporary copy of the hosted plan). BW_LOAD_PLAN: the plan named there (default small_3_0).
#   BW_LOAD_DIR=<state folder> bash infra/load/run-day.sh <label> <first run> <runs> <run seconds> <rest seconds> <on|off> [final]
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="${BW_LOAD_DIR:?set BW_LOAD_DIR}"
label="$1" first="$2" runs="$3" seconds="$4" rest="$5" vans="$6" final="${7:-}"
server() { bash "$root/infra/load/temp-server.sh" "$@"; }
routing="${BW_LOAD_ROUTING:-on}"
case "$routing" in on|off) ;; *) echo "run-day: BW_LOAD_ROUTING is on or off, not '$routing'" >&2; exit 2 ;; esac
release="${BW_LOAD_RELEASE:-delete}"
case "$release" in delete|none) ;; *) echo "run-day: BW_LOAD_RELEASE is delete or none, not '$release'" >&2; exit 2 ;; esac
release_server() {
  [ "$release" = delete ] || { echo 'run-day: release none: the server is not deleted (hosted-day.sh restores it)'; return 0; }
  server delete || echo 'run-day: DELETE FAILED, the instance may be alive'
}
delete_now() {
  server collect "$label-$first-stopped" &
  local c=$! waited=0
  while kill -0 "$c" 2>/dev/null && [ "$waited" -lt "${BW_LOAD_STOP_COLLECT_SECONDS:-60}" ]; do sleep 1; waited=$((waited + 1)); done
  kill -0 "$c" 2>/dev/null && { kill "$c" 2>/dev/null; echo 'run-day: collect cut at its limit'; }
  wait "$c" 2>/dev/null || echo 'run-day: collect failed or cut'
  release_server
}
stopped() { echo "run-day: stopped by signal $1"; [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null; trap - EXIT; delete_now; exit "$2"; }
on_exit() { if [ "$final" = final ]; then release_server; fi; }
trap on_exit EXIT
trap 'stopped INT 130' INT
trap 'stopped TERM 143' TERM
trap 'stopped HUP 129' HUP
server routing-arm "$routing" </dev/null || { echo "run-day: routing-arm $routing failed; no run started"; exit 2; }
# In the background and waited for, so a signal runs its trap at once, not after the load script ends.
NODE_EXTRA_CA_CERTS="$dir/tls-cert.pem" node "$root/packages/testkit/src/load/cli.ts" --origin "https://$(cat "$dir/ip")" --world "$dir/world.json" \
  --out "$dir/out" --instance-plan "${BW_LOAD_PLAN:-small_3_0}" --label "$label" --first-run "$first" --runs "$runs" --run-seconds "$seconds" \
  --rest-seconds "$rest" --vans "$vans" --runs-required "${BW_LOAD_RUNS_REQUIRED:-20}" --task "${BW_LOAD_TASK:-P4-LOAD}" \
  --pages "${BW_LOAD_PAGES:-off}" --page-cert "$dir/tls-cert.pem" --routing "$routing" \
  --server-kind "${BW_LOAD_SERVER_KIND:-temporary copy of the hosted plan}" &
pid=$!
wait "$pid"
rc=$?
pid=
server collect "$label-$first" || echo 'run-day: collect failed'
exit "$rc"
