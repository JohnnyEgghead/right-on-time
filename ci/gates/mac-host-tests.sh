#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate mac-host-tests (K-19, P10-CHECKS; D-34), when nightly, runner mac: infra/tests/seed-harold-photos.test.ts (macOS rsvg-convert and
# sips) and infra/tests/render-session.test.ts (a case-insensitive disk) skip on any other host, so the Linux unit run never proves them.
# This gate runs both on this Mac and fails when any case in the run was skipped, todo or failed, or a file ran no case.
#   bash ci/gates/mac-host-tests.sh [--plant-skip]
# --plant-skip: the known-bad. It adds a third test file with 1 skipped case (removed again at the end); the gate must exit 1.
# Exit: 0 both files ran, 0 skipped. 1 a case skipped or failed, or a file ran nothing. 2 usage. 3 vitest wrote no report.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
plant=0
case "${1:-}" in
  "") ;;
  --plant-skip) plant=1 ;;
  *) echo "mac-host-tests: unknown argument $1" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "mac-host-tests: too many arguments" >&2; exit 2; }
work="$(mktemp -d "${TMPDIR:-/tmp}/bw-mac-host.XXXXXX")"
planted="$root/infra/tests/mac-host-planted-skip.test.ts"
cleanup() { rm -rf "$work"; rm -f "$planted"; }
trap cleanup EXIT
files=(infra/tests/seed-harold-photos.test.ts infra/tests/render-session.test.ts)
if [ "$plant" = 1 ]; then
  printf '%s\n' "import { it } from 'vitest';" "it.skip('planted skip (mac-host-tests --plant-skip)', () => undefined);" > "$planted"
  files+=(infra/tests/mac-host-planted-skip.test.ts)
fi
cd "$root"
pnpm exec vitest run "${files[@]}" --reporter=json --outputFile="$work/report.json" > "$work/vitest.log" 2>&1
vrc=$?
if [ ! -s "$work/report.json" ]; then
  tail -30 "$work/vitest.log" >&2
  echo "mac-host-tests: FAIL vitest wrote no report (exit $vrc)" >&2
  exit 3
fi
node ci/gates/mac-host-tests-check.ts "$work/report.json"
crc=$?
# A red case shows in the report; vitest's own exit is kept too, so a crash that left a partial report is red.
if [ "$crc" = 0 ] && [ "$vrc" != 0 ]; then
  tail -30 "$work/vitest.log" >&2
  echo "mac-host-tests: FAIL vitest exited $vrc though the report is clean" >&2
  exit 1
fi
exit "$crc"
