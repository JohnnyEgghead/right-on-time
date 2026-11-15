#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI5, inv5-location-window (P5-LIVEMAP activates; P3-POSITIONS added the server case; P5-INBOX adds its preview case; SPECIFICATIONS section 14
# item 5, invariant 5; FR-TEXT-4, FR-TEXT-22, FR-TEXT-23; NFR-04): a technician's location is shared from On my way until arrival and at no other time.
#   1. No database: every case file in ci/gates/G-CI5/ by glob except the database ones (ci/gates/G-CI5/**/*.test.ts): the position case of
#      P3-POSITIONS (visitPosition answers a point only while the job is on the way, and reads no coordinate otherwise), and this lane's committed cases
#      (the link-ended rule, and the data row of API-116 reading no coordinate once the link has ended). A later lane adds its own file there and never
#      edits this script.
#   2. Real PostgreSQL 18 through the production web kernel (ci/gates/G-CI5/vitest.db.config.ts, every ci/gates/G-CI5/**/*.db.test.ts): before On my way,
#      after arrival and after the office cancels, reassigns or reschedules a trip in progress, the live map page and its data answer 410 with no
#      coordinate; while the van is on the way the data answers the van, the minutes, when it left, the van number and the office phone.
#   3. The live map on the Compose stack on Chromium and WebKit (ci/livemap-stack.sh): the same answers from the real stack, WebKit and Chromium back and
#      forward after arrival showing the ended page, the Visit changed page after each office change, and the live map drawn with the outside-origin
#      guard on and 0 outside requests (FR-MAP-1).
# The known-bad (a data read that answers coordinates after arrival) was planted once at acceptance (owner ruling cf3b79ea: no standing sabotage job; F-73);
# the record is .build/evidence/P5-LIVEMAP/.
# Exit 0 only when every step holds; every step runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0

echo "G-CI5 step 1: the committed cases, no database"
pnpm exec vitest run --project unit ci/gates/G-CI5/ || rc=1

echo "G-CI5 step 2: the live map's page and data on PostgreSQL 18"
pnpm exec vitest run --config ci/gates/G-CI5/vitest.db.config.ts || rc=1

echo "G-CI5 step 3: the live map on the Compose stack, Chromium and WebKit"
bash ci/livemap-stack.sh || rc=1

[ "$rc" -eq 0 ] && echo "G-CI5: ok" || echo "G-CI5: FAIL" >&2
exit "$rc"
