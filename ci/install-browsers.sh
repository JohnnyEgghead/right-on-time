#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# CI browser runtime: installs the Playwright browsers (and their system libraries) matching the repo's
# pinned Playwright, INSIDE a CI container. Generic: any job that runs Playwright calls it.
#   bash ci/install-browsers.sh [chromium] [webkit]      default: chromium webkit
# Refuses to run outside the local wave container (ci/wave-run.sh sets BW_WAVE_CONTAINER=1, and /.dockerenv
# exists only inside a container), so it can never install browsers on this Mac or any host.
# Needs root (apt) and pnpm install already done; browsers go to PLAYWRIGHT_BROWSERS_PATH
# (set by ci/wave-run.sh to a path inside the container).
set -euo pipefail
if [ "${BW_WAVE_CONTAINER:-}" != "1" ] || [ ! -e /.dockerenv ]; then
  echo "install-browsers: refusing to run outside the wave container (ci/wave-run.sh; never on a developer machine)" >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
if [ "$#" -eq 0 ]; then set -- chromium webkit; fi
pnpm exec playwright install --with-deps "$@"
