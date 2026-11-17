#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Gate public-copy-tests (P9-AUDIT-PUBLIC; F-1852, audit J-09; BUILD_PLAN section 3 D-27): the unit suite passes on the public copy.
# The public export leaves out the private paths (scripts/private-paths.txt: mockups/, docs/UI-SPECIFICATION.md, .build/ and more),
# and README tells a developer to run pnpm run test there, so a test that reads a private path with no guard fails a public copy.
#   1. scripts/publish.sh --dry-run --out <a temp folder>: the export of HEAD, with no tag and no release rewrite. The dry run only
#      reads this repo (git archive of HEAD) and writes its --out and --list, both under this gate's temp folder; it pushes nothing.
#   2. The export as a public clone has it: 1 local commit in a new git repo (no remote), then pnpm install --frozen-lockfile --offline
#      --store-dir <the store this checkout was installed from> (lockfile drift is red). F-1860: the store is read from the
#      checkout's node_modules/.modules.yaml (its storeDir), never pnpm's default: the wave image fills /root/.pnpm-store only by
#      an explicit --store-dir (ci/wave-image/Dockerfile, ci/wave-run.sh), so the default store there is empty. No storeDir, or
#      a storeDir that is not a folder, is a red; there is no fallback, and --offline keeps the install off the network.
#   3. The data a developer fetches first (README Developer path: node ci/data-assets.ts ensure): the street list, copied from this
#      checkout's .build/data when it is there (else fetched by ensure, a read of the release), into the copy's .build/data, then
#      verified by its MANIFEST sha256. F-1861: the baked track set (README step 2, pnpm run setup:maps) is copied the same way
#      from this checkout's .build/data/maps/tracks.ndjson when it is there, so the tests it unlocks run on the copy too (a track
#      set that is not the manifest's fails those tests, as it does in the checkout). Both stay inside the temp folder.
#   4. pnpm run test in the export. A red run names each failing test file; the fix guards the test that read a private path
#      (it skips only when that path is absent, with a skip note naming it, so it still runs in the private checkout).
# Known-bad: --plant-private-read adds to the export 1 test, ci/public-copy-plant.test.ts, that reads mockups/ with no guard; the
# gate must then exit 1 and name that file.
#   0. F-1862: before the export, the tests whose skip note says a path is not in this copy are run in this checkout (the private one):
#      each must run and pass here, never skip. A guard that skips always (a typo in its path test) would otherwise stay green in both
#      the checkout and the export, since the export skips those tests anyway.
# Nothing is written outside the temp folder (TMPDIR is pointed inside it for every step), and it is removed at the end. The one
# exception, F-1864: under ci/run-gates.ts the gate inherits BW_JUNIT_DIR, so the nested vitest also writes its junit file there.
#   ci/gates/public-copy-tests.sh [--plant-private-read]
# Exit 0 the suite passed on the export, 1 the export, the install or a test failed, 2 usage.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)" || exit 1
plant=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --plant-private-read) plant=1; shift ;;
    *) echo "public-copy-tests: unknown argument $1 (usage: ci/gates/public-copy-tests.sh [--plant-private-read])" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d "${TMPDIR:-/tmp}/bw-public-copy-tests.XXXXXX")" || exit 1
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/tmp" || exit 1
export TMPDIR="$work/tmp"
copy="$work/export"
started="$(date +%s)"
step() { echo "public-copy-tests: $* ($(( $(date +%s) - started )) s)"; }

step "0. the guarded tests (a skip note naming a path not in this copy) run, not skip, in this checkout"
guarded="$(git -C "$root" grep -l 'is not in this copy' -- '*.test.ts' | LC_ALL=C sort)"
if [ -z "$guarded" ]; then
  echo "public-copy-tests: FAIL no test file carries a skip note 'is not in this copy' (the guard search found nothing)" >&2
  exit 1
fi
# shellcheck disable=SC2086
(cd "$root" && BW_SKIPS_OUT="$work/skips.jsonl" pnpm exec vitest run $guarded --reporter=./ci/gates/public-copy-skips-reporter.ts) > "$work/guarded.log" 2>&1
guarded_rc=$?
if [ ! -f "$work/skips.jsonl" ]; then
  tail -n 30 "$work/guarded.log" >&2
  echo "public-copy-tests: FAIL the guarded tests produced no report in this checkout (vitest exited $guarded_rc; the tail of the run is above)" >&2
  exit 1
fi
# A skip whose note says a path is not in this copy is the export's skip; in this checkout the path is there, so the test must run.
if grep -F 'is not in this copy' "$work/skips.jsonl" > "$work/skips.bad"; then
  sed 's/^/  skipped here: /' "$work/skips.bad" >&2
  echo "public-copy-tests: FAIL a test whose skip note says its path is not in this copy skipped in this checkout (above; F-1862). Its guard skips when the path is there." >&2
  exit 1
fi
# A guarded test that fails here is the unit suite's to report (step 4 runs the same tests); this step reads skips only.
echo "public-copy-tests: the $(printf '%s\n' "$guarded" | wc -l | tr -d ' ') guarded test files ran in this checkout with no skip that names a missing path"

