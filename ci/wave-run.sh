#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The per-wave full CI run (BUILD_PLAN section 7, Full CI row; F-26, F-37). LOCAL only: the build manager
# starts it by hand. No GitHub workflow, no workflow_dispatch (owner rulings 7b7a6a90, f3b1a4af).
#
#   bash ci/wave-run.sh [<sha>]        default: HEAD. Full run of exactly that sha, clean export.
#   bash ci/wave-run.sh --setup-only [<sha>]   F-409: stop after setup (image, engine, install, stack images) and tear down
#   BW_CI_ARGS='--serial --gates a,b' bash ci/wave-run.sh [<sha>]   a NARROW run of those gates on the same rig (P3-CI-CADENCE: probes and
#                                      timing); its verdict is judged as mode gates (F-579) and prints NARROW GATES RUN GREEN or RED, never WAVE RUN; the
#                                      container's verdict is kept under .build/evidence/NARROW-RUNS (F-586). BW_CI_ARGS=--nightly is judged as nightly
#   bash ci/wave-run.sh --print-cap    print the whole-run cap in seconds
#   bash ci/wave-run.sh --copy-gate-logs <container> <dir>   F-578: copy a run container's gate logs out (the cap branch does this before it removes the container)
#   bash ci/wave-run.sh --check-verdict <file> <sha> [all|nightly|gates]   judge a copied ci-verdict.json (no docker)
#   BW_CI_ARGS=--nightly BW_CI_CHANGE=<label> bash ci/wave-run.sh [<sha>]   F-691: a nightly run appends 1 row (scope nightly) to
#                                      .build/ci-time.jsonl on this host; <label> (a finding or task id) is the row's "change" when the run tests a fix
#   bash ci/wave-run.sh --time-check <verdict> <all|nightly|gates> <history>   the row step alone (no docker; for tests and dry runs)
#   [BW_CI_ARGS=--nightly] bash ci/wave-run.sh --mac-half [<sha>]   F-1201: only the mac half (step 5) of that run's mode, on this Mac;
#                                      nothing starts on Spectre. Prints MAC HALF GREEN or RED; exit 0 or 1 (2 usage)
#
# What it does:
#   1. Exports the sha into a clean clone (never a working tree) and ships it into a container on Spectre
#      (docker --context spectre; bind mounts would resolve on Spectre's disk, so the tree is piped in).
#   2. Inside the prebuilt CI image (F-409, owner ruling ffd9f9ff): apt pins, pnpm, the pnpm store and both browsers
#      are baked into an image on Spectre keyed by a content hash (ci/wave-image-key.ts: base image digest, apt list,
#      pnpm and Playwright versions, pnpm-lock.yaml, workspace package.json files, .node-version, ci/wave-image/Dockerfile).
#      A key with no image rebuilds it; every run prints "ci-image: CACHE HIT" or "REBUILD" with the key; the newest
#      2 keys are kept. The run still does pnpm install --frozen-lockfile --offline (lockfile drift is red), checks the
#      browsers are present for the pinned Playwright (a missing one is red, never downloaded), then ci.sh --all.
#      Browsers live only in the Spectre container, never on this Mac. BW_PW_ENGINES stays unset.
#   3. Copies ci-verdict.json out and checks its sha. Missing verdict or wrong sha is RED.
#   4. Whole-run cap: install allowance + the 2 h full-CI budget + the largest per-gate cap. When it fires
#      the container and the run's engine are stopped and removed, not only the client.
#   5. The mac half (F-1201; owner ruling Nov 4, 2026 items 1 and 3): the gates with runner mac in ci/gates.json that this run's mode
#      holds (ci/mac-half.ts; the native suite and native-no-demo, which need Xcode and the simulator) run on this Mac's checkout, which
#      must be at the sha with its tracked code unchanged; each under its own time limit, its log in <out>/mac. A red, a timeout or a
#      checkout at another sha makes the run red. ci.sh never selects a mac gate in its sets, so the push run is unchanged.
#      F-1430: nor in the container's --gates run (BW_WAVE_CONTAINER=1): a narrow run that names a mac gate runs it in the mac half only, and its
#      verdict copy (the one kept under NARROW-RUNS) takes that gate's row from the mac half, as a nightly verdict does.
#      Ruling item 3 (Nov 10, 2026): the mac half starts with the run, beside the Spectre half, not after it; the verdict still needs both. Commits
#      on main are held only from the line 'MAC HALF STARTED' to the line 'MAC HALF ENDED'. The run output carries each mac gate's measured time.
#   6. Prints ci-time-check.py output.
# Unique container name per run, no published ports (the Spectre push runner shares that machine).
#
# The run's own Docker engine (F-126). A gate that needs the Compose stack (infra/compose.yaml at its default
# settings: real PostgreSQL 18, real handlers, pbs running) starts its own Compose project, exactly as on the Mac.
# So each run gets a throwaway Docker-in-Docker engine (the linux runner's pinned engine image, SPECIFICATIONS
# SD-38), never Docker Desktop's socket:
#   - The engine and the CI container share 1 per-run volume at /work, so Compose bind mounts and build
#     contexts resolve on the engine at the same path as in the container (the tree is still piped in).
#   - The CI container joins the engine's network namespace, so a port a gate publishes on 127.0.0.1 is the
#     engine's loopback: reachable by the gate, never published on Spectre.
#   - The engine listens on a unix socket in a per-run volume only (no TCP); the container's docker CLI and
#     Compose plugin are copied from the engine image, so client and engine are the same release.
#   - Every container and volume of a run carries the label bw.wave.run=<run name> and is removed on every exit
#     path (green, red, cap fired, interrupted). Both containers also expire by themselves past the cap.
#
# Exit codes: 0 green; 1 red (failed gate, missing verdict, sha mismatch, cap fired, engine down); 2 usage;
#             10 WAIT: Spectre unreachable (a wait, never green, never a red verdict).
set -uo pipefail

