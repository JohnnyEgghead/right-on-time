#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Nightly gate look-values-comparator-nightly (G-LOOK-PARITY; P3-CI-CADENCE; BUILD_PLAN section 3 D-15). The WebKit compare:
# the same self-compare and known-bad proofs as the push gate look-values-comparator (ci/gates/look-values-comparator.sh, Chromium),
# on WebKit through the shared browser config (vitest.browser.config.ts). Owner ruling Nov 2, 2026, "Daily + phase close":
# WebKit moves to nightly. A missing browser fails the gate; it is never skipped.
# Prints "screen-seconds" lines so the per-screen time can be read from the log.
set -euo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
# The narrowing is named, never silent (F-39).
export BW_PW_ENGINES=webkit
export BW_PW_ENGINES_WHY="nightly: this gate is the WebKit half, Chromium runs in look-values-comparator"
exec pnpm exec vitest run --config vitest.browser.config.ts ci/look-values