step "1. export of $(git -C "$root" rev-parse --short HEAD) (scripts/publish.sh --dry-run)"
if ! bash "$root/scripts/publish.sh" --dry-run --out "$copy" --list "$work/export.list" > "$work/export.log" 2>&1; then
  cat "$work/export.log" >&2
  echo "public-copy-tests: FAIL the export (scripts/publish.sh --dry-run) did not pass its guards" >&2
  exit 1
fi
tail -n 1 "$work/export.log"
for p in mockups docs/UI-SPECIFICATION.md .build; do
  if [ -e "$copy/$p" ]; then echo "public-copy-tests: FAIL the export holds the private path $p" >&2; exit 1; fi
done

if [ "$plant" -eq 1 ]; then
  step "known-bad: planting ci/public-copy-plant.test.ts, which reads mockups/ with no guard"
  cat > "$copy/ci/public-copy-plant.test.ts" <<'PLANT'
// SPDX-License-Identifier: AGPL-3.0-or-later
// The known-bad of ci/gates/public-copy-tests.sh: a test that reads a private path with no guard.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('a planted private read', () => {
  // why: F-1852 the gate's known-bad: mockups/ is not in the public copy, so this read throws there
  it('reads the approved pages folder with no guard', () => {
    expect(readdirSync(new URL('../mockups/pages', import.meta.url)).length).toBeGreaterThan(0);
  });
});
PLANT
fi

step "2. the copy as a clone has it, and pnpm install --frozen-lockfile --offline"
if ! (cd "$copy" && git init -q -b main . && git add -A && git -c user.name=public-copy -c user.email=public-copy@example.invalid -c commit.gpgsign=false commit -q -m "public copy") > "$work/git.log" 2>&1; then
  cat "$work/git.log" >&2
  echo "public-copy-tests: FAIL the export could not be committed in a new local repo" >&2
  exit 1
fi
# F-1876: ci/gates/public-copy-store.ts keeps its stderr: a missing file, a file that is not JSON and a missing key each say their own remedy.
store="$(node "$root/ci/gates/public-copy-store.ts" "$root/node_modules/.modules.yaml" 2> "$work/store.err")" \
  || { echo "public-copy-tests: FAIL $(cat "$work/store.err")" >&2; exit 1; }
[ -d "$store" ] || { echo "public-copy-tests: FAIL the checkout's pnpm store $store is not a folder" >&2; exit 1; }
echo "public-copy-tests: pnpm store $store (the checkout's, from node_modules/.modules.yaml)"
if ! (cd "$copy" && pnpm install --frozen-lockfile --offline --store-dir "$store") > "$work/install.log" 2>&1; then
  tail -n 40 "$work/install.log" >&2
  echo "public-copy-tests: FAIL pnpm install --frozen-lockfile --offline --store-dir $store in the export (the tail of its log is above)" >&2
  exit 1
fi

step "3. the street list (node ci/data-assets.ts ensure) and, when this checkout has it, the baked track set into the copy"
if [ -f "$root/.build/data/street-list.json" ]; then
  mkdir -p "$copy/.build/data" && cp "$root/.build/data/street-list.json" "$copy/.build/data/" || exit 1
fi
if [ -f "$root/.build/data/maps/tracks.ndjson" ]; then
  mkdir -p "$copy/.build/data/maps" && cp "$root/.build/data/maps/tracks.ndjson" "$copy/.build/data/maps/" || exit 1
  echo "public-copy-tests: staged the baked track set (.build/data/maps/tracks.ndjson), as pnpm run setup:maps has it"
else
  echo "public-copy-tests: no .build/data/maps/tracks.ndjson in this checkout, so the copy has none (its tests skip there too)"
fi
if ! (cd "$copy" && node ci/data-assets.ts ensure) > "$work/data.log" 2>&1; then
  cat "$work/data.log" >&2
  echo "public-copy-tests: FAIL node ci/data-assets.ts ensure in the export" >&2
  exit 1
fi
tail -n 1 "$work/data.log"

step "4. pnpm run test in the export"
(cd "$copy" && pnpm run test) > "$work/test.log" 2>&1
rc=$?
# F-1873: the wave image sets a color flag, so vitest prints its lines with color codes ahead of the words; strip them before matching.
sed "s/$(printf '\033')\[[0-9;]*m//g" "$work/test.log" > "$work/test.plain.log"
grep -E '^ *(Test Files|Tests) ' "$work/test.plain.log" | sed 's/^ */public-copy-tests: /'
if [ "$rc" -ne 0 ]; then
  echo "public-copy-tests: FAIL pnpm run test exited $rc on the public copy. Failing tests (each likely reads a path the export leaves out):" >&2
  grep -E '^ *(FAIL|×|✗) ' "$work/test.plain.log" | sed 's/^ */  /' | LC_ALL=C sort -u >&2
  grep -E 'ENOENT' "$work/test.plain.log" | sed 's/^ */  /' | LC_ALL=C sort -u | head -n 40 >&2
  if [ "$plant" -eq 1 ]; then
    if grep -q 'public-copy-plant.test.ts' "$work/test.plain.log"; then echo "public-copy-tests: known-bad seen: the planted test failed" >&2
    else echo "public-copy-tests: the planted test was not among the failures (a different test failed)" >&2; fi
  fi
  exit 1
fi
step "PASS: the unit suite passed on the public copy"
exit 0
