#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P3-BACKUP: the server half of the hosted check (BUILD_PLAN P3-BACKUP Acceptance, hosted half). Run ON the hosted
# server as root by infra/backup/hosted-check.sh, never by hand:  sudo bash /opt/brightwater/backup/hosted-check-server.sh
# Arms, in order (each prints ARM <name> PASS|FAIL with its figures):
#   preflight  the units and timers are installed and enabled; no AWS key on the server; the world is set up
#              (FR-IMP-6 import rows present). A failed preflight stops before anything is written.
#   region     the bucket's Region (S3 head-bucket and get-bucket-location) and the instance's (metadata) are the
#              same US Region as BACKUP_REGION (NFR-10, SD-36).
#   backup     1 backup triggered early by its unit; its backup_record row is passed and its set is in the bucket.
#   restore    1 restore test triggered early by its unit, with the db container's memory and the host's available
#              memory sampled every 0.5 s beside the running stack; its record is passed and its truncated-copy
#              check failed to restore, as required.
#   planted    a copy of the newest set under checks/planted-<run>/ with 1 wrong checksum (world.customer) in its
#              manifest; restore-test.sh with that prefix and BACKUP_RECORD=off must fail its compare on exactly
#              that table (its record check fails too: no backup ran under that prefix). Removed afterwards.
#   retention  planted objects under backups/ dated 20 days and 13 days ago; retention.sh deletes the first and
#              keeps the second; the second is removed afterwards. Real sets are untouched.
# Safe to run twice: every planted name carries this run's stamp and is removed by this run; each run adds 1 backup
# set and 1 restore_test record, as a nightly or weekly run would. Prints no secret: only the BACKUP_* settings are
# read from .env, the database is reached through the db container's socket, the bucket by resource access.
# Exit 0 when every arm passes, 1 otherwise, 2 when preflight fails.
set -uo pipefail
DEST=/opt/brightwater
B="$DEST/backup"
RUN="$(date -u +%Y%m%dT%H%M%SZ)"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "[$(ts)] $*"; }
declare -A VERDICT=()
arm() { VERDICT[$1]="$2"; say "ARM $1 $2${3:+ - $3}"; }

