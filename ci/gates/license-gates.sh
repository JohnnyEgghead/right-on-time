#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate license-gates (G-LICENSE; SPECIFICATIONS SD-39, FR-DIST-6, HC-07): license-inventory and ios-bundle-copyleft over the
# resolved pnpm tree, then the proofs: each planted known-bad (ci/gates/license-gates/cases) must fail for its stated reason.
# Needs only the committed lockfile install (pnpm install --frozen-lockfile); no network at run time.
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
pnpm exec vitest run ci/license-gates.test.ts
# The real tree runs once, here and nowhere else (it needs expo export, 3 to 8 s: too heavy for the merge-tier vitest gate, F-82).
# The run's own output is the record: the real tree must pass, and the section 14 record must reach the output with SPDX IDs.
# F-92: the output is printed before a failed run can abort the script, and checked with here-strings, not a pipe
# (grep -q exits on its first match, so a pipe could take SIGPIPE on output past one write and report a present line as missing).
rc=0
out="$(node ci/license-gates.ts all)" || rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || exit "$rc"
# An npm entry prints PENDING until its package lands in the lockfile and VERIFIED after (F-91), so either state passes;
# a retired entry (F-1163) prints RETIRED, and the inventory itself fails if its package lands.
want=(
  'build-verified native map library \(React Native binding\): MIT VERIFIED against @maplibre/maplibre-react-native@'
  'build-verified native map library \(MapLibre Native iOS\): BSD-2-Clause PENDING \(Swift Package Manager, outside the npm tree'
  'build-verified react-native-webview: MIT (VERIFIED against react-native-webview@|PENDING|RETIRED \(not shipped: )'
  'build-verified expo-secure-store: MIT (VERIFIED against expo-secure-store@|PENDING)'
  'build-verified vector-tile decoder: BSD-3-Clause (VERIFIED against |PENDING)'
  'build-verified certbot: Apache-2.0 PENDING'
  'build-verified photo small copy \(SD-32\): Apache-2.0 VERIFIED against sharp@'
  '^never-shipped '
  'build-verified live routing \(SD-49\): BSD-2-Clause PENDING \(container, outside the npm tree'
)
for w in "${want[@]}"; do
  grep -qE "$w" <<<"$out" || { echo "license-gates: FAIL section 14 record missing from the real-tree output: $w" >&2; exit 1; }
done
