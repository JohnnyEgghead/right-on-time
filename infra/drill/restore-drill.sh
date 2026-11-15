#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P8-RESTORE-DRILL (owner ruling 7b6bf018): the pre-release restore drill, unattended, from this Mac.
#   bash infra/drill/restore-drill.sh run        the drill on 2 temporary Lightsail copies of the hosted plan
#   bash infra/drill/restore-drill.sh dry-run    the same flow with canned answers: every remote action printed (DRY-RUN aws ... and
#                                                DRY-RUN ssh ..., the 2 hosted bucket listings marked READ-ONLY), none made, no
#                                                server; the record goes to the state folder, never into the repo
#   bash infra/drill/restore-drill.sh cleanup <state folder>   delete the copies a stopped drill left (its own trap normally does)
# Flow (each step must pass before the next; any failure goes straight to the teardown):
#   1 preflight: tools; a clean tracked tree (run); the hour (05:00 to 22:59 America/New_York: the hosted backup at 02:30 and 03:30
#     and the Sunday 04:00 restore test would change the bucket listing, and the smoke's Today must not cross midnight); the
#     instance list must be the hosted server only (its plan is the copies' plan), no drill key pair left, the bucket listing read (on
#     the hosted server, READ-ONLY: see "The bucket listing" below); the
#     data staged (street list, map tiles, no routing files); the amd64 release image built if this commit has none
#   2 temporary copy 1 (infra/load/temp-server.sh: create, install, deploy, fresh): a fresh setup of the sample world
#   3 infra/backup/backup.sh on copy 1 (target local on the copy: nothing hosted is touched); restore-test.sh against a planted
#     manifest (must exit 1), then against the set (must exit 0); the set fetched to this Mac and its dump's SHA-256 checked
#   4 temporary copy 2: create, install, deploy (an empty database, as a fresh server); the set sent to it
#   5 the operator procedure (SPECIFICATIONS 11.7): web, worker and pbs stopped, infra/drill/restore-copy.sh restore (pg_restore --clean,
#     then every table compared with the manifest; must exit 0), a planted manifest check (must exit 1), the stack started, healthz
#     200 through the proxy within 90 s (polled every 2 s; F-1585), the smoke sign-in (ci/smoke/smoke.mjs) against copy 2 with copy 1's
#     sample password seed (must exit 0)
#   6 the teardown, always (EXIT trap; temp-server.sh's launchd backstop at 3 hours behind it): both copies and their key pairs deleted,
#     the instance list must be the hosted server only again, no drill key pair, the bucket listing equal to the one before; then the
#     record (infra/drill/record.ts) and the evidence folder: a run writes them at BW_RESTORE_DRILL_RECORD and BW_RESTORE_DRILL_EVIDENCE
#     (F-1605: the environment, else the private owner file of infra/drill/owner-env.sh, else drill-out/; relative paths are under the repo)
# Every aws and ssh call goes through infra/drill/guard.sh (the state folder's bin first on PATH): the hosted server and bucket can be
# listed, never written. Nothing here prints or records an address, a seed or a key; the copies are "temporary copy 1" and "2".
# The bucket listing (owner answer 1921a7c5, Nov 14, 2026: "Read it on the server"): this Mac's profile cannot list the Lightsail
# bucket, so the drill reads it on the hosted server over deploy.sh's own ssh target and options, with the server's backup job's own
# client and credentials (root's aws CLI by the instance's resource access, the bucket and Region of infra/hosted/hosted.env). 1 fixed
# command, list-objects-v2 only (no get, put or delete, no file written there, no key passed or printed); the guard refuses any other
# command to the hosted server. Before = in the preflight, before any copy exists; after = in the teardown, after both are deleted.
# Each is sorted (LC_ALL=C) into the state folder; the drill fails unless they are byte-equal. The record keeps the verdict, the object
# counts and each listing's SHA-256, never a key, the host or an address.
# Exit: 0 PASS, 1 FAIL (the record says why), 2 refused before any AWS write (no record written).
# Env: BW_DRILL_DIR (the state folder, outside the repo; default ~/.bw-drill/<time>, a dry run's a new temp folder),
#      BW_HOST, BW_KEY (the hosted ssh target and key, as infra/deploy/deploy.sh reads them; the target has no default: F-1609; the key defaults to deploy.sh's),
#      BW_DRILL_FIXTURES (dry run: the canned answers, default infra/drill/dry-run), BW_DRILL_HOUR (dry run: the hour the clock check sees).
set -euo pipefail
exec </dev/null
exec 3>&2
root="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=owner-env.sh
. "$root/infra/drill/owner-env.sh"
bw_owner_env "$root"
cmd="${1:-}"
case "$cmd" in run) mode=run ;; dry-run) mode=dry ;; cleanup) mode=cleanup ;; *) echo "usage: restore-drill.sh run | dry-run | cleanup <state folder>" >&2; exit 2 ;; esac
scrub() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<address>/g'; }
say() { printf 'drill: %s %s\n' "$(date '+%-I:%M:%S %p %Z')" "$*" | scrub >&3; }
refuse() { say "refused: $*"; exit 2; }
ts_n() { local n="$1"; shift; BW_LOAD_DIR="$state/copy$n" bash "$root/infra/load/temp-server.sh" "$@"; }
awsr() { aws --profile brightwater --region us-east-1 "$@"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
drill_key_re='^bw-load-p4-[0-9]{8}-[a-z0-9]+-drill[12]-key$'

# ---- cleanup <state>: the copies of a stopped drill, through that drill's own guard ----
if [ "$mode" = cleanup ]; then
  state="${2:?cleanup needs the state folder of the stopped drill}"
  [ -f "$state/bin/mode" ] || refuse "$state is not a drill state folder"
  state="$(cd "$state" && pwd)"
  export PATH="$state/bin:$PATH"
  rc=0
  for n in 2 1; do
    if [ -f "$state/copy$n/instance-name" ]; then ts_n "$n" delete 2>&1 | scrub || rc=1; fi
  done
  awsr lightsail get-instances --query 'instances[].name' --output text | tr '\t' '\n' | sed 's/^/drill: instance left: /'
  exit "$rc"
fi

# ---- the state folder and the guard ----
if [ -n "${BW_DRILL_DIR:-}" ]; then state="$BW_DRILL_DIR"
elif [ "$mode" = run ]; then state="$HOME/.bw-drill/$(date +%Y%m%d-%H%M%S)"
else state="$(mktemp -d "${TMPDIR:-/tmp}/bw-drill-dry.XXXXXX")"; fi
mkdir -p "$state"
state="$(cd "$state" && pwd -P)"
case "$state/" in "$(cd "$root" && pwd -P)/"*) refuse "the state folder must be outside the repo" ;; esac
[ ! -e "$state/results.env" ] || refuse "$state holds an earlier drill; give a new BW_DRILL_DIR"
fixtures="${BW_DRILL_FIXTURES:-$root/infra/drill/dry-run}"
bucket="$(sed -n 's/^BACKUP_BUCKET=//p' "$root/infra/hosted/hosted.env")"
region="$(sed -n 's/^BACKUP_REGION=//p' "$root/infra/hosted/hosted.env")"
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || refuse "no BACKUP_BUCKET bucket name in infra/hosted/hosted.env"
[[ "$region" =~ ^us-(east|west)-[0-9]+$ ]] || refuse "no BACKUP_REGION US Region in infra/hosted/hosted.env"
# The hosted target is BW_HOST (F-1609: the environment or the owner's private file, never a committed file); the key is BW_KEY, else deploy.sh's default.
bw_owner_env "$root"
hosted_host="${BW_HOST:-}"
# shellcheck disable=SC2016 # deploy.sh's line, matched as text
hosted_key="${BW_KEY:-$(sed -n 's/^KEY="${BW_KEY:-\(.*\)}"$/\1/p' "$root/infra/deploy/deploy.sh" | head -1)}"
hosted_key="${hosted_key/#\$HOME/$HOME}"
# F-1686: the stand-in goes in before the checks below, so a dry run needs no real host.
# A dry run never holds the hosted target: a TEST-NET stand-in (instances.txt's) and a key path that does not exist.
[ "$mode" != dry ] || { hosted_host=admin@198.51.100.10; hosted_key=/nonexistent/dry-run-key; }
[[ "$hosted_host" =~ ^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$ ]] || refuse "no hosted ssh target (BW_HOST: set it in the environment or in the owner's private file; F-1609)"
[ -n "$hosted_key" ] || refuse "no hosted ssh key (BW_KEY, or deploy.sh's default)"
[ "$mode" != run ] || [ -f "$hosted_key" ] || refuse "the hosted ssh key (BW_KEY, or deploy.sh's default) is not on this Mac"
# The READ-ONLY listing, run on the server as its backup job reaches the bucket (lib.sh target_list): key, size, ETag, last modified.
list_cmd="sudo env AWS_PAGER= aws s3api list-objects-v2 --bucket $bucket --region $region --query 'Contents[].[Key,Size,ETag,LastModified]' --output text"
need=(node openssl tar gzip git)
[ "$mode" = run ] && need+=(aws ssh docker curl)
for t in "${need[@]}"; do command -v "$t" >/dev/null || refuse "$t is not installed"; done
# The commit, read once and before a dry run moves HOME into the state folder (F-1607): git reads safe.directory from the caller's own
# global config, so after the move a checkout another user owns (the push runner's) reads as dubious and git exits 128.
commit="$(git -C "$root" rev-parse --short=12 HEAD)" || refuse "git cannot read the commit of the checkout"
install -d -m 700 "$state/bin" "$state/copy1" "$state/copy2" "$state/dry" "$state/logs"
echo "$mode" >"$state/bin/mode"
(cd "$fixtures" && pwd) >"$state/bin/fixtures"
printf '%s\n' "$hosted_host" >"$state/bin/hosted-host"
printf '%s\n' "$hosted_key" >"$state/bin/hosted-key"
printf '%s\n' "$list_cmd" >"$state/bin/hosted-list-cmd"
if [ "$mode" = dry ]; then echo /nonexistent/aws >"$state/bin/real-aws"; echo /nonexistent/ssh >"$state/bin/real-ssh"
else
  command -v aws >"$state/bin/real-aws" || echo /nonexistent/aws >"$state/bin/real-aws"
  command -v ssh >"$state/bin/real-ssh" || echo /nonexistent/ssh >"$state/bin/real-ssh"
