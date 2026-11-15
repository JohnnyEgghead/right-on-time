#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate G-CI7, inv7-deny-by-default (P2-KERNEL; SPECIFICATIONS section 14 item 7, invariant 7; FR-AUTH-1).
#   1. The committed must-fail cases (ci/gates/G-CI7/cases.test.ts, W-38: every run): a contract row, an app page file
#      and an inventory page with no policy entry, an entry whose access disagrees with the spec (page and API), and
#      mount given a planted handler with no entry, each refused for its stated reason.
#   2. The role-by-route test over the real policy table, handlers and route registries: every contract row, every
#      page-inventory row of a phase before the phase under certification, or of that phase once its task is merged (the
#      phase is derived from the merged Task trailers, F-585; rows read from acceptance/page-inventory.json) and every page
#      entry, each principal (signed out, manager, office, technician, Sign in as) with the access code off, on and
#      entered, through the mounted router and the page gate; plus the kernel's own unit tests. Steps 2 and 3 run with fetch refusing
#      any host that is not loopback (ci/gates/G-CI7/outside-fetch-guard.ts, F-683), so a handler that calls a service by host name
#      fails at once instead of stalling on a lookup (F-643).
#   3. The kernel on the real database (PostgreSQL 18): SQL sessions, the process logins at the access wall, and the
#      production kernel as bw_web.
# Exit 0 only when every step holds; every step runs even after a red one.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0

echo "G-CI7 step 1: committed must-fail cases"
pnpm exec vitest run ci/gates/G-CI7/cases.test.ts || rc=1

echo "G-CI7 step 2: the role-by-route test and the kernel unit tests"
pnpm exec vitest run --config ci/gates/G-CI7/vitest.config.ts || rc=1

echo "G-CI7 step 3: the kernel on PostgreSQL 18"
pnpm exec vitest run --config ci/gates/G-CI7/vitest.db.config.ts || rc=1

[ "$rc" -eq 0 ] && echo "G-CI7: ok" || echo "G-CI7: FAIL" >&2
exit "$rc"