SELF_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE='node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c'
# F-126: the run's own engine, the same pin as the linux runner's engine (docs/build/P1-REPO-pins.md, 2026-10-16).
ENGINE_IMAGE='docker:29.9.1-dind@sha256:3e5756e2b6dad6a5f1f5deacf0a19f9eaa2581b76ae092b2d4a118162e1d4d4e'
ENGINE_SOCK='unix:///var/run/dind/docker.sock'
ENGINE_READY_S=90
# F-106: apt pins, each first published at least 14 days before 2026-11-01 (snapshot.debian.org first_seen, UTC):
# git 2025-10-19, ca-certificates 2025-06-13 (the 20250419~deb12u2 security upload of 2026-10-20 is too young),
# python3 2023-02-15, python3.11 2026-10-07, curl 2026-06-30 (curl: the stack gates' health probe), systemd 2026-05-03 (F-489: systemd-analyze, for the F-389 spring-forward timer test). A pin that
# leaves the Debian archive makes apt fail loudly (red), never install something else.
APT_PINS='git=1:2.39.5-0+deb12u3 ca-certificates=20230311+deb12u1 python3=3.11.2-1+b1 python3.11=3.11.2-6+deb12u9 curl=7.88.1-10+deb12u15 systemd=252.39-1~deb12u2'
PNPM_VERSION='12.14.0'
CTX="${WAVE_DOCKER_CONTEXT:-spectre}"
INSTALL_ALLOWANCE_S=1200   # apt, pnpm install, browser download (2 times the measured allowance), inside the whole-run cap
# F-460: F-409 moved the install into the image build, which runs BEFORE the whole-run timer starts, so the whole-run cap
# does not cover it. Each pre-run step has its own cap through bounded(): RED naming the step, process tree killed.
CI_BUILD_CAP_S=1500        # cold image build: 2 times the slower measured cold build (714 s)
JUNIT_COPY_CAP_S=120       # F-997 b: the junit folder copied out after the container finished
SPECTRE_CALL_CAP_S=60      # image inspect, image list, image count: each is a local metadata read on Spectre
SPECTRE_RMI_CAP_S=120      # rmi of a ~5 GB image removes layers; slower than a read, still seconds
CI_IMAGE_REPO='bw-ci-image'
CI_IMAGE_KEEP=2            # F-409: newest image keys kept on Spectre
FULL_CI_BUDGET_S=7200      # F-973: 2 h, owner answer 5b1b574a (Nov 8); was 2700 (the BUILD_PLAN header's 45 min, whose edit is in the Phase 5 doc batch)
EXIT_WAIT=10

largest_gate_cap_s() {
  node -e '
    const g = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    // F-1201: a runner mac gate never runs in the container (the mac half runs it with its own limit), so it does not size the cap.
    console.log(Math.max(g.defaultTimeoutS, ...g.gates.filter((x) => (x.runner ?? "linux") !== "mac").map((x) => x.timeoutS ?? 0)));
  ' "$SELF_ROOT/ci/gates.json"
}

cap_s() {
  local largest
  largest="$(largest_gate_cap_s)" || return 1
  echo $((INSTALL_ALLOWANCE_S + FULL_CI_BUDGET_S + largest + 60))
}

# check_verdict <file> <sha> [mode]: 0 only when the file exists, parses, carries the requested sha, result pass,
# the expected mode (all by default; nightly for a --nightly run, with both engines; gates for a --gates run, sha and result
# only: F-579) and, for all and nightly, the Playwright engines (F-47). A merge-set verdict (pnpm run ci, mode merge) for the same sha never ran the browser gates (F-42).
check_verdict() {
  local file="$1" want="$2" expect="${3:-all}"
  if [ ! -f "$file" ]; then
    echo "RED: no ci-verdict.json was produced ($file is missing)" >&2
    return 1
  fi
  node -e '
    const [file, want, expect] = process.argv.slice(1);
    let v;
    try { v = JSON.parse(require("fs").readFileSync(file, "utf8")); }
    catch (e) { console.error("RED: ci-verdict.json is not valid JSON: " + e.message); process.exit(1); }
    if (v.sha !== want) { console.error("RED: verdict sha " + v.sha + " is not the requested sha " + want); process.exit(1); }
    if (v.result !== "pass") { console.error("RED: verdict result is " + v.result); process.exit(1); }
    if (v.mode !== expect) { console.error("RED: verdict mode is " + v.mode + ", not " + expect + (expect === "all" ? " (a per-wave run is ci.sh --all)" : "")); process.exit(1); }
    if (expect === "gates") { console.log("verdict: result pass, sha " + v.sha + ", " + v.totalDurationS + "s, mode gates (a narrow run: no engine rule)"); process.exit(0); }
    const eng = v.engines;
    if (!eng || !Array.isArray(eng.run) || !Array.isArray(eng.dropped)) { console.error("RED: verdict names no engine list (engines.run); a run before F-47 or a copied verdict"); process.exit(1); }
    // P3-CI-CADENCE: the push set (scope push) runs its browser gates on Chromium only; WebKit belongs to the nightly set. A push verdict
    // therefore needs chromium, may drop webkit with a stated reason, and must not claim webkit ran when no gate ran it. Any
    // other verdict (no scope, or a nightly one) still needs both engines.
    const push = v.scope === "push";
    const okEngines = push ? eng.run.includes("chromium") && eng.dropped.every((n) => n === "webkit") && (eng.dropped.length === 0 || (typeof eng.why === "string" && eng.why !== "")) : eng.dropped.length === 0 && eng.run.includes("chromium") && eng.run.includes("webkit");
    if (!okEngines) { console.error("RED: verdict ran engines " + eng.run.join(",") + " and dropped " + eng.dropped.join(",") + (eng.why ? " (" + eng.why + ")" : "") + (push ? "; a push verdict needs chromium, and a dropped webkit needs its reason" : "; both chromium and webkit are required")); process.exit(1); }
    console.log("verdict: result pass, sha " + v.sha + ", " + v.totalDurationS + "s, mode " + v.mode);
  ' "$file" "$want" "$expect"
}

# time_check <verdict> <mode> <history>: F-691. The host-side time row. The container's own ci-time-check call writes to
# a history inside the container, which dies with it, so the row of record is appended here from the copied verdict.
#   nightly: --scope nightly, appended to <history> (the committed .build/ci-time.jsonl), judged against the plan's nightly
#            budget (2 h); BW_CI_CHANGE=<label> names the fix the run tests and lands in the row's "change".
#   all:     --scope full --no-append (the wave gate is the GitHub push run, not this script), compared with the committed history.
#   gates:   no row (F-587, F-579: a narrow run has no budget row and must not become a growth baseline).
# A smoke alarm only: its exit status is printed and never changes the run's result. Uses the vendored copy (the plugin tool
# on PATH takes only --scope full|merge).
time_check() {
  local verdict="$1" expect="$2" history="$3"
  echo
  echo "=== ci-time-check.py"
  if [ ! -f "$SELF_ROOT/ci/vendor/jl-dev/ci-time-check.py" ]; then
    # F-1571: the vendored tool is the owner's private copy; the public repo leaves ci/vendor out.
    echo "ci-time-check.py skipped: ci/vendor is not in this tree"
  elif [ "$expect" = gates ]; then
    echo "no time budget row for a gates run; ci-time-check.py skipped"
  elif [ ! -f "$verdict" ]; then
    echo "no verdict to check"
  elif [ "$expect" = nightly ]; then
    (cd "$SELF_ROOT" && python3 ci/vendor/jl-dev/ci-time-check.py --scope nightly --verdict "$verdict" --history "$history" --plan docs/BUILD_PLAN.md --label nightly --change "${BW_CI_CHANGE:-}") || echo "ci-time-check.py exit $? (advisory)"
  else
    # F-577: a verdict that names scope push is judged against the push budget; any other all-mode verdict keeps the full budget.
    local scope=full
    grep -q '"scope" *: *"push"' "$verdict" && scope=push
    (cd "$SELF_ROOT" && python3 ci/vendor/jl-dev/ci-time-check.py --scope "$scope" --verdict "$verdict" --history "$history" --plan docs/BUILD_PLAN.md --label wave --no-append) || echo "ci-time-check.py exit $? (advisory)"
  fi
  return 0
}