fi
cp "$root/infra/drill/guard.sh" "$state/bin/guard.sh"
tools=(aws ssh bw-drill-smoke)
[ "$mode" = dry ] && tools+=(curl docker launchctl)
for t in "${tools[@]}"; do
  # shellcheck disable=SC2016 # the wrapper's own $0 and $@, written as text
  printf '#!/usr/bin/env bash\nexec bash "$(dirname "$0")/guard.sh" %s "$@"\n' "$t" >"$state/bin/$t"
  chmod +x "$state/bin/$t"
done
export PATH="$state/bin:$PATH"
export BW_LOAD_BACKSTOP_HOURS=3 BW_LOAD_PURPOSE=restore-drill
if [ "$mode" = dry ]; then
  export HOME="$state/home" BW_LOAD_DELETE_WAIT=0
  mkdir -p "$HOME"
  cp "$fixtures/instances.txt" "$state/dry/instances"
  cp "$fixtures/keys.txt" "$state/dry/keys"
fi
results="$state/results.env"
: >"$results"
res() { printf '%s=%s\n' "$1" "$(printf '%s' "${2:-}" | tr '\n' ' ' | scrub)" >>"$results"; }
step() { export BW_DRILL_STEP="$1"; }
# must <step> <log> <command...>: the step must exit 0, or the drill stops there.
must() {
  local name="$1" log="$2"
  shift 2
  step "$name"
  say "$name"
  if ! "$@" >"$log" 2>&1; then
    res failed_step "$name"
    say "step $name failed; its last lines:"
    tail -5 "$log" | scrub >&3
    exit 1
  fi
}
# arm <name> <required exit> <log> <command...>
arm() {
  local name="$1" want="$2" log="$3" rc=0 key
  shift 3
  key="${name//-/_}"
  step "$name"
  say "arm $name (required exit $want)"
  "$@" >"$log" 2>&1 || rc=$?
  res "arm_${key}_want" "$want"
  res "arm_${key}_rc" "$rc"
  if [ "$rc" != "$want" ]; then
    res failed_step "$name"
    say "arm $name exited $rc, required $want; its last lines:"
    tail -5 "$log" | scrub >&3
    exit 1
  fi
}
started=$(date +%s)
res mode "$mode"
res started_epoch "$started"
res commit "$commit"

