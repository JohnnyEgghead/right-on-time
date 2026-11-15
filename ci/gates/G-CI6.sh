#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI6, inv6-no-pii-in-links-logs (P7-SCANS; SPECIFICATIONS section 11.4 and section 14 item 6, invariant 6; NFR-05).
#   1. No stack: the scanner's committed tests (ci/privacy-scan/scan.test.ts): phone and address forms, no noise on times and ids, the empty-population
#      failures, and a planted log line holding a customer phone that fails the scan.
#   2. The full P7-E2E run (ci/e2e-stack.sh: the 7-step happy path on Chromium and WebKit against a local copy of the stack), then, before the
#      teardown, the privacy scan over every container log, every customer phone and address in the database and every issued link. The scan
#      proves itself in the same run on planted lines (a phone with and without the area code, an address) and fails an empty population.
# Exit 0 only when both hold; both run even after a red 1. Needs docker for step 2 (ci/e2e-stack.sh exits 3 without it: a red).
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0

echo "G-CI6 step 1: the privacy scanner's committed cases"
pnpm exec vitest run ci/privacy-scan/scan.test.ts || rc=1

echo "G-CI6 step 2: the full end-to-end run, then the privacy scan over its logs, links and database"
BW_E2E_PRIVACY_SCAN=1 bash ci/e2e-stack.sh || rc=1

[ "$rc" -eq 0 ] && echo "G-CI6: ok" || echo "G-CI6: FAIL" >&2
exit "$rc"
