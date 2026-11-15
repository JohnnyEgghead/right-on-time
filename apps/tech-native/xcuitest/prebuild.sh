#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Generates the iOS project (Expo continuous native generation: ios/ is never committed), adds the XCUITest target and installs the
# pods. Run from anywhere: bash apps/tech-native/xcuitest/prebuild.sh [--if-stale]
# F-1207: a checkout may have no ios/ (a fresh clone, or the main tree the nightly mac half runs in), or one generated from older
# inputs (add-uitests.rb keeps an existing test target as it is, so a suite file written later is not in it). The last step writes
# the inputs' key to ios/.bw-prebuild-key. With --if-stale this script does nothing when ios/ holds the key of the current inputs
# (and the workspace and build/map-assets are there), and otherwise generates both again; run.sh's build step calls it so. The key
# is a sha-256 over the path and content of each input file (inputs() below). It is keyed on content, not mtimes: a git checkout or
# a copied folder sets mtimes that say nothing about which inputs a prebuild read.
# F-1073: the map's glyph and sprite folder is added by the Expo config plugin plugins/with-map-assets.js (app.json), inside expo prebuild, so
# the rig's build and the TestFlight archive have it alike; an empty or missing set stops the prebuild. F-988: --release generates the project
# for the TestFlight archive: BW_RELEASE=1 for pod install leaves the look reader out of the BwLook pod (it is compiled only under BW_RIG).
# The mode is part of the key, so a rig project and a release project never stand in for each other. F-86: the last step checks the Pods
# acknowledgments (node ci/license-gates.ts pods), which fails on an absent input.
# Exit: 0 when ios/ is current or was generated; else the failing step's exit (its output is above the exit).
set -euo pipefail
app="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$app/../.." && pwd)"
# The inputs of the generated ios/ and build/map-assets, relative to the repo root: this script and the 2 project edits; the Expo
# config and what prebuild reads for it (the icon and fonts under assets/, the plugins' versions in package.json and the lockfile);
# the local native modules' module and pod specs; and the map's glyph and sprite set. The suite files count by name only: run.sh
# copies each one's content into ios/ on every build, and the test target's file list is what add-uitests.rb fixes. A missing
# input is an error (find fails), never a key.
# (errexit does not reach into a command substitution, so each step's failure is passed on by hand.)
inputs() {
  find apps/tech-native/xcuitest/prebuild.sh apps/tech-native/xcuitest/add-uitests.rb \
    apps/tech-native/app.json apps/tech-native/app.config.js apps/tech-native/release/owner-env.cjs apps/tech-native/package.json pnpm-lock.yaml apps/tech-native/assets apps/tech-native/plugins apps/web/src/map/assets \
    -type f ! -name .DS_Store -print0 || return 1
  find apps/tech-native/modules \( -name expo-module.config.json -o -name '*.podspec' \) -type f -print0
}
key() {
  local sums
  cd "$root" || return 1
  sums="$(inputs | LC_ALL=C sort -z | xargs -0 shasum -a 256)" || return 1
  # F-1217: the local modules' podspecs take source_files from a glob that pod install expands, so the module source file names count (names
  # only, like the suite files: an edited body is rebuilt); the toolchain that generates and builds ios/ counts by its versions.
  {
    printf '%s\n' "$sums"; printf 'mode %s\n' "$mode"; printf 'suite file %s\n' apps/tech-native/xcuitest/*UITests.swift
    printf 'module file %s\n' $(find apps/tech-native/modules -path '*/ios/*' -type f ! -name .DS_Store | LC_ALL=C sort)
    printf 'xcodebuild %s\n' "$(xcodebuild -version 2>&1 | tr '\n' ' ')"
    printf 'pod %s\n' "$(pod --version 2>&1 | tr '\n' ' ')"
  } | shasum -a 256 | cut -c1-64
}
mode=rig
stale=no
for a in "$@"; do
  case "$a" in
    --if-stale) stale=yes ;;
    --release) mode=release ;;
    *) echo "prebuild: unknown argument $a" >&2; exit 2 ;;
  esac
done
want="$(key)" || { echo "prebuild: FAIL could not read the inputs (the error is above)" >&2; exit 1; }
stamp="$app/ios/.bw-prebuild-key"
if [ "$stale" = "yes" ]; then
  if [ ! -d "$app/ios" ]; then why="there is no ios/"
  elif [ ! -f "$stamp" ]; then why="ios/ has no prebuild key (generated before F-1207, or by a prebuild that did not finish)"
  elif [ "$(cat "$stamp")" != "$want" ]; then why="ios/ was generated from other inputs (key $(cut -c1-12 "$stamp"), the inputs now ${want:0:12})"
  elif [ ! -d "$app/ios/RightOnTime.xcworkspace" ]; then why="ios/ has no RightOnTime.xcworkspace"
  elif [ ! -d "$app/ios/map-assets/fonts" ] || [ ! -d "$app/ios/map-assets/sprites" ]; then why="ios/map-assets is missing"
  else
    echo "prebuild: ios/ is current (key ${want:0:12}), not generated again"
    exit 0
  fi
  echo "prebuild: generating ios/: $why"
fi
# F-1216: the key hashes pnpm-lock.yaml, but expo reads node_modules: a main tree that was never installed since the lockfile changed would
# generate ios/ from older plugins and stamp it with the new key. Installed here, only when ios/ is generated, so a current ios/ costs nothing.
(cd "$root" && pnpm install --frozen-lockfile --prefer-offline) || { echo "prebuild: FAIL pnpm install --frozen-lockfile exited $? (the error is above)" >&2; exit 1; }
cd "$app"
if [ "$mode" = "release" ]; then rel=1; else rel=0; fi
# F-1621: BW_RELEASE reaches app.config.js too, which refuses a release project without the owner's team id.
BW_RELEASE="$rel" CI=1 npx expo prebuild --platform ios --clean --no-install
BW_RELEASE="$rel" GEM_HOME="$(brew --prefix cocoapods)/libexec" ruby xcuitest/add-uitests.rb
cd ios
if [ "$mode" = "release" ]; then BW_RELEASE=1 pod install; else BW_RELEASE=0 pod install; fi
cd "$root"
node ci/license-gates.ts pods || { echo "prebuild: FAIL the CocoaPods acknowledgments check (node ci/license-gates.ts pods) exited $? (F-86)" >&2; exit 1; }
# Written last, so a prebuild stopped part way leaves no key and the next --if-stale generates ios/ again.
echo "$want" >"$stamp"
echo "prebuild: generated ios/ (key ${want:0:12}, mode $mode)"
