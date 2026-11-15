#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate public-files-check, "spdx-header-check, readme-items, copying-ios-present" (P8-PUBLIC-FILES; SPECIFICATIONS section 6.13:
# FR-DIST-2, FR-DIST-4, FR-DIST-5, FR-DIST-7, OI-29, F-321).
#   1. ci/public-files.test.ts: each check against its planted known-bad (a source file with no header, a README with its demo mode
#      item removed, a tree without COPYING.iOS, and the other items), and the real tree.
#   2. The real tree: node ci/public-files.ts all (the 3 checks, LICENSE-DATA.md and the .env.example seed). The tree is what git knows:
#      tracked files and new files that are not ignored, minus scripts/private-paths.txt.
# Both steps run; the gate is red when either was.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0
pnpm exec vitest run ci/public-files.test.ts || rc=1
node ci/public-files.ts all || rc=1
exit "$rc"