setting() { sed -n "s/^$1=//p" "$DEST/.env" | tail -n 1; }
BACKUP_TARGET="$(setting BACKUP_TARGET)"; BACKUP_BUCKET="$(setting BACKUP_BUCKET)"; BACKUP_REGION="$(setting BACKUP_REGION)"
export BACKUP_TARGET BACKUP_BUCKET BACKUP_REGION
say "== hosted-check-server run $RUN"
say "settings: BACKUP_TARGET=$BACKUP_TARGET BACKUP_BUCKET=$BACKUP_BUCKET BACKUP_REGION=$BACKUP_REGION"
BW_PROJECT="${BW_PROJECT:-brightwater}"
DB="$(docker ps -q --filter "label=com.docker.compose.project=$BW_PROJECT" --filter label=com.docker.compose.service=db)"; DB=${DB%%$'\n'*}
q() { docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$DB" psql -X -q -A -t -v ON_ERROR_STOP=1 -U brightwater -d brightwater -c "$1"; }
# BACKUP_ENDPOINT_URL: the local rehearsal's S3-compatible server only (infra/backup/tests); never set on the server.
s3() { aws --region "$BACKUP_REGION" ${BACKUP_ENDPOINT_URL:+--endpoint-url "$BACKUP_ENDPOINT_URL"} "$@"; }

# F-392 (d): a dropped ssh (or any exit) leaves no planted object behind: this run's planted copy and dated objects are removed on every exit.
planted_prefix="" old="" young="" mark=""
cleanup() {
  [ -z "$planted_prefix" ] || s3 s3 rm --only-show-errors --recursive "s3://$BACKUP_BUCKET/$planted_prefix" >/dev/null 2>&1 || true
  if [ -n "$mark" ]; then
    [ -z "$old" ] || s3 s3 rm --only-show-errors "s3://$BACKUP_BUCKET/backups/$old/$mark" >/dev/null 2>&1 || true
    [ -z "$young" ] || s3 s3 rm --only-show-errors "s3://$BACKUP_BUCKET/backups/$young/$mark" >/dev/null 2>&1 || true
    rm -f "/tmp/$mark"
  fi
}
trap cleanup EXIT

# ---- preflight -------------------------------------------------------------------------------------------------
pre_ok=1
if [ "$BACKUP_TARGET" != lightsail ] || [ -z "$BACKUP_BUCKET" ] || [ -z "$BACKUP_REGION" ]; then
  say "preflight: the BACKUP_* settings are not the hosted ones"; pre_ok=0
fi
for f in backup.sh restore-test.sh retention.sh lib.sh checksums.sql import-check.sql; do
  [ -f "$B/$f" ] || { say "preflight: $B/$f is missing (deploy this commit first)"; pre_ok=0; }
done
for t in brightwater-backup brightwater-restore-test; do
  say "timer $t: enabled $(systemctl is-enabled "$t.timer" 2>&1), active $(systemctl is-active "$t.timer" 2>&1)," \
      "OnCalendar $(systemctl show -P TimersCalendar "$t.timer" | sed -n 's/.*OnCalendar=\([^;]*\);.*/\1/p' | sed 's/ *$//')," \
      "next $(systemctl show -P NextElapseUSecRealtime "$t.timer"), last trigger $(systemctl show -P LastTriggerUSec "$t.timer")"
  [ "$(systemctl is-enabled "$t.timer" 2>/dev/null)" = enabled ] || pre_ok=0
  [ "$(systemctl is-active "$t.timer" 2>/dev/null)" = active ] || pre_ok=0
done
# F-392 (c): the key can also sit in the stack's .env or in an AWS config file, not only in credentials or the environment.
if [ -e "$HOME/.aws/credentials" ] || [ -e /root/.aws/credentials ] || [ -n "${AWS_ACCESS_KEY_ID:-}" ] || [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] \
   || grep -Eqi '^[[:space:]]*(export[[:space:]]+)?aws_(access_key_id|secret_access_key)[[:space:]]*=' "$DEST/.env" "$HOME/.aws/config" /root/.aws/config 2>/dev/null; then
  say "preflight: an AWS key is present on the server (resource access only, section 4.8)"; pre_ok=0
fi
if [ -z "$DB" ]; then say "preflight: no running db container in project brightwater"; pre_ok=0
else
  imported="$(q "SELECT count(*) FROM world.customer WHERE source = 'import'" 2>/dev/null || echo error)"
  say "world: $imported imported customers (FR-IMP-6 target 18400)"
  [ "$imported" = 18400 ] || { say "preflight: the world is not set up, so the restore test's import check cannot pass"; pre_ok=0; }
fi
if [ "$pre_ok" != 1 ]; then arm preflight FAIL "nothing was written"; say "HOSTED-CHECK-SERVER FAIL (preflight)"; exit 2; fi
arm preflight PASS

# ---- region ----------------------------------------------------------------------------------------------------
tok="$(curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
inst_region="$(curl -s -m 5 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/placement/region || true)"
head_region="$(s3 s3api head-bucket --bucket "$BACKUP_BUCKET" --query BucketRegion --output text 2>/dev/null || echo unreadable)"
case "$head_region" in ""|None) head_region=unreadable ;; esac
[[ "$inst_region" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || inst_region=unreadable
loc_region="$(s3 s3api get-bucket-location --bucket "$BACKUP_BUCKET" --query LocationConstraint --output text 2>/dev/null || echo unreadable)"
# get-bucket-location answers None (null) for us-east-1, the classic Region.
[ "$loc_region" != None ] || loc_region=us-east-1
say "region: BACKUP_REGION $BACKUP_REGION, instance ${inst_region:-unreadable}, bucket head-bucket $head_region, get-bucket-location $loc_region"
region_ok=1
[[ "$BACKUP_REGION" =~ ^us-(east|west)-[0-9]+$ ]] || region_ok=0
seen=0 bucket_seen=0
for r in "$inst_region" "$head_region" "$loc_region"; do
  case "$r" in ""|unreadable) ;; "$BACKUP_REGION") seen=$((seen + 1)) ;; *) region_ok=0 ;; esac
