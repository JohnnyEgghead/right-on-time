#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Exports the archive with manual signing (the Apple Distribution certificate in the login keychain and the "Right On Time App Store"
# profile, release/ExportOptions-manual.template.plist), and with "upload" also sends it to App Store Connect, TestFlight internal only.
# Usage: bash apps/tech-native/release/export-upload.sh export|upload [evidence-dir]
#   export: signs the archive into apps/tech-native/build/export/ (nothing leaves this Mac).
#   upload: the same plist with destination upload, so Apple receives the build. It is never submitted for review and
#           never released: the plist sets testFlightInternalTestingOnly, and no step here touches a version or a review.
# F-1621 (owner answer dedc3b70, "Keep them private"): the committed plist is a template with no team id. Each run writes the real one,
# apps/tech-native/build/ExportOptions-<mode>.plist (ignored by git), with BW_APPLE_TEAM_ID from the environment or the owner's private
# file (infra/drill/owner-env.sh); without a team id nothing runs (exit 2).
# The issuer id, the key id and the team id are redacted from all output by release/xcb-asc.sh. Exit: the xcodebuild exit; 2 on usage.
set -euo pipefail
mode="${1:?usage: export-upload.sh export|upload [evidence-dir]}"
case "$mode" in export|upload) ;; *) echo "export-upload: mode must be export or upload" >&2; exit 2 ;; esac
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
if [ "$mode" = "upload" ]; then dest=upload; else dest=export; fi
(umask 077 && sed -e "s#<string>BW_APPLE_TEAM_ID</string>#<string>$team</string>#" -e "s#<string>export</string>#<string>$dest</string>#" "$template" >"$plist")
if [ "$(grep -c -F "<string>$team</string>" "$plist")" != 1 ] || grep -q -F '<string>BW_APPLE_TEAM_ID</string>' "$plist"; then
  echo "export-upload: the generated plist does not hold the team id exactly once" >&2; exit 2
fi
grep -q "<string>$dest</string>" "$plist" || { echo "export-upload: the generated plist has no $dest destination" >&2; exit 2; }
[ -d "$app/build/RightOnTime.xcarchive" ] || { echo "export-upload: no archive; run release/archive.sh first" >&2; exit 2; }
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
