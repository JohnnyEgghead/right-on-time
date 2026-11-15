#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI8, inv8-one-message (P2-SMS built the check; P3-TEXTS activates it over the real templates; SPECIFICATIONS
# section 14 item 8, section 6.4 and SD-17; invariant 8; FR-TEXT-9, FR-TEXT-18).
#   1. text-budget-check (packages/outbox/src/testing/text-budget-check.ts, with --require-templates so an empty template
#      set exits 2, never a pass): the 10 must-fail arms every run (the 5 FR-TEXT-9 fail inputs: "Llegará", 161 GSM-7
#      characters, a curly apostrophe, a skipped Saturday, a Spanish "Sáb"; then an extension-table character, an empty slot
#      list, a formatted placeholder, a fixed copy 1 over budget at the SD-17 maxima, and a Spanish confirmation 1 over its 106-character fixed-copy budget), then the 5 real templates x both
#      languages x every real slot value (every service label, window, date, technician name, arrival time, link, branch
#      phone and weekday, Saturday included), each GSM-7 basic and 1 message, and the fixed copy at the maxima.
#   2. The text tests: @bw/sms (the counter and the check), the slot formatter and the real-template tests in
#      packages/outbox (every rendered text holds the text link host and no other host, FR-TEXT-18; the name in texts
#      refusal, FR-TEXT-11), and the catalog lint (curly quotes, packages/i18n).
#   3. The office half (P4-JOB, F-443): API-143 through its real route on PostgreSQL 18 queues 160 GSM-7 characters as 1
#      text and refuses the 161st with message_too_long and no text row (ci/gates/G-CI8/office-text.db.test.ts); and (P4-TECHNICIANS,
#      FR-TEXT-11) API-33 through its real route refuses a name in texts outside GSM-7 or over 10 characters with the problem and keeps the
#      stored name (ci/gates/G-CI8/name-in-texts.db.test.ts).
# Exit 0 only when every step holds; every step runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0

echo "G-CI8 step 1: text-budget-check over the real templates and slot values"
node packages/outbox/src/testing/text-budget-check.ts --require-templates || rc=1

echo "G-CI8 step 2: the text tests"
pnpm exec vitest run packages/sms packages/outbox/src/slots.test.ts packages/outbox/src/templates.test.ts packages/outbox/src/name-in-texts.test.ts packages/i18n/src/parity.test.ts || rc=1

echo "G-CI8 step 3: the office text's 161st character refused through API-143, and a technician name that breaks 1 message refused through API-33, on PostgreSQL 18 (F-443, P4-TECHNICIANS)"
pnpm exec vitest run --config ci/gates/G-CI8/vitest.db.config.ts || rc=1

[ "$rc" -eq 0 ] && echo "G-CI8: ok" || echo "G-CI8: FAIL" >&2
exit "$rc"
