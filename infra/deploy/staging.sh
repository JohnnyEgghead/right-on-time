#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# G-IPHONE-WEB: the staging copy for the scripted iPhone run (BUILD_PLAN G-IPHONE-WEB; NFR-09, FR-TECH-4). The build manager runs it by
# hand from this Mac, from a checkout of the phase 5 tag; nothing starts it on its own. It never names or touches the hosted server
# (bw.j7l.io): the copy is a temporary Lightsail instance of the hosted plan (BUILD_PLAN D-12, like the load days' copy in
# infra/load/temp-server.sh), with its own database, so the hosted demo's data and memory are never shared. It talks only to the 1
# instance it created, by the name and address in its state folder.
#   BW_STAGING_DIR=<a folder outside the repo> bash infra/deploy/staging.sh <step>
#     create          the instance (small_3_0, Debian 13), tagged with its expiry; firewall 22 open to this Mac only, 80 and 443 to all
#                     (Let's Encrypt checks port 80 from the internet; the iPhone's address changes with its signal). Its name for HTTPS
#                     is BW_STAGING_NAME, default <address with dashes>.sslip.io (a public DNS name that answers with the address in it).
#     install         Docker at the pins of infra/hosted/setup.sh
#     deploy <tag>    the release image built from <tag> (HEAD must be that tag, its shipped files clean), Compose project bw-staging,
#                     every setting at the own-copy default but the origin, routes open, a Let's Encrypt certificate for the name
#                     (first deploy only), then https://<name>/healthz from this Mac (the public certificate chain). The map files
#                     go with the routing files (--with-routing), and the routing service starts with the other services, so the
#                     copy routes every leg no baked track covers live (F-1305; BUILD_PLAN section 3 D-21: routing stays on, no
#                     routing setting)
#     world [--again] the seeded world (setup, a fresh sample password seed); Maria Santos's password and the office's (Keisha Thompson,
#                     keisha.t@brightwater.example) into the state folder (never printed). --again wipes the world first (only before an
#                     owner run, never between the run and the check)
#     check           the ledger check after the owner's run: infra/deploy/staging/ledger.sql on the copy's database, judged by
#                     infra/deploy/staging/ledger-check.ts; exit 0 PASS, 1 FAIL (a lost or doubled item), 2 no usable ledger
#     status          the copy's services and /healthz
#     delete          delete the instance and prove it with get-instances (always safe to repeat); this is the teardown
# The state folder holds the SSH key, the sample password seed, Maria Santos's password and the office's: it stays outside the repo, mode 700, and
# the manager removes it after the run. Every step prints what it did and ends with a line that starts "staging:".
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$root"
dir="${BW_STAGING_DIR:?set BW_STAGING_DIR to a state folder outside the repo}"
# F-1053: the folder is made first and then resolved (pwd -P), so a path whose parent does not exist yet is judged by where it really is,
# not by a cd that fails. An empty folder this makes inside the repo is left empty: nothing is written before the refusal.
mkdir -p "$dir"
real="$(cd "$dir" && pwd -P)"
# F-1352: judged by file identity, not path text: some ancestor of the folder is the repo root (-ef, so a mis-cased path on a
# case-insensitive disk is the same file), or the folder is inside any git work tree (another checkout of the repo).
inside_repo() {
  local p="$1"
  while :; do
    if [ "$p" -ef "$root" ]; then return 0; fi
    [ "$p" = / ] && break
    p="$(dirname "$p")"
  done
  git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}
if inside_repo "$real"; then
  echo "staging: refused: BW_STAGING_DIR is inside the repo ($root) or a git work tree" >&2; exit 2
