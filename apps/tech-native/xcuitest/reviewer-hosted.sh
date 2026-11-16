#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The FR-IOS-5 test against the hosted site (P8-APPSTORE): ReviewerUITests in the iOS Simulator, the app's server the signal relay and the
# relay's upstream https://bw.j7l.io, where the access code is on. The reviewer's password is read at run time into this process's
# environment: from BW_REVIEWER_PASSWORD, else from the REVIEWER_PASSWORD line of the owner's private file (BW_HOSTED_SECRETS, default
# ~/.brightwater-owner/hosted-secrets.env). It is never printed, never a launch argument, and the logs are scrubbed of it.
#   bash apps/tech-native/xcuitest/reviewer-hosted.sh [<evidence-dir>]
# It runs the test bundle run.sh built (apps/tech-native/build/dd): run bash apps/tech-native/xcuitest/run.sh with BW_NATIVE_TESTS=ReviewerUITests
# first (the local stack run), which builds it. Env: BW_SIM_UDID, BW_HOSTED_ORIGIN (default https://bw.j7l.io).
set -euo pipefail
app="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$app/../.." && pwd)"
ev="${1:-$root/.build/evidence/native-runs/reviewer-hosted-$$}"
udid="${BW_SIM_UDID:-43F6C8A4-67D0-4623-B356-C4F71A2ABA21}"
bundle="com.johnloring.rightontime"
origin="${BW_HOSTED_ORIGIN:-https://bw.j7l.io}"
secrets="${BW_HOSTED_SECRETS:-$HOME/.brightwater-owner/hosted-secrets.env}"
mkdir -p "$ev"
pw="${BW_REVIEWER_PASSWORD:-}"
if [ -z "$pw" ] && [ -f "$secrets" ]; then pw="$(grep -E '^REVIEWER_PASSWORD=' "$secrets" | tail -1 | cut -d= -f2-)"; fi
[ -n "$pw" ] || { echo "reviewer-hosted: no reviewer password (BW_REVIEWER_PASSWORD, or REVIEWER_PASSWORD in $secrets)" >&2; exit 2; }
[ -d "$app/build/dd" ] || { echo "reviewer-hosted: no test build in $app/build/dd (run xcuitest/run.sh with BW_NATIVE_TESTS=ReviewerUITests first)" >&2; exit 2; }
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
relay_port="$(freeport)"; control_port="$(freeport)"
relay_pid=""
cleanup() { [ -z "$relay_pid" ] || kill "$relay_pid" 2>/dev/null || true; }
trap cleanup EXIT
. "$app/xcuitest/sim-lock.sh"
sim_lock_take "$udid" "ReviewerUITests hosted from $root" || exit $?

: >"$ev/relay.log"
BW_REVIEWER_LOGIN="reviewer@brightwater.example" BW_REVIEWER_PASSWORD="$pw" BW_SIM_UDID="$udid" BW_APP_BUNDLE="$bundle" \
  node "$app/xcuitest/signal-relay.mjs" "$relay_port" "$control_port" "$origin" "$ev/relay.log" 9>&- &
relay_pid=$!
curl -fsS --retry 20 --retry-connrefused --retry-delay 0 -o /dev/null "http://127.0.0.1:$control_port/signal/on"
echo "reviewer-hosted: relay on $relay_port to $origin"

xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl uninstall "$udid" "$bundle" 2>/dev/null || true
xcrun simctl keychain "$udid" reset 2>/dev/null || true
rb="$ev/reviewer-hosted.xcresult"
rm -rf "$rb"
set +e
TEST_RUNNER_BW_RELAY="http://127.0.0.1:$relay_port" TEST_RUNNER_BW_CONTROL="http://127.0.0.1:$control_port" \
  xcodebuild test-without-building -workspace "$app/ios/RightOnTime.xcworkspace" -scheme RightOnTime -configuration Release \
  -destination "id=$udid" -derivedDataPath "$app/build/dd" -resultBundlePath "$rb" -only-testing:RightOnTimeUITests/ReviewerUITests >"$ev/xcuitest-full.log" 2>&1
rc=$?
set -e
PW="$pw" perl -pi -e 's/\Q$ENV{PW}\E/[reviewer password]/g' "$ev/xcuitest-full.log" "$ev/relay.log"
grep -E '^NATIVE-|Test Case .*(passed|failed)|\*\* TEST' "$ev/xcuitest-full.log" >"$ev/xcuitest.log" || true
cat "$ev/xcuitest.log"
echo "reviewer-hosted: exit $rc against $origin"
if grep -qF -e "$pw" "$ev"/*.log; then echo "reviewer-hosted: FAIL the password is in a log" >&2; exit 1; fi
exit "$rc"