# gates_asked: the ids of a --gates run's BW_CI_ARGS (--gates a,b or --gates=a,b), comma-joined.
gates_asked() {
  local prev="" a
  for a in ${BW_CI_ARGS:-}; do
    case "$a" in
      --gates=*) echo "${a#--gates=}"; return 0 ;;
    esac
    [ "$prev" = --gates ] && { echo "$a"; return 0; }
    prev="$a"
  done
  echo ""
}

# run_mode: the mode this run's verdict must carry, from BW_CI_ARGS (F-579): nightly, gates, else all.
run_mode() {
  case " ${BW_CI_ARGS:-} " in
    *" --all "*) echo all ;;
    *" --nightly "*) echo nightly ;;
    *" --checkpoint "*) echo nightly ;; # F-1410: the nightly set plus the checkpoint gates, judged and recorded as nightly
    *" --gates"*) echo gates ;;
    *) echo all ;;
  esac
}

# mac_half <mode> <sha> <run: 1 runs, 0 lists>: F-1201. The runner mac gates of a <mode> run (ci/mac-half.ts), run one after another on
# this Mac's checkout ($SELF_ROOT), which must be at <sha> with its tracked code (outside .build/ and docs/BUILD_REPORTS/) the same as
# <sha>: the native suite builds the app from the working tree, so a checkout at another sha would test other code. Each gate runs under
# bounded() with its timeoutS, stdin closed, its log in $OUT/mac/<id>.log. 0 when every planned gate passed (or none is planned), else 1.
mac_half() {
  local mode="$1" sha="$2" run="$3" plan kind id lim cmd head rc=0 i r t0 log
  # F-1410: a --checkpoint run is judged as nightly; its mac half takes the checkpoint set
  [ "$mode" = nightly ] && case " ${BW_CI_ARGS:-} " in *" --checkpoint "*) mode=checkpoint ;; esac
  local ids=() lims=() cmds=()
  echo
  echo "=== mac half (this Mac)"
  plan="$(CI_ROOT="$SELF_ROOT" node "$SELF_ROOT/ci/mac-half.ts" "$mode" --gates "$(gates_asked)")" \
    || { echo "RED: mac half: ci/mac-half.ts could not read the gate map" >&2; return 1; }
  while IFS=$'\t' read -r kind id lim cmd; do
    case "$kind" in
      RUN) ids+=("$id"); lims+=("$lim"); cmds+=("$cmd") ;;
      INACTIVE) echo "INACTIVE $id (mac): activates when $lim merges (marker ci/active/$id)" ;;
      MISSING) echo "RED: mac gate $id is active but $lim is missing" >&2; rc=1 ;;
    esac
  done <<<"$plan"
  if [ "${#ids[@]}" -eq 0 ]; then
    echo "mac gate set: EMPTY for a $mode run (no active gate with runner mac in it)"
    return "$rc"
  fi
  echo "mac gate set ($mode): ${ids[*]}"
  if [ "$run" != 1 ]; then
    echo "mac gates listed, not run: the run did not reach its mac half. Not a pass."
    return "$rc"
  fi
  head="$(git -C "$SELF_ROOT" rev-parse HEAD 2>/dev/null)"
  if [ "$head" != "$sha" ]; then
    echo "RED: mac half: this Mac's checkout is at ${head:-no commit}, not $sha; the mac gates run on the checkout, so none ran" >&2
    return 1
  fi
  # F-1210: the same 4 record paths as the GitHub push run's paths-ignore (agents edit tracked memory files between record commits).
  if ! git -C "$SELF_ROOT" diff --quiet "$sha" -- . ':(exclude).build' ':(exclude)docs/BUILD_REPORTS' ':(exclude).claude/agent-memory' ':(exclude).askq'; then
    echo "RED: mac half: this Mac's checkout has tracked changes against $sha outside .build/ (git diff $sha); none ran" >&2
    return 1
  fi
  mkdir -p "$OUT/mac"
  local mac_t0; mac_t0=$(date +%s)
  : >"$OUT/mac/gate-times.tsv"
  for i in "${!ids[@]}"; do
    id="${ids[$i]}"; lim="${lims[$i]}"; cmd="${cmds[$i]}"; log="$OUT/mac/$id.log"
    echo "--- mac gate $id (limit ${lim}s): $cmd"
    t0=$(date +%s)
    BOUNDED_GRACE_S=120 bounded "$lim" "mac gate $id" logged "$log" bash -c "cd \"\$1\" && $cmd" mac-gate "$SELF_ROOT" </dev/null
    r=$?
    # F-1372: each mac gate's own seconds and status, read by add_mac_time into the verdict copy.
    printf '%s\t%s\t%s\n' "$id" "$(( $(date +%s) - t0 ))" "$([ "$r" = 0 ] && echo pass || echo fail)" >>"$OUT/mac/gate-times.tsv"
    if [ "$r" = 0 ]; then
      echo "mac gate $id: PASS ($(( $(date +%s) - t0 ))s, log $log)"
    else
      [ "$r" = 124 ] && echo "RED: mac gate $id timed out after ${lim}s and was killed" >&2
      echo "mac gate $id: FAIL exit $r ($(( $(date +%s) - t0 ))s, log $log)"
      tail -5 "$log" | sed 's/^/    /'
      rc=1
    fi
  done
  MAC_HALF_S=$(( $(date +%s) - mac_t0 ))
  echo "Owner ruling 7af1c96c (Nov 3): the simulator under xcodebuild is headless; no browser runs on this Mac."
  return "$rc"
}

