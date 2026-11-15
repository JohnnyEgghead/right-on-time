#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The TestFlight archive (P6-TESTFLIGHT): generates the iOS project in release mode, archives it, runs the release proof on the archive.
# Usage, from anywhere: bash apps/tech-native/release/archive.sh <build-number> [evidence-dir]
#   <build-number> is the CFBundleVersion: it must be higher than every build App Store Connect holds (node release/asc.mjs builds).
# Steps (each failing step stops the script with its own exit; the step name is printed first):
#   1. xcuitest/prebuild.sh --release --if-stale: BW_RELEASE=1 leaves the look reader out of the BwLook pod (F-988); the map folder comes in
#      through plugins/with-map-assets.js (F-1073); the Pods acknowledgments are checked (F-86).
#   2. xcodebuild archive through release/xcb-asc.sh, with EXPO_PUBLIC_BW_RIG unset, so the bundle step leaves the probe and the look
#      reader out of the JavaScript (F-988, F-1111, F-1088). The issuer id is redacted from the saved log.
#   3. release/check-seams.py on the archive: no seam strings in the bundle or the binary, the glyph and sprite set in the app.
# The archive is at apps/tech-native/build/RightOnTime.xcarchive. Nothing leaves this Mac here; release/export-upload.sh does that.
set -euo pipefail
n="${1:?usage: archive.sh <build-number> [evidence-dir]}"
case "$n" in ''|*[!0-9]*) echo "archive: the build number must be an integer, got $n" >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "$here/.." && pwd)"
root="$(cd "$app/../.." && pwd)"
ev="${2:-$root/.build/evidence/P6-TESTFLIGHT}"
mkdir -p "$ev"
ev="$(cd "$ev" && pwd)"   # F-1365: absolute, so the later cd into the app's ios folder keeps the log paths valid
unset EXPO_PUBLIC_BW_RIG BW_RIG
[ -z "${EXPO_PUBLIC_BW_RIG:-}" ] || { echo "archive: EXPO_PUBLIC_BW_RIG is set; a release bundle must be made without it" >&2; exit 2; }

# F-1223: the number is app.json ios.buildNumber (prebuild writes it as CFBundleVersion); refuse before any work when it differs.
bash "$here/check-build.sh" app-json "$n" "$app/app.json" || { echo "archive: FAIL app.json does not name build $n" >&2; exit 2; }

echo "archive: step 1 prebuild --release"
set +e
bash "$app/xcuitest/prebuild.sh" --release --if-stale >"$ev/01-prebuild.log" 2>&1
rc=$?
set -e
tail -n 3 "$ev/01-prebuild.log"
[ "$rc" -eq 0 ] || { echo "archive: FAIL prebuild exited $rc (see $ev/01-prebuild.log)" >&2; exit "$rc"; }
bash "$here/check-build.sh" plist "$n" "$app/ios/RightOnTime/Info.plist" || { echo "archive: FAIL the generated Info.plist is not build $n" >&2; exit 2; }

echo "archive: step 2 xcodebuild archive, build number $n"
rm -rf "$app/build/RightOnTime.xcarchive"
cd "$app/ios"
set +e
"$here/xcb-asc.sh" archive -workspace RightOnTime.xcworkspace -scheme RightOnTime -configuration Release -destination generic/platform=iOS \
  -archivePath ../build/RightOnTime.xcarchive >"$ev/02-archive-full.log" 2>&1
rc=$?
set -e
grep -E 'error:|\*\* ARCHIVE|xcb-asc: xcodebuild exit' "$ev/02-archive-full.log" >"$ev/02-archive.filtered.log" || true
tail -n 5 "$ev/02-archive.filtered.log"
[ "$rc" -eq 0 ] || { echo "archive: FAIL xcodebuild archive exited $rc (see $ev/02-archive.filtered.log)" >&2; exit "$rc"; }

echo "archive: step 3 release proof"
set +e
python3 "$here/check-seams.py" "$app/build/RightOnTime.xcarchive" >"$ev/03-check-seams.txt" 2>&1
rc=$?
set -e
cat "$ev/03-check-seams.txt"
[ "$rc" -eq 0 ] || { echo "archive: FAIL the release proof exited $rc" >&2; exit "$rc"; }
/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$app/build/RightOnTime.xcarchive/Info.plist"
# F-1223: the OK line names the archive's own CFBundleVersion, read back here, never the argument alone.
bash "$here/check-build.sh" plist "$n" "$app/build/RightOnTime.xcarchive/Info.plist" ApplicationProperties:CFBundleVersion || { echo "archive: FAIL the archive is not build $n" >&2; exit 2; }
echo "archive: OK build $n"
