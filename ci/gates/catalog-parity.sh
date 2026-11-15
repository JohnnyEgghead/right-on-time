#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Merge gate catalog-parity (BUILD_PLAN P2-I18N; D-16; FR-LANG-2).
#   1. The real catalog pair must pass: every key in both languages, no empty or English-equal
#      Spanish value outside the allowlist, both files key-sorted with 1 key per line.
#   2. The proofs run every time, so the gate shows it can fail: the planted English-only key, the
#      2 planted branch merges (different keys; 1 key set 2 ways), the missing-key render, and the
#      planted JSX literal for no-inline-strings.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && cd .. && pwd)"
cd "$root"

node packages/i18n/scripts/catalog-parity.ts
exec pnpm exec vitest run packages/i18n ci/eslint/no-inline-strings.test.ts
