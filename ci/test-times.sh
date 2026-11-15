#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# F-974: record the per-test times of a CI run. Usage: ci/test-times.sh <junit root> [<sha> [<history file>]]
# <junit root> holds one folder per gate (.build/junit/<gate id>/*.xml, written by the vitest junit reporter that every
# vitest config turns on when BW_JUNIT_DIR is set). Each gate folder is passed to jl-dev's test-cost.py as
#   test-cost.py record --junit <file> ... --label <gate id> [--sha <sha>]
# which appends to the history file (default .build/test-history.jsonl under the repo root). Advisory: a missing tool
# or a folder with no files prints a note and exits 0; a failed record exits 1 so the caller can print it. The CI verdict never depends on it.
set -uo pipefail
root="${1:?usage: test-times.sh <junit root> [<sha> [<history file>]]}"
sha="${2:-}"
history="${3:-$(cd "$(dirname "$0")/.." && pwd)/.build/test-history.jsonl}"
if [ ! -d "$root" ]; then echo "test-times: no $root (no gate ran)"; exit 0; fi
if ! command -v test-cost.py >/dev/null 2>&1; then
  echo "test-times: test-cost.py is not on PATH; per-test times in $root are not recorded"
  exit 0
fi
# F-999: test-cost.py prunes to the last --keep run rows across all labels, and every gate writes its own label per CI run, so the
# default (50) holds about 2 CI runs. Keep 50 CI runs: 50 x the number of gate folders.
gates=0
for dir in "$root"/*/; do [ -d "$dir" ] && gates=$((gates + 1)); done
keep=$((50 * (gates > 0 ? gates : 1)))
rc=0
for dir in "$root"/*/; do
  [ -d "$dir" ] || continue
  id="$(basename "$dir")"
  files=()
  for f in "$dir"*.xml; do
    [ -f "$f" ] || continue
    # F-999: one unreadable file (a run killed while writing) must not drop the good ones: name it and go on.
    if python3 -c 'import sys, xml.dom.minidom as m; m.parse(sys.argv[1])' "$f" 2>/dev/null; then files+=(--junit "$f"); else echo "test-times: $f does not parse; skipped ($id)"; fi
  done
  if [ "${#files[@]}" -eq 0 ]; then continue; fi
  args=(record "${files[@]}" --label "$id" --history "$history")
  if [ -n "$sha" ]; then args+=(--sha "$sha"); fi
  args+=(--keep "$keep")
  test-cost.py "${args[@]}" || { echo "test-times: record failed for $id"; rc=1; }
done
exit $rc