fi
dir="$real"
chmod 700 "$dir"
PROJECT=bw-staging
OPT=/opt/bw-staging
aws_ls() { aws --profile brightwater --region us-east-1 lightsail "$@"; }
name_file="$dir/instance-name"
need() { [ -s "$dir/$1" ] || { echo "staging: no $1 in $dir (run '$2' first)" >&2; exit 2; }; }
remote() { need ip create; ssh -i "$dir/key.pem" -o UserKnownHostsFile="$dir/known_hosts" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "admin@$(cat "$dir/ip")" "$@"; }
dc="sudo docker compose -p $PROJECT --project-directory $OPT/infra -f $OPT/infra/compose.yaml --env-file $OPT/infra/.env"
psql_q() { remote "$dc exec -T db psql -q -t -A -U brightwater -d brightwater -v ON_ERROR_STOP=1 -c \"$1\""; }

# write_env <site file>: the copy's .env. Every setting the stack suites run at stays at its own-copy default (DEMO_MODE, ACCESS_CODE_ON
# off: sign-in is by password); only the origin and the text-link host are the staging name's.
write_env() {
  local host image
  host="$(cat "$dir/host")"
  image="$(cat "$dir/image")"
  {
    echo "BW_IMAGE=$image"
    echo "DB_ENV_FILE=/etc/bw-staging/db.env"
    echo "PROXY_CONF=$1"
    echo "ROUTES=open"
    echo "HTTP_BIND=80"
    echo "HTTPS_BIND=443"
    echo "APP_ORIGIN=https://$host"
    echo "TEXT_LINK_HOST=$host"
    echo "BW_DATA_DIR=$OPT/data"
    echo "BW_MAPS_DIR=$OPT/data/maps"
    # A Lightsail copy of the hosted plan: routing at the cap measured on small_3_0 (BUILD_PLAN D-21), not the local copies' default.
    echo "ROUTING_MEM_LIMIT=320m"
  } | remote "cat > $OPT/infra/.env"
}

