#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P1-DEPLOY: the server half of the deploy (SPECIFICATIONS SD-40 step 5). Run ON the hosted server
# as root by infra/deploy/deploy.sh, never by hand:
#   sudo bash /tmp/bw-deploy-stage/server-deploy.sh /tmp/bw-deploy-stage <image tag>
#   sudo bash /tmp/bw-deploy-stage/server-deploy.sh /tmp/bw-deploy-stage --host-files   (F-45: host files only, see below)
# The image is already loaded (deploy.sh pipes docker save into docker load). This script:
#   0. refuses while any spike stack is on the server (BUILD_PLAN D-12: 1 stage at a time);
#   1. checks the staged compose.yaml with docker compose config and the staged nginx config with
#      nginx -t in a throwaway container;
#   2. if nothing changed (same files, same image), only checks /healthz and stops (idempotent);
#   3. keeps the current release's files (.env holds its BW_IMAGE) in /opt/brightwater/.prev;
#   4. installs the staged files, docker compose up -d, reloads nginx;
#   5. waits up to 120 s for https://bw.j7l.io/healthz 200 (through the real proxy and TLS) and then
#      confirms that the web container runs the new image tag (F-95), else it is a failed deploy;
#   6. else restores .prev (the previous image and its files), docker compose up -d, and waits
#      again for 200. That is the rollback.
#   Healthy (step 2 or 5): the worker's import source check (P3-IMPORT-WORKER): the worker makes the
#   export an office import run reads, from the street list installed below (staged data/, put where
#   the Compose file mounts it: BW_DATA_DIR, default ../.build/data beside /opt/brightwater), and it must match
#   packages/generator/MANIFEST.json. A failed check is exit 5 (the release stays: a rollback would
#   not change the data file).
# /healthz waiting rule: 200 passes; no answer, 502, 503 and 504 mean "not up yet" and keep
# waiting; any other status (500, 404, ...) is outside the section 7.4 contract (which answers
# only 200 or 503), so it fails at once instead of waiting out the 120 s.
# Exit: 0 deployed (or unchanged and healthy); 3 rolled back, previous release healthy;
#       4 rollback failed or impossible; 1 refused before anything changed; 5 deployed and healthy,
#       but the worker's import source check failed; 6 deployed and healthy, but a backup timer
#       reads enabled or active while the deploy asked it off (F-560).
# The server's .env (F-98): the keys of the staged env.base and BW_IMAGE are the deploy's, rewritten
# by every deploy; every other KEY=value line already in /opt/brightwater/.env (the owner's: secrets,
# IOS_INSTALL_KIND, IOS_INSTALL_LINK; SPECIFICATIONS 11.1) is carried into the new .env. See write_env.
# The map files (F-364 (a)): deploy.sh stages maps.sha256 (every file packages/maps/MANIFEST.json
# names) and sends each file the server's record does not list yet into <map folder>/.incoming, on the
# map folder's own filesystem, never /tmp (F-1646); this script checks every sent file's SHA-256 before
# it moves any, installs each by a same-filesystem rename, the routing sentinel last (F-1647), and
# refuses (exit 1) unless every listed file is there. The map folder is the staged env.base's
# BW_MAPS_DIR line, the one deploy.sh read and Compose mounts (F-1648).
# --host-files (F-45): syncs setup.sh, certbot-renew.sh, renewal-status.sh and the whole systemd/ folder into /opt/brightwater, installs only
# the 2 certbot units (service and timer) into /etc/systemd/system, reloads systemd, enables the timer, and seeds the renewal status file. It never touches compose.yaml, .env, nginx, the image or any container, so web stays as it is. Exit 0 or 1.
set -euo pipefail
STAGE="${1:?stage dir}"
IMAGE="${2:?image tag}"
DEST=/opt/brightwater
PREV="$DEST/.prev"
DOMAIN=bw.j7l.io
WAIT_S=120
# The files this script owns in $DEST. Everything else there (none today) is left alone.
MANAGED=(compose.yaml nginx placeholder .env setup.sh certbot-renew.sh renewal-status.sh bucket-check.sh systemd backup)
# The host timers this script installs from systemd/ (each with its .service); the certbot one is kept enabled, the backup ones per BACKUP_TIMERS.
TIMERS=(brightwater-certbot-renew brightwater-backup brightwater-restore-test)
# F-388 (owner ruling 1c7bcc42, "Move hosted half to phase 8": no hosted backups until then): the 2 backup timers are installed
# but turned on only by a deploy that asks for them, P8-UNLOCK's (deploy.sh --profile demo stages $STAGE/backups-on). Any other
# deploy leaves them off, and turns off a pair an earlier deploy had enabled.
BACKUP_TIMERS=(brightwater-backup brightwater-restore-test)

