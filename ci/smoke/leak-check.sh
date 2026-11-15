#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# smoke-public-tag, Clean item 4: no secret or environment from the private repo reaches the copy.
#   ci/smoke/leak-check.sh <engine-container>
# Takes the value of each secret variable that is set HERE (the job's own environment: SMOKE_LEAK_VARS, default
# GH_TOKEN GITHUB_TOKEN ACTIONS_RUNTIME_TOKEN BW_SMOKE_PLANT_SECRET) and looks for it inside the engine: the engine's own
# environment, the environment of every container in it, the copy's settings file (/work/settings.env) and the copy's files (the
# .build folder, which holds staged data, is not searched). A value is never printed and never passed into the engine: the engine's text comes out and is searched here, by
# a pattern file in a mode-600 temp file. Prints the NAME of any variable whose value it finds.
#   exit 0  at least 1 variable was checked and no value was found
#   exit 1  a value was found
#   exit 2  usage error, the engine's text could not be read, or 0 variables were checked (fail closed: a check of nothing
#           proves nothing, F-1453; the workflow's smoke step sets a per-run BW_SMOKE_PLANT_SECRET so the count is never 0)
set -euo pipefail

eng="${1:-}"
if [ -z "$eng" ]; then
  echo "usage: ci/smoke/leak-check.sh <engine-container>" >&2
  exit 2
fi
names="${SMOKE_LEAK_VARS:-GH_TOKEN GITHUB_TOKEN ACTIONS_RUNTIME_TOKEN BW_SMOKE_PLANT_SECRET}"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/bw-leak.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"

dump="$tmp/dump"
# shellcheck disable=SC2016  # the single quotes are the point: this text runs inside the engine
docker exec "$eng" sh -c '
  env
  ids="$(docker ps -aq)" || exit 1
  for c in $ids; do docker inspect --format "{{json .Config.Env}}" "$c" || exit 1; done
  cat /work/settings.env || exit 1
  tar -C /work/copy --exclude=./.build -cf - . 2>/dev/null
' > "$dump" || { echo "leak-check: could not read the engine $eng" >&2; exit 2; }
[ -s "$dump" ] || { echo "leak-check: the engine gave no text" >&2; exit 2; }

checked=0
found=0
for name in $names; do
  value="${!name:-}"
  [ -n "$value" ] || continue
  checked=$((checked + 1))
  printf '%s\n' "$value" > "$tmp/pat"
  chmod 600 "$tmp/pat"
  # -F: the value is text, not a pattern. -a: the dump holds a tar stream. -q: nothing is printed but the name below.
  if grep -a -q -F -f "$tmp/pat" "$dump"; then
    echo "leak-check: FAIL the value of $name is inside the engine" >&2
    found=$((found + 1))
  fi
done
echo "leak-check: $checked secret variable(s) set in the job, $found found inside the engine"
if [ "$checked" -eq 0 ]; then
  echo "leak-check: FAIL 0 variables were checked (none of: $names is set here); a check of nothing proves nothing" >&2
  exit 2
fi
[ "$found" -eq 0 ]
