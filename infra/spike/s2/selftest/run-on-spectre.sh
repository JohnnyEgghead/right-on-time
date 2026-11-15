#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S2 (THROWAWAY): runs selftest.mjs in WebKit inside a uniquely named container on Spectre
# (docker --context spectre), no published ports. Never installs a browser on this Mac.
#   bash infra/spike/s2/selftest/run-on-spectre.sh <out-dir>
# Image: the repo's pinned Node image. npm ci from package-lock.json (playwright 1.64.1), then the
# matching WebKit with its system libraries, inside the container only. The container expires by
# itself (sleep 900) and is removed at the end.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:?out dir}"
CTX=spectre
IMAGE='node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c'
NAME="bw-s2-selftest-$(date -u +%Y%m%dT%H%M%SZ)"
trap 'docker --context "$CTX" rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
echo "container $NAME on context $CTX, started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$out/selftest-container.txt"
docker --context "$CTX" run -d --name "$NAME" --entrypoint sleep "$IMAGE" 900 >/dev/null
COPYFILE_DISABLE=1 tar --no-xattrs -C "$here" -cf - package.json package-lock.json selftest.mjs \
  | docker --context "$CTX" exec -i "$NAME" sh -c 'mkdir -p /s2 && tar -x --no-same-owner -C /s2'
# ca-certificates: WebKit verifies TLS against the system store (the slim image has none); the
# certificate is checked for real, never ignored (a service worker needs a trusted origin).
docker --context "$CTX" exec "$NAME" bash -c 'set -e; cd /s2; node -v;
  export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq --no-install-recommends ca-certificates >/dev/null; npm ci --no-audit --no-fund 2>&1 | tail -2;
  npx playwright --version; npx playwright install --with-deps webkit >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 3; };
  echo "webkit installed"' 2>&1 | tee -a "$out/selftest-container.txt"
set +e
docker --context "$CTX" exec "$NAME" bash -c 'cd /s2 && node selftest.mjs' >"$out/selftest.txt" 2>&1
rc=$?
set -e
echo "selftest exit $rc, finished $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$out/selftest-container.txt"
grep -E '^(PASS|FAIL)' "$out/selftest.txt" | cut -c1-200
exit $rc
