#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P1-DEPLOY: deploy the app to the hosted server bw.j7l.io, from this Mac or Spectre.
# Owner ruling 64032d47 (Oct 31, 2026, "Local script"): the manager starts it by hand, like the
# wave test run. No GitHub Actions job and no tag push starts it.
#
#   bash infra/deploy/deploy.sh                  deploy HEAD (from the repo root, clean tree)
#   bash infra/deploy/deploy.sh --drill 500      rollback drill: deploy a planted image whose
#                                                /healthz answers 500; passes when the server
#                                                rolls back and /healthz answers 200 again
#   bash infra/deploy/deploy.sh --drill 503      the same, through the full 120 s wait
#   bash infra/deploy/deploy.sh --release v1.0.0 --profile demo
#                                                F-1611 (P8-UNLOCK): deploy the published release image
#                                                bw-app:<tag> that scripts/publish.sh built and checked, not a
#                                                build of HEAD, so the footer's Source link names the public
#                                                commit (FR-DIST-3). See "Release mode" below. This is the only
#                                                deploy that opens the demo (ROUTES=open, below).
#   bash infra/deploy/deploy.sh --lock          F-1660: stage the lock (ROUTES=locked) over a server that runs open. Without it, a deploy that
#                                                would stage locked over a server whose .env reads ROUTES=open stops (exit 2) before any copy.
#   options: --profile demo   add the demo profile settings (infra/profiles/demo.env); P8-UNLOCK. A deploy (not a drill)
#                             with --profile demo needs --release: the open demo runs only a published image (F-1611).
# ROUTES (F-1645) comes from the deploy mode, never from a file: --release <tag> --profile demo stages ROUTES=open, every other
# deploy and every drill stages ROUTES=locked, exactly 1 line in env.base (hosted.env and demo.env hold none; a ROUTES line
# there stops the deploy). So P8-UNLOCK opens the demo with the files of the published release, which the --release guard
# requires, and a plain deploy of HEAD can never open it. The closing probe (F-1641) expects what the deploy staged: locked,
# the placeholder on every probed path; open, the app (not the placeholder, no 5xx). A drill expects the routes the server ran
# before it (its .env's ROUTES), since the rollback restores them.
# F-1660: every deploy reads the server's ROUTES (the drill's read) right after the architecture check. One that would stage locked
# over ROUTES=open stops with exit 2 before anything is built, copied or changed, unless --lock says the lock is wanted; so a plain
# deploy cannot silently re-lock the open demo. To keep it open, re-run with --release <tag> --profile demo.
#            --allow-dirty    deploy uncommitted files (image tag gets a -dirty-<epoch> suffix)
#            --host-files     F-45: sync setup.sh, certbot-renew.sh, renewal-status.sh and the whole systemd/
#                             folder to the server, install only the 2 certbot units, enable the timer and seed the renewal status file; no image build or transfer, no compose up, web untouched. P8-OUTAGE-DRILL runs
#                             it inside its stop window. Deploys whatever commit is checked out here (any branch, clean tree).
# Env: BW_HOST (user@server-address; from the environment or the owner's private file, else the script stops), BW_KEY (default ~/.ssh/brightwater-lightsail.pem).
#
# Steps (SPECIFICATIONS SD-40 step 5): read the server's CPU architecture; build the image for it
# (infra/image/Dockerfile, tag bw-app:<commit>); docker save | ssh docker load, skipped when the
# server already holds that tag; copy the Compose file, nginx config, placeholder, hosted
# scripts and the verified street list; run infra/deploy/server-deploy.sh there (install, docker
# compose up -d, wait up to 120 s for /healthz 200, else start the previous image; then the
# worker's import source check); probe the public URLs.
# F-364 (a): the map files of packages/maps/MANIFEST.json (the 3 branch maps, the track set and the routing files) are fetched and
# checked here (node ci/data-assets.ts ensure --with-routing, as the stacks do), listed with their SHA-256 in the staged maps.sha256,
# and each one the server's record (<map folder>/.verified.sha256) does not hold yet is sent; server-deploy.sh checks and installs
# them. The first deploy sends all of them (about 2.8 GB); a later one sends only a changed file.
# F-1646: the map files never go through /tmp (on Debian 13 a RAM-backed tmpfs, half of the server's 2 GB). They are streamed
# (tar over ssh, written by root) into <map folder>/.incoming, on the map folder's own filesystem, after a check that it has room
# for them plus 1 GiB; server-deploy.sh installs each by a same-filesystem rename and removes .incoming. A failed send removes it.
# F-1648: the map folder is BW_MAPS_DIR of hosted.env (default /opt/.build/data/maps, Compose's default beside /opt/brightwater),
# written into env.base as 1 line; this script, server-deploy.sh and Compose (the deploy owns the key, F-98) all read that line.
# Release mode (--release <tag>, F-1611): the image is the one scripts/publish.sh image built for the tag and the push published:
# the publish state (<clone>/.git/bw-publish/<tag>.env; clone BW_PUBLISH_CLONE, default .build/publish/right-on-time) must say
# PUSHED=1, and its checked image (IMAGE_ID, IMAGE_COMMIT = COMMIT, IMAGE_CONTEXT) must still be bw-app:<tag> in that Docker
# context, with PUBLIC_COMMIT and the revision label the public commit, for the server's architecture. What the deploy stages
# (DEPLOY_INPUTS) must equal the release's private commit (PRIVATE). Nothing is built; the image goes from that context to the
# server, which must then hold bw-app:<tag> with that PUBLIC_COMMIT.
# Idempotent: a re-run of a deployed commit changes nothing and only re-checks /healthz.
# The other files (small: config, scripts, the street list) travel through /tmp/bw-deploy-stage on the server, which root owns once
# server-deploy.sh has run; this script removes it as root before the copy and after the run (F-94).
# Log: .build/deploy/<UTC stamp>-<mode>.log (gitignored). Exit 0 on success (a drill: rolled back
# and healthy), non-zero otherwise.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
. "$root/infra/drill/owner-env.sh"; bw_need_host "$root" || exit 2
HOST="$BW_HOST"
KEY="${BW_KEY:-$HOME/.ssh/brightwater-lightsail.pem}"
DOMAIN=bw.j7l.io
REMOTE_STAGE=/tmp/bw-deploy-stage