# F-364 (a): the map folder's record of the files this script has checked (sha256sum format, 1 line per file).
MAPS_RECORD=.verified.sha256
# F-1646: the folder inside the map folder that deploy.sh sends the map files into (its literal there too).
MAPS_INCOMING=.incoming
# F-1647: the file the routing service waits for (infra/compose.yaml's routing command); installed after every other map file.
MAPS_SENTINEL=ohio.osrm.mldgr
# F-98: the first line of every .env this script writes, naming the keys the deploy owns.
OWNED_MARK='# deploy-owned keys:'
# F-1649: the line that ends the deploy's own lines of that .env; the owner's lines are below it.
OWNER_MARK='# Owner-set lines go below'

ts() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
log() { echo "[$(ts)] $*"; }

# Install the units from $DEST/systemd and set each timer: the certbot timer always on, the backup timers on only when the deploy asked.
# F-560: then each timer's state is read back (systemctl is-enabled and is-active) and logged; a backup timer that reads enabled or
# active while the deploy asked it off sets timers_wrong=1 (the caller fails the deploy, exit 6). It is not a return code, so a
# failed "enable --now" still stops the script under set -e.
timers_wrong=0
install_timers() {
  local t u asked=off backup want en ac
  [ ! -e "$STAGE/backups-on" ] || asked=on
  for t in "${TIMERS[@]}"; do
    for u in "$t.service" "$t.timer"; do
      if ! cmp -s "$DEST/systemd/$u" "/etc/systemd/system/$u"; then
        install -m 0644 "$DEST/systemd/$u" /etc/systemd/system/
        systemctl daemon-reload
        log "  installed $u"
      fi
    done
    backup=0
    case " ${BACKUP_TIMERS[*]} " in *" $t "*) backup=1 ;; esac
    if [ "$backup" = 1 ] && [ "$asked" = off ]; then
      systemctl disable --now "$t.timer" >/dev/null 2>&1 || true
    else
      systemctl enable --now "$t.timer" >/dev/null 2>&1
    fi
  done
  for t in "${TIMERS[@]}"; do
    want=on
    case " ${BACKUP_TIMERS[*]} " in *" $t "*) want="$asked" ;; esac
    en=$(systemctl is-enabled "$t.timer" 2>/dev/null) || true
    ac=$(systemctl is-active "$t.timer" 2>/dev/null) || true
    log "  $t.timer asked $want: is-enabled ${en:-unknown}, is-active ${ac:-unknown}"
    if [ "$want" = off ]; then
      case "$en" in enabled*) timers_wrong=1; log "  TIMER WRONG: $t.timer reads $en while asked off (no hosted backups until P8-UNLOCK)" ;; esac
      [ "$ac" != active ] || { timers_wrong=1; log "  TIMER WRONG: $t.timer reads active while asked off"; }
    fi
  done
}

