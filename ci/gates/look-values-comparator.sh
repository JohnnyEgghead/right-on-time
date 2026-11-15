#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate look-values-comparator (G-LOOK-PARITY): runs the self-compare and known-bad proofs on Chromium through the shared
# browser config (vitest.browser.config.ts). This is the push half (P3-CI-CADENCE; owner ruling Nov 2, 2026, "Daily + phase
# close": "At the wave, run page-walkers and look-values-comparator on Chromium only"); the WebKit compare is the nightly gate
# look-values-comparator-nightly (ci/gates/look-values-comparator-nightly.sh). Wave-run only: browsers live in the
# wave container, never in the merge set. A missing browser fails the gate; it is never skipped.
# Prints "screen-seconds" lines so the per-screen time can be read from the log.
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
# The narrowing is named, never silent (F-39).
export BW_PW_ENGINES=chromium
export BW_PW_ENGINES_WHY="push set: WebKit is the nightly gate look-values-comparator-nightly (P3-CI-CADENCE)"
exec pnpm exec vitest run --config vitest.browser.config.ts ci/look-values