# ---- 1 preflight: nothing is written in AWS before this block passes ----
say "preflight (state folder $state)"
if [ "$mode" = run ]; then
  [ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ] || refuse "the tracked tree has changes; the drill records a commit"
  hour="$(TZ=America/New_York date +%H)"
else hour="${BW_DRILL_HOUR:-$(TZ=America/New_York date +%H)}"; fi
[ "$((10#$hour))" -ge 5 ] && [ "$((10#$hour))" -le 22 ] || refuse "the drill runs from 5:00 AM to 10:59 PM America/New_York only (hosted backup 2:30 AM, restore test Sun 4:00 AM, the smoke's Today)"
step preflight
awsr sts get-caller-identity --query Arn --output text >/dev/null || refuse "the brightwater profile does not answer"
awsr lightsail get-instances --query 'instances[].[name,bundleId,state.name]' --output text >"$state/instances-before.txt" || refuse "get-instances failed"
names_before="$(cut -f1 "$state/instances-before.txt" | sort | paste -sd , -)"
[ "$names_before" = brightwater-1 ] || refuse "the instance list is not the hosted server only: $names_before (a leftover copy? restore-drill.sh cleanup <its state folder>)"
plan="$(awk -F'\t' '$1 == "brightwater-1" { print $2 }' "$state/instances-before.txt")"
[ -n "$plan" ] || refuse "no plan for brightwater-1"
awsr lightsail get-key-pairs --query 'keyPairs[].name' --output text | tr '\t' '\n' >"$state/keys-before.txt" || refuse "get-key-pairs failed"
if grep -qE "$drill_key_re" "$state/keys-before.txt"; then refuse "a drill key pair is left from an earlier drill"; fi
# bucket_list <file>: the hosted server's READ-ONLY listing, sorted, into <file> (the guard passes only this exact call).
bucket_list() {
  ssh -n -i "$hosted_key" -o BatchMode=yes -o ConnectTimeout=15 "$hosted_host" "$list_cmd" >"$1.raw" || return 1
  LC_ALL=C sort "$1.raw" >"$1" && rm -f "$1.raw"
}
bucket_list "$state/bucket-before.txt" || refuse "the bucket listing on the hosted server failed (READ-ONLY, before any copy)"
data="$state/data"
mkdir -p "$data/generator" "$data/maps"
if [ -f "$root/.build/data/street-list.json" ] && ls "$root/.build/data/maps/"*.pmtiles >/dev/null 2>&1; then
  cp "$root/.build/data/street-list.json" "$data/"
  # The map tiles and baked tracks, never the routing files (2.5 GB): routing waits for them and legs are approximate, as smoke-public-tag.
  find "$root/.build/data/maps" -maxdepth 1 -type f ! -name 'ohio.osrm*' -exec cp {} "$data/maps/" \;
