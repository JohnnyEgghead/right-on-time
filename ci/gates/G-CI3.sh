#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI3, inv3-one-technician-capacity (P3-OFFICE-WRITES; SPECIFICATIONS section 14 item 3, section 5.3; invariant 3;
# FR-DISP-6, FR-BOOK-3; D15).
#   1. The barrier races on PostgreSQL 18 (ci/gates/G-CI3/barrier.db.test.ts), through the real router as bw_web: 2
#      requests held at their first lock and released together, on the same job, on the last place in a window and on
#      the same block; exactly 1 commits each round. Its must-fail case (every run): the same barrier over a write with
#      no lock lets both commit, so the harness is not vacuous.
#      P4-ADMIN-WINDOWS adds ci/gates/G-CI3/window-writes.db.test.ts: a capacity edit (API-155) or a day switch (API-91) against the booking,
#      the reschedule and the assign that decide on those values, each order forced and asserted (the 1st request held inside its lock, the
#      2nd seen queued on the booking-day row): the window never holds more than its capacity, and a write behind a switch sees the switch
#      (FR-BOOK-17, FR-BOOK-2, F-745, F-746). Its must-fail case: an edit with no lock, after the booking counted, overfills the window.
#   2. The capacity model and day planner the writes decide with (packages/domain, pure).
# The online booking race (P5-BOOKING) runs on the same locks (packages/api-server/src/office-writes/locks.ts).
# Exit 0 only when every step holds; every step runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0

echo "G-CI3 step 1: the barrier races on PostgreSQL 18"
pnpm exec vitest run --config ci/gates/G-CI3/vitest.db.config.ts || rc=1

echo "G-CI3 step 2: the capacity model and the day planner"
pnpm exec vitest run packages/domain || rc=1

[ "$rc" -eq 0 ] && echo "G-CI3: ok" || echo "G-CI3: FAIL" >&2
exit "$rc"
