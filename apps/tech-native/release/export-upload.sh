#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Exports the archive with manual signing (the Apple Distribution certificate in the login keychain and the "Right On Time App Store"
# profile, release/ExportOptions-manual.template.plist), and with "upload" or "store" also sends it to App Store Connect.
# Usage: bash apps/tech-native/release/export-upload.sh export|upload|store [evidence-dir]
#   export: signs the archive into apps/tech-native/build/export/ (nothing leaves this Mac).
#   upload: the same plist with destination upload, so Apple receives the build for TestFlight internal testing only
#           (testFlightInternalTestingOnly true: buildAudienceType INTERNAL_ONLY). It is never submitted for review and never released.
#   store:  destination upload with testFlightInternalTestingOnly false (F-1721), so the build is APP_STORE_ELIGIBLE and can be attached to an
#           App Store version. An INTERNAL_ONLY build cannot: Apple answers 409 "pre-release build could not be added". Still no step here
#           touches a version or a review; the owner attaches and submits with release/asc-listing.mjs.
# F-1621 (owner answer dedc3b70, "Keep them private"): the committed plist is a template with no team id. Each run writes the real one,
# apps/tech-native/build/ExportOptions-<mode>.plist (ignored by git), with BW_APPLE_TEAM_ID from the environment or the owner's private
# file (infra/drill/owner-env.sh); without a team id nothing runs (exit 2).
# The issuer id, the key id and the team id are redacted from all output by release/xcb-asc.sh. Exit: the xcodebuild exit; 2 on usage.
set -euo pipefail
mode="${1:?usage: export-upload.sh export|upload|store [evidence-dir]}"
case "$mode" in export|upload|store) ;; *) echo "export-upload: mode must be export, upload or store" >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "$here/.." && pwd)"
root="$(cd "$app/../.." && pwd)"
ev="${2:-$root/.build/evidence/P6-TESTFLIGHT}"
mkdir -p "$ev"
ev="$(cd "$ev" && pwd)"   # F-1365: absolute, so the later cd into the app's ios folder keeps the log paths valid
# shellcheck source=../../../infra/drill/owner-env.sh
. "$root/infra/drill/owner-env.sh"
bw_owner_env "$root"
team="${BW_APPLE_TEAM_ID:-}"
[[ "$team" =~ ^[A-Z0-9]{10}$ ]] || { echo "export-upload: BW_APPLE_TEAM_ID (the Apple team id, 10 capitals or digits) is not set: set it in the environment or put the line BW_APPLE_TEAM_ID=<team id> in the owner's private file; nothing run (F-1621)" >&2; exit 2; }
template="$here/ExportOptions-manual.template.plist"
plist="$app/build/ExportOptions-$mode.plist"
mkdir -p "$app/build"
if [ "$mode" = "export" ]; then dest="export"; else dest="upload"; fi
if [ "$mode" = "store" ]; then internal='<false/>'; else internal='<true/>'; fi
(umask 077 && sed -e "s#<string>BW_APPLE_TEAM_ID</string>#<string>$team</string>#" -e "s#<string>export</string>#<string>$dest</string>#" -e "s#<BW_INTERNAL_TESTING_ONLY/>#$internal#" "$template" >"$plist")
{ grep -q -F "$internal" "$plist" && ! grep -q -F 'BW_INTERNAL_TESTING_ONLY/>' "$plist"; } || { echo "export-upload: the generated plist does not set testFlightInternalTestingOnly" >&2; exit 2; }
if [ "$(grep -c -F "<string>$team</string>" "$plist")" != 1 ] || grep -q -F '<string>BW_APPLE_TEAM_ID</string>' "$plist"; then
  echo "export-upload: the generated plist does not hold the team id exactly once" >&2; exit 2
fi
grep -q "<string>$dest</string>" "$plist" || { echo "export-upload: the generated plist has no $dest destination" >&2; exit 2; }
[ -d "$app/build/RightOnTime.xcarchive" ] || { echo "export-upload: no archive; run release/archive.sh first" >&2; exit 2; }
# F-1832: a build that reaches App Store Connect cannot be deleted, so before any upload the archive on disk must be the one app.json names.
# BW_PLISTBUDDY is a seam for the tests (PlistBuddy exists only on macOS).
if [ "$mode" != export ]; then
  pb="${BW_PLISTBUDDY:-/usr/libexec/PlistBuddy}"
  arch_plist="$app/build/RightOnTime.xcarchive/Info.plist"
  [ -f "$arch_plist" ] || { echo "export-upload: the archive has no Info.plist; nothing uploaded; run release/archive.sh first" >&2; exit 2; }
  arch_ver="$("$pb" -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$arch_plist" 2>/dev/null || true)"
  arch_build="$("$pb" -c 'Print :ApplicationProperties:CFBundleVersion' "$arch_plist" 2>/dev/null || true)"
  want_ver="$(node -p "require('$app/app.json').expo.version")"
  want_build="$(node -p "require('$app/app.json').expo.ios.buildNumber")"
  if [ -z "$arch_ver" ] || [ -z "$arch_build" ] || [ "$arch_ver" != "$want_ver" ] || [ "$arch_build" != "$want_build" ]; then
    echo "export-upload: the archive is version ${arch_ver:-unknown} build ${arch_build:-unknown} but app.json says version $want_ver build $want_build; nothing uploaded; run release/archive.sh first" >&2; exit 2
  fi
fi
rm -rf "$app/build/export"
cd "$app/ios"
set +e
"$here/xcb-asc.sh" -exportArchive -archivePath ../build/RightOnTime.xcarchive -exportPath ../build/export -exportOptionsPlist "$plist" >"$ev/04-$mode-full.log" 2>&1
rc=$?
set -e
grep -E 'error:|\*\* EXPORT|Upload succeeded|Uploaded|warning: .*dSYM|xcb-asc: xcodebuild exit' "$ev/04-$mode-full.log" >"$ev/04-$mode.filtered.log" || true
tail -n 8 "$ev/04-$mode.filtered.log"
echo "export-upload: $mode exit $rc"
exit "$rc"
