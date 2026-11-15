#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S5 (G-S5-HOST), adapted by P1-DEPLOY: prepare the hosted server
# (Lightsail, Debian 13): Docker, the postgres password, the first TLS
# certificate and the renewal timer. It no longer starts the app stack;
# infra/deploy/deploy.sh does (see infra/README.md, "A fresh server").
# Run as root on the server from /opt/brightwater, which holds compose.yaml,
# nginx/ and placeholder/ (copied from infra/):  sudo bash setup.sh
# Idempotent: re-running keeps the existing postgres password and volumes.
set -euo pipefail

DOCKER_VERSION="5:29.9.1-1~debian.13~trixie"
COMPOSE_VERSION="5.6.0-1~debian.13~trixie"
# Newest releases at least 14 days old on Oct 31, 2026 (REQUIREMENTS 543); Docker
# published containerd.io 2.4.2-3 and buildx 0.38.1 on Oct 20, 2026, too young.
CONTAINERD_VERSION="2.4.2-2~debian.13~trixie"
BUILDX_VERSION="0.38.0-1~debian.13~trixie"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl

# Docker's apt repository (https://docs.docker.com/engine/install/debian/)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -y -q --allow-downgrades \
  "docker-ce=${DOCKER_VERSION}" "docker-ce-cli=${DOCKER_VERSION}" \
  "containerd.io=${CONTAINERD_VERSION}" "docker-buildx-plugin=${BUILDX_VERSION}" \
  "docker-compose-plugin=${COMPOSE_VERSION}"
# Hold the exact pins so unattended upgrades never move them.
apt-mark hold docker-ce docker-ce-cli docker-compose-plugin containerd.io docker-buildx-plugin
systemctl enable --now docker

# AWS CLI for the backup scripts (resource access to the Lightsail bucket;
# SPECIFICATIONS section 4.8). No access keys are ever written on the server.
apt-get install -y -q awscli

# The postgres password lives only here: root-only, never in git.
install -m 0700 -d /etc/brightwater
if [ ! -f /etc/brightwater/db.env ]; then
  umask 077
  printf 'POSTGRES_PASSWORD=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)" \
    > /etc/brightwater/db.env
fi
chmod 600 /etc/brightwater/db.env

# TLS for bw.j7l.io (Let's Encrypt, HTTP-01 webroot through the acme volume).
# hosted.conf cannot start without a certificate, so on the first run the
# proxy starts alone with the port-80-only bootstrap.conf (static, no web
# container), certbot obtains the certificate, and the bootstrap proxy is
# removed; the first deploy starts the stack with hosted.conf. Needs the DNS
# A record for the domain to point here first. CERTBOT_STAGING=1 uses the
# Let's Encrypt staging CA (a test certificate, no rate limits).
DOMAIN="bw.j7l.io"
CERTBOT_SERVER=()
if [ "${CERTBOT_STAGING:-0}" = "1" ]; then CERTBOT_SERVER=(--staging); fi
if ! docker compose run --rm --entrypoint test certbot -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"; then
  PROXY_CONF=bootstrap.conf HTTP_BIND=80 docker compose up -d --no-deps proxy
  # No account email: Let's Encrypt sends no expiry mail any more; the
  # renewal timer below and the monitor own expiry.
  docker compose run --rm certbot certonly --webroot -w /var/www/acme \
    -d "${DOMAIN}" --agree-tos --register-unsafely-without-email \
    --non-interactive "${CERTBOT_SERVER[@]}"
  docker compose rm -sf proxy
fi

# Renewal: a host timer runs the one-shot certbot service twice a day and
# reloads nginx (certbot-renew.sh).
install -m 0644 systemd/brightwater-certbot-renew.service systemd/brightwater-certbot-renew.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now brightwater-certbot-renew.timer
