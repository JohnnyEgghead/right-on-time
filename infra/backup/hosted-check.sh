#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P3-BACKUP: the hosted half of the Acceptance, run by the manager from this Mac AFTER a deploy of this commit
# (bash infra/deploy/deploy.sh), like the deploy itself (owner ruling 64032d47: a local script, started by hand):
#   bash infra/backup/hosted-check.sh --log <file>
# It checks that the server runs these backup scripts (same SHA-256 as this tree), runs the server half
# (infra/backup/hosted-check-server.sh: preflight, region, backup, restore with memory, planted manifest, retention)
# over ssh, and reads the bucket's Region from the Lightsail API too when this Mac has the brightwater AWS CLI
# profile. Everything goes to the log named by --log (refused if it exists, so 2 runs never mix) and to the terminal.
# The last line is the verdict: HOSTED-CHECK PASS or HOSTED-CHECK FAIL, with every arm's result.
# Safe to run twice (see the server half). Prints no secret.
# Env: BW_HOST (user@server-address; from the environment or the owner's private file, else the script stops), BW_KEY (default ~/.ssh/brightwater-lightsail.pem), as deploy.sh.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
. "$root/infra/drill/owner-env.sh"; bw_need_host "$root" || exit 2
HOST="$BW_HOST"
KEY="${BW_KEY:-$HOME/.ssh/brightwater-lightsail.pem}"
log_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --log) log_file="${2:?--log <file>}"; shift 2 ;;
    *) echo "usage: bash infra/backup/hosted-check.sh --log <file>" >&2; exit 2 ;;
  esac
done
[ -n "$log_file" ] || { echo "usage: bash infra/backup/hosted-check.sh --log <file>" >&2; exit 2; }
[ ! -e "$log_file" ] || { echo "hosted-check: $log_file exists; name a new log" >&2; exit 2; }
mkdir -p "$(dirname "$log_file")"
exec > >(tee "$log_file") 2>&1
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "[$(ts)] $*"; }
ssh_() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }

say "== hosted-check.sh (local $(date '+%b %-d, %-I:%M %p %Z')), commit $(git -C "$root" rev-parse --short=12 HEAD)"
verdict=PASS

say "== the deployed backup scripts are this tree's"
same=1
for f in lib.sh backup.sh restore-test.sh retention.sh checksums.sql import-check.sql hosted-check-server.sh; do
  here="$(shasum -a 256 "$root/infra/backup/$f" | cut -d' ' -f1)"
  there="$(ssh_ "sudo sha256sum /opt/brightwater/backup/$f 2>/dev/null" | cut -d' ' -f1)"
  if [ "$here" = "$there" ]; then say "  $f same"; else say "  $f DIFFERS (server ${there:-missing})"; same=0; fi
done
for u in brightwater-backup.service brightwater-backup.timer brightwater-restore-test.service brightwater-restore-test.timer; do
  here="$(shasum -a 256 "$root/infra/hosted/systemd/$u" | cut -d' ' -f1)"
  there="$(ssh_ "sudo sha256sum /etc/systemd/system/$u 2>/dev/null" | cut -d' ' -f1)"
  if [ "$here" = "$there" ]; then say "  $u installed, same"; else say "  $u DIFFERS or is not installed"; same=0; fi
done
if [ "$same" != 1 ]; then say "STOP: deploy this commit first (bash infra/deploy/deploy.sh)"; say "HOSTED-CHECK FAIL: deployed=FAIL"; exit 1; fi

say "== the bucket's Region from the Lightsail API (this Mac)"
api_region=""
if command -v aws >/dev/null 2>&1 && grep -qx brightwater < <(aws configure list-profiles 2>/dev/null); then
  bucket="$(sed -n 's/^BACKUP_BUCKET=//p' "$root/infra/hosted/hosted.env")"
  api_region="$(aws lightsail get-buckets --profile brightwater --region us-east-1 --bucket-name "$bucket" \
                  --query 'buckets[0].location.regionName' --output text 2>/dev/null || true)"
  say "  lightsail get-buckets $bucket: region ${api_region:-unreadable}"
  case "$api_region" in us-east-*|us-west-*) ;; *) verdict=FAIL; say "  the bucket is not in a US Region (NFR-10)";; esac
else
  say "  skipped: no aws CLI profile brightwater on this Mac (the server half reads the Region itself)"
fi

say "== server half"
ssh_ "sudo bash /opt/brightwater/backup/hosted-check-server.sh"; rc=$?
say "server half exit $rc"
[ "$rc" = 0 ] || verdict=FAIL
server_line="$(grep -a 'HOSTED-CHECK-SERVER ' "$log_file" | tail -n 1 | sed 's/.*HOSTED-CHECK-SERVER //')"
say "HOSTED-CHECK $verdict: deployed=PASS lightsail-api=${api_region:-skipped} server: ${server_line:-no verdict line}"
[ "$verdict" = PASS ]