done
# F-392 (b): the instance's Region alone does not show where the bucket is; at least 1 of the 2 bucket readings must agree.
for r in "$head_region" "$loc_region"; do [ "$r" != "$BACKUP_REGION" ] || bucket_seen=$((bucket_seen + 1)); done
[ "$seen" -ge 1 ] && [ "$bucket_seen" -ge 1 ] || region_ok=0
if [ "$region_ok" = 1 ]; then arm region PASS "$BACKUP_REGION is a US Region; $seen of 3 readings agree ($bucket_seen of the 2 bucket readings), none differs"; else arm region FAIL; fi

# ---- backup ----------------------------------------------------------------------------------------------------
t0="$(date +%s)"
say "== systemctl start brightwater-backup.service"
systemctl start brightwater-backup.service; brc=$?
journalctl -u brightwater-backup.service --since "@$t0" -o cat --no-pager | sed 's/^/  journal: /'
rec="$(q "SELECT result || '|' || size_bytes || '|' || nights_kept || '|' || location || '|' || started_real || '|' || finished_real
          FROM system.backup_record WHERE kind = 'backup' AND started_real >= to_timestamp($t0) - interval '5 seconds'
          ORDER BY started_real DESC LIMIT 1")"
say "backup unit exit $brc; record result|size_bytes|nights_kept|location|started_real|finished_real: ${rec:-none}"
stamp="$(sed -n 's#.*/backups/\([0-9TZ]*\)/|.*#\1#p' <<<"$rec")"
objs="$(s3 s3 ls "s3://$BACKUP_BUCKET/backups/$stamp/" 2>/dev/null | awk '{print $4 " " $3 " bytes"}' | tr '\n' ';')"
say "bucket objects of set ${stamp:-none}: ${objs:-none}"
if [ "$brc" = 0 ] && [ "${rec%%|*}" = passed ] && grep -q 'brightwater.dump' <<<"$objs" && grep -q 'manifest.json' <<<"$objs"; then
  arm backup PASS "set $stamp"; else arm backup FAIL; fi

# ---- restore, with memory beside the running stack --------------------------------------------------------------
say "stack memory before the restore test (docker stats):"
mapfile -t stack_ids < <(docker ps -q --filter "label=com.docker.compose.project=$BW_PROJECT")
docker stats --no-stream --format '  {{.Name}} {{.MemUsage}}' "${stack_ids[@]}"
# The db container's cgroup (cgroup v2): memory.current counts page cache too, which the kernel reclaims at the cap;
# anon and shmem (memory.stat) are what cannot be reclaimed, and memory.events oom_kill counts the kills at the cap.
cgdir="/sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' "$DB").scope"
cgread() { cat "$cgdir/$1" 2>/dev/null || docker exec "$DB" cat "/sys/fs/cgroup/$1" 2>/dev/null; }
oom_before="$(cgread memory.events | awk '$1 == "oom_kill" {print $2}')"
db_max="$(cgread memory.max)"
memlog="$(mktemp)"
( while :; do
    cur="$(cgread memory.current || echo 0)"
    # anon plus shmem (PostgreSQL's shared buffers): the part no reclaim can free, with no swap on the plan.
    anon="$(cgread memory.stat | awk '$1 == "anon" || $1 == "shmem" {s += $2} END {print s}')"
    avail="$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)"
    echo "${cur:-0} ${anon:-0} ${avail:-0}"
    sleep 0.5
  done > "$memlog" ) &