# Ruling item 3 (Nov 10, 2026): the mac half starts with the run, beside the Spectre half, and the verdict needs both.
# mac_half_start <mode> <sha>: runs mac_half in the background, its output in $OUT/mac-half.log, its result in $OUT/mac-half.rc
# ("<rc> <seconds>"), then touches $OUT/mac-half.ended. Sets MAC_PID. The hold on commits to main lasts from this line to the ended line:
# the mac gates build from this Mac's checkout, which must stay at <sha> while they run.
MAC_PID=""
MAC_START_EPOCH=0
MAC_OVERRUN_S=0
CONTAINER_END_EPOCH=0
mac_half_start() {
  local mode="$1" sha="$2"
  rm -f "$OUT/mac-half.rc" "$OUT/mac-half.ended" "$OUT/mac-half.stopping"
  MAC_START_EPOCH=$(date +%s)
  (
    MAC_HALF_S=0
    mac_half "$mode" "$sha" 1 >"$OUT/mac-half.log" 2>&1
    mac_rc=$?
    echo "$mac_rc $MAC_HALF_S" >"$OUT/mac-half.rc"
    : >"$OUT/mac-half.ended"
    # F-1374: the hold-lifted line is printed here, at the moment the mac half ends, whatever the Spectre half or the host-side setup is doing.
    # F-1819: kill_tree stops the children before the subshell, so a stop in flight can reach here first; the marker says it was a stop, not an end.
    [ -e "$OUT/mac-half.stopping" ] || echo "MAC HALF ENDED (rc $mac_rc, ${MAC_HALF_S}s): commits on main may resume; the run's verdict still waits for the Spectre half"
  ) &
  MAC_PID=$!
  echo "MAC HALF STARTED (pid $MAC_PID, beside the Spectre half): hold commits on main until the line 'MAC HALF ENDED'; log $OUT/mac-half.log"
}
# mac_half_finish: waits for the mac half, prints its log and the measured time of each mac gate (native-suite among them), sets MAC_HALF_S,
# returns the mac half's own rc (1 when it left no result, or never started: F-1373). Sets MAC_OVERRUN_S: the seconds the mac half ran past the
# Spectre half's end (F-1375), the only mac seconds that lengthen the run.
mac_half_finish() {
  local rc=1
  MAC_HALF_S=0
  MAC_OVERRUN_S=0
  if [ -z "$MAC_PID" ]; then
    echo "RED: the mac half never started" >&2
    return 1
  fi
  wait "$MAC_PID" 2>/dev/null
  MAC_PID=""
  [ -f "$OUT/mac-half.log" ] && cat "$OUT/mac-half.log"
  if [ -f "$OUT/mac-half.rc" ]; then
    read -r rc MAC_HALF_S <"$OUT/mac-half.rc"
  else
    echo "RED: the mac half left no result" >&2
  fi
  MAC_OVERRUN_S=$(( MAC_START_EPOCH + MAC_HALF_S - CONTAINER_END_EPOCH ))
  [ "$MAC_OVERRUN_S" -gt 0 ] || MAC_OVERRUN_S=0
  echo "mac half measured: ${MAC_HALF_S}s wall, ${MAC_OVERRUN_S}s of it past the Spectre half's end; per gate: $(grep -oE '^mac gate [A-Za-z0-9-]+: (PASS|FAIL exit [0-9]+) \([0-9]+s' "$OUT/mac-half.log" 2>/dev/null | sed -E 's/^mac gate ([A-Za-z0-9-]+): .*\(([0-9]+)s$/\1=\2s/' | tr '\n' ' ')"
  return "$rc"
}
# mac_half_stop: the run ends early: stop the mac half's tree (TERM, so run.sh's EXIT trap tears its stack down) and wait for it.
mac_half_stop() {
  [ -n "$MAC_PID" ] || return 0
  local was_running=0
  kill -0 "$MAC_PID" 2>/dev/null && { was_running=1; : >"$OUT/mac-half.stopping"; echo "stopping the mac half (pid $MAC_PID)" >&2; kill_tree "$MAC_PID" TERM; }
  wait "$MAC_PID" 2>/dev/null
  MAC_PID=""
  # F-1374: a stopped mac half prints no ENDED line; this is its hold-lifted line.
  [ "$was_running" = 0 ] || echo "MAC HALF STOPPED: commits on main may resume"
}
# await_container <pid> <cap s> <on-cap command>: the Spectre half's wait loop. Sets CAP_FIRED, CONTAINER_RC and CONTAINER_END_EPOCH.
await_container() {
  local pid="$1" cap="$2" on_cap="$3" t0
  t0=$(date +%s)
  CAP_FIRED=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ $(( $(date +%s) - t0 )) -ge "$cap" ]; then
      CAP_FIRED=1
      echo "RED: whole-run cap ${cap}s fired; stopping and removing container $NAME and engine $ENGINE" >&2
      eval "$on_cap"
      break
    fi
    sleep "${BW_WAVE_POLL_S:-5}"
  done
  wait "$pid" 2>/dev/null
  CONTAINER_RC=$?
  CONTAINER_END_EPOCH=$(date +%s)
}

# add_mac_time <verdict> <seconds> [pass|fail] [<gate-times.tsv>] [<overrun seconds>]: F-1210; the gate's status is the mac half's own result (F-1242), pass when not given.
# The mac half runs beside the Spectre half (ruling item 3) and its time is in no container verdict. Adds it to the host's copy of the verdict as a gate "mac-half"
# (its own seconds). F-1375: totalDurationS gains only <overrun seconds> (0 when not given), the seconds the mac half ran past the container's end,
# so it reads the run's length, not the sum of both halves.
# F-1372: with a gate-times file (id, seconds, status per line; mac_half writes it) each mac gate also gets its own row by gate id (native-suite,
# native-no-demo), ahead of the mac-half row. F-1387: a row of the same id already in the verdict (the container's skipped 0 s row) is replaced in place.
# The copy is $OUT's; the container's own verdict is untouched. A no-op when the verdict is missing or <seconds> is not a number, or is 0 with a pass.
# F-1249: a fail also sets the copy's top-level result to fail (ci-time-check.py takes the nightly row's result from it, and a red row is no growth
# baseline), and is written even at 0 s (a mac half that went red before any gate ran, F-1210's early returns, still gets its mac-half gate).
add_mac_time() {
  local file="$1" secs="${2:-0}" status="${3:-pass}" times="${4:-}" overrun="${5:-0}"
  [ -f "$file" ] && [ "$secs" -ge 0 ] 2>/dev/null || return 0
  [ "$secs" -gt 0 ] || [ "$status" = fail ] || return 0
  python3 -c '
import json, sys
f, s, st, tf, ov = sys.argv[1], float(sys.argv[2]), sys.argv[3], sys.argv[4], float(sys.argv[5])
v = json.load(open(f))
def put(row):
    gates = v.setdefault("gates", [])
    for i, g in enumerate(gates):
        if g.get("id") == row["id"]:
            gates[i] = row
            return
    gates.append(row)
if tf:
    try:
        for line in open(tf):
            p = line.rstrip("\n").split("\t")
            if len(p) == 3 and p[0] and p[0] != "mac-half":
                put({"id": p[0], "durationS": float(p[1]), "status": p[2]})
    except OSError:
        pass
put({"id": "mac-half", "durationS": s, "status": st})
if st == "fail":
    v["result"] = "fail"
    if "verdict" in v:
        v["verdict"] = "fail"
v["totalDurationS"] = float(v.get("totalDurationS") or 0) + max(0.0, ov)
json.dump(v, open(f, "w"), indent=2)
' "$file" "$secs" "$status" "$times" "$overrun" || echo "WARN: add_mac_time could not update $file" >&2
}

# install_flat <file> <sha> <dest>: F-102. Install the copied flat shape-2 verdict at <dest> only when it exists,
# parses and its sha equals <sha>; atomic (temp file in dest's dir, then mv). Otherwise WARN, leave dest untouched,
# return 1. Advisory only: the caller never lets this change the wave result.
install_flat() {
  local file="$1" want="$2" dest="$3" got tmp
  if [ ! -f "$file" ]; then echo "WARN: no flat ci-verdict.json was copied out ($file is missing); $dest not updated" >&2; return 1; fi
  got="$(node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sha)); } catch (e) {}' "$file")"
  if [ "$got" != "$want" ]; then echo "WARN: flat ci-verdict.json sha '$got' is not the wave sha $want; $dest not updated" >&2; return 1; fi
  mkdir -p "$(dirname "$dest")"
  tmp="$dest.tmp.$$"
  if cp "$file" "$tmp" && mv -f "$tmp" "$dest"; then echo "flat verdict installed: $dest"; return 0; fi
  rm -f "$tmp"; echo "WARN: could not install the flat verdict at $dest" >&2; return 1
}

