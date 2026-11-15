#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# xcodebuild with automatic signing through the App Store Connect Team API key (TestFlight upload, P6-TESTFLIGHT).
# Usage: release/xcb-asc.sh <xcodebuild args...>
# The key stays in ~/.appstoreconnect (never in the repo). xcodebuild echoes its command line,
# so the issuer id is redacted from all output, which is safe to save as evidence.
# F-1621 (owner answer dedc3b70, "Keep them private"): the key id is BW_ASC_KEY_ID, from the environment or the owner's private file
# (infra/drill/owner-env.sh reads it; a public copy has none and sets it in the environment); without it nothing runs (exit 2).
# The key id and the Apple team id (BW_APPLE_TEAM_ID, when set) are redacted from the output too.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=../../../infra/drill/owner-env.sh
. "$root/infra/drill/owner-env.sh"
bw_owner_env "$root"
kid="${BW_ASC_KEY_ID:-}"
[[ "$kid" =~ ^[A-Z0-9]{10}$ ]] || { echo "xcb-asc: BW_ASC_KEY_ID (the App Store Connect API key id, 10 capitals or digits) is not set: set it in the environment or put the line BW_ASC_KEY_ID=<key id> in the owner's private file; nothing run (F-1621)" >&2; exit 2; }
team="${BW_APPLE_TEAM_ID:-}"
[[ -z "$team" || "$team" =~ ^[A-Z0-9]{10}$ ]] || { echo "xcb-asc: BW_APPLE_TEAM_ID is set but is not 10 capitals or digits (not printed); nothing run (F-1621)" >&2; exit 2; }
dir="$HOME/.appstoreconnect"
iss="$(tr -d '[:space:]' < "$dir/issuer_id.txt")"
redact=(-e "s/$iss/<issuer-id>/g" -e "s/$kid/<key-id>/g")
[ -z "$team" ] || redact+=(-e "s/$team/<team-id>/g")
set +e
xcodebuild "$@" -allowProvisioningUpdates \
  -authenticationKeyPath "$dir/AuthKey_$kid.p8" \
  -authenticationKeyID "$kid" \
  -authenticationKeyIssuerID "$iss" 2>&1 | sed "${redact[@]}"
rc="${PIPESTATUS[0]}"
echo "xcb-asc: xcodebuild exit $rc"
exit "$rc"
