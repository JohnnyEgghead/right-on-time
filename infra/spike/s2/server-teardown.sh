#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S2 (G-S2-TWA-OFFLINE): THROWAWAY teardown, run ON brightwater-1 as root, AFTER the later
# pass has copied the receive log off the server (see the record's "Log watch" section):
#   sudo bash /opt/brightwater-spike-s2/server-teardown.sh
# 1. recreates the proxy from /opt/brightwater/compose.yaml alone (the original default.conf mount),
# 2. removes the spike Compose project, 3. deletes /opt/brightwater-spike-s2 (items and log too).
set -euo pipefail
cd /opt/brightwater
docker compose up -d --no-deps proxy
sleep 2
docker compose exec -T proxy nginx -t
docker inspect brightwater-proxy-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
cd /opt/brightwater-spike-s2
docker compose -p brightwater-spike-s2 down --remove-orphans
cd /
rm -rf /opt/brightwater-spike-s2
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
echo "== teardown done"