# write_env <env.base> <current .env> <out> (F-98): the new .env. The deploy owns the keys of env.base and BW_IMAGE, written from the
# committed files. Every other KEY=value line of the current .env is carried, in order and byte for byte, below the deploy's lines:
# the owner's secrets and settings survive every deploy. A key the last deploy owned (the OWNED_MARK line of the current .env) and
# this one does not (taken out of hosted.env, or the demo profile not asked this time) is dropped, not carried. A current .env with
# no OWNED_MARK line (written before F-98: deploy keys only) carries every key the new env.base does not hold. Logs key names only.
# F-1649: no owner line is dropped without a log line, and none is logged with its value. Every line Compose's .env reader takes as
# a key (an export prefix, leading spaces, spaces around the equals sign) is read by its key name and carried as it is; a value that
# opens a quote and closes it on a later line is carried (or not) whole, with its continuation lines. Below OWNER_MARK (the owner's
# part), an owner value of a key the deploy owns (ROUTES, DOMAIN, ...) is not carried, and the log names the key and the line. A line
# that is no key, comment or blank is not carried, and the log names its line number only. The deploy's own lines above OWNER_MARK
# (or every line of a .env with no OWNER_MARK, written before F-98 by the deploy) are rewritten without a log line.
write_env() {
  local base="$1" cur="$2" out="$3" owned prev=" " line k="" v n=0 from=0 q="" carry=0 region=deploy
  local kv='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$'
  local dq_shut='(^|[^\\])"'
  owned=" $(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$base" | tr '\n' ' ')BW_IMAGE "
  if [ -f "$cur" ]; then prev=" $(sed -n "s/^$OWNED_MARK //p" "$cur" | head -n 1) "; fi
  {
    echo "$OWNED_MARK$(printf '%s' "$owned" | sed 's/ $//')"
    cat "$base"
    echo "BW_IMAGE=$IMAGE"
    echo "$OWNER_MARK (secrets, IOS_INSTALL_KIND, IOS_INSTALL_LINK): every deploy keeps each key it does not own (F-98)."
  } > "$out"
  [ -f "$cur" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    if [ -n "$q" ]; then
      # a continuation line of a multi-line quoted value: it goes where its first line went
      [ "$carry" = 0 ] || printf '%s\n' "$line" >> "$out"
      if [ "$q" = "'" ]; then [[ "$line" != *"'"* ]] || q=""; elif [[ "$line" =~ $dq_shut ]]; then q=""; fi
      if [ -z "$q" ] && [ "$carry" = 1 ]; then log "  .env: kept the owner-set key $k (lines $from-$n, a multi-line value)"; fi
      continue
    fi
    case "$line" in "$OWNER_MARK"*) region=owner; continue ;; esac
    if [[ "$line" =~ ^[[:space:]]*(#|$) ]]; then continue; fi
    if ! [[ "$line" =~ $kv ]]; then log "  .env: line $n not carried: it is not a KEY=value line (its text is not logged)"; continue; fi
    k="${BASH_REMATCH[2]}" v="${BASH_REMATCH[3]}" from=$n q="" carry=0
    case "$v" in
      \"*) [[ "${v:1}" =~ $dq_shut ]] || q='"' ;;
      \'*) [[ "${v:1}" == *"'"* ]] || q="'" ;;
    esac
    if [[ "$owned" == *" $k "* ]]; then
      [ "$region" = deploy ] || log "  .env: the owner value of $k (line $n) is not carried: the deploy owns $k"
    elif [[ "$prev" == *" $k "* ]]; then
      log "  .env: dropped $k (the last deploy owned it, this one does not)"
    else
      carry=1
      printf '%s\n' "$line" >> "$out"
      [ -n "$q" ] || log "  .env: kept the owner-set key $k"
    fi
  done < "$cur"
  if [ -n "$q" ]; then log "  .env: the value of $k (from line $from) never closes its quote"; fi
  return 0
}

# install_maps <dir> (F-364 (a)): 0 when every file of $STAGE/maps.sha256 is in <dir> and checked, 1 otherwise. The files deploy.sh
# sent are in <dir>/$MAPS_INCOMING, on the map folder's own filesystem (F-1646): every one named in the list is checked before any is
# moved (a bad one moves none), then each is moved in by a rename on that filesystem and its line written to the folder's record, the
# routing sentinel $MAPS_SENTINEL after every other file (F-1647: the routing service starts on the set it guards, never a part of it).
# The folder $MAPS_INCOMING is removed on every return (anything there not in the list is not installed). A file not sent must already
# be in <dir> with the same line in the record.
install_maps() {
  local dir="$1" in="$1/$MAPS_INCOMING" name line bad=0 rest=() last=()
  [ -f "$STAGE/maps.sha256" ] || { log "  no map list staged"; rm -rf "$in"; return 1; }
  mkdir -p "$dir"
  touch "$dir/$MAPS_RECORD"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line#*  }"
    [ -f "$in/$name" ] || continue
    if [ "$(sha256sum "$in/$name" | cut -d' ' -f1)" != "${line%%  *}" ]; then log "  map file $name: its SHA-256 is not the manifest's"; rm -rf "$in"; return 1; fi
    if [ "$name" = "$MAPS_SENTINEL" ]; then last+=("$line"); else rest+=("$line"); fi
  done < "$STAGE/maps.sha256"
  for line in ${rest[@]+"${rest[@]}"} ${last[@]+"${last[@]}"}; do
    name="${line#*  }"
    chmod 0644 "$in/$name"
    mv -f "$in/$name" "$dir/$name"
    { grep -v -E "  $name\$" "$dir/$MAPS_RECORD" || true; printf '%s\n' "$line"; } > "$dir/$MAPS_RECORD.new"
    mv -f "$dir/$MAPS_RECORD.new" "$dir/$MAPS_RECORD"
    log "  installed the map file $name"
  done
  rm -rf "$in"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line#*  }"
    if [ ! -f "$dir/$name" ] || ! grep -q -x -F -e "$line" "$dir/$MAPS_RECORD"; then bad=1; log "  map file $name: not on the server as the manifest names it"; fi
  done < "$STAGE/maps.sha256"
  [ "$bad" = 0 ] || return 1
  log "  map files: all $(grep -c . "$STAGE/maps.sha256") in $dir, checked against the manifest"
}

# Copy src over dest keeping dest's directory inodes: the proxy bind-mounts nginx/ and
# placeholder/, and a deleted-and-recreated directory would leave it serving the old one.
sync_item() {
  local src="$1" dst="$2"
  if [ ! -e "$src" ]; then rm -rf "$dst"; return; fi
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    cp -a "$src/." "$dst/"
    (cd "$dst" && find . -type f) | while read -r f; do [ -e "$src/$f" ] || rm -f "$dst/$f"; done
  else
    cp -a "$src" "$dst"
  fi
}

# The worker's import source check (apps/worker/src/import/check.ts), after a healthy start. 0 or 5.
import_source_check() {
  local out rc=0
  # F-532 (a): in its own container (same image, mounts and memory cap), not exec'd into the running worker, whose cgroup may be executing an
  # owed office run (the pick-up at start-up): measured, the check alone peaks at 217 MiB and one office dry run at 401 MiB, together near the
  # 768m cap. --no-deps: the check reads the generator's inputs and needs no other service.
  out=$(cd "$DEST" && docker compose run --rm --no-deps -T worker node apps/worker/src/import/check.ts 2>&1) || rc=$?
  echo "$out" | sed 's/^/  /'
  if [ "$rc" = 0 ]; then log "IMPORT SOURCE OK"; return 0; fi
  log "IMPORT SOURCE FAILED (exit $rc)"
  return 5
}

health_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" || true
}

# wait_healthy <label>: 0 on 200 within WAIT_S seconds, 1 otherwise.
wait_healthy() {
  local label="$1" start now code last=""
  start=$(date +%s)
  while :; do
    now=$(date +%s)
    code=$(health_code)
    if [ "$code" != "$last" ]; then log "HEALTH $label t=+$((now - start))s /healthz $code"; last="$code"; fi
    case "$code" in
      200) log "HEALTHY $label after $((now - start))s"; return 0 ;;
      000|502|503|504) ;;
      *) log "UNHEALTHY $label: /healthz answered $code (outside the 7.4 contract), not waiting"; return 1 ;;
    esac
    if [ $((now - start)) -ge "$WAIT_S" ]; then log "UNHEALTHY $label: no 200 within ${WAIT_S}s (last $code)"; return 1; fi
    sleep 1
  done
}

