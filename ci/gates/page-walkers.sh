#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Wave gate page-walkers (BUILD_PLAN P1-PAGE-GATES): axe-scan, tap-target-44, outside-origin-guard,
# spanish-fallback-pass, overflow-pass. The PUSH half (P3-CI-CADENCE; owner ruling Nov 2, 2026, "Daily + phase close": "At the
# wave, run page-walkers and look-values-comparator on Chromium only ... WebKit and the all-screens Spanish and overflow passes
# move to nightly"): Chromium only, and on every built screen the English passes (axe-scan, tap-target-44, outside-origin-guard).
# The WebKit walk and the all-screens Spanish and overflow passes are the nightly gate page-walkers-nightly
# (ci/gates/page-walkers-nightly.sh). The proofs of each walker (the planted known-bads) still run here, on Chromium.
#   1. Select the page-inventory rows whose phase is at or before the current phase AND whose building task (the row's
#      task field) is merged (F-154: a page is checked from the moment its task merges). The current phase is BW_PHASE
#      when set, else 1 plus the highest merged CP<n> task; no default, an unreadable phase exits 2. "Merged" is read by
#      the same function as the phase (readMergedTasks: Task trailers on the integration branch plus done checkpoints).
#      Rows still waiting on an unmerged task are printed by task, never hidden. Red: a row of an EARLIER phase whose
#      task is unmerged; a row whose task is not a "#### <ID> -" heading in docs/BUILD_PLAN.md; a merged row with no
#      app wiring. An empty selection is stated.
#      Tests only: BW_MERGED_TASKS="P2-AUTH,P2-SHELL" replaces the merged set (and so the derived phase).
#   2. Run the proofs every time: each walker must flag its planted known-bad and pass its clean fixture.
#      A known-bad that is not flagged fails the test, so the gate is red.
# Needs Playwright browsers (the CI browser job image, or a local install). Headless only.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
# The 2 narrowings are named, never silent (F-39): the engine list carries its reason into every stack suite below.
export BW_PW_ENGINES=chromium
export BW_PW_ENGINES_WHY="push set: WebKit is the nightly gate page-walkers-nightly (P3-CI-CADENCE)"
export BW_APP_WALK_PASSES=english