# F-578: the gates' held output (/work/.build/ci/gate-logs, F-466) copied out of a container before it is removed. The cap
# branch removes the container with docker rm -f (SIGKILL), so the runner's own SIGTERM print never runs and the folder is the
# only evidence of the gate that hung. Best effort: a failed copy is a warning, never a different exit.
copy_gate_logs() {
  local container="$1" dest="$2"
  mkdir -p "$dest"
  if docker --context "$CTX" cp "$container:/work/.build/ci/gate-logs/." "$dest" >/dev/null 2>&1; then
    echo "gate logs copied out: $dest"; return 0
  fi
  echo "WARN: could not copy /work/.build/ci/gate-logs out of $container" >&2; return 1
}

# F-974: the per-test times. The container's .build/junit (one folder per gate, written by the vitest junit reporter) is copied out
# and recorded on the host by ci/test-times.sh (test-cost.py is a host tool; its history is .build/test-history.jsonl). Best effort:
# a failed copy or record is a warning, never a different exit.
record_test_times() {
  local container="$1" dest="$2" sha="$3"
  rm -rf "$dest"; mkdir -p "$dest"
  # F-997 b: capped like the other pre-run steps (a small folder of xml files; the cap is not a measured Spectre copy time).
  if bounded "$JUNIT_COPY_CAP_S" "per-test times copy" quiet docker --context "$CTX" cp "$container:/work/.build/junit/." "$dest" >/dev/null; then
    bash "$SELF_ROOT/ci/test-times.sh" "$dest" "$sha" "$SELF_ROOT/.build/test-history.jsonl" || echo "WARN: per-test times were not all recorded" >&2
    return 0
  fi
  echo "WARN: could not copy /work/.build/junit out of $container; no per-test times recorded" >&2; return 1
}

# F-1165, F-501: core_limit_ok reads a /proc/<pid>/limits text on stdin; 0 only when the core file limit is exactly 1 byte, soft
# and hard. Spectre's kernel pipes every core to Windows (core_pattern |/wsl-capture-crash) and ignores RLIMIT_CORE for a pipe
# unless it is exactly 1, so with Docker's default (soft 0) each WebKit web process crash wrote a 6 GB dump to Spectre's disk for
# 25 to 30 s: 4 in 4 minutes of nightly 40f8433c, while look-values-comparator-nightly (15 cases red on time, none on a value) and
# G-CI2 (killed at 300 s) ran. With 1 the kernel drops the core: the process ends at once ("Page crashed"), nothing is written.
core_limit_ok() { awk '/^Max core file size/ { n++; ok = ($5 == "1" && $6 == "1") } END { exit !(n == 1 && ok) }'; }

HALVES=0
SETUP_ONLY=0
if [ "${1:-}" = "--setup-only" ]; then SETUP_ONLY=1; shift; fi
MAC_ONLY=0
if [ "${1:-}" = "--mac-half" ]; then MAC_ONLY=1; shift; fi

case "${1:-}" in
  --install-flat)
    [ "$#" -eq 4 ] || { echo "usage: wave-run.sh --install-flat <file> <sha> <dest>" >&2; exit 2; }
    install_flat "$2" "$3" "$4"; exit $? ;;
  --print-cap) cap_s; exit $? ;;
  --copy-gate-logs)
    [ "$#" -eq 3 ] || { echo "usage: wave-run.sh --copy-gate-logs <container> <dest dir>" >&2; exit 2; }
    copy_gate_logs "$2" "$3"; exit $? ;;
  --check-verdict)
    [ "$#" -ge 3 ] && [ "$#" -le 4 ] || { echo "usage: wave-run.sh --check-verdict <file> <sha> [all|nightly|gates]" >&2; exit 2; }
    check_verdict "$2" "$3" "${4:-all}"; exit $? ;;
  --add-mac-time)
    [ "$#" -ge 3 ] && [ "$#" -le 6 ] || { echo "usage: wave-run.sh --add-mac-time <verdict> <seconds> [pass|fail] [<gate-times.tsv>] [<overrun seconds>]" >&2; exit 2; }
    add_mac_time "$2" "$3" "${4:-pass}" "${5:-}" "${6:-0}"; exit $? ;;
  --time-check)
    [ "$#" -eq 4 ] || { echo "usage: wave-run.sh --time-check <verdict> <all|nightly|gates> <history>" >&2; exit 2; }
    time_check "$2" "$3" "$4"; exit $? ;;
  --core-limit-check) core_limit_ok; exit $? ;;
  --halves-selftest)
    # Test hook (ruling item 3): the real mac half and the real wait loop against a stand-in container half (see below the MAC_ONLY block).
    [ "$#" -eq 3 ] || { echo "usage: wave-run.sh --halves-selftest <container secs> <container rc>" >&2; exit 2; }
    HALVES=1; HS_SECS="$2"; HS_RC="$3"; shift 3 ;;
  -h|--help) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; exit 0 ;;
esac

REQ="${1:-HEAD}"
SHA="$(git -C "$SELF_ROOT" rev-parse --verify --quiet "$REQ^{commit}")" || { echo "wave-run: not a commit: $REQ" >&2; exit 2; }
CAP="$(cap_s)" || { echo "wave-run: cannot read ci/gates.json" >&2; exit 2; }
NAME="bw-wave-${SHA:0:8}-$$-$(date +%s)"
ENGINE="$NAME-engine"
VOLS=("$NAME-work" "$NAME-sock" "$NAME-engine-storage")
RUN_LABEL="bw.wave.run=$NAME"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bw-wave.XXXXXX")"
OUT="${WAVE_OUT_DIR:-$WORK/out}"
mkdir -p "$OUT"
STARTED=0
EXEC_PID=""

# Remove the run's containers: the CI container first (it lives in the engine's network namespace), then the engine.
# Removing the engine also ends every Compose project a gate started (and any a killed gate left behind).
remove_run_containers() {
  docker --context "$CTX" rm -f -v "$NAME" >/dev/null 2>&1
  docker --context "$CTX" rm -f -v "$ENGINE" >/dev/null 2>&1
}

