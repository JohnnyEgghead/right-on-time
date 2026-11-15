#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S5 (G-S5-HOST), kept by P1-DEPLOY: renew the bw.j7l.io certificate and reload nginx.
# Run as root by brightwater-certbot-renew.service (twice a day, from
# brightwater-certbot-renew.timer). certbot renews only when the certificate
# is inside its renewal window, so most runs change nothing; the nginx reload
# is graceful, so it runs every time instead of tracking whether a renewal
# happened. Extra arguments go to certbot (for example --dry-run).
set -euo pipefail
cd /opt/brightwater
docker compose run --rm certbot renew --non-interactive "$@"
docker compose exec -T proxy nginx -s reload
