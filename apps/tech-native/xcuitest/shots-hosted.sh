#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The App Store screenshots from the hosted site (F-1718, P8-APPSTORE): ScreenshotsUITests in the iOS Simulator with the app on its own
# default server, https://bw.j7l.io (no -bwServer), signed in as Maria Santos (employee 40712). The local Compose stack run.sh starts has no
# routing service up and is built from the phase 5 tag, so its Directions shot said steps were not available and its Me shot showed
# 127.0.0.1. The relay here only hands the app's probe the sign-in (control port); the app's own traffic is HTTPS to the hosted site and the
# shots only view screens (no job state is changed on the shared site). Maria's password is worked out at run time from SAMPLE_PASSWORD_SEED
# in the owner's private file (SD-9, as asc-listing.mjs does) into this process's environment: never printed, never a launch argument.
#   BW_SIM_UDID=<simulator> bash apps/tech-native/xcuitest/shots-hosted.sh <shots-dir> [<evidence-dir>]
# It runs the test bundle in apps/tech-native/build/dd: build it first (xcodebuild build-for-testing, as run.sh does).
set -euo pipefail
app="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$app/../.." && pwd)"
shots="${1:?usage: shots-hosted.sh <shots-dir> [<evidence-dir>]}"
ev="${2:-$root/.build/evidence/native-runs/shots-hosted-$$}"
udid="${BW_SIM_UDID:?BW_SIM_UDID is the simulator of the size the listing needs}"
bundle="com.johnloring.rightontime"
secrets="${BW_HOSTED_SECRETS:-$HOME/.brightwater-owner/hosted-secrets.env}"
mkdir -p "$ev" "$shots"
[ -f "$secrets" ] || { echo "shots-hosted: no secrets file $secrets" >&2; exit 2; }
pw="$(SECRETS="$secrets" node -e '
const { createHmac } = require("node:crypto");
const { readFileSync } = require("node:fs");
const line = readFileSync(process.env.SECRETS, "utf8").split("\n").filter((l) => l.startsWith("SAMPLE_PASSWORD_SEED=")).pop() ?? "";
const seed = line.slice("SAMPLE_PASSWORD_SEED=".length).trim();
if (!seed) process.exit(3);
const C = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let out = "", acc = 0, bits = 0;
for (const b of createHmac("sha256", seed).update("maria.santos@brightwater.example").digest()) {
  acc = (acc << 8) | b; bits += 8;
  while (bits >= 5) { out += C[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  acc &= (1 << bits) - 1;
}
process.stdout.write(out.slice(0, 5) + "-" + out.slice(5, 10));
')" || { echo "shots-hosted: no SAMPLE_PASSWORD_SEED in $secrets" >&2; exit 2; }
[ -d "$app/build/dd" ] || { echo "shots-hosted: no test build in $app/build/dd" >&2; exit 2; }
freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
relay_port="$(freeport)"; control_port="$(freeport)"
relay_pid=""
cleanup() { [ -z "$relay_pid" ] || kill "$relay_pid" 2>/dev/null || true; }
trap cleanup EXIT
. "$app/xcuitest/sim-lock.sh"
sim_lock_take "$udid" "ScreenshotsUITests hosted from $root" || exit $?

: >"$ev/relay.log"
BW_PROBE_LOGIN="40712" BW_PROBE_PASSWORD="$pw" BW_SIM_UDID="$udid" BW_APP_BUNDLE="$bundle" \
  node "$app/xcuitest/signal-relay.mjs" "$relay_port" "$control_port" "https://bw.j7l.io" "$ev/relay.log" 9>&- &
relay_pid=$!
curl -fsS --retry 20 --retry-connrefused --retry-delay 0 -o /dev/null "http://127.0.0.1:$control_port/signal/on"
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl uninstall "$udid" "$bundle" 2>/dev/null || true
xcrun simctl keychain "$udid" reset 2>/dev/null || true
rb="$ev/shots-hosted.xcresult"
rm -rf "$rb"
set +e
TEST_RUNNER_BW_CONTROL="http://127.0.0.1:$control_port" TEST_RUNNER_BW_SHOTS="$shots" \
  xcodebuild test-without-building -workspace "$app/ios/RightOnTime.xcworkspace" -scheme RightOnTime -configuration Release \
  -destination "id=$udid" -derivedDataPath "$app/build/dd" -resultBundlePath "$rb" -only-testing:RightOnTimeUITests/ScreenshotsUITests >"$ev/xcuitest-full.log" 2>&1
rc=$?
set -e
PW="$pw" perl -pi -e 's/\Q$ENV{PW}\E/[password]/g' "$ev/xcuitest-full.log" "$ev/relay.log"
grep -E '^NATIVE-|Test Case .*(passed|failed)|\*\* TEST' "$ev/xcuitest-full.log" >"$ev/xcuitest.log" || true
cat "$ev/xcuitest.log"
echo "shots-hosted: exit $rc"
if grep -qF -e "$pw" "$ev"/*.log; then echo "shots-hosted: FAIL the password is in a log" >&2; exit 1; fi
exit "$rc"
