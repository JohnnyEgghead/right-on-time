#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The fetch step's answer: a tar of 1 backup set (set 20261114T150000Z) whose manifest describes its dump (size and SHA-256), as backup.sh writes it.
set -euo pipefail
d="$(mktemp -d)"
trap 'rm -rf "$d"' EXIT
s=20261114T150000Z
mkdir -p "$d/$s"
printf 'dry-run dump\n' >"$d/$s/brightwater.dump"
if command -v sha256sum >/dev/null; then sha="$(sha256sum "$d/$s/brightwater.dump" | cut -d' ' -f1)"; else sha="$(shasum -a 256 "$d/$s/brightwater.dump" | cut -d' ' -f1)"; fi
printf '{"format": 1, "set": "%s", "dump": {"name": "brightwater.dump", "bytes": 13, "sha256": "%s"}, "tables": {"world.job": {"rows": 2, "md5": "%s"}, "world.user": {"rows": 1, "md5": "%s"}}}\n' \
  "$s" "$sha" 0123456789abcdef0123456789abcdef fedcba9876543210fedcba9876543210 >"$d/$s/manifest.json"
tar -C "$d" -cf - "$s"