drill="" profile="" allow_dirty=0 host_files=0 release="" lock=0
while [ $# -gt 0 ]; do
  case "$1" in
    --drill) drill="${2:?--drill 500|503}"; shift 2 ;;
    --release) release="${2:?--release vX.Y.Z}"; shift 2 ;;
    --profile) profile="${2:?--profile demo}"; shift 2 ;;
    --allow-dirty) allow_dirty=1; shift ;;
    --host-files) host_files=1; shift ;;
    --lock) lock=1; shift ;;
    *) echo "usage: bash infra/deploy/deploy.sh [--drill 500|503] [--release vX.Y.Z] [--profile demo] [--allow-dirty] [--host-files] [--lock]" >&2; exit 2 ;;
  esac
done
case "$drill" in ""|500|503) ;; *) echo "--drill takes 500 or 503" >&2; exit 2 ;; esac
case "$profile" in ""|demo) ;; *) echo "--profile takes demo" >&2; exit 2 ;; esac

if [ "$host_files" = 1 ] && { [ -n "$drill" ] || [ -n "$profile" ]; }; then echo "--host-files does not combine with --drill or --profile" >&2; exit 2; fi
if [ "$lock" = 1 ] && { [ -n "$drill" ] || [ -n "$profile" ] || [ "$host_files" = 1 ]; }; then echo "--lock does not combine with --drill, --profile or --host-files" >&2; exit 2; fi
if [ -n "$release" ]; then
  [[ "$release" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--release takes a version tag vX.Y.Z" >&2; exit 2; }
  if [ -n "$drill" ] || [ "$host_files" = 1 ] || [ "$allow_dirty" = 1 ]; then echo "--release does not combine with --drill, --host-files or --allow-dirty" >&2; exit 2; fi
fi
if [ "$profile" = demo ] && [ -z "$drill" ] && [ -z "$release" ]; then
  echo "--profile demo needs --release <tag>: the open demo runs only the published release image (F-1611)" >&2; exit 2
fi
log_dir="${BW_DEPLOY_LOG_DIR:-$root/.build/deploy}"
mkdir -p "$log_dir"
mode=deploy; [ -z "$drill" ] || mode="drill-$drill"; [ "$host_files" = 0 ] || mode=host-files
log_file="$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-$mode.log"
exec > >(tee "$log_file") 2>&1
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*"; }
ssh_() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }

log "== deploy.sh ${drill:+--drill $drill }${release:+--release $release }${profile:+--profile $profile }(log $log_file)"
commit=$(git rev-parse --short=12 HEAD)
tag="bw-app:$commit"
# F-100: the clean-tree guard covers what the deploy ships (the image's COPY sources and the staged
# files), not the whole repo: uncommitted .build/ records or docs do not change the release.
DEPLOY_INPUTS=(
  apps/web apps/worker/package.json apps/worker/src apps/pbs/package.json apps/pbs/src
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages LICENSE LICENSE-DATA.md THIRD-PARTY-NOTICES.md
  infra/image infra/placeholder infra/deploy infra/compose.yaml infra/nginx infra/hosted infra/profiles infra/backup
)
if [ -n "$(git status --porcelain -- "${DEPLOY_INPUTS[@]}")" ]; then
  if [ "$allow_dirty" != 1 ]; then git status --short -- "${DEPLOY_INPUTS[@]}" | head -20; log "STOP: uncommitted changes in what the deploy ships (commit them, or pass --allow-dirty)"; exit 2; fi
  tag="$tag-dirty-$(date +%s)"
fi
if [ -n "$release" ]; then
  log "== the published release $release (F-1611)"
  clone="${BW_PUBLISH_CLONE:-$root/.build/publish/right-on-time}"
  state="$clone/.git/bw-publish/$release.env"
  sget() { { grep -E "^$1=" "$state" || true; } | tail -n 1 | cut -d= -f2-; }
  [ -f "$state" ] || { log "STOP: no publish state for $release ($state): scripts/publish.sh prepare, image and push it first"; exit 2; }
  [ "$(sget PUSHED)" = 1 ] || { log "STOP: $release is not published (its publish state does not say PUSHED=1)"; exit 2; }
  public_commit=$(sget COMMIT)
  release_private=$(sget PRIVATE)
  image_id=$(sget IMAGE_ID)
  image_ctx=$(sget IMAGE_CONTEXT)
  [[ "$public_commit" =~ ^[0-9a-f]{40}$ ]] || { log "STOP: the publish state of $release names no public commit"; exit 2; }
  if [ -z "$image_id" ] || [ -z "$image_ctx" ] || [ "$(sget IMAGE_COMMIT)" != "$public_commit" ]; then
    log "STOP: no release image of $release is checked for the public commit $public_commit (scripts/publish.sh image $release)"; exit 2
  fi
  git cat-file -e "$release_private^{commit}" 2>/dev/null || { log "STOP: the release's private commit $release_private is not in this repo"; exit 2; }
  if ! git diff --quiet "$release_private" HEAD -- "${DEPLOY_INPUTS[@]}"; then
    git diff --stat "$release_private" HEAD -- "${DEPLOY_INPUTS[@]}" | tail -n 5
    log "STOP: what the deploy ships differs from the release's private commit $release_private (check out that commit's files)"; exit 2
  fi
  tag="bw-app:$release"
  commit="$release_private"
fi
log "commit $commit, image $tag${release:+, public commit $public_commit}"

if [ "$host_files" = 1 ]; then
  log "== host files only (F-45): no image, no compose up"
  if [ -n "$(git status --porcelain -- infra/hosted infra/deploy)" ]; then git status --short -- infra/hosted infra/deploy | head -20; log "STOP: uncommitted changes in infra/hosted or infra/deploy"; exit 2; fi
  stage="$(mktemp -d)/bw-deploy-stage"
  mkdir -p "$stage"
  cp -R infra/hosted/setup.sh infra/hosted/certbot-renew.sh infra/hosted/renewal-status.sh infra/hosted/bucket-check.sh infra/hosted/systemd "$stage/"
  cp infra/deploy/server-deploy.sh "$stage/"
  if ! ssh_ "sudo rm -rf ${REMOTE_STAGE}"; then log "STOP: cannot remove the old stage $REMOTE_STAGE on the server"; exit 1; fi
  scp -q -r -i "$KEY" -o BatchMode=yes "$stage" "$HOST:/tmp/"
  rm -rf "$(dirname "$stage")"
  set +e
  ssh_ "sudo bash $REMOTE_STAGE/server-deploy.sh $REMOTE_STAGE --host-files"
  rc=$?
  set -e
  log "server-deploy.sh --host-files exit $rc"
  ssh_ "sudo rm -rf ${REMOTE_STAGE}" || log "WARN: could not remove the stage $REMOTE_STAGE on the server"
  status_url="http://$DOMAIN/.well-known/acme-challenge/renewal-status.txt"
  body=$(curl -s --max-time 10 "$status_url" || true)
  log "$status_url -> $(printf '%s' "$body" | head -n 1)"
  if [ "$rc" = 0 ] && [ "$(printf '%s' "$body" | head -n 1)" = RENEWAL_OK ]; then log "HOST FILES OK"; exit 0; fi
  log "HOST FILES FAILED (server exit $rc)"
  exit 1
fi

log "== server architecture"
case "$(ssh_ uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) log "STOP: unknown server architecture"; exit 2 ;;
esac
log "server linux/$arch, this machine $(uname -m)"

# F-1660: the routes the server runs now (no line: the pre-P1-DEPLOY lock). A drill expects them (F-1641); any other deploy that would
# stage locked over open stops here, before anything is built, sent or changed.
# F-1684: only an absent line (or an absent file) reads as locked. A failed read (ssh or sudo) is a failed deploy, never taken for locked: that
# would skip the stop below and lock an open demo.
if ! routes_read=$(ssh_ "sudo sh -c 'if [ -f /opt/brightwater/.env ]; then sed -n \"s/^ROUTES=//p\" /opt/brightwater/.env; fi'"); then
  log "STOP: cannot read ROUTES from the server's /opt/brightwater/.env (ssh or sudo failed), so the deploy FAILED before anything was built, sent or changed"; exit 1
fi
live_routes=$(printf '%s\n' "$routes_read" | tail -n 1)
live_routes="${live_routes:-locked}"
if [ -z "$drill" ] && [ "$live_routes" = open ] && [ "$lock" != 1 ] && { [ -z "$release" ] || [ "$profile" != demo ]; }; then
  log "STOP: the server runs ROUTES=open and this deploy would lock it: re-run with --release <tag> --profile demo to keep it open, or add --lock to lock it on purpose"; exit 2
fi

if [ -n "$release" ]; then
  log "== check the release image $tag in Docker context $image_ctx (no build)"
  rdocker() { docker --context "$image_ctx" "$@"; }
  got=$(rdocker image inspect --format '{{.Id}}' "$tag" 2>/dev/null) || { log "STOP: $tag is not in the Docker engine of context $image_ctx"; exit 2; }
  [ "$got" = "$image_id" ] || { log "STOP: $tag (context $image_ctx) is now another image ($got), not the published one ($image_id)"; exit 2; }
  rdocker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$tag" | grep -q -x -e "PUBLIC_COMMIT=$public_commit" \
    || { log "STOP: the PUBLIC_COMMIT of $tag is not the public commit $public_commit"; exit 2; }
  got=$(rdocker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")
  [ "$got" = "$public_commit" ] || { log "STOP: the revision label of $tag is '$got', not the public commit $public_commit"; exit 2; }
  got=$(rdocker image inspect --format '{{.Os}}/{{.Architecture}}' "$tag")
  [ "$got" = "linux/$arch" ] || { log "STOP: $tag is $got, the server is linux/$arch"; exit 2; }
  log "$tag ($image_id) carries PUBLIC_COMMIT $public_commit, linux/$arch"
else
  log "== build $tag for linux/$arch"
  docker build -q --platform "linux/$arch" -f infra/image/Dockerfile --target release \
    --build-arg SOURCE_COMMIT="$commit" -t "$tag" .
fi
deploy_tag="$tag"
if [ -n "$drill" ]; then
  deploy_tag="$tag-plant$drill"
  log "== build the planted image $deploy_tag (/healthz answers $drill)"
  docker build -q --platform "linux/$arch" -f infra/image/Dockerfile --target plant \
    --build-arg SOURCE_COMMIT="$commit" --build-arg PLANT_STATUS="$drill" -t "$deploy_tag" .
  log "== a drill needs a healthy release to roll back to"
  live=$(ssh_ "sudo sed -n 's/^BW_IMAGE=//p' /opt/brightwater/.env" 2>/dev/null || true)
  # F-1641: live_routes (read above) is what the rollback restores, which the closing probe then expects.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/healthz" || true)
  log "live image ${live:-none}, routes $live_routes, /healthz $code"
  case "$live_routes" in locked|open) ;; *) log "STOP: the server's .env reads ROUTES '$live_routes', not locked or open"; exit 2 ;; esac
  if [ -z "$live" ] || [ "$code" != 200 ]; then log "STOP: deploy a good release first"; exit 2; fi
