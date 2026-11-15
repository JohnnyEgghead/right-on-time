#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The native technician suite on the mac runner (P6-XCUITEST; SPECIFICATIONS section 14 Native, SD-38 `mac`; FR-IOS-1, UC-12): the app built
# once, then each XCUITest class on its own fresh Compose stack built from the phase 5 tag (run.sh, BW_STACK_REF, default p5-checkpoint),
# then native-no-demo on the bundle that build shipped. Together the classes prove FR-TECH-1 to FR-TECH-15 natively, the terminate-and-
# relaunch scenario (ShellUITests test3, JobUITests test2: kept and resent on relaunch, D17 item 4) and the Spanish walk of every native
# page-inventory row (SpanishUITests, judged by ci/native/spanish-walk.ts). Where each FR-TECH acceptance runs (each test's why: tag names it):
#   FR-TECH-1, -12  TodayUITests test2 (Maria's Sep 15 jobs in window order; Van and "n of m done")
#   FR-TECH-2       TodayUITests test2 (nothing sent before the confirm, the relay's counts), JobUITests test5
#   FR-TECH-3       JobUITests test2 (photo), test4 (note), test5 (notes and photos on the finish screen), StepsUITests test6 (Photos (5)), test8 (the pinned main button)
#   FR-TECH-4       ShellUITests test3, JobUITests test2 and test4, MapMeUITests test10, WaitingUITests test1 (each once, run.sh's ledgers)
#   FR-TECH-5, -13  MapMeUITests test04 and test05, TodayUITests test2 (the minutes on the Directions button), StepsUITests test2 to test5 and test7 (Directions to this job)
#                   (turn-by-turn steps in English and Spanish, kept steps with no signal, the Approximate state; P6-NATIVE-STEPS)
#   FR-TECH-6       JobUITests test6, WaitingUITests test2 (a server-refused item listed for the technician, never dropped)
#   FR-TECH-7       WaitingUITests test1 ("3 waiting"; the 24-hour banner), JobUITests test6, MapMeUITests test06
#   FR-TECH-8       JobUITests test3, TodayUITests test2, MapMeUITests test04 and test04b
#   FR-TECH-9       TodayUITests test2 (every walked job to No one home; run.sh's ledger by kind)
#   FR-TECH-10      MapMeUITests test02 (Parts with no signal) and the 4 tabs every class opens
#   FR-TECH-11      MapMeUITests test03, test04, test04b
#   FR-TECH-14      JobUITests test5 (work-done lines, the signature and Clear, kept with no signal)
#   FR-TECH-15      MapMeUITests test06 to test08 and test10, TodayUITests test2
#   UC-12           TodayUITests test2 (Maria's day from sign-in to All done, the server's ledger), JobUITests test5 (a job worked to
#                   Done); against this Compose stack, the plan's stand-in for the hosted demo
#   bash apps/tech-native/xcuitest/suite.sh [--no-build] [--only <Class,...>]
# The first class's run.sh builds the app, after xcuitest/prebuild.sh --if-stale (F-1207: ios/ is generated, so a checkout may have
# none, or a stale one). When that run did not build, the suite stops there and names the cause: no other class runs.
# Env: as run.sh (BW_SIM_UDID, BW_STACK_REF, BW_NATIVE_BUILD_CAP_S); BW_NATIVE_SUITE_EVIDENCE (default 1 new folder per run,
# .build/evidence/native-suite/<date>-<pid>, with 1 folder per class and summary.txt).
# Exit: 0 when every class's run.sh and native-no-demo pass.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
here="$root/apps/tech-native/xcuitest"
classes="ShellUITests,MapMeUITests,JobUITests,TodayUITests,WaitingUITests,SpanishUITests,StepsUITests"
build=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) build=0; shift ;;
    --only) classes="$2"; shift 2 ;;
    *) echo "suite: unknown argument $1" >&2; exit 2 ;;
  esac
done
out="${BW_NATIVE_SUITE_EVIDENCE:-$root/.build/evidence/native-suite/$(date +%Y%m%d-%H%M%S)-$$}"
mkdir -p "$out"
summary="$out/summary.txt"
: >"$summary"
fail=0
for c in ${classes//,/ }; do
  # each class on its own stack: its own project name (run.sh's form) and evidence folder
  p="bw-w28-native-$(echo "$c" | tr '[:upper:]' '[:lower:]' | sed 's/uitests$//')"
  args=()
  [ "$build" -eq 1 ] || args+=(--no-build)
  set +e
  BW_NATIVE_TESTS="$c" BW_NATIVE_PROJECT="$p" BW_NATIVE_EVIDENCE="$out/$c" bash "$here/run.sh" ${args[@]+"${args[@]}"} >"$out/$c.log" 2>&1
  rc=$?
  set -e
  echo "$c: run.sh exit $rc ($(grep -h 'test-without-building' "$out/$c/times.txt" 2>/dev/null | tail -1))" | tee -a "$summary"
  [ "$rc" -eq 0 ] || fail=1
  # F-1207: every later class runs --no-build on this build, so a run that did not build ends the suite here, with its cause.
  if [ "$build" -eq 1 ] && ! grep -q '^build-for-testing: exit 0,' "$out/$c/times.txt" 2>/dev/null; then
    echo "suite: FAIL the app was not built in $c's run, so no other class ran: $(grep -h '^run: FAIL' "$out/$c.log" 2>/dev/null | head -1) (see $out/$c.log)" | tee -a "$summary"
    exit 1
  fi
  build=0 # the app is built once
done
app="$root/apps/tech-native/build/dd/Build/Products/Release-iphonesimulator/RightOnTime.app"
set +e
bash "$root/ci/gates/native-no-demo.sh" --hbc "$app/main.jsbundle" --out "$out/native-no-demo" >"$out/native-no-demo.log" 2>&1
nd=$?
set -e
echo "native-no-demo: exit $nd ($(tail -1 "$out/native-no-demo.log"))" | tee -a "$summary"
[ "$nd" -eq 0 ] || fail=1
echo "suite: $([ "$fail" -eq 0 ] && echo PASS || echo FAIL) (evidence $out)" | tee -a "$summary"
exit "$fail"