sampler=$!
t0="$(date +%s)"
say "== systemctl start brightwater-restore-test.service"
systemctl start brightwater-restore-test.service; rrc=$?
kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
journal="$(journalctl -u brightwater-restore-test.service --since "@$t0" -o cat --no-pager)"
awk '{ print "  journal: " $0 }' <<<"$journal"
rrec="$(q "SELECT result || '|' || location || '|' || started_real || '|' || finished_real FROM system.backup_record
           WHERE kind = 'restore_test' AND started_real >= to_timestamp($t0) - interval '5 seconds' ORDER BY started_real DESC LIMIT 1")"
say "restore unit exit $rrc; record result|location|started_real|finished_real: ${rrec:-none}"
oom_after="$(cgread memory.events | awk '$1 == "oom_kill" {print $2}')"
mem="$(awk 'NR == 1 { b = $1; ba = $2; mn = $3 } { if ($1 > mx) mx = $1; if ($2 > ma) ma = $2; if ($3 < mn) mn = $3 }
            END { printf "samples %d; db container memory.current baseline %.0f MiB, peak %.0f MiB; anon+shmem baseline %.0f MiB, peak %.0f MiB; host MemAvailable min %.0f MiB",
                  NR, b / 1048576, mx / 1048576, ba / 1048576, ma / 1048576, mn / 1048576 }' "$memlog")"
total="$(awk '/^MemTotal:/ {printf "%.0f", $2 / 1024}' /proc/meminfo)"
say "MEMORY restore beside the running stack: $mem (MemTotal $total MiB; db memory.max $db_max; db oom_kill before ${oom_before:-?}, after ${oom_after:-?})"
rm -f "$memlog"
if [ "$rrc" = 0 ] && [ "${rrec%%|*}" = passed ] && grep -q '"event":"check_passed","msg":"truncated: .*failed to restore.*as required' <<<"$journal" \
   && [ "${oom_after:-x}" = "${oom_before:-y}" ]; then
  arm restore PASS "truncated-copy check failed to restore, as required; record passed; no OOM kill in the db container"
else arm restore FAIL; fi

# ---- planted manifest: 1 wrong checksum ---------------------------------------------------------------------------
pp="checks/planted-$RUN/"
planted_prefix="$pp"
work="$(mktemp -d)"
if [ -n "$stamp" ] \
   && s3 s3 cp --only-show-errors "s3://$BACKUP_BUCKET/backups/$stamp/brightwater.dump" "s3://$BACKUP_BUCKET/$pp$stamp/brightwater.dump" \
   && s3 s3 cp --only-show-errors "s3://$BACKUP_BUCKET/backups/$stamp/manifest.json" "$work/manifest.json" \
   && python3 -I -c 'import json,sys; p=sys.argv[1]; m=json.load(open(p)); t=m["tables"]["world.customer"]; t["md5"]=("0" if t["md5"][0]!="0" else "1")+t["md5"][1:]; json.dump(m,open(p,"w"))' "$work/manifest.json" \
   && s3 s3 cp --only-show-errors "$work/manifest.json" "s3://$BACKUP_BUCKET/$pp$stamp/manifest.json"; then
  say "planted: $pp$stamp/ = the dump of $stamp and its manifest with world.customer's md5 changed in 1 hex digit"
  pout="$(BACKUP_PREFIX="$pp" BACKUP_RECORD=off bash "$B/restore-test.sh" 2>&1)"; prc=$?
  awk '{ print "  planted run: " $0 }' <<<"$pout"
  failed_checks="$(grep -o '"event":"check_failed","msg":"[a-z]*' <<<"$pout" | sed 's/.*"msg":"//' | sort | tr '\n' ' ')"
  mism="$(grep -c '"event":"mismatch"' <<<"$pout")"
  say "planted run exit $prc; failed checks: ${failed_checks:-none}; mismatch lines: $mism"
  if [ "$prc" = 1 ] && [ "$failed_checks" = "compare record " ] && [ "$mism" = 1 ] \
     && grep -q '"event":"mismatch","msg":"world.customer: ' <<<"$pout"; then
    arm planted PASS "the compare failed on world.customer only"; else arm planted FAIL; fi