fi

log "== transfer $deploy_tag"
# server_env <tag>: the env of that image on the server (empty when the server does not hold it).
server_env() { ssh_ "sudo docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $1 2>/dev/null" || true; }
if [ -n "$release" ]; then
  if server_env "$deploy_tag" | grep -q -x -e "PUBLIC_COMMIT=$public_commit"; then
    log "server already holds $deploy_tag with PUBLIC_COMMIT $public_commit, skipped"
  else
    t0=$(date +%s)
    rdocker save "$deploy_tag" | gzip -1 | ssh_ "gunzip | sudo docker load" | sed 's/^/  /'
    log "loaded in $(( $(date +%s) - t0 ))s"
    server_env "$deploy_tag" | grep -q -x -e "PUBLIC_COMMIT=$public_commit" \
      || { log "STOP: after the load, the server's $deploy_tag does not carry PUBLIC_COMMIT $public_commit"; exit 1; }
  fi
elif [ "$deploy_tag" = "$tag" ] && [ "$allow_dirty" != 1 ] && ssh_ "sudo docker image inspect $deploy_tag >/dev/null 2>&1"; then
  log "server already holds $deploy_tag, skipped"
else
  t0=$(date +%s)
  docker save --platform "linux/$arch" "$deploy_tag" | gzip -1 | ssh_ "gunzip | sudo docker load" | sed 's/^/  /'
  log "loaded in $(( $(date +%s) - t0 ))s"
