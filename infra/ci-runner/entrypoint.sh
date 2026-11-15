#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Entrypoint of the `linux` runner container (infra/ci-runner/compose.yaml).
# First start: registers with RUNNER_TOKEN and saves the runner's credentials to /runner-state.
# Later starts: restores the saved credentials, so no token is needed again.
set -euo pipefail
cd /home/runner

state=/runner-state
# Runs as root (compose.yaml says why), so the root-owned named volumes need no chown.

# Job containers mount /home/runner/externals from the engine; give it this image's copy.
cp -a /home/runner/externals/. /externals-shared/

files=(.runner .credentials .credentials_rsaparams)
if [ -f "$state/.runner" ]; then
  for f in "${files[@]}"; do cp "$state/$f" "/home/runner/$f"; done
  echo "runner: restored saved registration"
else
  if [ -z "${RUNNER_TOKEN:-}" ]; then
    echo "runner: not registered and RUNNER_TOKEN is empty; see infra/ci-runner/README.md" >&2
    exit 1
  fi
  ./config.sh --unattended --url "$RUNNER_URL" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels linux --work /home/runner/_work --disableupdate --replace
  for f in "${files[@]}"; do cp "/home/runner/$f" "$state/$f"; done
  echo "runner: registered and saved"
fi
unset RUNNER_TOKEN
exec ./run.sh
