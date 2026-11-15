#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# F-1685: tells the private repo from the public export. Sourced by the gates that may skip a check only in the public tree.
#   . ci/tree-kind.sh; kind="$(bw_tree_kind <repo root>)" || <neither side can be determined: exit 2>
# Prints private or public. The markers are tracked files that scripts/private-paths.txt leaves out of the export, so the private repo
# has all of them and a public copy has none. Some present and some missing is a damaged tree, not either side: status 2, nothing printed.
# ci/tree-kind.test.ts holds the markers to the list.
BW_PRIVATE_MARKERS=(jl-build jl-plan jl-anchor docs/REQUIREMENTS.md)
bw_tree_kind() {
  local m have=0 miss=0
  for m in "${BW_PRIVATE_MARKERS[@]}"; do
    if [ -e "$1/$m" ]; then have=$((have + 1)); else miss=$((miss + 1)); fi
  done
  if [ "$miss" -eq 0 ]; then echo private
  elif [ "$have" -eq 0 ]; then echo public
  else return 2
  fi
}