elif [ "$mode" = run ]; then refuse "no staged data: node ci/data-assets.ts ensure, then node packages/maps/src/cli.ts fetch --no-routing"
else echo '[]' >"$data/street-list.json"; : >"$data/maps/dry.pmtiles"; fi
image="bw-p8-drill:amd64-$commit"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  say "building $image (amd64 release image)"
  docker build --platform linux/amd64 -f "$root/infra/image/Dockerfile" --target release \
    --build-arg "SOURCE_COMMIT=$commit" -t "$image" "$root" >"$state/logs/image-build.log" 2>&1 || refuse "the image build failed (logs/image-build.log)"
fi
export BW_LOAD_IMAGE="$image" BW_LOAD_DATA="$data" BW_LOAD_PLAN="$plan"
res plan "$plan"
res hosted_plan "$plan"
res image "$image"
res instances_before "$names_before"
res bucket_before_count "$(grep -cv '^None$' "$state/bucket-before.txt" || true)"
res bucket_before_sha "$(sha256 "$state/bucket-before.txt")"
res t_preflight "$(($(date +%s) - started))"

# ---- the teardown: from here on every exit runs it ----
# shellcheck disable=SC2329 # the EXIT trap runs it
teardown() {
  local rc=$? n try ok t0 record evidence verdict
  set +e
  trap - EXIT INT TERM
  t0=$(date +%s)
  step teardown
  say "teardown"
  ok=ok
  for n in 2 1; do
    [ -f "$state/copy$n/instance-name" ] || continue
    for try in 1 2 3; do
      if ts_n "$n" delete >>"$state/logs/delete-copy$n.log" 2>&1; then break; fi
      say "delete of temporary copy $n failed (try $try)"
      [ "$try" = 3 ] && ok=failed
      [ "$mode" = run ] && sleep 30
    done
  done
  res teardown "$ok"
  if awsr lightsail get-instances --query 'instances[].[name,bundleId,state.name]' --output text >"$state/instances-after.txt"; then
    res instances_after "$(cut -f1 "$state/instances-after.txt" | sort | paste -sd , -)"
  fi
  if awsr lightsail get-key-pairs --query 'keyPairs[].name' --output text | tr '\t' '\n' >"$state/keys-after.txt"; then
    res drill_keys_after "$(grep -cE "$drill_key_re" "$state/keys-after.txt" || true)"
  fi
  if bucket_list "$state/bucket-after.txt"; then
    res bucket_after_count "$(grep -cv '^None$' "$state/bucket-after.txt" || true)"
    res bucket_after_sha "$(sha256 "$state/bucket-after.txt")"
    if cmp -s "$state/bucket-before.txt" "$state/bucket-after.txt"; then res bucket_equal yes; else res bucket_equal no; fi
  fi
  res t_teardown "$(($(date +%s) - t0))"
  res ended_epoch "$(date +%s)"
  if [ "$mode" = run ]; then
    record="$(bw_root_path "$root" "${BW_RESTORE_DRILL_RECORD:-drill-out/restore-drill.md}")"
    evidence="$(bw_root_path "$root" "${BW_RESTORE_DRILL_EVIDENCE:-drill-out/restore-drill}")"
    mkdir -p "$(dirname "$record")"
  else record="$state/P8-RESTORE-DRILL.md" evidence="$state/evidence"; fi
  mkdir -p "$evidence"
  # F-1605: the record names its evidence folder repo-relative inside the checkout, <state>/... for a dry run (no home path).
  case "$evidence" in "$root"/*) res evidence_dir "${evidence#"$root"/}" ;; "$state"/*) res evidence_dir "<state>/${evidence#"$state"/}" ;; *) res evidence_dir "$evidence" ;; esac
  node "$root/infra/drill/record.ts" "$results" >"$record" || say "the record did not render"
  # No address, and no local path (the state folder and the checkout are named <state> and <repo>).
  paths() { scrub | sed -e "s|$state|<state>|g" -e "s|$root|<repo>|g"; }
  paths <"$results" >"$evidence/results.env"
  paths <"$state/calls.log" >"$evidence/aws-ssh-calls.log" 2>/dev/null
  for f in "$state"/logs/arm-*.log; do
    [ -f "$f" ] || continue
    grep -E '^\{"|^smoke\.mjs:' "$f" | paths >"$evidence/$(basename "$f" .log).events" || true
  done
  if [ "$mode" = dry ]; then
    # The dry run's proof: every remote action the drill and temp-server.sh made, as the guard saw them; none was sent (a sent call
    # is logged in mode run, and the dry run's real aws and ssh are /nonexistent).
    cl="$evidence/aws-ssh-calls.log"
    say "every remote action of the dry run ($(grep -c ' dry aws ' "$cl") aws calls, $(grep -c ' aws WRITE ' "$cl") of them writes; $(grep -c ' dry ssh ' "$cl") ssh calls, $(grep -c ' ssh hosted READ-ONLY ' "$cl") of them READ-ONLY hosted bucket listings; $(grep -c ' REFUSED ' "$cl") refused; $(grep -c '^[0-9:]*Z run ' "$cl") sent):"
    grep -E ' dry (aws (read|WRITE)|ssh|REFUSED) ' "$cl" | sed -E 's/^[0-9:]+Z dry aws (read|WRITE) [a-z0-9]+ [a-z0-9-]+ /DRY-RUN \1 aws /; s/^[0-9:]+Z dry ssh hosted READ-ONLY /DRY-RUN READ-ONLY ssh hosted: /; s/^[0-9:]+Z dry ssh (copy[12]) /DRY-RUN ssh \1: /; s/^[0-9:]+Z dry REFUSED /DRY-RUN REFUSED /' | cut -c1-220 >&3
  fi
  [ "$mode" = run ] && bash "$root/ci/spikes-index.sh"
  verdict="$(sed -n 's/^Verdict: \([A-Z]*\).*/\1/p' "$record" | head -1)"
  say "verdict ${verdict:-none}; record $record"
  if [ "$verdict" = PASS ]; then
    [ "$mode" = run ] && rm -rf "$state"
    exit 0
  fi
  say "kept the state folder $state (if a copy is listed: bash infra/drill/restore-drill.sh cleanup $state)"
  [ "$rc" -ne 0 ] || rc=1
  exit "$rc"
}
trap teardown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- 2 temporary copy 1: a fresh setup of the sample world ----
s=$(date +%s)
export BW_LOAD_NAME_TAG=drill1
must create1 "$state/logs/create-copy1.log" ts_n 1 create
must install1 "$state/logs/install-copy1.log" ts_n 1 install
must deploy1 "$state/logs/deploy-copy1.log" ts_n 1 deploy
must fresh1 "$state/logs/fresh-copy1.log" ts_n 1 fresh
res t_copy1 "$(($(date +%s) - s))"

