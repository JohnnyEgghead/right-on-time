#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI1, inv1-offline-exactly-once (P3-ITEMS server cases; SPECIFICATIONS section 14 item 1, section 5.1; invariant 1;
# FR-TECH-4, FR-TECH-6; UC-03). P5-TWA-OUTBOX adds the client cases (WebKit, a context close) as its own step, step 3.
#   1. No database: the offline conflict table constant held cell for cell to REQUIREMENTS section 4.3 with its planted
#      must-fail cases (ci/gates/G-CI1/table.test.ts, every run), and the classifier, the forward-move rule, the late
#      On my way rule and the re-base (packages/domain/src/techItems.test.ts).
#   2. Real PostgreSQL 18, the production kernel as bw_web, technicians of the reference seed: every one of the 36 cells
#      generated from the typed constant through API-102 or API-103, the 2 variants, a repeated key answering duplicate
#      with nothing applied twice, the must-fail cases of the cell rule (every run), and the item protocol's own tests
#      (exactly once under a race, world_reset, FR-TEXT-19, FR-DEMO-9, finishing, photos and the F-67 file-write case).
#   3. P5-TWA-OUTBOX's client cases (ci/outbox-stack.sh: WebKit and Chromium at 520 x 980 against the Compose stack): a note and a
#      photo saved with the network off survive a closed browser profile and reach the server once; a lost answer is resent and
#      answered duplicate; a validation_failed and a not_found item leave the phone and are listed for the dispatcher (F-562);
#      the waiting count and the 24-hour banner; the service worker's shell opened with no signal.
# Exit 0 only when every step holds; every step runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0

echo "G-CI1 step 1: the conflict table constant and the item rules"
pnpm exec vitest run ci/gates/G-CI1/table.test.ts packages/domain/src/techItems.test.ts || rc=1

echo "G-CI1 step 2: the server cases on PostgreSQL 18"
pnpm exec vitest run --config ci/gates/G-CI1/vitest.db.config.ts || rc=1

echo "G-CI1 step 3: the client cases in WebKit and Chromium against the Compose stack"
bash ci/outbox-stack.sh || rc=1

[ "$rc" -eq 0 ] && echo "G-CI1: ok" || echo "G-CI1: FAIL" >&2
exit "$rc"
