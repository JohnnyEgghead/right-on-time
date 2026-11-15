#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Spike S3 (G-S3-MAP-SAFARI): THROWAWAY install, run ON brightwater-1 as root by deploy.sh:
#   sudo bash /tmp/spike-s3-stage/server-install.sh
# Touches only: /opt/brightwater-spike-s3 (new), the brightwater-spike-s3 Compose project (new),
# and the proxy container's default.conf mount (recreated with proxy-override.yaml). Nothing in
# /opt/brightwater changes. Any failure after the proxy recreate rolls the proxy back.
set -euo pipefail
STAGE=/tmp/spike-s3-stage
DEST=/opt/brightwater-spike-s3
NGINX_IMAGE='nginx:1.30.6@sha256:66b50d24288dba67f3d000b31223daefc4868c58d29aaacb6a4ff9771597b5eb'

echo "== 0. no other spike stack is present (D-12: the server is serialized by stage)"
if ls -d /opt/brightwater-spike-* 2>/dev/null | grep -v "^$DEST\$"; then echo "STOP: another spike dir exists"; exit 1; fi

echo "== 1. the spike default.conf differs from the live one by exactly the 3 added lines (comment, include, blank)"
added="$(diff /opt/brightwater/nginx/default.conf "$STAGE/nginx/default.conf" | grep -c '^>' || true)"
removed="$(diff /opt/brightwater/nginx/default.conf "$STAGE/nginx/default.conf" | grep -c '^<' || true)"
diff /opt/brightwater/nginx/default.conf "$STAGE/nginx/default.conf" || true
if [ "$added" != 3 ] || [ "$removed" != 0 ]; then echo "STOP: unexpected diff (+$added -$removed)"; exit 1; fi

echo "== 2. install files to $DEST"
install -d -m 755 "$DEST" "$DEST/site" "$DEST/site/vendor" "$DEST/nginx" "$DEST/logs"
install -m 644 "$STAGE"/site/index.html "$STAGE"/site/app.js "$STAGE"/site/columbus.pmtiles "$DEST/site/"
install -m 644 "$STAGE"/site/vendor/* "$DEST/site/vendor/"
install -m 644 "$STAGE/nginx/default.conf" "$STAGE/nginx/locations.conf" "$STAGE/nginx/spike.conf" "$DEST/nginx/"
install -m 644 "$STAGE/compose.yaml" "$STAGE/proxy-override.yaml" "$DEST/"
install -m 755 "$STAGE/server-teardown.sh" "$DEST/"
sha256sum $(find "$DEST" -type f -not -path "$DEST/logs/*" | sort)

echo "== 3. proxy mounts before"
docker inspect brightwater-proxy-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

echo "== 4. nginx -t of the spike configs in throwaway containers on the stack network"
docker run --rm --network brightwater_default \
  -v "$DEST/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$DEST/nginx/locations.conf:/etc/nginx/spike-s3/locations.conf:ro" \
  -v brightwater_letsencrypt:/etc/letsencrypt:ro -v brightwater_acme:/var/www/acme:ro \
  "$NGINX_IMAGE" nginx -t
docker run --rm -v "$DEST/nginx/spike.conf:/etc/nginx/conf.d/default.conf:ro" -v "$DEST/logs:/var/log/spike" \
  "$NGINX_IMAGE" nginx -t

echo "== 5. start the spike file server (its own Compose project)"
cd "$DEST"
docker compose -p brightwater-spike-s3 up -d
for _ in $(seq 1 20); do
  if docker run --rm --network brightwater_default "$NGINX_IMAGE" curl -sf -o /dev/null http://spike-s3:8080/spike/s3/; then break; fi
  sleep 1
done
docker run --rm --network brightwater_default "$NGINX_IMAGE" curl -s -o /dev/null -w 'spike-s3 direct: %{http_code}\n' http://spike-s3:8080/spike/s3/

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
