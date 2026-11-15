#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# F-45 (owner answer 2d9da4be, "Add it with the drill"): write the certificate renewal status file the 2nd UptimeRobot monitor reads.
# Run as root by brightwater-certbot-renew.service as ExecStopPost=, so it runs after EVERY attempt, success or failure, with systemd's
# SERVICE_RESULT ("success" or a failure word) and EXIT_STATUS in the environment. Also run once by the deploy (server-deploy.sh
# --host-files) as "seed", which writes only when no file exists yet, from the certificate's own remaining life.
# The file is served by the proxy's port 80 server from the acme volume (location /.well-known/acme-challenge/, no nginx change):
#   http://bw.j7l.io/.well-known/acme-challenge/renewal-status.txt
# First line RENEWAL_OK or RENEWAL_FAILED (the monitor alerts when RENEWAL_OK is missing); then the UTC time and the cause. No secrets.
# Env for tests: BW_RENEWAL_STATUS_FILE, BW_RENEWAL_CERT.
set -uo pipefail
FILE="${BW_RENEWAL_STATUS_FILE:-/var/lib/docker/volumes/brightwater_acme/_data/.well-known/acme-challenge/renewal-status.txt}"
CERT="${BW_RENEWAL_CERT:-/var/lib/docker/volumes/brightwater_letsencrypt/_data/live/bw.j7l.io/fullchain.pem}"
mode="${1:-unit}"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

case "$mode" in
  unit)
    result="${SERVICE_RESULT:-unknown}"
    word=RENEWAL_FAILED
    [ "$result" != success ] || word=RENEWAL_OK
    cause="renewal service result=$result exit=${EXIT_STATUS:-unknown}"
    ;;
  seed)
    # A seed never overwrites a real attempt's answer.
    [ ! -e "$FILE" ] || { echo "renewal-status: $FILE exists, seed skipped"; exit 0; }
    if openssl x509 -checkend 2592000 -noout -in "$CERT" >/dev/null 2>&1; then
      word=RENEWAL_OK
      cause="seeded by the deploy: the certificate is valid for more than 30 days; no renewal attempt has run since"
    else
      word=RENEWAL_FAILED
      cause="seeded by the deploy: the certificate is missing, unreadable or expires within 30 days"
    fi
    ;;
  *) echo "usage: renewal-status.sh [unit|seed]" >&2; exit 2 ;;
esac

mkdir -p "$(dirname "$FILE")"
tmp="$FILE.tmp.$$"
printf '%s\nchecked_at=%s\n%s\n' "$word" "$now" "$cause" >"$tmp" || { rm -f "$tmp"; echo "renewal-status: cannot write $tmp" >&2; exit 1; }
chmod 0644 "$tmp"
mv -f "$tmp" "$FILE" || { rm -f "$tmp"; echo "renewal-status: cannot move into $FILE" >&2; exit 1; }
echo "renewal-status: wrote $word to $FILE"