# running_image <service>: the image tag the running container of a Compose service was created from.
running_image() {
  local cid
  cid=$(cd "$DEST" && docker compose ps -q "$1" 2>/dev/null | head -n 1) || return 1
  [ -n "$cid" ] || return 1
  docker inspect --format '{{.Config.Image}}' "$cid"
}

# confirm_image <label> <expected tag>: 0 when the web container runs the expected image (F-95: a 200 from
# /healthz says some release answered, not which one; after a failed compose up the old web still answers).
confirm_image() {
  local label="$1" want="$2" got
  got=$(running_image web) || got=""
  if [ "$got" = "$want" ]; then log "IMAGE $label: web runs $want"; return 0; fi
  log "UNHEALTHY $label: web runs '${got:-nothing}', not $want, so the 200 did not come from this release"
  return 1
}

# Never exits the script: a failed start is judged by the /healthz wait, which rolls back.
# F-1295, F-1305: every service outside a profile starts, the routing service (SD-49) among them. P6-ROUTING-MEMORY measured routing on
# small_3_0 and the owner kept it (BUILD_PLAN section 3 D-21, owner answer 8936427c): it runs at its 320 MiB cap, and no setting turns it
# off. Until the routing files reach the server with its map files (F-364 (a)), the service waits for them, checking every 30 s
# (infra/compose.yaml), and every leg no baked track covers answers approximate (SD-49 step 3).
compose_up() {
  (cd "$DEST" && docker compose up -d 2>&1 | sed -e '/^[[:space:]]*$/d' -e 's/^/  compose: /') || log "WARN: docker compose up failed"
  # The proxy may not have been recreated; its files may have changed in place.
  (cd "$DEST" && docker compose exec -T proxy sh -c 'nginx -t -q && nginx -s reload') || log "WARN: nginx reload failed"
}

