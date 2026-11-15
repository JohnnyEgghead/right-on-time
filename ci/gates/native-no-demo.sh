#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# native-no-demo (FR-IOS-4; ci/native/native-no-demo.ts): the native app's release JavaScript bundle, made by the command the Xcode build
# phase runs before Hermes compiles it (expo export:embed, --dev false, --minify false), scanned for "demo" in its catalog.
#   bash ci/gates/native-no-demo.sh [--hbc <RightOnTime.app/main.jsbundle>] [--out <dir>]
# --hbc also checks the export against the app the Xcode build shipped (xcuitest/suite.sh passes it on the mac runner).
# Exit: native-no-demo.ts's (0 PASS, 1 FAIL, 2 usage); 3 when the export itself failed.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
hbc=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hbc) hbc="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "native-no-demo: unknown argument $1" >&2; exit 2 ;;
  esac
done
work="${out:-$(mktemp -d "${TMPDIR:-/tmp}/bw-no-demo.XXXXXX")}"
mkdir -p "$work/assets"
# F-1204: the script changes directory below, so a relative --out or --hbc is resolved against the caller's directory here.
work="$(cd "$work" && pwd)"
case "$hbc" in ""|/*) ;; *) hbc="$PWD/$hbc" ;; esac
cd "$root/apps/tech-native"
if ! npx expo export:embed --platform ios --dev false --minify false --entry-file index.ts \
  --bundle-output "$work/main.jsbundle" --assets-dest "$work/assets" >"$work/export.log" 2>&1; then
  tail -20 "$work/export.log" >&2
  echo "native-no-demo: FAIL the bundle export failed (see $work/export.log)"
  exit 3
fi
cd "$root"
node ci/native/native-no-demo.ts --bundle "$work/main.jsbundle" ${hbc:+--hbc "$hbc"}