fi

log "== stage files"
stage="$(mktemp -d)/bw-deploy-stage"
mkdir -p "$stage"
cp -R infra/compose.yaml infra/nginx infra/placeholder "$stage/"
cp -R infra/hosted/setup.sh infra/hosted/certbot-renew.sh infra/hosted/renewal-status.sh infra/hosted/bucket-check.sh infra/hosted/systemd "$stage/"
# P3-BACKUP: the backup scripts (run by the systemd units in systemd/), without their local proofs.
cp -R infra/backup "$stage/"
rm -rf "$stage/backup/tests"
cp infra/deploy/server-deploy.sh "$stage/"
# P3-IMPORT-WORKER (F-258): the verified street list setup reads, which the worker's import job makes the export from.
# Fetched and checked against packages/db/src/data-manifest.json here; server-deploy.sh installs it where the Compose
# file mounts it from (BW_DATA_DIR, default ../.build/data beside the stack's folder).
node ci/data-assets.ts ensure >/dev/null
mkdir -p "$stage/data"
cp .build/data/street-list.json "$stage/data/"
# F-388: only the deploy that asks (P8-UNLOCK's, --profile demo) turns the 2 backup timers on; server-deploy.sh reads this marker.
[ "$profile" != demo ] || : > "$stage/backups-on"
{ grep -v '^#' infra/hosted/hosted.env; [ "$profile" != demo ] || grep -v '^#' infra/profiles/demo.env; } | grep -v '^$' > "$stage/env.files"
# F-1645: ROUTES from the deploy mode (see the header), never from a file.
if grep -q -E '^ROUTES=' "$stage/env.files"; then
  log "STOP: infra/hosted/hosted.env or infra/profiles/demo.env sets ROUTES; the deploy mode sets it (open only for --release <tag> --profile demo)"; exit 2