log "== server-deploy $IMAGE"

# F-45: the host-files mode, run by deploy.sh --host-files inside the outage drill's stop window.
if [ "$IMAGE" = --host-files ]; then
  chown -R root:root "$STAGE"
  for f in setup.sh certbot-renew.sh renewal-status.sh systemd; do sync_item "$STAGE/$f" "$DEST/$f"; done
  for u in brightwater-certbot-renew.service brightwater-certbot-renew.timer; do
    if ! cmp -s "$DEST/systemd/$u" "/etc/systemd/system/$u"; then install -m 0644 "$DEST/systemd/$u" /etc/systemd/system/; log "  installed $u"; fi
  done
  systemctl daemon-reload
  systemctl enable --now brightwater-certbot-renew.timer >/dev/null 2>&1
  bash "$DEST/renewal-status.sh" seed || { log "RESULT host files installed, seeding the status file failed"; exit 1; }
  log "RESULT host files installed"
  exit 0
fi

log "== 0. no spike stack on the server (D-12)"
if ls -d /opt/brightwater-spike-* 2>/dev/null; then log "REFUSED: a spike directory exists"; exit 1; fi
if docker compose ls -a --format json | grep -o '"Name":"[^"]*"' | grep -v '"Name":"brightwater"'; then
  log "REFUSED: a Compose project other than brightwater exists"; exit 1
fi
log "none"

log "== 1. image and staged config"
# scp ran as the login user; the installed files belong to root, like the S5 originals.
chown -R root:root "$STAGE"
docker image inspect "$IMAGE" --format "  image $IMAGE id {{.Id}} revision {{index .Config.Labels \"org.opencontainers.image.revision\"}}"
write_env "$STAGE/env.base" "$DEST/.env" "$STAGE/.env"
chmod 600 "$STAGE/.env"
#    F-95: the staged compose file must parse and interpolate with the staged .env, or docker compose up
#    could fail before it replaces web and the old release would answer the health wait.
if ! compose_cfg=$(docker compose --project-directory "$STAGE" -p brightwater -f "$STAGE/compose.yaml" --env-file "$STAGE/.env" config -q 2>&1); then
  echo "$compose_cfg" | sed 's/^/  /'
  log "REFUSED: docker compose config failed on the staged compose.yaml"; exit 1
fi
log "  staged compose.yaml parses"
proxy_conf=$(sed -n 's/^PROXY_CONF=//p' "$STAGE/.env")
routes=$(sed -n 's/^ROUTES=//p' "$STAGE/.env")
nginx_image=$(sed -n 's/^ *image: \(nginx:.*\)$/\1/p' "$STAGE/compose.yaml")
if ! nginx_t=$(docker run --rm --network brightwater_default \
  -v "$STAGE/nginx:/etc/nginx/bw:ro" -v "$STAGE/placeholder:/usr/share/nginx/placeholder:ro" \
  -v brightwater_letsencrypt:/etc/letsencrypt:ro -v brightwater_acme:/var/www/acme:ro \
  "$nginx_image" sh -c "ln -sf /etc/nginx/bw/$proxy_conf /etc/nginx/conf.d/default.conf && ln -sf /etc/nginx/bw/routes-$routes.conf /etc/nginx/bw-routes.conf && nginx -t" 2>&1); then
  echo "$nginx_t" | sed 's/^/  /'
  log "REFUSED: nginx -t failed on the staged config"; exit 1
fi
echo "$nginx_t" | sed 's/^/  /'

