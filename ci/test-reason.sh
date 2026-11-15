#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Merge-set gate: every test added since the merge base carries a why: tag.
#   ci/test-reason.sh [<base-ref>]
# Base ref: the argument, else TEST_REASON_BASE, else origin/main, else main. No resolvable ref
# fails closed (exit 2): a shallow clone cannot judge, and a skipped check is not a pass.
# Runs the vendored jl-dev tool (ci/vendor/jl-dev/VERSION.md). Needs python3 and git.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# F-1571: the vendored tool is the owner's private copy and is not in the public tree; without it there is nothing to run.
# F-1685: only the public tree skips. In the private repo a missing tool is red (exit 1); a tree that is neither side exits 2.
. ci/tree-kind.sh
kind="$(bw_tree_kind .)" || { echo "test-reason: cannot tell the private repo from the public export (some private-only paths are present, some missing)" >&2; exit 2; }
tool=ci/vendor/jl-dev/test-reason-check.py
if [ ! -f "$tool" ]; then
  if [ "$kind" = private ]; then echo "test-reason: $tool is missing in the private repo" >&2; exit 1; fi
  echo "test-reason: skipped, $tool is not in this tree (the public repo leaves ci/vendor out)"
  exit 0
fi

base=""
for ref in "${1:-}" "${TEST_REASON_BASE:-}" origin/main main; do
  [ -n "$ref" ] || continue
  if git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then base="$ref"; break; fi
done
if [ -z "$base" ]; then
  echo "test-reason: no base ref (tried the argument, TEST_REASON_BASE, origin/main, main); fetch full history" >&2
  exit 2
fi
echo "test-reason: --since $base"
exec python3 "$tool" --since "$base"