fi
routes=locked
if [ -n "$release" ] && [ "$profile" = demo ]; then routes=open; fi
# F-1648: the map folder, 1 line, read by both halves and by Compose. The value goes into remote shell commands: a plain absolute path only.
server_maps=$(sed -n 's/^BW_MAPS_DIR=//p' "$stage/env.files" | tail -n 1)
server_maps="${server_maps:-/opt/.build/data/maps}"
[[ "$server_maps" =~ ^/[A-Za-z0-9._/-]+$ ]] || { log "STOP: BW_MAPS_DIR '$server_maps' is not a plain absolute path"; exit 2; }
{ grep -v -E '^BW_MAPS_DIR=' "$stage/env.files" || true; echo "ROUTES=$routes"; echo "BW_MAPS_DIR=$server_maps"; } > "$stage/env.base"
rm -f "$stage/env.files"
log "routes $routes (from the deploy mode), map folder $server_maps"
# F-364 (a): the map files (see the header).
node ci/data-assets.ts ensure --with-routing --manifest packages/maps/MANIFEST.json --dir .build/data/maps >/dev/null
node -e 'for (const a of JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).assets) console.log(a.sha256 + "  " + a.id)' \
  packages/maps/MANIFEST.json > "$stage/maps.sha256"
if [ "$(grep -c . "$stage/maps.sha256")" = 0 ] || grep -q -v -E '^[0-9a-f]{64}  [A-Za-z0-9._-]+$' "$stage/maps.sha256"; then
  log "STOP: packages/maps/MANIFEST.json gave no usable map list"; exit 2
