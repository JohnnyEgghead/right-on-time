#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Wave gate catalog-review (BUILD_PLAN P7-SPANISH; FR-LANG-4, OA-45: Spanish copy is reviewed by agents only).
#   1. Every Spanish catalog value holds a pass record from an agent other than the one that wrote it (the author is read
#      from git blame and the commit trailers, never from the record), (the gate runs --strict, so a pending key fails it; main holds none).
#   2. The proofs run every time, so the gate shows it can fail: a planted self-review, a stale record, a missing record.
# Exit 2 from the check (a shallow clone: git cannot say who wrote a value) fails the gate; fetch full history, never skip.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && cd .. && pwd)"
cd "$root"

node packages/i18n/scripts/catalog-review.ts --strict
exec pnpm exec vitest run packages/i18n/src/catalog-review.test.ts
