#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI10, inv10-billing-exactly-once (P3-BILLING; SPECIFICATIONS section 14 item 10, invariant 10; FR-BILL-3,
# FR-BILL-8, FR-BILL-11). P3-REPLAY adds its epoch case as its own file under ci/gates/G-CI10/.
#   1. No database: the finish-path check's committed must-fail cases and its run over the real spec, contract table
#      and probe list (ci/gates/G-CI10/cases.test.ts, W-38: every run), and the finishLines validator and invoice
#      composition (@bw/domain).
#   2. Real PostgreSQL 18, pbs over real HTTP as bw_pbs, the billing link as bw_worker: a late success then a retry
#      leaves 1 invoice (scaled, and at production timing: the real 30 s timeout against the real 60 s hold), Mark
#      fixed records 1 entered-by-hand invoice, every finish path refuses neither parts nor No parts used (and every
#      registered finish probe), an old epoch is answered wrong_epoch and never stored, a No one home job makes no
#      billing item; plus pbs's and the billing link's own database tests.
# Exit 0 only when every step holds; every step runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0

echo "G-CI10 step 1: committed cases, the finish-path check, finishLines and invoice composition"
pnpm exec vitest run ci/gates/G-CI10/cases.test.ts packages/domain/src/finishLines.test.ts packages/domain/src/invoice.test.ts || rc=1

echo "G-CI10 step 2: pbs and the billing link on PostgreSQL 18"
pnpm exec vitest run --config ci/gates/G-CI10/vitest.db.config.ts || rc=1

[ "$rc" -eq 0 ] && echo "G-CI10: ok" || echo "G-CI10: FAIL" >&2
exit "$rc"