# The street list the worker's import job reads (not a release file: the same verified bytes for every release, so a
# rollback keeps it). Installed where the Compose file mounts it from, readable by the image's node user.
data_dir=$(sed -n 's/^BW_DATA_DIR=//p' "$STAGE/.env" 2>/dev/null || true)
data_dir="${data_dir:-$(dirname "$DEST")/.build/data}"
if [ -f "$STAGE/data/street-list.json" ] && ! cmp -s "$STAGE/data/street-list.json" "$data_dir/street-list.json"; then
  install -D -m 0644 "$STAGE/data/street-list.json" "$data_dir/street-list.json"
  log "  installed the street list in $data_dir"
fi
# F-364 (a): the map files, like the street list not release files (a rollback keeps them). F-1648: the folder is the BW_MAPS_DIR line
# deploy.sh wrote into env.base, the line it read the server's record by; Compose mounts the same value (the deploy owns the key).
maps_dir=$(sed -n 's/^BW_MAPS_DIR=//p' "$STAGE/env.base" | tail -n 1)
if [ -z "$maps_dir" ]; then log "REFUSED: the staged env.base names no BW_MAPS_DIR (deploy.sh writes it)"; exit 1; fi
if ! install_maps "$maps_dir"; then log "REFUSED: the map files on the server do not match packages/maps/MANIFEST.json"; exit 1; fi

changed=0
for f in "${MANAGED[@]}"; do
  if ! diff -rq "$STAGE/$f" "$DEST/$f" >/dev/null 2>&1; then changed=1; log "  changes: $f"; fi
done
if [ "$changed" = 0 ]; then
  log "== 2. nothing changed ($IMAGE already live); checking /healthz only"
  compose_up
  if wait_healthy current && confirm_image current "$IMAGE"; then
    import_source_check || { log "RESULT unchanged, import source check failed"; exit 5; }
    log "RESULT unchanged"; exit 0
  fi
  log "RESULT unchanged but unhealthy"; exit 4
fi

log "== 3. keep the current release in $PREV"
prev_image=$(sed -n 's/^BW_IMAGE=//p' "$DEST/.env" 2>/dev/null || true)
log "  previous image: ${prev_image:-none (pre-P1-DEPLOY placeholder stack)}"
if [ ! -e "$DEST/compose.yaml" ]; then log "  no current release to roll back to"; fi
rm -rf "$PREV"
mkdir -p "$PREV"
for f in "${MANAGED[@]}"; do [ -e "$DEST/$f" ] && cp -a "$DEST/$f" "$PREV/$f"; done

log "== 4. install and start $IMAGE"
for f in "${MANAGED[@]}"; do sync_item "$STAGE/$f" "$DEST/$f"; done
compose_up
log "  started"

log "== 5. wait up to ${WAIT_S}s for /healthz 200"
if wait_healthy new && confirm_image new "$IMAGE"; then
  install_timers
  if [ "$timers_wrong" = 1 ]; then log "RESULT deployed $IMAGE, but a backup timer is on while asked off (F-560)"; exit 6; fi
  # Keep the 3 newest bw-app images plus the live and previous ones.
  docker image ls bw-app --format '{{.Repository}}:{{.Tag}}' | tail -n +4 | while read -r old; do
    [ "$old" = "$IMAGE" ] || [ "$old" = "$prev_image" ] || docker image rm "$old" >/dev/null 2>&1 || true
  done
  docker compose -f "$DEST/compose.yaml" ps --format '  {{.Service}} {{.Image}} {{.Status}}' || true
  import_source_check || { log "RESULT deployed $IMAGE, import source check failed"; exit 5; }
  log "RESULT deployed $IMAGE"
  exit 0
fi

log "== 6. ROLLBACK to ${prev_image:-the previous release}"
if [ ! -e "$PREV/compose.yaml" ]; then log "RESULT rollback impossible: no previous release"; exit 4; fi
for f in "${MANAGED[@]}"; do sync_item "$PREV/$f" "$DEST/$f"; done
compose_up
log "  previous release started"
if wait_healthy rollback && { [ -z "$prev_image" ] || confirm_image rollback "$prev_image"; }; then
  docker compose -f "$DEST/compose.yaml" ps --format '  {{.Service}} {{.Image}} {{.Status}}' || true
  log "RESULT rolled back to ${prev_image:-the previous release}"
  exit 3
fi
log "RESULT rollback failed"
exit 4