node ci/page-walkers/run-inventory.ts
# The job page draws CMP-05; its walker rows read the map files (app-wiring.ts maps: true), fetched or verified here.
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps >/dev/null
pnpm exec vitest run --config vitest.browser.config.ts ci/page-walkers
#   3. (P2-SHELL) The shell against the Compose stack at its default settings: ci/shell-stack.sh (needs docker; the wave
#      run's own engine, F-126). No docker is a red (exit 3), never a skip.
#   4. (P2-AUTH) The sign-in screens against the Compose stack with ACCESS_CODE_ON=on, DEMO_MODE off and then on, in 1 project:
#      ci/auth-stack.sh. Each runs to the end; the gate is red when any step was.
#   5. (P3-EVENTS, F-348) The event bus and the event stream (API-09) against the Compose stack at its default settings:
#      ci/events-stack.sh (a notify through publishEvent as bw_worker reaches 2 streams; a 30 s drop reconnects and re-reads
#      API-10 through the client cache; an epoch change empties the cache). The stack suites' gate, as for steps 3 and 4.
#   6. (P4-BILLING-UI) The billing list, Mark fixed and the pretend billing screens against the Compose stack at its default settings:
#      ci/billing-stack.sh (Playwright on Chromium here, the BW_PW_ENGINES above; its WebKit half is step 3 of the nightly gate
#      page-walkers-nightly, F-595; the outside-origin guard on: UC-20 clears the list with Retry all and Mark fixed, a finished job
#      shows on API-60 while billing is Down, the sample invoice totals $132.65, the export equals the page's rows, the list follows the
#      top bar's branch).
#   7. (P4-BOARD) The day board against the Compose stack at its default settings, set up by the setup service (the seeded
#      world): ci/board-stack.sh (2 dispatchers moving the same job and the same block at once, the drop preview, the
#      flagged items, the late and at-risk words at 2:00 PM). The stack suites' gate, as for steps 3 to 6.
#   8. (P4-HEALTH) System health and the alert bell against the Compose stack at its default settings, set up by the setup service:
#      ci/health-stack.sh (UC-06 for real: All sends fail, the 5th failure raises the bell by 1 and names the customer, a bell-off type
#      leaves the count unchanged and is still listed, Check now sets Last check to the demo time, Simulator up lets the next send go out).
#   9. (P4-MESSAGES) The Messages text log and call list against the Compose stack at its default settings: ci/messages-stack.sh (the 5th
#      failed try puts the customer on the call list, Try now at 10:00 PM is held to 8:00 AM, a visit booked at 7:15 PM gets its reminder at
#      once and a texts-off customer is on the call list, the call outcomes, the export equals the log). The stack suites' gate, as for steps 3 to 8.
#  10. (P4-JOB) The job page against the Compose stack at its default settings, set up by the setup service (the seeded world):
#      ci/job-stack.sh (UC-17 on Harold Jenkins's job while Maria is on the way, the On the way rulings end to end, SCR-OFC-23's
#      time_overlap and window_full messages, the role-gated controls). The stack suites' gate, as for steps 3 to 9.
#      (P4-NEWJOB) The same step then runs the new job page's suite on that stack (ci/newjob-stack: a Sep 15 job at 5:01 PM on Sep 14,
#      a customer made from the page and the Spanish confirmation in the inbox, the SD-26 order, Not suggested, the reschedule's new
#      confirmation, the Comfort Club words on 4 pages): no second bring-up, so it adds only its own suite seconds to step 10.
#      (P4-CUSTOMER-ACTIONS) Then the customer page's suite on the same stack (ci/customer-actions-stack: Add equipment, Add note and Text
#      on Harold Jenkins's page, Text off with its reason and texts_off, the zone save moving the 6:00 PM reminder, Open text inbox, Also
#      found in jobs with the search text in no URL or log, and last the next-day visit of a texts-off customer on API-42's call list).
#  11. (P4-ADMIN-WINDOWS) The arrival windows page against the Compose stack at its default settings, set up by the setup service (the seeded
#      world): ci/windows-stack.sh (UC-13: Wed, Sep 16 switched to 4-hour windows while a 10 AM-12 PM booking holds that day, which keeps its
#      window on the board, its job page and its reminder text; a capacity below the bookings refused and the booking past a saved capacity
#      refused; the Saturday rule; the week board's day-mode link). The stack suites' gate, as for steps 3 to 10.
#  12. (P4-REPORTS) The Reports page against the Compose stack at its default settings, set up by the setup service (the seeded world):
#      ci/reports-stack.sh (every report number of the generated pilot rows equals an independent SQL query, the page prints the
#      Simulated pilot data label and those numbers in both languages, the filters, the chart tips and data tables, the export equals
#      the page's rows, a live No one home visit raises its week, the top bar's Reports item opens the page for the manager only).
#      The stack suites' gate, as for steps 3 to 11.
#  13. (P5-BOOKING, F-943) The online booking site (SCR-CUS-01 to SCR-CUS-03) against the Compose stack at its default settings, set up by the
#      setup service (the seeded world): ci/booking-stack.sh (Playwright on Chromium here, the BW_PW_ENGINES above; its WebKit half is step 3 of the
#      nightly gate page-walkers-nightly). The stack suites' gate, as for steps 3 to 12.
#  14. (P5-INBOX, F-967) The customer's text inbox and Change your visit time (SCR-INB-01, SCR-CUS-06) against the Compose stack at its default
#      settings, set up by the setup service (the seeded world): ci/inbox-stack.sh (Playwright on Chromium here, the BW_PW_ENGINES above; its
#      WebKit half is step 3 of the nightly gate page-walkers-nightly). The stack suites' gate, as for steps 3 to 13.
#  15. (P5-TWA-MAP-ME) The web technician app's Map tab, Directions, Parts, Me and install page (SCR-TEC-15, -08, -16, -10, -11) against the Compose stack
#      at its default settings, set up by the setup service (the seeded world): ci/mapme-stack.sh (Playwright on Chromium here, the BW_PW_ENGINES above;
#      its WebKit half is step 3 of the nightly gate page-walkers-nightly). The stack suites' gate, as for steps 3 to 14.
# Steps 3 to 15 run one after the other, never side by side (F-290): the browsers share the run engine's network namespace,
# so one project's bring-up or teardown adds and removes interfaces under the other's browsers, and Chromium then fails a
# page load with net::ERR_NETWORK_CHANGED (measured: .build/evidence/F-290/wave-run-7ead420.log). The gate's own time limit
# (ci/gates.json timeoutS) covers the sum.
rc=0
bash ci/shell-stack.sh || rc=$?
bash ci/auth-stack.sh || rc=$?
bash ci/events-stack.sh || rc=$?
bash ci/billing-stack.sh || rc=$?
bash ci/board-stack.sh || rc=$?
bash ci/health-stack.sh || rc=$?
bash ci/messages-stack.sh || rc=$?
bash ci/job-stack.sh || rc=$?
bash ci/windows-stack.sh || rc=$?
bash ci/reports-stack.sh || rc=$?
bash ci/booking-stack.sh || rc=$?
bash ci/inbox-stack.sh || rc=$?
bash ci/mapme-stack.sh || rc=$?
exit "$rc"