fi
held=$(ssh_ "sudo cat $server_maps/.verified.sha256 2>/dev/null" || true)
to_send=()
bytes=0
while IFS= read -r line; do
  if ! printf '%s\n' "$held" | grep -q -x -F -e "$line"; then
    f="${line#*  }"
    to_send+=("$f")
    bytes=$((bytes + $(wc -c < ".build/data/maps/$f")))
  fi
done < "$stage/maps.sha256"
log "map files: $(grep -c . "$stage/maps.sha256") in the manifest, checked here; ${#to_send[@]} to send, $bytes bytes (the server's record holds the rest)"
if [ "${#to_send[@]}" -gt 0 ]; then
  # F-1646: into <map folder>/.incoming (see the header), never /tmp. A stale .incoming (a cut-off send) is removed first; the
  # files to send are chosen by the server's record, so nothing in it is kept.
  incoming="$server_maps/.incoming"
  free_kib=$(ssh_ "sudo rm -rf $incoming && sudo mkdir -p $incoming && df -Pk $incoming" | tail -n 1 | awk '{print $4}') || free_kib=""
  [[ "$free_kib" =~ ^[0-9]+$ ]] || { log "STOP: cannot read the free space of the map folder's filesystem on the server"; exit 1; }
  if [ $((free_kib * 1024)) -lt $((bytes + 1073741824)) ]; then
    ssh_ "sudo rm -rf $incoming" || true
    log "STOP: the map folder's filesystem has $((free_kib / 1024)) MiB free; the map files need $((bytes / 1048576)) MiB plus 1 GiB"; exit 2
  fi
  t0=$(date +%s)
  if ! COPYFILE_DISABLE=1 tar --no-xattrs -h -C .build/data/maps -cf - -- "${to_send[@]}" | ssh_ "sudo tar -x --no-same-owner -f - -C $incoming"; then
    ssh_ "sudo rm -rf $incoming" || log "WARN: could not remove $incoming on the server (the next deploy removes it first)"
    log "STOP: sending the map files to $incoming failed"; exit 1
  fi
  log "map files sent to $incoming in $(( $(date +%s) - t0 ))s"