# F-460: bounded <secs> <step name> <command...>. Runs the command in the background and polls (macOS has no GNU timeout by
# default; this is the same background-watchdog shape as the whole-run cap below). On expiry it kills the command's whole
# process tree (children first, so no docker client or ssh child outlives the wrapper), says which step timed out, and
# returns 124. Callers treat 124 as RED. Otherwise it returns the command's own status.
kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c" "${2:-TERM}"; done
  kill -"${2:-TERM}" "$1" 2>/dev/null
}
# tree_pids <pid>: the pid and all its descendants. any_alive <pid...>: 0 when one of them still runs.
tree_pids() {
  local c
  echo "$1"
  for c in $(pgrep -P "$1" 2>/dev/null); do tree_pids "$c"; done
}
# F-1250: a zombie is dead. Where PID 1 does not reap orphans (the CI job container runs a bare init), a killed process whose parent
# is gone stays a zombie, kill -0 still succeeds on it, and the grace below would run to its full length for nothing.
any_alive() {
  local p s
  for p in "$@"; do
    kill -0 "$p" 2>/dev/null || continue
    s="$(ps -o stat= -p "$p" 2>/dev/null)"
    case "${s// /}" in Z*) continue ;; esac
    return 0
  done
  return 1
}
# quiet <command...>: the command's own stderr is dropped, so a call site never redirects bounded()'s RED line away (F-480).
quiet() { "$@" 2>/dev/null; }
# logged <file> <command...>: the command's stdout and stderr go to <file>; bounded()'s own RED line stays on the console (F-480, F-1215).
logged() { local f=$1; shift; "$@" >"$f" 2>&1; }
bounded() {
  local secs=$1 step=$2 pid t0 g p all
  shift 2
  "$@" &
  pid=$!
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    if [ $(( $(date +%s) - t0 )) -ge "$secs" ]; then
      # F-1203: the grace between TERM and KILL is BOUNDED_GRACE_S (default 2 s). The mac half sets it long enough for run.sh's EXIT
      # trap (compose down -v) to finish; it ends as soon as the command has exited, so a command that stops at TERM waits no longer.
      # The tree is listed first: a child that dies at TERM (bash -c) would otherwise hide its own child, run.sh, which is still cleaning up.
      all="$(tree_pids "$pid")"
      kill_tree "$pid" TERM
      g=0
      while [ "$g" -lt $(( ${BOUNDED_GRACE_S:-2} * 5 )) ] && any_alive $all; do sleep 0.2; g=$((g + 1)); done
      for p in $all; do kill_tree "$p" KILL; done
      wait "$pid" 2>/dev/null
      echo "RED: step '$step' timed out after ${secs}s and was killed" >&2
      return 124
    fi
    sleep 1
  done
  wait "$pid"
}

cleanup() {
  mac_half_stop
  if [ "$STARTED" = 1 ]; then
    remove_run_containers
    docker --context "$CTX" volume rm -f "${VOLS[@]}" >/dev/null 2>&1
    local left
    left="$(docker --context "$CTX" ps -aq --filter "label=$RUN_LABEL" 2>/dev/null) $(docker --context "$CTX" volume ls -q --filter "label=$RUN_LABEL" 2>/dev/null)"
    if [ -z "${left// /}" ]; then
      echo "teardown: run $NAME left no container and no volume on $CTX"
    else
      echo "WARN: teardown of run $NAME left on $CTX:" $left >&2
    fi
  fi
  rm -rf "$WORK/export"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# F-1201: --mac-half runs step 5 alone. Nothing here calls docker, so nothing starts on Spectre.
EXPECT="$(run_mode)"
if [ "$MAC_ONLY" = 1 ]; then
  echo "=== mac half only: sha $SHA, mode $EXPECT (nothing starts on $CTX)"
  mac_half "$EXPECT" "$SHA" 1
  r=$?
  echo
  if [ "$r" = 0 ]; then echo "MAC HALF GREEN: $SHA ($EXPECT)"; else echo "MAC HALF RED: $SHA ($EXPECT)"; fi
  echo "logs: $OUT/mac"
  exit "$r"
fi

if [ "$HALVES" = 1 ]; then
  [ "${BW_HALVES_NO_START:-}" = 1 ] || mac_half_start "$EXPECT" "$SHA" # test seam (F-1373): 1 skips the start, as a lost call would
  sleep "${BW_HALVES_SETUP_S:-0}" # stands in for the host-side setup before the container exec (F-1374); no wait loop runs during it
  [ "${BW_HALVES_EXIT_EARLY:-}" != 1 ] || exit 1 # test seam (F-1374): an early exit with the mac half running; the EXIT trap stops it
  ( sleep "$HS_SECS"; exit "$HS_RC" ) &
  await_container "$!" 600 true
  echo "=== container run finished (stand-in, rc $CONTAINER_RC)"
  RESULT=0; [ "$CONTAINER_RC" = 0 ] || RESULT=1
  mac_half_finish || RESULT=1
  if [ "$RESULT" = 0 ]; then echo "HALVES GREEN"; else echo "HALVES RED"; fi
  exit "$RESULT"
fi

echo "=== wave run: sha $SHA, container $NAME, engine $ENGINE, whole-run cap ${CAP}s, docker context $CTX"

# Spectre unreachable is a wait, never green.
if ! docker --context "$CTX" info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  echo "WAIT: docker context '$CTX' (Spectre) is unreachable. This is a wait, not a red and not a pass. Run again when Spectre is up." >&2
  mac_half "$EXPECT" "$SHA" 0
  exit "$EXIT_WAIT"
fi

# Ruling item 3: the mac half starts here, with the run, and runs beside the Spectre half (step 5 only waits for it).
[ "$SETUP_ONLY" = 1 ] || mac_half_start "$EXPECT" "$SHA"

# 1. Clean export of exactly the sha, with history (the gates read merge trailers and the merge base).
git clone --quiet --no-hardlinks "$SELF_ROOT" "$WORK/export" || { echo "RED: clone failed" >&2; exit 1; }
git -C "$WORK/export" checkout --quiet --detach "$SHA" || { echo "RED: checkout of $SHA failed" >&2; exit 1; }
git -C "$WORK/export" clean -fdxq
# F-164, F-195, F-361: the release-asset files (street list, map files, tracks) are git-ignored, so the clone lacks them, and
# the container has no gh and no GitHub token. ci/wave-fetch-assets.sh fetches and verifies them here (gh on this Mac)
# into the export so the tar below ships them, then re-checks with --no-fetch. Failure is RED, never a skip.
bash "$WORK/export/ci/wave-fetch-assets.sh" "$WORK/export" || exit 1

# 1b. F-409: the content-keyed CI image. The key covers every input that shapes the image (ci/wave-image-key.ts);
#     the tag is the key, so only an image built from exactly these inputs can be selected. A miss builds it on Spectre
#     (build context = exactly the key's files). Failure is RED. Old keys are pruned to the newest $CI_IMAGE_KEEP.
CI_KEY="$(node "$WORK/export/ci/wave-image-key.ts" key "$WORK/export" --base "$IMAGE" --apt "$APT_PINS" --pnpm "$PNPM_VERSION")" \
  || { echo "RED: cannot compute the CI image key" >&2; exit 1; }
CI_IMG="$CI_IMAGE_REPO:$CI_KEY"
IMG_T0=$(date +%s)
img_label="$(bounded "$SPECTRE_CALL_CAP_S" "CI image inspect" quiet docker --context "$CTX" image inspect --format '{{index .Config.Labels "bw.ci.key"}}' "$CI_IMG")"
[ $? = 124 ] && exit 1
if [ "$img_label" = "$CI_KEY" ]; then
  echo "ci-image: CACHE HIT key=$CI_KEY ($CI_IMG)"
else
  echo "ci-image: REBUILD key=$CI_KEY ($CI_IMG): no image with this key on $CTX"
  node "$WORK/export/ci/wave-image-key.ts" stage "$WORK/export" "$WORK/imgctx" || { echo "RED: cannot stage the image build context" >&2; exit 1; }
  bounded "$CI_BUILD_CAP_S" "cold CI image build" docker --context "$CTX" build --progress=plain \
       --build-arg "BASE=$IMAGE" --build-arg "APT_PINS=$APT_PINS" --build-arg "PNPM_VERSION=$PNPM_VERSION" --build-arg "KEY=$CI_KEY" \
       -f "$WORK/imgctx/ci/wave-image/Dockerfile" -t "$CI_IMG" "$WORK/imgctx" >"$OUT/ci-image-build.log" 2>&1
  build_rc=$?
  if [ "$build_rc" != 0 ]; then
    tail -n 30 "$OUT/ci-image-build.log" >&2
    echo "RED: building the CI image $CI_IMG failed or timed out, rc=$build_rc (log: $OUT/ci-image-build.log)" >&2
    exit 1
  fi
  rm -rf "$WORK/imgctx"
fi
# Prune: keep the newest $CI_IMAGE_KEEP keys (docker lists newest first); an image still in use is left (rmi refuses).
# A list or rmi that does not finish inside its cap is RED; an rmi that merely refuses stays silent.
img_list="$(bounded "$SPECTRE_CALL_CAP_S" "CI image list" quiet docker --context "$CTX" images --filter "label=bw.ci.image=1" --format '{{.Repository}}:{{.Tag}}' "$CI_IMAGE_REPO")"
[ $? = 124 ] && exit 1
for old in $(printf '%s\n' "$img_list" | awk -v keep="$CI_IMAGE_KEEP" -v cur="$CI_IMG" 'NR > keep && $0 != cur'); do
  bounded "$SPECTRE_RMI_CAP_S" "CI image prune (rmi $old)" quiet docker --context "$CTX" rmi "$old" >/dev/null
  case $? in 0) echo "ci-image: pruned $old" ;; 124) exit 1 ;; esac