else
  arm planted FAIL "could not plant the copy"
fi
s3 s3 rm --only-show-errors --recursive "s3://$BACKUP_BUCKET/$pp" || say "WARN: could not remove $pp"
rm -rf "$work"

# ---- retention: planted dated objects -------------------------------------------------------------------------------
old="$(date -u -d '-20 days' +%Y%m%dT%H%M%SZ)"; young="$(date -u -d '-13 days' +%Y%m%dT%H%M%SZ)"
mark="PLANTED-hosted-check-$RUN.txt"
echo "planted by hosted-check-server.sh run $RUN" > "/tmp/$mark"
# Real sets inside the 14 days (a manifest under a stamp at or after the cutoff): retention must keep every one.
cutoff="$(date -u -d '-14 days' +%Y%m%dT%H%M%SZ)"
young_sets() {
  s3 s3 ls --recursive "s3://$BACKUP_BUCKET/backups/" | awk -v c="$cutoff" '{ n = split($4, p, "/") } n == 3 && p[3] == "manifest.json" && p[2] >= c' | wc -l | tr -d ' '
}
present() { s3 s3api head-object --bucket "$BACKUP_BUCKET" --key "backups/$1/$mark" >/dev/null 2>&1; }
sets_before="$(young_sets)"
# F-392 (a): the verdict needs both planted objects confirmed present before retention runs, the deleted event for the old one in
# retention's own output, and the old object confirmed gone after; a failed upload or a failed read cannot read as "deleted".
planted_ok=1
s3 s3 cp --only-show-errors "/tmp/$mark" "s3://$BACKUP_BUCKET/backups/$old/$mark" || planted_ok=0
s3 s3 cp --only-show-errors "/tmp/$mark" "s3://$BACKUP_BUCKET/backups/$young/$mark" || planted_ok=0
rm -f "/tmp/$mark"
present "$old" || planted_ok=0
present "$young" || planted_ok=0
say "planted backups/$old/$mark (20 days old) and backups/$young/$mark (13 days old); both confirmed present: $planted_ok"
rout="$(bash "$B/retention.sh" 2>&1)"
sed 's/^/  retention: /' <<<"$rout"
deleted_event=0
grep -q "\"event\":\"deleted\",\"msg\":\"$old/$mark " <<<"$rout" && deleted_event=1
old_left=1; present "$old" || old_left=0
young_left=0; present "$young" && young_left=1
s3 s3 rm --only-show-errors "s3://$BACKUP_BUCKET/backups/$young/$mark" || say "WARN: could not remove the 13-day planted object"
sets_after="$(young_sets)"
say "retention: deleted event for the 20-day object $deleted_event, 20-day planted object left $old_left, 13-day planted object left $young_left; real sets inside 14 days before $sets_before, after $sets_after"
if [ "$planted_ok" = 1 ] && [ "$deleted_event" = 1 ] && [ "$old_left" = 0 ] && [ "$young_left" = 1 ] && [ "$sets_after" = "$sets_before" ]; then arm retention PASS; else arm retention FAIL; fi

# ---- verdict ---------------------------------------------------------------------------------------------------------
all=PASS
summary=""
for a in preflight region backup restore planted retention; do
  summary+="$a=${VERDICT[$a]:-MISSING} "
  [ "${VERDICT[$a]:-}" = PASS ] || all=FAIL
done
say "HOSTED-CHECK-SERVER $all: $summary"
[ "$all" = PASS ]
