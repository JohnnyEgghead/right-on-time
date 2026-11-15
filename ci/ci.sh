#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The CI entry (BUILD_PLAN P1-GATES). Runs the gate map ci/gates.json through ci/run-gates.ts.
#   ci/ci.sh             merge set (gates tagged when: merge)
#   ci/ci.sh --all       the push set (the wave run): every gate except the when: nightly ones, then ci-time-check.py
#   ci/ci.sh --nightly   every gate unscoped, the when: nightly ones too (not the when: checkpoint ones), then ci-time-check.py
#   ci/ci.sh --checkpoint   the nightly set plus the when: checkpoint ones (owner answer 24ad46b5, F-1410)
#   ci/ci.sh --gates <ids>   only the named gates (unscoped)
#   ci/ci.sh --records   only the gates with reads: globs
# Writes .build/ci/ci-verdict.json. `pnpm run ci` calls this script.
set -euo pipefail
# F-164: the release-asset data files (.build/data, git-ignored) must be present and verified before any gate runs.
# A verified copy is kept (no download); a missing or bad one is fetched, else this stops loudly. Not for --records.
case " $* " in
  *" --records "*) ;;
  *) node "$(dirname "$0")/data-assets.ts" ensure ;;
esac
exec node "$(dirname "$0")/run-gates.ts" "$@"
