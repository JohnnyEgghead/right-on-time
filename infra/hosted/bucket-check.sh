#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S5 (G-S5-HOST): prove the instance reaches its Lightsail bucket by
# resource access alone (SPECIFICATIONS section 4.8, the OQ-12 trigger).
# Exercises the 4 BackupTarget operations with the AWS CLI: put, list, get,
# remove. Fails if any AWS credential file or key variable is present, so a
# pass can only come from the instance role.
# Usage (on the server): bash bucket-check.sh <bucket> <region>
set -euo pipefail
BUCKET="${1:?bucket}"
REGION="${2:?region}"

if [ -e "$HOME/.aws/credentials" ] || [ -e /root/.aws/credentials ] \
   || [ -n "${AWS_ACCESS_KEY_ID:-}" ] || [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "FAIL: an AWS key is present on the server" >&2
  exit 2
fi

echo "caller: $(aws sts get-caller-identity --query Arn --output text)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="s5-check/$(date -u +%Y%m%dT%H%M%SZ).bin"
head -c 1048576 /dev/urandom > "$work/up.bin"
sum_up="$(sha256sum "$work/up.bin" | cut -d' ' -f1)"

aws s3 cp "$work/up.bin" "s3://$BUCKET/$name" --region "$REGION" --only-show-errors
echo "put: ok $name"
aws s3 ls "s3://$BUCKET/s5-check/" --region "$REGION" | sed 's/^/list: /'
aws s3 cp "s3://$BUCKET/$name" "$work/down.bin" --region "$REGION" --only-show-errors
sum_down="$(sha256sum "$work/down.bin" | cut -d' ' -f1)"
echo "get: sha256 up=$sum_up down=$sum_down"
[ "$sum_up" = "$sum_down" ] || { echo "FAIL: checksum mismatch" >&2; exit 1; }
aws s3 rm "s3://$BUCKET/$name" --region "$REGION" --only-show-errors
# aws s3 ls exits 1 on an empty prefix, which is the expected result here.
left="$( (aws s3 ls "s3://$BUCKET/s5-check/" --region "$REGION" || true) | wc -l)"
echo "remove: ok, objects left under s5-check/: $left"
echo "PASS: put, list, get, remove by resource access"
