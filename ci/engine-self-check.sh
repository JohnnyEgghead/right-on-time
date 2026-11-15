#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Smoke engine self-check (SPECIFICATIONS section 14, "Clean, for smoke-public-tag", item 6).
#   ci/engine-self-check.sh <engine-container>
# The engine is a throwaway Docker-in-Docker container; its own docker CLI is asked through
# `docker exec`. Waits for the engine to answer (poll, ENGINE_WAIT_S seconds, default 60), then:
#   exit 0  the engine holds 0 images and 0 volumes
#   exit 1  it holds any image or volume (each is listed)
#   exit 2  usage error, or the engine never answered (fail closed: never a pass)
set -euo pipefail

eng="${1:-}"
if [ -z "$eng" ]; then
  echo "usage: ci/engine-self-check.sh <engine-container>" >&2
  exit 2
fi
wait_s="${ENGINE_WAIT_S:-60}"

ready=0
for ((i = 0; i < wait_s * 2; i++)); do
  if docker exec "$eng" docker info >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "self-check: engine $eng did not answer within ${wait_s}s" >&2
  exit 2
fi

images="$(docker exec "$eng" docker image ls -aq --no-trunc)" || { echo "self-check: image list failed" >&2; exit 2; }
volumes="$(docker exec "$eng" docker volume ls -q)" || { echo "self-check: volume list failed" >&2; exit 2; }
count() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }
ni="$(count "$images")"
nv="$(count "$volumes")"
echo "self-check: engine $eng holds $ni image(s), $nv volume(s)"
if [ "$ni" -ne 0 ] || [ "$nv" -ne 0 ]; then
  [ -n "$images" ] && printf '  image  %s\n' $images
  [ -n "$volumes" ] && printf '  volume %s\n' $volumes
  echo "self-check: FAIL - the engine is not empty, so the install would not start clean" >&2
  exit 1
fi
echo "self-check: PASS - empty engine"
