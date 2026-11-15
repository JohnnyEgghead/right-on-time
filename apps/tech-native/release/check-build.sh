#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# F-1223: the build number the TestFlight archive carries is app.json ios.buildNumber (expo prebuild writes it into Info.plist as a
# literal CFBundleVersion; an xcodebuild CURRENT_PROJECT_VERSION override has no effect). This checks a number against the state it names.
# Usage: check-build.sh app-json <n> [app.json]      exit 2 when ios.buildNumber is not <n> (run before any archive)
#        check-build.sh plist <n> <plist> [key]      exit 2 when the plist's CFBundleVersion (or [key], a PlistBuddy path; python3 plistlib stands in where PlistBuddy is absent) is not <n>
set -euo pipefail
mode="${1:?usage: check-build.sh app-json|plist <n> <file> [key]}"
n="${2:?usage: check-build.sh app-json|plist <n> <file> [key]}"
here="$(cd "$(dirname "$0")" && pwd)"
case "$mode" in
  app-json)
    file="${3:-$here/../app.json}"
    got="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["expo"]["ios"]["buildNumber"])' "$file")"
    what="app.json ios.buildNumber ($file)"
    ;;
  plist)
    file="${3:?plist path}"
    if [ -x /usr/libexec/PlistBuddy ]; then
      got="$(/usr/libexec/PlistBuddy -c "Print :${4:-CFBundleVersion}" "$file")"
    else
      # No PlistBuddy off macOS (the Linux CI image): plistlib reads XML and binary plists; [key] is a colon path, as for PlistBuddy.
      got="$(python3 -I -c 'import plistlib,sys; v=plistlib.load(open(sys.argv[1],"rb"))
for k in sys.argv[2].split(":"): v=v[k]
print(v)' "$file" "${4:-CFBundleVersion}")"
    fi
    what="${4:-CFBundleVersion} in $file"
    ;;
  *) echo "check-build: unknown mode $mode" >&2; exit 2 ;;
esac
if [ "$got" != "$n" ]; then
  echo "check-build: FAIL $what is $got, not $n (set app.json ios.buildNumber to \"$n\" and run again)" >&2
  exit 2
fi
echo "check-build: $what is $n"
