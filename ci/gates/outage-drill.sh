#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate outage-drill, "outage drill (monitor)" (P8-OUTAGE-DRILL; NFR-11, SD-37; BUILD_PLAN section 7: a 12-minute planned outage the
# monitor must record). The drill itself stops the hosted app and reads UptimeRobot, so it never runs here. The gate checks its instrument
# and its record:
#   1. infra/tests/outage-drill.test.ts: the UptimeRobot answer parser and verdict against planted answers (0 outages, 2 outages, an open
#      outage, a bad duration and a failed healthz each FAIL), and the driver run for real with stubbed ssh and curl (no server, no
#      monitor, no key).
#   2. The record docs/build/spikes/P8-OUTAGE-DRILL.md reads "Verdict: PASS - ": the monitor recorded the drill as an outage. The public
#      export (F-1612) keeps no record, so only there is this step skipped, and it says so. In the private repo a missing record is red
#      (F-1685), and a record that is present must read PASS. A tree that is neither side (ci/tree-kind.sh) exits 2.
# Both steps run; the gate is red when either was.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
. ci/tree-kind.sh
kind="$(bw_tree_kind .)" || { echo "outage-drill: cannot tell the private repo from the public export (some private-only paths are present, some missing)" >&2; exit 2; }
rc=0
pnpm exec vitest run infra/tests/outage-drill.test.ts || rc=1
record=docs/build/spikes/P8-OUTAGE-DRILL.md
if [ ! -e "$record" ] && [ "$kind" = private ]; then
  echo "outage-drill: $record is absent in the private repo (the drill is not recorded)" >&2
  rc=1
elif [ ! -e "$record" ]; then
  echo "outage-drill: $record is absent (a public copy keeps no drill record); the record check is skipped"
elif grep -q '^Verdict: PASS - ' "$record"; then
  echo "outage-drill: $record reads Verdict: PASS"
else
  echo "outage-drill: $record does not read Verdict: PASS (the drill is not recorded as an outage)" >&2
  rc=1
fi
exit "$rc"
