#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate privacy-secret-scan, "privacy scan, secret-scan" (P7-SCANS; NFR-05, NFR-14; SPECIFICATIONS section 11.5 Secrets, SD-40).
# The catalog maps this id to the secret-scan half; the privacy scan half is G-CI6 (ci/gates/G-CI6.sh), which runs the end-to-end stack.
#   1. The pin and config tests: gitleaks pinned to 8.30.1 with a SHA-256 per platform; the allowances are path plus rule id, never a string.
#   2. The F-341 allowance probes on synthetic trees (the published sample seed in .env.example is allowed; the same value in any other path,
#      and any other rule in .env.example, still fail).
#   3. gitleaks over the publish set of HEAD (what scripts/publish.sh --dry-run lists, planning files removed): 0 hits, then the same export
#      with 1 planted test secret, which must be found, and found alone. HEAD is the committed tree: commit first.
# gitleaks is installed by ci/gitleaks/install.ts from ci/gitleaks/pin.json (checksum-verified), here as on the Mac and in the CI image.
# Exit 0 only when every step holds; every step runs even after a red one. P8-PUBLISH's re-scan: node ci/secret-scan/scan.ts run --ref <release ref>.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
rc=0

echo "privacy-secret-scan step 1: the pin and config tests"
pnpm exec vitest run ci/gitleaks ci/secret-scan || rc=1

echo "privacy-secret-scan step 2: the F-341 allowance probes"
node ci/secret-scan/scan.ts allowance || rc=1

echo "privacy-secret-scan step 3: gitleaks over the publish set, and the planted test secret"
node ci/secret-scan/scan.ts run --plant || rc=1

[ "$rc" -eq 0 ] && echo "privacy-secret-scan: ok" || echo "privacy-secret-scan: FAIL" >&2
exit "$rc"
