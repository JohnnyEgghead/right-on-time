#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P3-BACKUP local proofs: the Compose stack the backup scripts run against, on this Mac or Spectre.
#   bash infra/backup/tests/stack.sh up      build the app and runner images, start proxy, web, worker, pbs and db,
#                                            run the fresh setup (the seeded world), and start the S3-compatible server
#   bash infra/backup/tests/stack.sh down    remove the stack, its volumes, its images and its state folder
# The project is BW_BACKUP_PROJECT (default bw-w16-backup; must match bw-*backup*), so it never meets another lane's.
# No fixed host port: the proxy binds 2 free 127.0.0.1 ports; the database and S3 server publish none.
# State (bucket folder, the S3 server's random keys, mode 600) lives in $TMPDIR/<project>, named by the
# BW_PROOF_STATE line "up" prints; infra/backup/tests/backup.stack.test.ts reads it from there. Nothing secret is printed.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
project="${BW_BACKUP_PROJECT:-bw-w16-backup}"
[[ "$project" =~ ^bw-[a-z0-9-]*backup[a-z0-9-]*$ ]] || { echo "stack: project name '$project' is refused (bw-*backup*)" >&2; exit 2; }
state="${TMPDIR:-/tmp}"; state="${state%/}/$project"
image="$project:local"
runner_image="$project-runner:local"

compose() {
  BW_IMAGE="$image" DB_ENV_FILE="$state/no-db-env-file" HTTP_BIND="127.0.0.1:${PORT:-0}" HTTPS_BIND="127.0.0.1:${HTTPS_PORT:-0}" \
    SAMPLE_PASSWORD_SEED="${SEED:-unused}" BW_DATA_DIR="$root/.build/data" \
    BW_PROOF_S3_ACCESS="${S3_ACCESS:-unused}" BW_PROOF_S3_SECRET="${S3_SECRET:-unused}" \
    docker compose -p "$project" -f infra/compose.yaml -f infra/backup/tests/compose.proof.yaml "$@"
}

case "${1:-}" in
  up)
    if ! docker info >/dev/null 2>&1; then echo "stack: FAIL no usable docker" >&2; exit 3; fi
    node ci/data-assets.ts ensure >/dev/null
    install -m 0700 -d "$state" "$state/bucket"
    freeport() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
    PORT="$(freeport)" HTTPS_PORT="$(freeport)"
    SEED="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
    if [ ! -f "$state/s3.env" ]; then
      ( umask 077; node -e 'const c=require("node:crypto");console.log("AWS_ACCESS_KEY_ID="+c.randomBytes(10).toString("hex")+"\nAWS_SECRET_ACCESS_KEY="+c.randomBytes(20).toString("hex"))' > "$state/s3.env" )
    fi
    # shellcheck disable=SC1091
    . "$state/s3.env"
    S3_ACCESS="$AWS_ACCESS_KEY_ID" S3_SECRET="$AWS_SECRET_ACCESS_KEY"
    t0=$(date +%s)
    compose build web >/dev/null
    docker build -q -t "$runner_image" -f infra/backup/tests/runner.Dockerfile infra/backup/tests >/dev/null
    echo "stack: images built in $(( $(date +%s) - t0 )) s"
    compose up -d --no-build --wait --wait-timeout 240 proxy web worker pbs db s3
    t0=$(date +%s)
    rc=0
    compose --profile setup run --rm --no-deps setup >"$state/setup.log" 2>&1 || rc=$?
    [ "$rc" -eq 0 ] || { echo "stack: FAIL setup exited $rc" >&2; tail -5 "$state/setup.log" >&2; exit 1; }
    echo "stack: setup done in $(( $(date +%s) - t0 )) s"
    # The S3-compatible server's bucket, which the lightsail target writes to in the proofs.
    docker run --rm --network "${project}_default" --env-file "$state/s3.env" "$runner_image" \
      aws --endpoint-url http://s3:7070 --region us-east-1 s3 mb s3://bw-proof-bucket
    printf 'PROJECT=%s\nRUNNER_IMAGE=%s\nBUCKET_DIR=%s\nNETWORK=%s_default\n' "$project" "$runner_image" "$state/bucket" "$project" > "$state/stack.env"
    echo "BW_PROOF_STATE=$state"
    ;;
  down)
    compose --profile setup down -v --remove-orphans >/dev/null 2>&1 || true
    docker image rm -f "$image" "$runner_image" >/dev/null 2>&1 || true
    # The bucket folder holds files the runner container wrote as root; remove them from inside a container.
    if [ -d "$state" ]; then docker run --rm -v "$state:/state" debian:trixie-20261005-slim rm -rf /state/bucket >/dev/null 2>&1 || true; fi
    rm -rf "$state"
    echo "stack: $project down"
    ;;
  *) echo "usage: bash infra/backup/tests/stack.sh up|down" >&2; exit 2 ;;
esac