# ---- 3 the backup on copy 1, the restore test (known-bad first), the set fetched ----
s=$(date +%s)
# shellcheck disable=SC2329 # send_scripts, on, send_set and smoke run through must and arm
send_scripts() { # send_scripts <n>: the backup scripts and the drill's restore script to /opt/bw-drill on that copy
  (cd "$root/infra" && COPYFILE_DISABLE=1 tar -czf - backup/*.sh backup/*.sql drill/restore-copy.sh drill/compare.sql) \
    | ts_n "$1" remote 'sudo install -d -m 755 /opt/bw-drill && sudo tar -C /opt/bw-drill -xzf -'
}
on() { local n="$1"; shift; ts_n "$n" remote "sudo env BW_PROJECT=bw-p4-load $*"; }
must scripts1 "$state/logs/scripts-copy1.log" send_scripts 1
arm backup 0 "$state/logs/arm-backup.log" on 1 BACKUP_TARGET=local BACKUP_LOCAL_DIR=/var/lib/bw-drill/target bash /opt/bw-drill/backup/backup.sh
stamp="$(sed -n 's/.*"event":"passed","msg":"backup \([0-9TZ]*\):.*/\1/p' "$state/logs/arm-backup.log" | head -1)"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { res failed_step backup-stamp; say "no set stamp in the backup output"; exit 1; }
res set_stamp "$stamp"
must plant1 "$state/logs/plant-copy1.log" on 1 bash /opt/bw-drill/drill/restore-copy.sh plant "/var/lib/bw-drill/target/backups/$stamp" "/var/lib/bw-drill/planted/backups/$stamp"
arm restore-test-planted 1 "$state/logs/arm-restore-test-planted.log" on 1 BACKUP_TARGET=local BACKUP_LOCAL_DIR=/var/lib/bw-drill/planted BACKUP_RECORD=off bash /opt/bw-drill/backup/restore-test.sh
arm restore-test 0 "$state/logs/arm-restore-test.log" on 1 BACKUP_TARGET=local BACKUP_LOCAL_DIR=/var/lib/bw-drill/target bash /opt/bw-drill/backup/restore-test.sh
step fetch
say "fetch the set to this Mac"
umask 077
ts_n 1 remote "sudo tar -C /var/lib/bw-drill/target/backups -cf - $stamp" >"$state/set.tar" || { res failed_step fetch; exit 1; }
umask 022
mkdir -p "$state/set"
tar -C "$state/set" -xf "$state/set.tar" || { res failed_step fetch; exit 1; }
manifest="$state/set/$stamp/manifest.json"
dump="$state/set/$stamp/brightwater.dump"
read -r want_bytes want_sha tables rows < <(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const t = Object.values(m.tables);
  console.log(m.dump.bytes, m.dump.sha256, t.length, t.reduce((s, v) => s + Number(v.rows), 0));' "$manifest") || { res failed_step fetch-manifest; exit 1; }
got_bytes="$(wc -c <"$dump" | tr -d ' ')"
got_sha="$(sha256 "$dump")"
[ "$got_bytes $got_sha" = "$want_bytes $want_sha" ] || { res failed_step fetch-checksum; say "the fetched dump does not equal its manifest"; exit 1; }
res dump_bytes "$got_bytes"
res tables "$tables"
res rows "$rows"
res t_backup "$(($(date +%s) - s))"

# ---- 4 temporary copy 2: an empty database, the set sent to it ----
s=$(date +%s)
export BW_LOAD_NAME_TAG=drill2
must create2 "$state/logs/create-copy2.log" ts_n 2 create
must install2 "$state/logs/install-copy2.log" ts_n 2 install
must deploy2 "$state/logs/deploy-copy2.log" ts_n 2 deploy
must scripts2 "$state/logs/scripts-copy2.log" send_scripts 2
send_set() { ts_n 2 remote 'sudo install -d -m 700 /var/lib/bw-drill/target/backups && sudo tar -C /var/lib/bw-drill/target/backups -xf -' <"$state/set.tar"; }
must sendset2 "$state/logs/sendset-copy2.log" send_set
res t_copy2 "$(($(date +%s) - s))"

# ---- 5 the operator procedure on copy 2, then the smoke sign-in ----
s=$(date +%s)
set2="/var/lib/bw-drill/target/backups/$stamp"
must stop2 "$state/logs/stop-copy2.log" ts_n 2 compose stop web worker pbs
arm restore 0 "$state/logs/arm-restore.log" on 2 bash /opt/bw-drill/drill/restore-copy.sh restore "$set2"
res restore_seconds "$(sed -n 's/.*pg_restore --clean into [a-z]* in \([0-9]*\) s.*/\1/p' "$state/logs/arm-restore.log" | head -1)"
must plant2 "$state/logs/plant-copy2.log" on 2 bash /opt/bw-drill/drill/restore-copy.sh plant "$set2" "/var/lib/bw-drill/planted/backups/$stamp"
arm check-planted 1 "$state/logs/arm-check-planted.log" on 2 bash /opt/bw-drill/drill/restore-copy.sh check "/var/lib/bw-drill/planted/backups/$stamp"
must start2 "$state/logs/start-copy2.log" ts_n 2 compose up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing
# healthz2 (F-1585): web is healthy when up --wait returns, yet the proxy can answer 502 for about half a minute more. nginx's
# "resolve" keeps web's old address until a lookup of web answers, and it retries a failed lookup only after its resolver timeout
# (30 s). So the drill waits for 200 up to a cap: no answer (000), 502, 503 and 504 mean not up yet; any other answer fails at once.
step healthz2
health_cap=90 health_every=2 h0=$(date +%s) tries=0
say "healthz on copy 2 (200 within $health_cap s)"
while :; do
  tries=$((tries + 1))
  health="$(curl -s -o /dev/null -w 'healthz %{http_code}\n' --max-time 10 --cacert "$state/copy2/tls-cert.pem" "https://$(cat "$state/copy2/ip")/healthz" || true)"
  case "$health" in
    'healthz 200') break ;;
    'healthz 000' | 'healthz 502' | 'healthz 503' | 'healthz 504') ;;
    *) res failed_step healthz2; res healthz2_tries "$tries"; say "copy 2 answered '$health'"; exit 1 ;;
  esac
  if [ $(($(date +%s) - h0)) -ge "$health_cap" ] || [ "$tries" -ge $((health_cap / health_every)) ]; then
    res failed_step healthz2
    res healthz2_tries "$tries"
    say "copy 2 still answered '$health' after $(($(date +%s) - h0)) s and $tries tries (cap $health_cap s)"
    exit 1
  fi
  # A dry run's answers are canned: it does not wait between them.
  [ "$mode" = dry ] || sleep "$health_every"
done
res healthz2_seconds "$(($(date +%s) - h0))"
res healthz2_tries "$tries"
harness="$state/harness"
mkdir -p "$harness"
cp "$root/ci/smoke/smoke.mjs" "$root/ci/page-walkers/origin-guard.ts" "$root/packages/db/src/passwords.ts" "$harness/"
ln -sfn "$root/node_modules" "$harness/node_modules"
smoke() {
  SMOKE_BASE="https://$(cat "$state/copy2/ip")" SMOKE_IGNORE_HTTPS_ERRORS=1 SMOKE_SEED="$(cat "$state/copy1/seed")" BW_DRILL_HARNESS="$harness" bw-drill-smoke
}
arm smoke 0 "$state/logs/arm-smoke.log" smoke
res smoke_row "$(sed -n 's/^smoke\.mjs: Maria Santos signed in; found: //p' "$state/logs/arm-smoke.log" | head -1)"
res t_restore "$(($(date +%s) - s))"
say "every arm as required; the teardown follows"
exit 0
