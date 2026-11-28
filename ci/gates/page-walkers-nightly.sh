#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Nightly gate page-walkers-nightly (P3-CI-CADENCE; BUILD_PLAN section 3 D-15, section 7 gate map). Owner ruling Nov 2, 2026,
# "Daily + phase close": "WebKit and the all-screens Spanish and overflow passes move to nightly." The push half is page-walkers
# (ci/gates/page-walkers.sh: Chromium only, the English passes on every built screen, the walkers' proofs, the stack suites).
#   1. WebKit: the walkers' proofs and the page walk on every built screen with tap-target-44, outside-origin-guard and overflow-pass
#      (P10-NIGHTLY-SPEED, owner answer 400ec3ba: axe-scan and spanish-fallback-pass run on Chromium only): ci/page-walkers on
#      vitest.browser.config.ts, BW_PW_ENGINES=webkit.
#   2. Chromium: the all-screens Spanish and overflow passes the push half leaves out (BW_APP_WALK_PASSES=spanish).
#   3. WebKit: the stack suites that drive a browser, one after the other and never side by side (F-290): ci/shell-stack.sh (with
#      the clock banner suite), ci/auth-stack.sh and ci/billing-stack.sh (P4-BILLING-UI, F-595: its Acceptance names Chromium and
#      WebKit; the push half runs it on Chromium), (P4-BOARD) ci/board-stack.sh, (P4-JOB, with P4-NEWJOB's suite after it on the same stack) ci/job-stack.sh, (P4-ADMIN-WINDOWS) ci/windows-stack.sh and (P4-REPORTS) ci/reports-stack.sh and (P5-BOOKING, F-943) ci/booking-stack.sh and (P5-INBOX, F-967) ci/inbox-stack.sh and (P5-TWA-MAP-ME) ci/mapme-stack.sh. The events stack (ci/events-stack.sh) drives no
#      browser and stays in the push half.
#   4. (F-519) ci/import-stack.sh: the P3-IMPORT-WORKER stack suite (API-80 to done with the setup counts, API-81 moving, EVT-08 per
#      change, the killed and restarted worker, 3 killed attempts then failed, the planted generator byte). It fetches the map
#      files itself (setup needs MAPS_DIR). Nightly only: the push time is unchanged.
#   5. (P4-ADMIN-IMPORT) ci/import-ui-stack.sh: the import pages in Playwright on Chromium and WebKit against the Compose stack after a fresh
#      setup (the history lists setup's run; a dry run through the page changes no row count; M, K and S act only with focus on the
#      shown pair; Undo restores the customer; on a world with no real run Run the import is offered). Both engines, in the 1 project.
#   6. (P4-CLOCK) ci/clock-ui-stack.sh: UC-10 on the demo clock page in Playwright on Chromium and WebKit against the Compose stack after a
#      fresh setup, with the access code and demo mode on as named settings (the code, the sample manager's sign-in, the 6:00 PM jump with
#      the due reminders in order and the banner naming the mover, the daylight-saving presets, and Reset the demo world after its cool-down).
#   7. (P5-TWA-TODAY) ci/today-stack.sh: the web technician app's sign-in, Today and confirm steps in Playwright on Chromium and WebKit at
#      520 x 980 against the Compose stack after a fresh setup (the day in order with the van and progress, On my way sent only after the
#      confirm step, a No one home visit in the report, a reassigned job Scheduled in the new technician's API-100, the empty day of the reviewer).
#   9. (P7-CLOSE, F-1534) ci/training-stack.sh: the 10-task dispatcher walkthrough of docs/public/walkthrough.md, run from its written steps in
#      Playwright on Chromium and WebKit (its own 2 engines) against the Compose stack after a fresh setup, so a screen or label change
#      that breaks the walkthrough goes red.
# Needs Playwright browsers and docker (the wave run's own engine). A missing browser or docker is a red, never a skip. Headless only.
# Each step runs to the end; the gate is red when any step was.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
rc=0

# The job page draws CMP-05; its walker rows read the map files (app-wiring.ts maps: true), fetched or verified here.
node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps >/dev/null
echo "page-walkers-nightly step 1: the walkers and every pass on every built screen, WebKit"
BW_PW_ENGINES=webkit BW_PW_ENGINES_WHY="nightly: this step is the WebKit half" \
  pnpm exec vitest run --config vitest.browser.config.ts ci/page-walkers || rc=1

echo "page-walkers-nightly step 2: the Spanish and overflow passes on every built screen, Chromium"
BW_PW_ENGINES=chromium BW_PW_ENGINES_WHY="nightly: the Chromium half of the walkers ran in page-walkers" BW_APP_WALK_PASSES=spanish \
  pnpm exec vitest run --config vitest.browser.config.ts ci/page-walkers/app.pw.test.ts || rc=1

echo "page-walkers-nightly step 3: the shell stack, the auth stack, the billing stack, the board stack, the health stack, the messages stack, the job stack, the windows stack, the reports stack, the booking stack, the inbox stack and the map and Me stack, WebKit"
export BW_PW_ENGINES=webkit BW_PW_ENGINES_WHY="nightly: the stack suites that drive a browser, WebKit half"
bash ci/shell-stack.sh || rc=1
bash ci/auth-stack.sh || rc=1
bash ci/billing-stack.sh || rc=1
bash ci/board-stack.sh || rc=1
bash ci/health-stack.sh || rc=1
bash ci/messages-stack.sh || rc=1
bash ci/job-stack.sh || rc=1
bash ci/windows-stack.sh || rc=1
bash ci/reports-stack.sh || rc=1
bash ci/booking-stack.sh || rc=1
bash ci/inbox-stack.sh || rc=1
bash ci/mapme-stack.sh || rc=1
unset BW_PW_ENGINES BW_PW_ENGINES_WHY

echo "page-walkers-nightly step 4: the import stack suite (F-519)"
bash ci/import-stack.sh || rc=1

echo "page-walkers-nightly step 5: the import pages on the Compose stack (P4-ADMIN-IMPORT)"
bash ci/import-ui-stack.sh || rc=1

echo "page-walkers-nightly step 6: the demo clock page on the Compose stack (P4-CLOCK)"
bash ci/clock-ui-stack.sh || rc=1

echo "page-walkers-nightly step 7: the web technician app on the Compose stack (P5-TWA-TODAY)"
bash ci/today-stack.sh || rc=1

echo "page-walkers-nightly step 8: the web technician app's job screens on the Compose stack (P5-TWA-JOB, F-1038)"
bash ci/tech-job-stack.sh || rc=1

echo "page-walkers-nightly step 9: the training walkthrough on the Compose stack (P7-TRAINING, F-1534)"
bash ci/training-stack.sh || rc=1

[ "$rc" -eq 0 ] && echo "page-walkers-nightly: ok" || echo "page-walkers-nightly: FAIL" >&2
exit "$rc"
