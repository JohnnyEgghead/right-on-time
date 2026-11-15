#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S1 (G-S1-SSE): prepare a TEMPORARY Lightsail instance (Debian 13, small_3_0) and
# start the spike stack. Run as root from the directory holding compose.yaml:
#   sudo bash setup.sh
# Docker pins match infra/hosted/setup.sh. Refuses to run on the locked server.
set -euo pipefail

# The guard is the directory check: Lightsail names hosts by private IP
# (ip-172-26-3-67), so a hostname test for brightwater-1 never matches.
if [ -d /opt/brightwater ]; then
  echo "setup.sh: this looks like the locked server; refusing" >&2
  exit 1
fi

DOCKER_VERSION="5:29.9.1-1~debian.13~trixie"
COMPOSE_VERSION="5.6.0-1~debian.13~trixie"
CONTAINERD_VERSION="2.4.2-2~debian.13~trixie"
BUILDX_VERSION="0.38.0-1~debian.13~trixie"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -y -q \
  "docker-ce=${DOCKER_VERSION}" "docker-ce-cli=${DOCKER_VERSION}" \
  "containerd.io=${CONTAINERD_VERSION}" "docker-buildx-plugin=${BUILDX_VERSION}" \
  "docker-compose-plugin=${COMPOSE_VERSION}"
systemctl enable --now docker

# The postgres password lives only on this throwaway server.
install -m 0700 -d /etc/bw-spike
if [ ! -f /etc/bw-spike/db.env ]; then
  umask 077
  pw="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  printf 'POSTGRES_PASSWORD=%s\nDATABASE_URL=postgres://brightwater:%s@db:5432/brightwater\n' "$pw" "$pw" \
    > /etc/bw-spike/db.env
fi
chmod 600 /etc/bw-spike/db.env

# Self-signed certificate for nginx (no domain on a temporary instance). The load
# script pins this certificate by fetching it over SSH.
mkdir -p certs
if [ ! -f certs/spike.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=bw-spike-s1" \
    -keyout certs/spike.key -out certs/spike.crt 2>/dev/null
fi

docker compose up -d --build
docker compose ps