done
img_count="$(bounded "$SPECTRE_CALL_CAP_S" "CI image count" quiet docker --context "$CTX" images -q --filter "label=bw.ci.image=1" "$CI_IMAGE_REPO")"
[ $? = 124 ] && exit 1
echo "ci-image: ready in $(( $(date +%s) - IMG_T0 ))s; images kept: $(printf '%s' "$img_count" | grep -c .)"

# 2. The run's own engine and the CI container (F-126), each expiring by itself past the cap (timeout, sleep), so
#    a lost client cannot leave them running. The engine outlives the CI container by 60 s.
STARTED=1
for v in "${VOLS[@]}"; do
  docker --context "$CTX" volume create --label "$RUN_LABEL" "$v" >/dev/null || { echo "RED: could not create volume $v" >&2; exit 1; }
done
docker --context "$CTX" run -d --name "$ENGINE" --label "$RUN_LABEL" --privileged -e DOCKER_TLS_CERTDIR= \
  -v "$NAME-sock:/var/run/dind" -v "$NAME-work:/work" -v "$NAME-engine-storage:/var/lib/docker" \
  --entrypoint timeout "$ENGINE_IMAGE" "$((CAP + 180))" dockerd-entrypoint.sh dockerd --host="$ENGINE_SOCK" >/dev/null \
  || { echo "RED: could not start the run's engine $ENGINE" >&2; exit 1; }
docker --context "$CTX" run -d --name "$NAME" --label "$RUN_LABEL" --network "container:$ENGINE" --ulimit core=1 \
  -v "$NAME-sock:/var/run/dind" -v "$NAME-work:/work" -e DOCKER_HOST="$ENGINE_SOCK" \
  --entrypoint sleep "$CI_IMG" "$((CAP + 120))" >/dev/null || { echo "RED: could not start the container" >&2; exit 1; }
# Every gate runs through docker exec, which takes the container's limits: read them the same way (F-1165).
docker --context "$CTX" exec "$NAME" cat /proc/self/limits | core_limit_ok \
  || { echo "RED: the CI container's core file limit is not 1 byte, so a browser crash would pipe its core to Windows (F-1165)" >&2; exit 1; }
echo "core file limit in the CI container: 1 byte (a crashed process ends at once and writes no core; F-1165)"
engine_up=""
for _ in $(seq 1 "$ENGINE_READY_S"); do
  engine_up="$(docker --context "$CTX" exec "$ENGINE" docker --host "$ENGINE_SOCK" version --format '{{.Server.Version}}' 2>/dev/null)" && break
  engine_up=""
  sleep 1
done
[ -n "$engine_up" ] || { echo "RED: the run's engine $ENGINE did not answer within ${ENGINE_READY_S}s" >&2; exit 1; }
echo "engine $ENGINE up: Docker $engine_up"
docker --context "$CTX" exec "$ENGINE" tar -C / -cf - usr/local/bin/docker usr/local/libexec/docker/cli-plugins \
  | docker --context "$CTX" exec -i "$NAME" tar -x --no-same-owner -C / || { echo "RED: copying the engine's docker CLI into the container failed" >&2; exit 1; }
COPYFILE_DISABLE=1 tar --no-xattrs -C "$WORK/export" -cf - . | docker --context "$CTX" exec -i "$NAME" sh -c 'mkdir -p /work && tar -x --no-same-owner -C /work' || { echo "RED: shipping the tree failed" >&2; exit 1; }

# The pnpm store goes outside /work: /work is a volume (its own filesystem), and pnpm would otherwise put its store
# at that filesystem's root, inside the tree. The engine check before ci.sh makes a missing engine a red here,
# never a stack gate's "stack unavailable". Pulling and building the stack images is install time, not a gate's.
# F-485: that includes the 1 web image a gate builds that the release build leaves uncached: ci/shell-stack.sh
# (page-walkers step 3) builds with BW_WEB_PREVIEW=1, which reruns pnpm install and next build on the run engine. Inside
# the gate it took 32 to 88 s alone and 335 s beside G-CI7 (wave run d822332), which pushed page-walkers past its limit.
# Built here, before any gate, the gate's own build is a cache hit (as auth-stack's and events-stack's already are), and
# it still builds and reports a failure itself: a failed build here is printed, never a red setup with no verdict.
INNER='set -eu
cd /work
docker version --format "docker client {{.Client.Version}}, engine {{.Server.Version}} at $DOCKER_HOST" \
  || { echo "RED: the container cannot reach the run engine at $DOCKER_HOST" >&2; exit 1; }
