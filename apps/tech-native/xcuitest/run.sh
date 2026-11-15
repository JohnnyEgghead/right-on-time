#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The native shell's XCUITest run (P6-NATIVE-SHELL Acceptance) on the owner's Mac: the iOS Simulator against the Compose stack on Docker
# context desktop-linux (its own project, bw-w28-native, at its default settings, set up by the setup service), through the signal relay.
#   bash apps/tech-native/xcuitest/run.sh [--no-build]        (the build step runs xcuitest/prebuild.sh --if-stale first, F-1207)
# Env: BW_SIM_UDID (the simulator; default the iPhone 17e of this Mac), BW_NATIVE_PROJECT (bw-w28-native or bw-w28-native-<x>),
# BW_NATIVE_TESTS (the XCUITest classes, comma separated: ShellUITests, the default, MapMeUITests, JobUITests, TodayUITests, and P6-XCUITEST's
# SpanishUITests and WaitingUITests), BW_NATIVE_EVIDENCE (the evidence folder; default 1 new folder per run, F-992:
# .build/evidence/native-runs/<project>-<date>-<pid>), BW_NATIVE_COMPARE_SET (optional override of the look case set; by default run.sh picks it
# from the classes: ShellUITests shell, MapMeUITests mapme, JobUITests job, TodayUITests today; SpanishUITests and WaitingUITests add none),
# BW_STACK_REF (the git ref the Compose stack is built from, default p5-checkpoint: the phase 5 tag CP5 was accepted against; P6-XCUITEST),
# BW_NATIVE_BUILD_CAP_S and BW_NATIVE_TEST_CAP_S (F-992: the wall-clock caps of the 2 xcodebuild calls; defaults below, from measured green runs),
# BW_SIM_LOCK_WAIT_S (F-1386: the longest wait for this Mac's simulator lock, default 3600 s; xcuitest/sim-lock.sh).
# TodayUITests (P6-NATIVE-TODAY) also gets: the reviewer sample user's password (set by this run) and a turned-off account (employee
# 40713), both in the relay's environment only, and its own ledger check: every job it walked is in the ledger once per status kind.
# It runs alone (its ledger check counts every item the stack holds).
# JobUITests (P6-NATIVE-JOB) also gets: the dispatcher Keisha Thompson's web session (its token only in the relay's environment, for
# API-140 Add note), a 3200 x 1200 PNG over 10 MB in the simulator's photo library (the system picker's photo: the simulator has no
# camera), and its own ledger check: the photo queued offline is in the server's ledger once, uploaded once, at most 2048 px.
# P6-NATIVE-STEPS: StepsUITests (turn-by-turn Directions, Photos (n), the photo tiles' small copies) runs on a stack built from this checkout
# (BW_STACK_REF defaults to HEAD for it: API-104's steps are newer than the phase 5 tag) with the routing service up for every test but test5, which runs in its own pass with it down (F-1392, F-1395); run.sh sets Maria's
# profile language to Spanish, sends 5 photos to Harold Jenkins's job (xcuitest/seed-photos.mjs: 1 more than the photo row shows in view),
# removes the baked legs into Linda Miller's job (so Directions from her job is the Approximate state), hands the test the expected steps
# of the route from the van to Harold's job (API-104 with no fromJob, as the app asks: F-1369; xcuitest/steps-expect.mjs), and checks after the
# suite that every photo tile read asked for the small copy (the relay's RELAY-FILE lines) and that the steps add up to the leg.
# P6-XCUITEST: SpanishUITests's walk is judged by ci/native/spanish-walk.ts (spanish-walk.log); WaitingUITests gets the simulator's id and the
# app's bundle id in the relay's environment (its /items/age moves a waiting item's entered real time in the app's files), the demo clock read
# before and after, and its own ledger check (3 notes once each, the refused finish once, applied). TodayUITests's customers get a customer note
# (F-1113 a: the Success frame's note box). Each xcodebuild call has a wall-clock cap (F-992): a call over it is stopped and the run fails.
# Evidence (1 folder per run, or $BW_NATIVE_EVIDENCE; never committed): xcuitest.log (the NATIVE- steps and the test results, filtered),
# relay.log (every request the stack received from the app, and each signal change), ledger.txt (the server's ledger line for the queued
# note and the relay's count of its sends), look-dumps/ and native-compare.log (G-LOOK-PARITY), device.txt.
# Exit: 0 when the suite, the ledger check and the look compare all pass. The stack is torn down on every exit path.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$root/apps/tech-native"
tests="${BW_NATIVE_TESTS:-ShellUITests}" # the XCUITest classes to run, comma separated (P6-NATIVE-MAP-ME: MapMeUITests)
project="${BW_NATIVE_PROJECT:-bw-w28-native}"
# F-992: 1 evidence folder per run (a re-run never overwrites the last run's evidence).
ev="${BW_NATIVE_EVIDENCE:-$root/.build/evidence/native-runs/$project-$(date +%Y%m%d-%H%M%S)-$$}"
# F-992: the caps, from measured green runs on this Mac (iPhone 17e simulator, Xcode 27.2; P6-XCUITEST, evidence row 485, Nov 9, 2026):
# a cold build-for-testing took 218 s (an incremental one 22 s); test-without-building took Shell 93 s, MapMe 535 s, Job 405 s, Today 727 s,
# Waiting 188 s, Spanish 138 s. Each cap is about 2.5 times its measured time.
build_cap="${BW_NATIVE_BUILD_CAP_S:-600}"
test_cap_of() {
  case "$1" in
    ShellUITests) echo 240 ;; MapMeUITests) echo 1350 ;; JobUITests) echo 1000 ;; TodayUITests) echo 1800 ;;
    SpanishUITests) echo 360 ;; WaitingUITests) echo 480 ;; StepsUITests) echo 900 ;; AccessibilityUITests) echo 600 ;;
  esac
}
only=""
for t in ${tests//,/ }; do only="$only -only-testing:RightOnTimeUITests/$t"; done
# P8-A11Y-TOOLS: BW_A11Y_METHOD=<test method> runs 1 method of AccessibilityUITests (test2Structure, test3LargestTextSize, test4ReduceMotion,
# testPlants); BW_A11Y_TEXT=<simctl content size> and BW_A11Y_REDUCE=on|off set the simulator's text size and Reduce Motion for the run and
# put the earlier values back on exit. BW_A11Y_CUT_AFTER=<screen row> ends a walk after that row: the walk then reaches fewer than 16 screens
# and the method fails (F-1627 must-fail proof). The largest-text method needs no BW_A11Y_TEXT: it walks at the default size and sets the largest through the relay's /textsize for each screen.
if [ -n "${BW_A11Y_METHOD:-}" ]; then
  [ "$tests" = "AccessibilityUITests" ] || { echo "run: BW_A11Y_METHOD belongs to AccessibilityUITests alone" >&2; exit 2; }
  only="-only-testing:RightOnTimeUITests/AccessibilityUITests/$BW_A11Y_METHOD"
fi
for t in ${tests//,/ }; do [[ "$t" =~ ^(ShellUITests|MapMeUITests|JobUITests|TodayUITests|SpanishUITests|WaitingUITests|StepsUITests|AccessibilityUITests)$ ]] || { echo "run: test class '$t' is refused" >&2; exit 2; }; done
test_cap=0
for t in ${tests//,/ }; do test_cap=$((test_cap + $(test_cap_of "$t"))); done
test_cap="${BW_NATIVE_TEST_CAP_S:-$test_cap}"
runs() { [[ ",$tests," == *",$1,"* ]]; } # this run's classes include $1
# The stack's commit: the phase 5 tag CP5 was accepted against, or this checkout for StepsUITests (its API-104 steps came after the tag).
if runs StepsUITests; then stack_ref="${BW_STACK_REF:-HEAD}"; else stack_ref="${BW_STACK_REF:-p5-checkpoint}"; fi
if runs TodayUITests && [ "$tests" != "TodayUITests" ]; then echo "run: TodayUITests runs alone (its ledger check counts every item)" >&2; exit 2; fi
build="$app/build"
mkdir -p "$ev" "$build"
cd "$root"
export DOCKER_CONTEXT=desktop-linux
# F-988: the probe, the look reader and the other test seams are in the app's JavaScript bundle only when Metro is given this variable at
# bundle time (the xcodebuild below runs the bundle step). The TestFlight archive (release/archive.sh) is made without it.
export EXPO_PUBLIC_BW_RIG=1
udid="${BW_SIM_UDID:-43F6C8A4-67D0-4623-B356-C4F71A2ABA21}"
bundle="com.johnloring.rightontime"
[[ "$project" =~ ^bw-w28-native(-[a-z0-9][a-z0-9_-]*)?$ ]] || { echo "run: project name '$project' is refused" >&2; exit 2; }
image="$project:local"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-w28-native.XXXXXX")"
chmod 700 "$tmp"
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
port="$(freeport)"; https_port="$(freeport)"; relay_port="$(freeport)"; control_port="$(freeport)"; dead_port="$(freeport)"
printf 'POSTGRES_PASSWORD=%s\n' "native-$$-$RANDOM$RANDOM" >"$tmp/db.env"
# The stack is built from $stack_ref (the phase 5 tag by default), never from this tree: its files, exported by git, are the build context.
stack="$tmp/stack"
compose() {
  BW_IMAGE="$image" DB_ENV_FILE="$tmp/db.env" HTTP_BIND="127.0.0.1:$port" HTTPS_BIND="127.0.0.1:$https_port" \
    BW_DATA_DIR="$root/.build/data" BW_MAPS_DIR="${maps_dir:-$root/.build/data/maps}" docker compose -p "$project" -f "$stack/infra/compose.yaml" "$@"
}
relay_pid=""
a11y_prev_size="" a11y_prev_reduce=""
cleanup() {
  if [ -n "$a11y_prev_size$a11y_prev_reduce" ]; then a11y_restore; fi # set only under the simulator lock, after a11y_restore is defined
  if [ -n "$relay_pid" ]; then kill "$relay_pid" 2>/dev/null || true; fi
  if [ -n "${net_pid:-}" ]; then kill "$net_pid" 2>/dev/null || true; fi
  compose --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$image" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
step() { echo "run: $*"; }

# F-992: capped <seconds> <name> <command...>: the command in the background, stopped (TERM, then KILL 10 s later) when it outlives the cap
# (macOS has no GNU timeout). Exit: the command's, or 124 when the cap stopped it (a "CAPPED" line names it).
capped() {
  local secs="$1" name="$2"
  shift 2
  "$@" &
  local pid=$!
  ( trap 'kill "$s" 2>/dev/null; exit 0' TERM
    sleep "$secs" & s=$!; wait "$s"
    echo "run: CAPPED $name at ${secs}s" >&2; : >"$tmp/capped-$name"; kill -TERM "$pid" 2>/dev/null
    sleep 10 & s=$!; wait "$s"; kill -KILL "$pid" 2>/dev/null ) &
  local dog=$!
  local rc=0
  wait "$pid" || rc=$?
  kill -TERM "$dog" 2>/dev/null || true
  wait "$dog" 2>/dev/null || true
  if [ -e "$tmp/capped-$name" ]; then return 124; fi
  return "$rc"
}

# ---- the app build (Release: the JS bundle embedded, no Metro), ad hoc signed for the simulator -------------------------------------
if [ "${1:-}" != "--no-build" ]; then
  # F-1207: ios/ is generated, never committed, so a checkout may have none or one made from older inputs. prebuild.sh --if-stale
  # generates it again unless it holds the key of the current inputs; a failed prebuild fails the run here and names it.
  step "the iOS project (xcuitest/prebuild.sh --if-stale)"
  set +e
  p0=$SECONDS
  bash "$app/xcuitest/prebuild.sh" --if-stale >"$ev/prebuild.log" 2>&1
  rc=$?
  set -e
  echo "prebuild: exit $rc, $((SECONDS - p0)) s ($(grep '^prebuild: ' "$ev/prebuild.log" | tail -1))" | tee -a "$ev/times.txt"
  [ "$rc" -eq 0 ] || { step "FAIL the iOS project was not generated: xcuitest/prebuild.sh --if-stale exited $rc (see $ev/prebuild.log)"; exit 1; }
  step "building the app and the UI tests"
  cp "$app"/xcuitest/*UITests.swift "$app/ios/RightOnTimeUITests/" # the committed suites, not prebuild's copies
  set +e
  b0=$SECONDS
  capped "$build_cap" build-for-testing xcodebuild build-for-testing -workspace "$app/ios/RightOnTime.xcworkspace" -scheme RightOnTime -configuration Release \
    -destination "id=$udid" -derivedDataPath "$build/dd" CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= >"$build/build-full.log" 2>&1
  rc=$?
  set -e
  grep -E 'error:|\*\* (BUILD|TEST BUILD)' "$build/build-full.log" >"$ev/xcode-build.log" || true
  echo "build-for-testing: exit $rc, $((SECONDS - b0)) s (cap $build_cap s)" | tee -a "$ev/times.txt"
  [ "$rc" -eq 0 ] || { step "FAIL the build exited $rc (see $ev/xcode-build.log)"; exit 1; }
fi

# ---- the simulator lock (F-1386) ----------------------------------------------------------------------------------------------------
# Every lane on this Mac shares the simulator and the app's bundle ids: a second run.sh on it uninstalls this run's app and replaces its
# test runner mid-test ("Test crashed with signal kill"). The lock is taken here, after the build (a build installs nothing on the
# simulator) and before the stack comes up (no wait falls between the stack's setup and the test), and held to exit (the stack's teardown
# included). A run that dies frees it (xcuitest/sim-lock.sh).
. "$app/xcuitest/sim-lock.sh"
sim_lock_take "$udid" "$tests from $root" || exit $?
echo "sim-lock: waited $sim_lock_waited s for the simulator ($sim_lock)" | tee -a "$ev/times.txt"

# ---- the stack ----------------------------------------------------------------------------------------------------------------------
node ci/data-assets.ts ensure
stack_sha="$(git -C "$root" rev-parse --verify "$stack_ref^{commit}")" || { step "FAIL the stack ref $stack_ref is not in this clone (fetch its tag)"; exit 1; }
mkdir -p "$stack"
git -C "$root" archive "$stack_sha" | tar -x -C "$stack"
# F-1362: the stack's setup checks the map files against ITS OWN manifest (map_hash_mismatch otherwise), so the files it serves are the ones
# its ref pins: the stack's manifest, ensured into a folder named by that commit. A stack built from this checkout uses the usual folder.
if [ "$stack_sha" = "$(git -C "$root" rev-parse HEAD)" ]; then maps_dir="$root/.build/data/maps"; else maps_dir="$root/.build/data/maps-${stack_sha:0:12}"; fi
node ci/data-assets.ts ensure --manifest "$stack/packages/maps/MANIFEST.json" --dir "$maps_dir"
echo "stack built from $stack_ref = $stack_sha (git archive of that commit); the app and the suite from $(git -C "$root" rev-parse HEAD)" | tee "$ev/stack.txt"
step "project $project on context $DOCKER_CONTEXT, image $image"
compose build web >/dev/null
compose up -d --no-build --wait --wait-timeout 240 proxy web worker pbs db
seed="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
reviewer_pw="rv-$(node -e 'console.log(require("node:crypto").randomBytes(12).toString("base64url"))')"
SAMPLE_PASSWORD_SEED="$seed" REVIEWER_PASSWORD="$reviewer_pw" compose --profile setup run --rm --no-deps setup >"$tmp/setup.log" 2>&1 || { tail -5 "$tmp/setup.log" >&2; exit 1; }
for s in db pbs proxy web worker; do compose ps --status running --services | grep -qw "$s" || { step "FAIL service $s is not running"; exit 1; }; done
pgv="$(compose exec -T db psql -U brightwater -d brightwater -tAc 'show server_version')"
node ci/wave/stack-settings.ts "$project" >/dev/null || { step "FAIL the stack is not at its default settings"; exit 1; }
base="http://127.0.0.1:$port"
curl -fsS --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "$base/healthz"
step "stack up at $base (PostgreSQL $pgv), set up by the setup service"
psql() { compose exec -T db psql -U brightwater -d brightwater -tAc "$1"; }
job="$(psql "SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id WHERE t.name = 'Maria Santos' AND j.job_number = 24830")"
[ "$job" = "24830" ] || { step "FAIL job 24830 is not Maria Santos's"; exit 1; }
# Maria Santos's sample password derives from the seed and her email (SD-9); it goes to the relay's environment only, which hands it
# to the app's probe sign-in (no password in a launch argument or in the test runner's log).
SEED="$seed" node --input-type=module -e "import { samplePassword } from '$root/packages/db/src/passwords.ts'; process.stdout.write(samplePassword(process.env.SEED, 'maria.santos@brightwater.example'));" >"$tmp/pw"

# P6-NATIVE-TODAY: the reviewer (App Reviewer, a technician-role user with no technician row; HC-05) signs in with the password this run
# set, and the sample technician with employee number 40713 has a turned-off account (the Turned off state). Both go to the relay's
# environment only.
off_email="$(psql "SELECT email FROM world.\"user\" WHERE employee_number = '40713'")"
[ -n "$off_email" ] || { step "FAIL no user with employee number 40713"; exit 1; }
if runs TodayUITests; then psql "UPDATE world.\"user\" SET status_before_off = status, status = 'turned_off' WHERE employee_number = '40713'" >/dev/null; fi
# F-1113 (a): each of Maria's customers with no note gets one (the Success frame's next job shows its customer note box beside See history).
if runs TodayUITests; then
  psql "INSERT INTO world.note (customer_id, author_user_id, author_kind, body, entered_at, sent_at, entered_offline) SELECT DISTINCT j.customer_id, u.id, 'office', 'Use the side door. Knock firmly.', now(), now(), false FROM world.job j JOIN world.technician t ON t.id = j.technician_id JOIN world.\"user\" u ON u.email = 'keisha.t@brightwater.example' WHERE t.name = 'Maria Santos' AND NOT EXISTS (SELECT 1 FROM world.note n WHERE n.customer_id = j.customer_id)" >/dev/null
fi
clock_before="$(psql "SELECT demo_anchor || ' ' || rate || ' ' || world_epoch FROM system.demo_clock" 2>/dev/null || echo unread)"
SEED="$seed" node --input-type=module -e "import { samplePassword } from '$root/packages/db/src/passwords.ts'; process.stdout.write(samplePassword(process.env.SEED, process.argv[1]));" "$off_email" >"$tmp/pw-off"

# The dispatcher's web session for API-140 (as ci/tech-job-stack/fixture.sql makes it): the token's sha256 is stored, the token goes only
# to the relay's environment.
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))' >"$tmp/office"
office_hash="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1],"utf8").trim()).digest("hex"))' "$tmp/office")"
psql "INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real) SELECT decode('$office_hash', 'hex'), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours' FROM world.\"user\" u WHERE u.email = 'keisha.t@brightwater.example'" >/dev/null
[ "$(psql "SELECT count(*) FROM system.session WHERE token_hash = decode('$office_hash', 'hex')")" = "1" ] || { step "FAIL the dispatcher session"; exit 1; }

# ---- JobUITests (F-1369): Directions on Harold's job shows the route from the van to his job, baked when the stop before his is ended ----
if runs JobUITests && ! runs StepsUITests; then
  day_date="$(psql "SELECT date FROM world.job WHERE job_number = $job")"
  before="$(psql "SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id WHERE t.name = 'Maria Santos' AND j.date = '$day_date' AND j.window_start < (SELECT window_start FROM world.job WHERE job_number = $job) ORDER BY j.window_start DESC, j.job_number DESC LIMIT 1")"
  if [ -n "$before" ]; then
    psql "UPDATE world.job SET status = 'no_one_home', ended_at = window_start WHERE job_number = $before AND status NOT IN ('done', 'no_one_home')" >/dev/null
    echo "the stop before Harold's, $before, is ended (the van's route into his job is baked)"
  fi
fi

# ---- StepsUITests (P6-NATIVE-STEPS): the routing service, a Spanish-speaking Maria, 3 photos on Harold's job, an unbaked leg, the expected steps ----
if runs StepsUITests; then
  # F-1395: the routing service is UP for the suite (the plan's "with routing up": test7, Directions to this job, runs against the live service,
  # and the files it serves are the ones ensured above). Only test5 needs it DOWN (SD-49, F-1392): it needs the Approximate state for Linda's
  # leg, and a map folder that holds the ohio.osrm.* files would live-route that leg and show steps. So the suite runs in 2 xcodebuild passes
  # below: every other test with routing up, then test5 alone after `compose stop routing` (its name no longer resolves, so the server answers
  # the leg approximate, SD-49 step 3, whatever the folder holds). The other tests read legs the bake holds.
  compose up -d --no-build routing >/dev/null
  for i in $(seq 1 60); do [ "$(compose ps --status running --services routing)" = "routing" ] && break; sleep 1; done
  echo "routing service for the main pass: $(compose ps --all --format '{{.Service}} {{.State}}' routing | grep . || echo 'not started')" | tee "$ev/steps-setup.txt"
  day_date="$(psql "SELECT date FROM world.job WHERE job_number = $job")"
  order="$(psql "SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id WHERE t.name = 'Maria Santos' AND j.date = '$day_date' ORDER BY j.window_start, j.job_number" | tr '\n' ' ')"
  next_job="$(echo "$order" | tr ' ' '\n' | grep -A1 -x "$job" | sed -n 2p)"
  after_job="$(echo "$order" | tr ' ' '\n' | grep -A1 -x "${next_job:-none}" | sed -n 2p)"
  echo "Maria's day $day_date: $order; Harold's $job, next $next_job, after it $after_job" | tee -a "$ev/steps-setup.txt"
  [ -n "$next_job" ] && [ -n "$after_job" ] || { step "FAIL Harold's job has no next job, or that one none after it"; exit 1; }
  [ "$(psql "SELECT c.name FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = $next_job")" = "Linda Miller" ] || { step "FAIL the job after Harold's is not Linda Miller's"; exit 1; }
  psql "UPDATE world.\"user\" SET language = 'es' WHERE email = 'maria.santos@brightwater.example'" >/dev/null
  # F-1369: Directions on a job is the route from the van to THAT job, so Linda's job shows the Approximate state when no baked leg ends at it
  removed="$(psql "WITH d AS (DELETE FROM world.van_track WHERE to_ref = '$next_job' RETURNING 1) SELECT count(*) FROM d")"
  echo "baked legs removed into $next_job: $removed" | tee -a "$ev/steps-setup.txt"
  # The van's position for Harold's job (API-104 with no fromJob) is the last ended stop of the day, else the depot, and only the legs between
  # stops are baked: the stop before Harold's is ended (No one home: Done needs a billing item), as a stop is when the web suite reads this day at 10:26 AM, so the route into his job is baked.
  before="$(echo "$order" | tr ' ' '\n' | grep -B1 -x "$job" | sed -n 1p)"
  if [ -n "$before" ] && [ "$before" != "$job" ]; then
    psql "UPDATE world.job SET status = 'no_one_home', ended_at = window_start WHERE job_number = $before AND status NOT IN ('done', 'no_one_home')" >/dev/null
    echo "the stop before Harold's, $before, is ended: $(psql "SELECT status FROM world.job WHERE job_number = $before")" | tee -a "$ev/steps-setup.txt"
  fi
  # 5 photos on Harold's job, sent as Maria's web app sends them (API-103), with a web session minted for her as the dispatcher's is
  node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))' >"$tmp/maria"
  maria_hash="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1],"utf8").trim()).digest("hex"))' "$tmp/maria")"
  psql "INSERT INTO system.session (token_hash, user_id, client, via, keep_signed_in, created_real, last_seen_real, expires_real) SELECT decode('$maria_hash', 'hex'), u.id, 'web', 'password', false, now(), now(), now() + interval '8 hours' FROM world.\"user\" u WHERE u.email = 'maria.santos@brightwater.example'" >/dev/null
  for i in 1 2 3 4 5; do
    node "$app/xcuitest/noise-png.mjs" "$tmp/seed-$i.png" $((900 + 100 * i)) 750 >/dev/null
    sips -s format jpeg "$tmp/seed-$i.png" --out "$tmp/seed-$i.jpg" >/dev/null
  done
  BW_SEED_TOKEN="$(tr -d '\n' <"$tmp/maria")" BW_CLOCK_TOKEN="$(tr -d '\n' <"$tmp/office")" BW_REAL_NOW="$(date -u '+%Y-%m-%dT%H:%M:%S+00:00[UTC]')" \
    node "$app/xcuitest/seed-photos.mjs" "$base" "http://localhost:8080" "$job" "$tmp/seed-1.jpg" "$tmp/seed-2.jpg" "$tmp/seed-3.jpg" "$tmp/seed-4.jpg" "$tmp/seed-5.jpg" >"$tmp/seeded.txt" \
    || { cat "$tmp/seeded.txt" >&2; step "FAIL the 5 photos on Harold's job"; exit 1; }
  tee -a "$ev/steps-setup.txt" <"$tmp/seeded.txt"
  # The expected steps: the route the app asks for from Harold's job screen (API-104, toJob = Harold's, no fromJob), read as Maria's web session
  # reads it; it must be a baked route with steps (the test needs 3 or more). Its destination is Harold's address.
  curl -fsS -H "cookie: bw_session=$(tr -d '\n' <"$tmp/maria"); bw_lang=en" "$base/api/v1/tech/route?toJob=$job" >"$tmp/route.json" || { step "FAIL API-104 for Harold's job"; head -c 400 "$tmp/route.json" >&2; exit 1; }
  node -e 'const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).data; if (!r.leg.track || !Array.isArray(r.steps) || r.steps.length < 3) { console.error("not a baked route with steps"); process.exit(1); } process.stdout.write(JSON.stringify(r.steps));' "$tmp/route.json" >"$tmp/steps.json" \
    || { head -c 700 "$tmp/route.json" | tr -d '\n' >&2; step "FAIL the route from the van to Harold's job is not a baked route with steps"; exit 1; }
  minutes="$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).data.leg.minutes))' "$tmp/route.json")"
  street="$(psql "SELECT c.house_number || ' ' || st.name FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street st ON st.id = c.street_id WHERE j.job_number = $job")"
  next_street="$(psql "SELECT c.house_number || ' ' || st.name FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street st ON st.id = c.street_id WHERE j.job_number = $next_job")"
  echo "the route from the van to Harold's job $job: $minutes min, to $street" | tee -a "$ev/steps-setup.txt"
  node "$app/xcuitest/steps-expect.mjs" en "$street" <"$tmp/steps.json" >"$tmp/steps-en.txt" || { step "FAIL the expected English steps"; exit 1; }
  node "$app/xcuitest/steps-expect.mjs" es "$street" <"$tmp/steps.json" >"$tmp/steps-es.txt" || { step "FAIL the expected Spanish steps"; exit 1; }
  cp "$tmp/steps-en.txt" "$ev/steps-expected-en.txt"
  cp "$tmp/steps-es.txt" "$ev/steps-expected-es.txt"
  # the expected steps reach the test runner through its environment (xcodebuild hands TEST_RUNNER_<name> to the runner as <name>)
  export TEST_RUNNER_BW_NEXT_JOB="$next_job" TEST_RUNNER_BW_MINUTES="$minutes" TEST_RUNNER_BW_STREET="$street" TEST_RUNNER_BW_NEXT_STREET="$next_street" \
    TEST_RUNNER_BW_STEPS_EN="$(sed -n 1p "$tmp/steps-en.txt")" TEST_RUNNER_BW_DIST_EN="$(sed -n 2p "$tmp/steps-en.txt")" TEST_RUNNER_BW_NEXT_EN="$(sed -n 3p "$tmp/steps-en.txt")" \
    TEST_RUNNER_BW_STEPS_ES="$(sed -n 1p "$tmp/steps-es.txt")" TEST_RUNNER_BW_NEXT_ES="$(sed -n 3p "$tmp/steps-es.txt")" \
    TEST_RUNNER_BW_TURN_AT="$(sed -n 4p "$tmp/steps-en.txt")" TEST_RUNNER_BW_PICK_AT="$(sed -n 5p "$tmp/steps-en.txt")"
fi

# ---- the signal relay ---------------------------------------------------------------------------------------------------------------
: >"$ev/relay.log"
BW_OFFICE_TOKEN="$(tr -d '\n' <"$tmp/office")" BW_OFFICE_ORIGIN="http://localhost:8080" \
BW_PROBE_LOGIN="40712" BW_PROBE_PASSWORD="$(cat "$tmp/pw")" BW_REVIEWER_LOGIN="reviewer@brightwater.example" BW_REVIEWER_PASSWORD="$reviewer_pw" \
BW_OFF_LOGIN="40713" BW_OFF_PASSWORD="$(cat "$tmp/pw-off")" BW_OFF_EMAIL="$off_email" BW_PROBE_EMAIL="maria.santos@brightwater.example" \
BW_SIM_UDID="$udid" BW_APP_BUNDLE="$bundle" node "$app/xcuitest/signal-relay.mjs" "$relay_port" "$control_port" "$base" "$ev/relay.log" 9>&- &
relay_pid=$!
curl -fsS --retry 20 --retry-connrefused --retry-delay 0 -o /dev/null "http://127.0.0.1:$control_port/signal/on"
step "relay http://127.0.0.1:$relay_port (control $control_port, nothing on $dead_port)"

# ---- the suite ----------------------------------------------------------------------------------------------------------------------
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl uninstall "$udid" "$bundle" 2>/dev/null || true
a11y_restore() {
  if [ -n "$a11y_prev_size" ]; then xcrun simctl ui "$udid" content_size "$a11y_prev_size" >/dev/null 2>&1 || true; fi
  if [ -n "$a11y_prev_reduce" ]; then xcrun simctl spawn "$udid" defaults write com.apple.Accessibility ReduceMotionEnabled -bool "$a11y_prev_reduce" >/dev/null 2>&1 || true; fi
}
if [ "${BW_A11Y_METHOD:-}" = test3LargestTextSize ] && [ -z "${BW_A11Y_TEXT:-}" ]; then
  # F-1627: the largest-text walk changes the size itself (the relay's /textsize) screen by screen; whatever it does, the size read here is put back on exit.
  a11y_prev_size="$(xcrun simctl ui "$udid" content_size | tr -d '[:space:]')"
  echo "a11y: the walk sets the text size itself; to be put back: $a11y_prev_size" | tee -a "$ev/times.txt"
fi
if [ -n "${BW_A11Y_TEXT:-}" ]; then
  a11y_prev_size="$(xcrun simctl ui "$udid" content_size | tr -d '[:space:]')"
  xcrun simctl ui "$udid" content_size "$BW_A11Y_TEXT"
  echo "a11y: text size $a11y_prev_size -> $BW_A11Y_TEXT" | tee -a "$ev/times.txt"
fi
if [ -n "${BW_A11Y_REDUCE:-}" ]; then
  want=false; [ "$BW_A11Y_REDUCE" = on ] && want=true
  a11y_prev_reduce="$(xcrun simctl spawn "$udid" defaults read com.apple.Accessibility ReduceMotionEnabled 2>/dev/null | tr -d '[:space:]' | sed 's/^1$/true/; s/^0$/false/')"
  [ -n "$a11y_prev_reduce" ] || a11y_prev_reduce=false
  xcrun simctl spawn "$udid" defaults write com.apple.Accessibility ReduceMotionEnabled -bool "$want"
  echo "a11y: Reduce Motion $a11y_prev_reduce -> $want" | tee -a "$ev/times.txt"
fi
export TEST_RUNNER_BW_A11Y_REDUCE="${BW_A11Y_REDUCE:-}" TEST_RUNNER_BW_A11Y_CUT_AFTER="${BW_A11Y_CUT_AFTER:-}" TEST_RUNNER_BW_A11Y_KEEP_SHOTS="${BW_A11Y_KEEP_SHOTS:-}"
xcrun simctl keychain "$udid" reset 2>/dev/null || true # a fresh install: no Keychain entry left by an earlier run
xcrun simctl list devices | grep "$udid" | sed 's/^ *//' >"$ev/device.txt"
if runs JobUITests; then
  # SCR-TEC-06: the photo the system picker hands over (no camera in the simulator): noise, so its PNG is over API-103's 10 MB cap.
  node "$app/xcuitest/noise-png.mjs" "$tmp/job-photo.png" 3200 1200 >"$ev/photo-source.txt"
  xcrun simctl addmedia "$udid" "$tmp/job-photo.png"
fi
rb="$ev/native-shell.xcresult" # F-1209: in the class's evidence folder, so a red class's failure screenshots outlive the next class (never committed: .gitignore)
rm -rf "$rb"
# The device side of "no outside request": once a second the app process's sockets are listed (lsof), so a connection to anything but the relay shows.
: >"$ev/device-net.log"
(while :; do
  pid="$(xcrun simctl spawn "$udid" launchctl list 2>/dev/null | awk -v b="UIKitApplication:$bundle" 'index($0, b) { print $1; exit }')"
  if [ -n "$pid" ] && [ "$pid" != "-" ]; then lsof -nP -a -p "$pid" -i 2>/dev/null | awk 'NR > 1' >>"$ev/device-net.log" || true; fi
  sleep 1
done) 9>&- &
net_pid=$!
set +e
t0=$SECONDS
# F-1395: with StepsUITests, test5 (the Approximate leg) runs in its own pass after the routing service is stopped; the main pass skips it.
main_only="$only"
if runs StepsUITests; then main_only="$only -skip-testing:RightOnTimeUITests/StepsUITests/test5ApproximateLeg"; fi
TEST_RUNNER_BW_RELAY="http://127.0.0.1:$relay_port" TEST_RUNNER_BW_CONTROL="http://127.0.0.1:$control_port" \
  TEST_RUNNER_BW_DEAD="http://127.0.0.1:$dead_port" TEST_RUNNER_BW_JOB="$job" \
  capped "$test_cap" test-without-building xcodebuild test-without-building -workspace "$app/ios/RightOnTime.xcworkspace" -scheme RightOnTime -configuration Release \
  -destination "id=$udid" -derivedDataPath "$build/dd" -resultBundlePath "$rb" $main_only >"$build/xcuitest-full.log" 2>&1
suite=$?
if runs StepsUITests; then
  compose stop routing >/dev/null 2>&1 || true
  echo "routing service for test5: $(compose ps --all --format '{{.Service}} {{.State}}' routing | grep . || echo 'not started')" | tee -a "$ev/steps-setup.txt"
  # With routing up the main pass live-routed Linda's leg and the server STORED it (van_track, build_id live; packages/maps/src/route-source.ts
  # step 2), so test5 would find a track: the legs into Linda's job are removed again, now that routing is down.
  echo "live legs into $next_job removed for test5: $(psql "WITH d AS (DELETE FROM world.van_track WHERE to_ref = '$next_job' RETURNING 1) SELECT count(*) FROM d")" | tee -a "$ev/steps-setup.txt"
  rm -rf "$rb-test5"
  TEST_RUNNER_BW_RELAY="http://127.0.0.1:$relay_port" TEST_RUNNER_BW_CONTROL="http://127.0.0.1:$control_port" \
    TEST_RUNNER_BW_DEAD="http://127.0.0.1:$dead_port" TEST_RUNNER_BW_JOB="$job" \
    capped "$test_cap" test-without-building xcodebuild test-without-building -workspace "$app/ios/RightOnTime.xcworkspace" -scheme RightOnTime -configuration Release \
    -destination "id=$udid" -derivedDataPath "$build/dd" -resultBundlePath "$rb-test5" -only-testing:RightOnTimeUITests/StepsUITests/test5ApproximateLeg >>"$build/xcuitest-full.log" 2>&1
  suite5=$?
  [ "$suite" -ne 0 ] || suite=$suite5
fi
set -e
echo "test-without-building ($tests): exit $suite, $((SECONDS - t0)) s (cap $test_cap s)" | tee -a "$ev/times.txt"
# The full log is scrubbed of the sample password all the same, and only the filtered lines are kept.
PW="$(cat "$tmp/pw")" perl -pi -e 's/\Q$ENV{PW}\E/[sample password]/g' "$build/xcuitest-full.log"
PW="$reviewer_pw" perl -pi -e 's/\Q$ENV{PW}\E/[reviewer password]/g' "$build/xcuitest-full.log"
PW="$(cat "$tmp/pw-off")" perl -pi -e 's/\Q$ENV{PW}\E/[sample password]/g' "$build/xcuitest-full.log"
PW="$(tr -d '\n' <"$tmp/office")" perl -pi -e 's/\Q$ENV{PW}\E/[office token]/g' "$build/xcuitest-full.log"
grep -E '^NATIVE-|Test Case|Executed|\*\* TEST|error:|IDERunDestination|XCTAssert|failed' "$build/xcuitest-full.log" >"$ev/xcuitest.log" || true
step "xcodebuild test exit $suite"
if [ -n "${net_pid:-}" ]; then kill "$net_pid" 2>/dev/null || true; net_pid=""; fi

# ---- the look dumps ------------------------------------------------------------------------------------------------------------------
container="$(xcrun simctl get_app_container "$udid" "$bundle" data)"
rm -rf "$ev/look-dumps"
mkdir -p "$ev/look-dumps"
cp "$container/Documents/bw-look/"*.json "$ev/look-dumps/" 2>/dev/null || true
cp "$container/Documents/bw-look/"*.txt "$ev/look-dumps/" 2>/dev/null || true
step "look dumps: $(ls "$ev/look-dumps" | tr '\n' ' ')"

# ---- the server's ledger: the queued note sent exactly once, and only after the signal returned --------------------------------------
ledger=0
: >"$ev/ledger.txt"
if runs ShellUITests; then
key="$(sed -n 's/^NATIVE-QUEUED key=\([0-9a-f-]\{36\}\)$/\1/p' "$ev/xcuitest.log" | head -1)"
ok=1
{
  echo "queued key: ${key:-none}"
  if [ -n "$key" ]; then
    rows="$(psql "SELECT count(*) FROM world.tech_item WHERE key = '$key'")"
    echo "ledger rows for the key: $rows"
    echo "ledger line: $(psql "SELECT key || ' ' || kind || ' job ' || job_number || ' ' || result FROM world.tech_item WHERE key = '$key'")"
    sends="$(grep -c "RELAY-ITEMS .*keys=.*$key" "$ev/relay.log" || true)"
    echo "API-102 sends through the relay carrying the key: $sends"
    off="$(grep -n 'RELAY-SIGNAL .* off' "$ev/relay.log" | tail -1 | cut -d: -f1)"
    on="$(grep -n 'RELAY-SIGNAL .* on' "$ev/relay.log" | tail -1 | cut -d: -f1)"
    first="$(grep -n "RELAY-ITEMS .*keys=.*$key" "$ev/relay.log" | head -1 | cut -d: -f1)"
    echo "relay log lines: signal off at ${off:-?}, back on at ${on:-?}, the key's send at ${first:-?}"
    if [ "$rows" = "1" ] && [ "$sends" = "1" ] && [ -n "$first" ] && [ -n "$on" ] && [ "$first" -gt "$on" ] && [ "$on" -gt "$off" ]; then ok=0; fi
  fi
  echo "ledger check: $([ "$ok" -eq 0 ] && echo PASS || echo FAIL)"
} | tee -a "$ev/ledger.txt"
# The block above runs in a pipeline's subshell: its verdict is read back from the file it wrote.
grep -q '^ledger check: PASS$' "$ev/ledger.txt" || ledger=1
fi

# ---- JobUITests: the photo queued offline is in the ledger once, was uploaded once (after the relaunch), and is SD-32's JPEG -----------
if runs JobUITests; then
  pkey="$(sed -n 's/^NATIVE-PHOTO-QUEUED key=\([0-9a-f-]\{36\}\)$/\1/p' "$ev/xcuitest.log" | head -1)"
  {
    echo "queued photo key: ${pkey:-none}"
    if [ -n "$pkey" ]; then
      rows="$(psql "SELECT count(*) FROM world.tech_item WHERE key = '$pkey'")"
      echo "ledger rows for the key: $rows"
      echo "ledger line: $(psql "SELECT key || ' ' || kind || ' job ' || job_number || ' ' || result FROM world.tech_item WHERE key = '$pkey'")"
      dims="$(psql "SELECT width || 'x' || height || ' ' || bytes FROM world.photo WHERE key = '$pkey'")"
      echo "stored photo: ${dims:-none} (width x height, bytes); picked: $(cat "$ev/photo-source.txt")"
      puts="$(grep -c "RELAY seq=.* PUT /api/v1/tech/photos/$pkey 2" "$ev/relay.log" || true)"
      echo "API-103 uploads through the relay answered 2xx for the key: $puts"
      relaunched="$(grep -n "^NATIVE-PHOTO-RELAUNCHED-STILL-QUEUED key=$pkey" "$ev/xcuitest.log" | head -1 | cut -d: -f1)"
      sent="$(grep -n "^NATIVE-PHOTO-SENT key=$pkey" "$ev/xcuitest.log" | head -1 | cut -d: -f1)"
      echo "suite lines: still queued after the relaunch at ${relaunched:-?}, shown sent at ${sent:-?}"
      w="${dims%%x*}"; rest="${dims#*x}"; h="${rest%% *}"; b="${dims##* }"
      if [ "$rows" = "1" ] && [ "$puts" = "1" ] && [ -n "$relaunched" ] && [ -n "$sent" ] && [ "$sent" -gt "$relaunched" ] \
        && [ -n "$dims" ] && [ "$w" -le 2048 ] && [ "$h" -le 2048 ] && [ "$b" -le 10485760 ]; then echo "photo ledger check: PASS"; else echo "photo ledger check: FAIL"; fi
    else
      echo "photo ledger check: FAIL"
    fi
    echo "office note (API-140): $(grep -c '^RELAY-OFFICE-NOTE .* 201' "$ev/relay.log" || true) saved; shown on SCR-TEC-04: $(grep -c '^NATIVE-OFFICE-NOTE-SHOWN' "$ev/xcuitest.log" || true)"
  } | tee -a "$ev/ledger.txt"
  grep -q '^photo ledger check: PASS$' "$ev/ledger.txt" || ledger=1
fi
# ---- TodayUITests: every job the suite walked (On my way, Arrived, No one home) is in the ledger once per kind, and nothing else is ----
# The Cancel taps saved and sent nothing, and nothing went out before its confirm (the suite also checks the relay's count at each step).
if runs TodayUITests; then
  walked="$(sed -n 's/^NATIVE-WALKED jobs=\([0-9][0-9]*\)$/\1/p' "$ev/xcuitest.log" | head -1)"
  {
    echo "jobs walked: ${walked:-none}"
    echo "ledger rows: $(psql "SELECT count(*) FROM world.tech_item")"
    have="$(psql "SELECT kind || '=' || count(*) || '/' || count(DISTINCT job_number) FROM world.tech_item GROUP BY kind ORDER BY kind" | tr '\n' ' ' | sed 's/ $//')"
    echo "ledger by kind (rows/jobs): $have"
    echo "ledger results: $(psql "SELECT result || '=' || count(*) FROM world.tech_item GROUP BY result ORDER BY result" | tr '\n' ' ')"
    ok=1
    if [ -n "$walked" ] && [ "$walked" -gt 0 ] && [ "$have" = "arrived=$walked/$walked no_one_home=$walked/$walked on_my_way=$walked/$walked" ]; then ok=0; fi
    echo "today ledger check: $([ "$ok" -eq 0 ] && echo PASS || echo FAIL)"
  } | tee -a "$ev/ledger.txt"
  grep -q '^today ledger check: PASS$' "$ev/ledger.txt" || ledger=1
fi
# ---- WaitingUITests: the 3 notes once each, the refused finish once and applied, and the demo clock where it was --------------------------
if runs WaitingUITests; then
  rkey="$(sed -n 's/^NATIVE-REFUSED-FINISH key=\([0-9a-f-]\{36\}\)$/\1/p' "$ev/xcuitest.log" | head -1)"
  {
    echo "notes in the ledger (rows/keys): $(psql "SELECT count(*) || '/' || count(DISTINCT key) FROM world.tech_item WHERE kind = 'note'")"
    echo "the aged item: $(sed -n 's/^NATIVE-AGED key=//p' "$ev/xcuitest.log" | head -1) (relay: $(grep -c '^RELAY-AGE .*hours=25 keys=.' "$ev/relay.log" || true) aging)"
    echo "demo clock before $clock_before, after $(psql "SELECT demo_anchor || ' ' || rate || ' ' || world_epoch FROM system.demo_clock" 2>/dev/null || echo unread)"
    echo "refused finish key: ${rkey:-none}"
    ok=1
    if [ -n "$rkey" ]; then
      rows="$(psql "SELECT count(*) FROM world.tech_item WHERE key = '$rkey'")"
      echo "ledger line: $(psql "SELECT key || ' ' || kind || ' job ' || job_number || ' ' || result FROM world.tech_item WHERE key = '$rkey'")"
      sends="$(grep -c "RELAY-ITEMS .*keys=.*$rkey" "$ev/relay.log" || true)"
      echo "API-102 sends carrying the key: $sends (the refused one with its parts emptied: $(grep -c '^RELAY-NOPARTS .* finishes=1' "$ev/relay.log" || true))"
      result="$(psql "SELECT result FROM world.tech_item WHERE key = '$rkey'")"
      notes="$(psql "SELECT count(*) || '/' || count(DISTINCT key) FROM world.tech_item WHERE kind = 'note'")"
      if [ "$rows" = "1" ] && [ "$sends" -ge 2 ] && [ "$result" = "applied" ] && [ "$notes" = "3/3" ] && [ "$clock_before" != "unread" ] \
        && [ "$clock_before" = "$(psql "SELECT demo_anchor || ' ' || rate || ' ' || world_epoch FROM system.demo_clock")" ]; then ok=0; fi
    fi
    echo "waiting ledger check: $([ "$ok" -eq 0 ] && echo PASS || echo FAIL)"
  } | tee -a "$ev/ledger.txt"
  grep -q '^waiting ledger check: PASS$' "$ev/ledger.txt" || ledger=1
fi
# ---- StepsUITests: every photo tile read asked for the small copy (UD-55, F-1235), the steps add up to the leg, the leg was unbaked --------
if runs StepsUITests; then
  compose logs --no-color proxy >"$ev/steps-proxy-log.txt" 2>/dev/null || true
  {
    thumbs="$(grep -c '^RELAY-FILE .* size=thumb$' "$ev/relay.log" || true)"
    full="$(grep -c '^RELAY-FILE .* size=full$' "$ev/relay.log" || true)"
    files="$(grep -c '^RELAY-FILE ' "$ev/relay.log" || true)"
    viewers="$(grep -c '^NATIVE-VIEWER-OPENED' "$ev/xcuitest.log" || true)"
    echo "stored photo reads through the relay (API-175): $files, $thumbs with size=thumb, $full of the whole file; viewer opens: $viewers"
    proxy_files="$(grep -c '"method":"GET","uri":"/api/v1/files/' "$ev/steps-proxy-log.txt" || true)"
    echo "server (proxy) log, GET /api/v1/files/ requests: $proxy_files (the relay forwarded $files)"
    sum="$(node -e 'const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).data; process.stdout.write(r.steps.reduce((n, s) => n + s.distanceMeters, 0) + " " + r.leg.distanceMeters)' "$tmp/route.json")"
    echo "the route from the van to $job: the steps' meters and the leg's distanceMeters: $sum (the expected steps' sum $(sed -n 6p "$tmp/steps-en.txt"))"
    echo "baked legs into $next_job now: $(psql "SELECT count(*) FROM world.van_track WHERE to_ref = '$next_job'")"
    ok=1
    if [ "$thumbs" -ge 5 ] && [ "$full" = "$viewers" ] && [ "$viewers" -ge 1 ] && [ "$files" = "$((thumbs + full))" ] && [ "$proxy_files" = "$files" ] \
      && [ "${sum%% *}" = "${sum##* }" ] && [ "${sum%% *}" = "$(sed -n 6p "$tmp/steps-en.txt")" ]; then ok=0; fi
    echo "steps check: $([ "$ok" -eq 0 ] && echo PASS || echo FAIL)"
  } | tee -a "$ev/ledger.txt"
  grep -q '^steps check: PASS$' "$ev/ledger.txt" || ledger=1
fi
if ! runs ShellUITests && ! runs JobUITests && ! runs TodayUITests && ! runs WaitingUITests && ! runs StepsUITests; then
  echo "ledger check: not run (the ledgers belong to ShellUITests, JobUITests, TodayUITests, WaitingUITests and StepsUITests; this run's classes: $tests)" >"$ev/ledger.txt"
fi

# ---- SpanishUITests: the walk's texts against the catalog (ci/native/spanish-walk.ts) ---------------------------------------------------
spanish=0
if runs SpanishUITests; then
  set +e
  node ci/native/spanish-walk.ts --log "$ev/xcuitest.log" >"$ev/spanish-walk.log" 2>&1
  spanish=$?
  set -e
  tail -1 "$ev/spanish-walk.log"
fi

# ---- no outside request (P6-NATIVE-MAP-ME): the relay log, the server's log and the app's sockets ----------------------------------------
net=0
if [[ ",$tests," == *,MapMeUITests,* ]]; then
  net=1
  awk '/RELAY-MARK .* MAP-START/ { on = 1; next } /RELAY-MARK .* MAP-END/ { on = 0 } on' "$ev/relay.log" >"$ev/map-phase-relay.log"
  awk '/RELAY-MARK .* MAP-OFFLINE-START/ { on = 1; next } /RELAY-MARK .* MAP-END/ { on = 0 } on' "$ev/relay.log" >"$ev/map-offline-relay.log"
  # F-1068: the server's side is read once, from the proxy's JSON access log ({"method":"GET","uri":"/maps/..."}, infra/nginx/http.conf log_format bw).
  # The read must have worked: the log holds the request this script's own curl made to /healthz (a positive control), or the run fails.
  compose logs --no-color proxy >"$ev/proxy-log.txt" 2>"$ev/proxy-log.err" || true
  proxy_control="$(grep -c '"method":"GET","uri":"/healthz"' "$ev/proxy-log.txt" || true)"
  proxy_maps="$(grep -c '"method":"GET","uri":"/maps/' "$ev/proxy-log.txt" || true)"
  proxy_assets="$(grep -c '"uri":"/map-assets' "$ev/proxy-log.txt" || true)"
  relay_maps="$(awk '$1 == "RELAY" && $4 == "GET" && $5 ~ /^\/maps\// { n++ } END { print n + 0 }' "$ev/relay.log")"
  {
    echo "relay requests from MAP-START to MAP-END: $(grep -c '^RELAY seq' "$ev/map-phase-relay.log" || true)"
    echo "by method and path:"
    grep '^RELAY seq' "$ev/map-phase-relay.log" | awk '{ print $4, $5, $6 }' | sort | uniq -c | sed 's/^/  /' || true
    # Allowed: the app's own API and the branch file (API-106). Anything else is an outside or unexpected request.
    other="$(grep '^RELAY seq' "$ev/map-phase-relay.log" | awk '{ print $5 }' | grep -Ev '^/api/v1/|^/maps/(columbus|dayton|springfield)\.pmtiles$' || true)"
    echo "requests that are neither the app's API nor the branch file: ${other:-none}"
    echo "branch file requests (first map open only): $(grep -c '^RELAY seq.* /maps/' "$ev/map-phase-relay.log" || true)"
    echo "requests answered while the signal was off (map reopened from the phone's copy): $(grep -c '^RELAY seq' "$ev/map-offline-relay.log" || true)"
    echo "glyph, sprite or tile requests to the relay: $(grep -Ec '/map-assets|\.pbf|/sprites/|/tiles/|openstreetmap' "$ev/relay.log" || true)"
    echo "server (proxy) log read: $(wc -l <"$ev/proxy-log.txt" | tr -d ' ') line(s), $proxy_control positive control request(s) (GET /healthz)"
    echo "server (proxy) log, requests for /map-assets: $proxy_assets"
    echo "server (proxy) log, GET requests for /maps/: $proxy_maps (the relay forwarded $relay_maps)"
    # F-1069: no call with the signed-out person's bearer token between the sign-out probe's marks; the reading is shown to work by the bearer calls before it.
    awk '/RELAY-MARK .* SIGNOUT-PROBE-START/ { on = 1; next } /RELAY-MARK .* SIGNOUT-PROBE-END/ { on = 0 } on' "$ev/relay.log" >"$ev/signout-probe-relay.log"
    probe_start="$(grep -c 'RELAY-MARK .* SIGNOUT-PROBE-START' "$ev/relay.log" || true)"
    probe_end="$(grep -c 'RELAY-MARK .* SIGNOUT-PROBE-END' "$ev/relay.log" || true)"
    bearer_before="$(awk '/RELAY-MARK .* SIGNOUT-PROBE-START/ { exit } /^RELAY seq.* auth=bearer/ { n++ } END { print n + 0 }' "$ev/relay.log")"
    bearer_after="$(grep -c '^RELAY seq.* auth=bearer' "$ev/signout-probe-relay.log" || true)"
    echo "sign-out probe: marks start $probe_start end $probe_end; bearer requests before it: $bearer_before; between its marks: $bearer_after"
    # F-1368: test12's Sign out sent API-06 once, and the relay held it unanswered (do=hold), so the sign-in screen it reached came without an answer.
    held_signout="$(grep -c 'RELAY-RULE .* hold /api/v1/sessions/current' "$ev/relay.log" || true)"
    echo "sign-out with a server that never answers (F-1368): API-06 requests held unanswered: $held_signout (1 expected)"
    echo "app sockets seen (lsof once a second): $(wc -l <"$ev/device-net.log" | tr -d ' ') line(s)"
    echo "remote ends the app connected to:"
    grep -o -- '->[^ ]*' "$ev/device-net.log" | sort | uniq -c | sed 's/^/  /' || true
    peers="$(grep -o -- '->[^ ]*' "$ev/device-net.log" | sort -u | grep -Ev "^->127\.0\.0\.1:($relay_port|$control_port)\$" || true)"
    echo "remote ends that are not the relay (or its control port, which hands the probe its sign-in): ${peers:-none}"
    if [ -z "$other" ] && [ -z "$peers" ] && [ "$(grep -c '^RELAY seq' "$ev/map-offline-relay.log" || true)" = "0" ] \
      && [ "$(grep -Ec '/map-assets|\.pbf|/sprites/|/tiles/|openstreetmap' "$ev/relay.log" || true)" = "0" ] \
      && [ "$proxy_control" -ge 1 ] && [ "$proxy_assets" = "0" ] && [ "$proxy_maps" = "$relay_maps" ] && [ "$relay_maps" -ge 1 ] \
      && [ "$probe_start" = "1" ] && [ "$probe_end" = "1" ] && [ "$bearer_before" -ge 1 ] && [ "$bearer_after" = "0" ] && [ "$held_signout" = "1" ] \
      && [ -s "$ev/device-net.log" ]; then echo "network check: PASS"; else echo "network check: FAIL"; fi
  } | tee "$ev/net-evidence.txt"
  grep -q '^network check: PASS$' "$ev/net-evidence.txt" && net=0 || net=1
fi

# F-1071: the compare set follows the classes this run ran (each class dumps its own cases); BW_NATIVE_COMPARE_SET overrides it.
sets=""
[[ ",$tests," == *,ShellUITests,* ]] && sets="shell"
[[ ",$tests," == *,MapMeUITests,* ]] && sets="${sets:+$sets,}mapme"
[[ ",$tests," == *,JobUITests,* ]] && sets="${sets:+$sets,}job"
[[ ",$tests," == *,TodayUITests,* ]] && sets="${sets:+$sets,}today"
[[ ",$tests," == *,StepsUITests,* ]] && sets="${sets:+$sets,}steps"
look=0
if [ -n "$sets" ] || [ -n "${BW_NATIVE_COMPARE_SET:-}" ]; then
  sets="${BW_NATIVE_COMPARE_SET:-$sets}"
  step "look compare set: $sets"
  set +e
  node ci/look-values/native-compare.ts --dumps "$ev/look-dumps" --set "$sets" >"$ev/native-compare.log" 2>&1
  look=$?
  set -e
  tail -1 "$ev/native-compare.log"
else
  echo "look compare: not run (no look case set for $tests)" >"$ev/native-compare.log"
fi
step "suite $suite, ledger $ledger, network $net, look $look, spanish $spanish (evidence $ev)"
[ "$suite" -eq 0 ] && [ "$ledger" -eq 0 ] && [ "$net" -eq 0 ] && [ "$look" -eq 0 ] && [ "$spanish" -eq 0 ]