fi
# The server's stage belongs to root once server-deploy.sh has run (it chowns the stage), and a run
# cut off before its cleanup leaves one behind: remove it as root. Stop if that fails, since scp
# would merge the new files into the old stage.
if ! ssh_ "sudo rm -rf $REMOTE_STAGE"; then log "STOP: cannot remove the old stage $REMOTE_STAGE on the server"; exit 1; fi
scp -q -r -i "$KEY" -o BatchMode=yes "$stage" "$HOST:/tmp/"
rm -rf "$(dirname "$stage")"

log "== run server-deploy.sh"
set +e
ssh_ "sudo bash $REMOTE_STAGE/server-deploy.sh $REMOTE_STAGE $deploy_tag"
rc=$?
set -e
log "server-deploy.sh exit $rc"
# Root owns the stage now (see "stage files"). A failure here does not change the result; the
# next run removes the stage first. It is logged and repeated on the last line, never hidden.
stage_note=""
if ! ssh_ "sudo rm -rf $REMOTE_STAGE"; then
  log "WARN: could not remove the stage $REMOTE_STAGE on the server (the next run removes it first)"
  stage_note=" (WARN: stage $REMOTE_STAGE left on the server)"
fi

log "== public probes"
placeholder_sha=$(shasum -a 256 infra/placeholder/index.html | cut -d' ' -f1)
hz_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/healthz" || true)
log "https://$DOMAIN/healthz -> $hz_code $(curl -s --max-time 10 "https://$DOMAIN/healthz" || true)"
# F-1641: each path must answer as the expected routes serve it: locked, the placeholder; open, the app (not the placeholder, no 5xx).
want="$routes"; [ -z "$drill" ] || want="$live_routes"
as_want=1
for p in / /m/probe-token /office/board /api/v1/events; do
  # F-1684: a transport error on a probe is a failed probe (no body, so it is not the placeholder and its code is 000), never an exit with no verdict.
  body_sha=$({ curl -s --max-time 10 "https://$DOMAIN$p" || true; } | shasum -a 256 | cut -d' ' -f1)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN$p" || true)
  same=no; [ "$body_sha" = "$placeholder_sha" ] && same=yes
  if [ "$want" = locked ]; then
    [ "$same" = yes ] || as_want=0
  elif [ "$same" = yes ] || ! [[ "$code" =~ ^[234][0-9][0-9]$ ]]; then
    as_want=0
  fi
  log "https://$DOMAIN$p -> $code, body is the placeholder: $same"
done
log "routes $want expected: $([ "$as_want" = 1 ] && echo 'every probe answers so' || echo 'NOT every probe answers so')"
# F-1808 (F-214's live clause): the live site sends Strict-Transport-Security, read from a real answer, not from the config files.
hsts=0
if curl -s -D - -o /dev/null --max-time 10 "https://$DOMAIN/" 2>/dev/null | tr -d '\r' | grep -qi '^strict-transport-security: .*max-age=[1-9]'; then hsts=1; fi
log "https://$DOMAIN/ sends Strict-Transport-Security: $([ "$hsts" = 1 ] && echo yes || echo 'NO')"

if [ -n "$drill" ]; then
  if [ "$rc" = 3 ] && [ "$hz_code" = 200 ] && [ "$as_want" = 1 ]; then log "DRILL PASS: rolled back, /healthz 200, routes still $want$stage_note"; exit 0; fi
  log "DRILL FAIL (server exit $rc, /healthz $hz_code, routes $want answered: $as_want)$stage_note"; exit 1
fi
if [ "$rc" = 0 ] && [ "$hz_code" = 200 ] && [ "$as_want" = 1 ] && [ "$hsts" = 1 ]; then log "DEPLOY OK $deploy_tag, routes $want$stage_note"; exit 0; fi
log "DEPLOY FAILED (server exit $rc, /healthz $hz_code, routes $want answered: $as_want, HSTS: $hsts)$stage_note"
exit 1