case "${1:-}" in
  create)
    if [ -s "$name_file" ]; then echo "staging: refused: $dir already names instance $(cat "$name_file") (run delete first)" >&2; exit 2; fi
    name="bw-staging-$(date +%Y%m%d)"
    my_ip="$(curl -s -4 --max-time 10 https://checkip.amazonaws.com)"
    [[ "$my_ip" =~ ^[0-9.]+$ ]] || { echo "staging: no address for this Mac" >&2; exit 1; }
    expires="$(date -u -v+24H +%Y-%m-%dT%H:%MZ)"
    aws_ls get-instances --query 'instances[].[name,bundleId,state.name,publicIpAddress]' --output text >"$dir/aws-before-instances.txt"
    umask 077
    aws_ls download-default-key-pair --query privateKeyBase64 --output text >"$dir/key.pem"
    umask 022
    aws_ls create-instances --instance-names "$name" --availability-zone us-east-1a --blueprint-id debian_13 --bundle-id small_3_0 \
      --tags "key=expires,value=$expires" key=purpose,value=G-IPHONE-WEB-staging >"$dir/aws-create.json"
    echo "$name" >"$name_file"
    state=unknown
    for _ in $(seq 1 60); do
      state="$(aws_ls get-instance-state --instance-name "$name" --query state.name --output text)"
      [ "$state" = running ] && break
      sleep 5
    done
    [ "$state" = running ] || { echo "staging: $name is $state after 5 minutes" >&2; exit 1; }
    aws_ls put-instance-public-ports --instance-name "$name" --port-infos \
      "fromPort=22,toPort=22,protocol=tcp,cidrs=$my_ip/32" "fromPort=80,toPort=80,protocol=tcp,cidrs=0.0.0.0/0" \
      "fromPort=443,toPort=443,protocol=tcp,cidrs=0.0.0.0/0" >"$dir/aws-ports.json"
    aws_ls get-instance --instance-name "$name" --query instance.publicIpAddress --output text >"$dir/ip"
    ip="$(cat "$dir/ip")"
    echo "${BW_STAGING_NAME:-${ip//./-}.sslip.io}" >"$dir/host"
    aws_ls get-instance-port-states --instance-name "$name" --query 'portStates[].[fromPort,state,join(`,`,cidrs)]' --output text
    for _ in $(seq 1 60); do
      remote true 2>/dev/null && break
      sleep 5
    done
    remote true
    echo "staging: $name up at $ip, name $(cat "$dir/host"), $(date '+%b %-d, %-I:%M:%S %p %Z'), expires tag $expires"
    ;;
  install)
    { echo 'set -euo pipefail'; sed -n '/^DOCKER_VERSION=/,/^systemctl enable --now docker/p' "$root/infra/hosted/setup.sh"; } >"$dir/install.sh"
    remote sudo bash -s <"$dir/install.sh" >"$dir/install.log" 2>&1
    echo "staging: docker $(remote sudo docker version --format '{{.Server.Version}}'), compose $(remote sudo docker compose version --short)"
    ;;
  deploy)
    tag="${2:?usage: staging.sh deploy <tag>}"
    [[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$ ]] || { echo "staging: refused: '$tag' is not a plain tag name" >&2; exit 2; }
    commit="$(git rev-parse --verify -q "refs/tags/$tag^{commit}")" || { echo "staging: refused: no tag $tag here" >&2; exit 2; }
    [ "$(git rev-parse HEAD)" = "$commit" ] || { echo "staging: refused: HEAD is not $tag ($commit); run from a checkout of the tag" >&2; exit 2; }
    # The same shipped paths as infra/deploy/deploy.sh's clean-tree guard (F-100): the image and the staged files come from the tag only.
    shipped=(apps packages package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json infra)
    if [ -n "$(git status --porcelain -- "${shipped[@]}")" ]; then git status --short -- "${shipped[@]}" | head -20; echo "staging: refused: uncommitted changes in what the copy ships" >&2; exit 2; fi
    need host create
    host="$(cat "$dir/host")"
    ip="$(cat "$dir/ip")"
    case "$(remote uname -m)" in
      x86_64) arch=amd64 ;;
      aarch64|arm64) arch=arm64 ;;
      *) echo "staging: unknown server architecture" >&2; exit 2 ;;
    esac
    image="bw-app:staging-$tag"
    echo "$image" >"$dir/image"
    echo "$tag" >"$dir/tag"
    echo "staging: building $image from $tag ($commit) for linux/$arch"
    docker build -q --platform "linux/$arch" -f infra/image/Dockerfile --target release --build-arg SOURCE_COMMIT="${commit:0:12}" -t "$image" .
    # An image the size of this one takes a minute or 2 over the wire; docker load prints its name.
    docker save --platform "linux/$arch" "$image" | gzip -1 | remote sudo docker load
    node ci/data-assets.ts ensure
    node ci/data-assets.ts ensure --with-routing --manifest packages/maps/MANIFEST.json --dir .build/data/maps
    # F-1055: the held-certificate test runs here, before rm -rf removes the .env and compose file it needs; after it, it always failed.
    if remote "$dc --profile certbot run --rm --no-deps --entrypoint test certbot -f /etc/letsencrypt/live/staging/fullchain.pem" 2>/dev/null; then held=yes; else held=no; fi
    remote "sudo install -d -m 755 -o admin $OPT && rm -rf $OPT/infra"
    COPYFILE_DISABLE=1 tar -C "$root" -czf - infra/compose.yaml infra/nginx infra/placeholder infra/own-copy-db.env | remote tar -C "$OPT" -xzf -
    remote "cat > $OPT/infra/nginx/staging.conf" <infra/deploy/staging/staging.conf
    COPYFILE_DISABLE=1 tar -C .build/data -czf - street-list.json maps | remote "mkdir -p $OPT/data && tar -C $OPT/data -xzf -"
    # The copy's own database password, made on the server and never printed (the hosted server's is in /etc/brightwater, untouched here).
    remote 'sudo test -s /etc/bw-staging/db.env || { sudo install -d -m 700 /etc/bw-staging && umask 077 && printf "POSTGRES_PASSWORD=%s\n" "$(head -c 32 /dev/urandom | base64 | tr -d "/+=" | head -c 32)" | sudo tee /etc/bw-staging/db.env >/dev/null; }'
    if [ "$held" = yes ]; then
      echo "staging: certificate for $host already held"
    else
      # First deploy: the port-80-only bootstrap site serves the ACME webroot while certbot asks Let's Encrypt (HTTP-01), as the hosted
      # server's first issue did (infra/hosted/setup.sh). The name must already answer with this address.
      remote "getent ahostsv4 $host | grep -qx '$ip *STREAM $host' || getent ahostsv4 $host | grep -q '^$ip '" \
        || { echo "staging: refused: $host does not resolve to $ip on the server yet" >&2; exit 1; }
      write_env bootstrap.conf
      remote "$dc up -d --no-deps proxy"
      remote "$dc --profile certbot run --rm --no-deps certbot certonly --webroot -w /var/www/acme -d $host --cert-name staging \
        --agree-tos --register-unsafely-without-email --non-interactive"
      remote "$dc rm -sf proxy"
      echo "staging: certificate issued for $host"
    fi
    write_env staging.conf
    remote "$dc up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing"
    remote "$dc ps --format '{{.Service}} {{.Image}} {{.Status}}'"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$host/healthz" || true)"
    tech="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$host/tech" || true)"
    echo "staging: deployed $image at https://$host (healthz $code, /tech $tech)"
    [ "$code" = 200 ]
    ;;
  world)
    need image deploy
    if [ "$(psql_q 'SELECT count(*) FROM world.job' 2>/dev/null || echo 0)" != 0 ]; then
      if [ "${2:-}" != --again ]; then echo "staging: refused: the copy already holds a world (world --again wipes it; never between the owner's run and check)" >&2; exit 2; fi
      remote "$dc rm -sf web worker pbs db && sudo docker volume rm ${PROJECT}_pgdata ${PROJECT}_photos"
      remote "$dc up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing"
      echo "staging: the old world was wiped"
    fi
    umask 077
    openssl rand -hex 24 >"$dir/seed"
    # The seed goes to setup only, over ssh's stdin (never in a command line on this Mac), as ci/outbox-stack.sh gives it to setup only.
    # F-1054: it is read inside the root shell (sudo sh -c), so sudo's log holds the command with $s, not the seed as a variable (ENV=).
    remote "sudo sh -c 'read -r s; SAMPLE_PASSWORD_SEED=\"\$s\" docker compose -p $PROJECT --project-directory $OPT/infra -f $OPT/infra/compose.yaml --env-file $OPT/infra/.env --profile setup run --rm --no-deps setup'" <"$dir/seed" >"$dir/setup.log" 2>&1
    grep -E '"status":"setup (done|refused)"' "$dir/setup.log" | cut -c1-160
    # Maria Santos's sample password (SPECIFICATIONS SD-9) in its shown form xxxxx-xxxxx, which sign-in matches without regard to case
    # (an iPhone password box types lowercase; the raw 10 characters match case-sensitively). Into the state folder only.
    # F-1350: the office account the builder's scripts sign in with (staging/add-live-job.ts, staging/seed-harold-photos.ts) is Keisha
    # Thompson, the Columbus dispatcher (packages/db/src/seed/reference-data.ts staff); her sample password is made the same way, from the
    # same seed, into office-password.txt. The umask above makes both files mode 600; neither is printed.
    for pw in maria.santos@brightwater.example:maria-password.txt keisha.t@brightwater.example:office-password.txt; do
      SEED="$(cat "$dir/seed")" EMAIL="${pw%%:*}" node --input-type=module -e "import { samplePassword, showSamplePassword } from '$root/packages/db/src/passwords.ts'; process.stdout.write(showSamplePassword(samplePassword(process.env.SEED, process.env.EMAIL)) + '\n');" >"$dir/${pw#*:}"
    done
    umask 022
    job="$(psql_q "SELECT j.job_number FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.technician t ON t.id = j.technician_id WHERE c.name = 'Harold Jenkins' AND t.name = 'Maria Santos' AND j.date = DATE '2026-09-15'")"
    rows="$(psql_q "SELECT count(*) FROM world.tech_item WHERE job_number = ${job:-0}")"
    echo "staging: world ready; Harold Jenkins's Sep 15 job is #$job ($rows ledger rows); Maria Santos signs in as 40712, password in $dir/maria-password.txt; the office signs in as keisha.t@brightwater.example, password in $dir/office-password.txt (neither printed)"
    ;;
  check)
    need image deploy
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    # F-1055: a failed read (psql exits 3, ssh 255) is "no usable ledger", exit 2 as the header says, not the tool's own code.
    remote "$dc exec -T db psql -q -t -A -U brightwater -d brightwater -v ON_ERROR_STOP=1 -f -" <infra/deploy/staging/ledger.sql >"$dir/ledger-$stamp.json" \
      || { echo "staging: no usable ledger (the read from the copy's database failed)" >&2; exit 2; }
    # The proxy's own log lines for the 2 send routes (SPECIFICATIONS 11.4: method, mapped path, status; no address). A resend after a
    # lost answer is allowed (the ledger then says duplicate, still 1 row), so these counts are recorded, not judged.
    remote "$dc logs --no-color --no-log-prefix proxy" 2>/dev/null | grep -E '"uri":"/api/v1/tech/(items|photos/[^"]*)"' >"$dir/sends-$stamp.log" || true
    echo "proxy send lines: $(grep -c '"/api/v1/tech/items"' "$dir/sends-$stamp.log" || true) to /api/v1/tech/items, $(grep -c '"/api/v1/tech/photos/' "$dir/sends-$stamp.log" || true) to /api/v1/tech/photos/<key>"
    # F-1052: the ledger's receipt time is the demo clock; the proxy's lines carry each photo key with a real time, so they are printed too.
    # The photo line whose time is after the owner's Airplane Mode off (step 15) is the one that proves the photo reached the server after reopening.
    grep '/api/v1/tech/photos/' "$dir/sends-$stamp.log" | sed -E 's/.*"time":"([^"]*)".*"uri":"([^"]*)","status":([0-9]+).*/proxy photo line: \1 \2 status \3/' || true
    set +e
    node infra/deploy/staging/ledger-check.ts <"$dir/ledger-$stamp.json" >"$dir/ledger-$stamp.txt"
    rc=$?
    set -e
    cat "$dir/ledger-$stamp.txt"
    echo "staging: check exit $rc (ledger $dir/ledger-$stamp.json, verdict $dir/ledger-$stamp.txt)"
    exit "$rc"
    ;;
  status)
    need image deploy
    remote "$dc ps --format '{{.Service}} {{.Image}} {{.Status}}'"
    echo "staging: https://$(cat "$dir/host")/healthz $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$(cat "$dir/host")/healthz" || true)"
    ;;
  delete)
    need instance-name create
    name="$(cat "$name_file")"
    case "$name" in bw-staging-*) ;; *) echo "staging: refused: '$name' is not a staging instance" >&2; exit 2 ;; esac
    aws_ls delete-instance --instance-name "$name" >"$dir/aws-delete.json" 2>&1 || grep -q 'DoesNotExist\|does not exist' "$dir/aws-delete.json" || { cat "$dir/aws-delete.json" >&2; exit 1; }
    sleep 15
    aws_ls get-instances --query 'instances[].[name,bundleId,state.name,publicIpAddress]' --output text | tee "$dir/aws-after-instances.txt"
    if grep -q "$name" "$dir/aws-after-instances.txt"; then echo "staging: $name is still listed" >&2; exit 1; fi
    # F-1055: the release image built for the copy stays on this Mac otherwise.
    if [ -s "$dir/image" ]; then docker image rm "$(cat "$dir/image")" >/dev/null 2>&1 || true; fi
    echo "staging: $name deleted at $(date '+%b %-d, %-I:%M:%S %p %Z')"
    ;;
  *) echo "usage: BW_STAGING_DIR=<dir> bash infra/deploy/staging.sh create|install|deploy <tag>|world [--again]|check|status|delete" >&2; exit 2 ;;
esac
