#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S2 (G-S2-TWA-OFFLINE): THROWAWAY install, run ON brightwater-1 as root by deploy.sh:
#   sudo bash /tmp/spike-s2-stage/server-install.sh
# Touches only: /opt/brightwater-spike-s2 (new), the brightwater-spike-s2 Compose project (new),
# and the proxy container's default.conf mount (recreated with proxy-override.yaml). Nothing in
# /opt/brightwater changes. Any failure after the proxy recreate rolls the proxy back.
set -euo pipefail
STAGE=/tmp/spike-s2-stage
DEST=/opt/brightwater-spike-s2
NGINX_IMAGE='nginx:1.30.6@sha256:66b50d24288dba67f3d000b31223daefc4868c58d29aaacb6a4ff9771597b5eb'
NODE_IMAGE='node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c'
health() { docker run --rm --network brightwater_default "$NODE_IMAGE" node -e "fetch('http://spike-s2:8080/spike/s2/api/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(e=>{console.log(String(e));process.exit(1)})"; }

echo "== 1. the spike default.conf differs from the live one by exactly the 3 added lines (comment, include, blank)"
added="$(diff /opt/brightwater/nginx/default.conf "$STAGE/nginx/default.conf" | grep -c '^>' || true)"
removed="$(diff /opt/brightwater/nginx/default.conf "$STAGE/nginx/default.conf" | grep -c '^<' || true)"
diff /opt/brightwater/nginx/default.conf "$STAGE/nginx/default.conf" || true
if [ "$added" != 3 ] || [ "$removed" != 0 ]; then echo "STOP: unexpected diff (+$added -$removed)"; exit 1; fi

echo "== 2. install files to $DEST"
install -d -m 755 "$DEST" "$DEST/app" "$DEST/app/public" "$DEST/nginx"
install -d -m 750 -o 1000 -g 1000 "$DEST/data"
install -m 644 "$STAGE/app/server.mjs" "$DEST/app/server.mjs"
install -m 644 "$STAGE"/app/public/* "$DEST/app/public/"
install -m 644 "$STAGE/nginx/default.conf" "$STAGE/nginx/locations.conf" "$DEST/nginx/"
install -m 644 "$STAGE/compose.yaml" "$STAGE/proxy-override.yaml" "$DEST/"
install -m 755 "$STAGE/server-teardown.sh" "$DEST/"
sha256sum $(find "$DEST" -type f -not -path "$DEST/data/*" | sort)

echo "== 3. proxy mounts before"
docker inspect brightwater-proxy-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

echo "== 4. nginx -t of the spike config in a throwaway container on the stack network"
docker run --rm --network brightwater_default \
  -v "$DEST/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$DEST/nginx/locations.conf:/etc/nginx/spike-s2/locations.conf:ro" \
  -v brightwater_letsencrypt:/etc/letsencrypt:ro -v brightwater_acme:/var/www/acme:ro \
  "$NGINX_IMAGE" nginx -t

echo "== 5. start the spike receiver (its own Compose project)"
cd "$DEST"
docker compose -p brightwater-spike-s2 up -d
for _ in $(seq 1 20); do
  if health >/dev/null 2>&1; then break; fi
  sleep 1
done
health

echo "== 6. recreate the proxy with the override (adds the include)"
cd /opt/brightwater
if ! docker compose -f compose.yaml -f "$DEST/proxy-override.yaml" up -d --no-deps proxy; then
  echo "ROLLBACK: proxy recreate failed; restoring the original proxy"
  docker compose up -d --no-deps proxy
  exit 1
fi
sleep 2
if ! docker compose exec -T proxy nginx -t; then
  echo "ROLLBACK: nginx -t failed in the new proxy"
  docker compose up -d --no-deps proxy
  exit 1
fi

echo "== 7. proxy mounts after"
docker inspect brightwater-proxy-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
free -m | head -2
rm -rf "$STAGE"
echo "== install done"