docker compose version
export DEBIAN_FRONTEND=noninteractive
git config --global --add safe.directory /work
want="v$(cat .node-version)"; got="$(node -v)"; echo "node $got (want $want)"; test "$got" = "$want"
test "$(pnpm -v)" = "'"$PNPM_VERSION"'"
echo "setup phase: start at ${SECONDS}s"
pnpm install --frozen-lockfile --offline --store-dir /root/.pnpm-store
echo "setup phase: pnpm install done at ${SECONDS}s"
# F-409: the browsers come from the image. A missing one for the pinned Playwright must go red here, so the
# download host is pointed at a dead address: install is a no-op when present and fails when it would download.
PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:9 pnpm exec playwright install chromium webkit
echo "setup phase: browsers checked at ${SECONDS}s"
docker compose -f infra/compose.yaml pull --ignore-buildable --quiet
echo "setup phase: stack pull done at ${SECONDS}s"
docker compose -f infra/compose.yaml build --quiet
BW_IMAGE=bw-wave-preview:local docker compose -f infra/compose.yaml build --quiet --build-arg BW_WEB_PREVIEW=1 web \
  || echo "setup phase: the BW_WEB_PREVIEW=1 web image did not build; page-walkers builds it again and reports it"
echo "setup phase: preview image step done at ${SECONDS}s"
echo "stack images ready on the run engine"
echo "in-container setup: ${SECONDS}s"
if [ "${BW_SETUP_ONLY:-}" = 1 ]; then echo "setup-only: stopping before ci.sh"; exit 0; fi
set +e
if [ -n "${BW_CI_ARGS:-}" ]; then
  echo "NARROW RUN: ci.sh $BW_CI_ARGS (BW_CI_ARGS; this is not a wave run)"
  bash ci/ci.sh $BW_CI_ARGS
  rc=$?
  echo "ci.sh $BW_CI_ARGS exit $rc"
  exit $rc
fi
bash ci/ci.sh --all
rc=$?
echo "ci.sh --all exit $rc"
exit $rc'

# 3. Run with the whole-run cap. The watchdog removes the container and the engine (not only the client) when it fires.
docker --context "$CTX" exec -e BW_WAVE_CONTAINER=1 -e BW_CI_ARGS="${BW_CI_ARGS:-}" -e BW_SETUP_ONLY="$SETUP_ONLY" -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright "$NAME" bash -c "$INNER" 2>&1 | tee "$OUT/wave-container.log" &
EXEC_PID=$!
T0=$(date +%s)
await_container "$EXEC_PID" "$CAP" 'copy_gate_logs "$NAME" "$OUT/gate-logs" || true; remove_run_containers'
ELAPSED=$(( $(date +%s) - T0 ))
echo "=== container run finished in ${ELAPSED}s (cap ${CAP}s)"

RESULT=0
[ "$CAP_FIRED" = 1 ] && RESULT=1

# F-409: --setup-only stops here; the pipe's status is not the container's, so read the log's own marker.
if [ "$SETUP_ONLY" = 1 ]; then
  if [ "$CAP_FIRED" = 0 ] && grep -q '^setup-only: stopping before ci.sh$' "$OUT/wave-container.log"; then
    echo "SETUP-ONLY OK: $SHA (image ${CI_KEY}, container ${ELAPSED}s)"; exit 0
  fi
  echo "SETUP-ONLY RED: $SHA (setup did not finish)" >&2; exit 1
fi

# 3b. F-12: the repo's registered runners are exactly the linux and mac runners (a failed read is red).
(cd "$SELF_ROOT" && node ci/no-hosted-runners.ts --runners) || { echo "RED: runner set check failed" >&2; RESULT=1; }

# 4. Copy the verdict out (a missing one is red) and check the sha.
VERDICT="$OUT/ci-verdict.json"
rm -f "$VERDICT"
if [ "$CAP_FIRED" = 0 ]; then
  docker --context "$CTX" cp "$NAME:/work/.build/ci/ci-verdict.json" "$VERDICT" >/dev/null 2>&1 || true
fi
# F-579: the mode this run's verdict must carry follows its BW_CI_ARGS (a nightly run is judged as nightly, a --gates run as gates):
# EXPECT, set by run_mode before the run started.
check_verdict "$VERDICT" "$SHA" "$EXPECT" || RESULT=1

# 4b. F-102: also copy the flat shape-2 file the dashboard reads; install it only on a sha match. Never changes RESULT.
FLAT="$OUT/ci-verdict.flat.json"
rm -f "$FLAT"
if [ "$CAP_FIRED" = 0 ]; then
  docker --context "$CTX" cp "$NAME:/work/.build/ci-verdict.json" "$FLAT" >/dev/null 2>&1 || true
fi
# F-586: a narrow run writes no flat shape-2 verdict at ci-verdict.json; its verdict is kept under NARROW-RUNS after step 5 (F-1430).
[ "$EXPECT" = gates ] || install_flat "$FLAT" "$SHA" "$SELF_ROOT/.build/ci-verdict.json" || true

# 4c. F-974: per-test times from the container's junit files, recorded on the host. Never changes RESULT.
if [ "$CAP_FIRED" = 0 ]; then
  record_test_times "$NAME" "$OUT/junit" "$SHA" || true
fi

# 5. The mac half (F-1201): a red mac gate makes the run red.
MAC_HALF_STATUS=pass
mac_half_finish || { RESULT=1; MAC_HALF_STATUS=fail; }
# F-1430: a gates verdict, like a nightly one, takes each mac gate's row from the mac half (the container skipped it), then is kept (F-586).
[ "$EXPECT" = all ] || add_mac_time "$VERDICT" "$MAC_HALF_S" "$MAC_HALF_STATUS" "$OUT/mac/gate-times.tsv" "$MAC_OVERRUN_S"
if [ "$EXPECT" = gates ] && [ -f "$VERDICT" ]; then
  DURABLE="$SELF_ROOT/.build/evidence/NARROW-RUNS/ci-verdict-${SHA:0:12}-$(date +%Y%m%d-%H%M%S).json"
  mkdir -p "$(dirname "$DURABLE")" && cp "$VERDICT" "$DURABLE" && echo "narrow-run verdict kept: $DURABLE"
fi

# 6. ci-time-check.py output, from the copied verdict. F-691: a nightly run appends its row here, on the host.
time_check "$VERDICT" "$EXPECT" "$SELF_ROOT/.build/ci-time.jsonl"

echo
if [ "$EXPECT" = gates ]; then
  # F-579: a narrow --gates run is never a wave run; it prints its own result line (exit still follows the result).
  if [ "$RESULT" = 0 ]; then echo "NARROW GATES RUN GREEN: $SHA (not a wave run)"; else echo "NARROW GATES RUN RED: $SHA (not a wave run)"; fi
elif [ "$RESULT" = 0 ]; then echo "$( [ "$EXPECT" = nightly ] && echo NIGHTLY || echo WAVE ) RUN GREEN: $SHA"; else echo "$( [ "$EXPECT" = nightly ] && echo NIGHTLY || echo WAVE ) RUN RED: $SHA"; fi
echo "verdict and logs: $OUT"
exit "$RESULT"
