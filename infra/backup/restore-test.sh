#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P3-BACKUP: the weekly restore test (SPECIFICATIONS section 11.7; NFR-07, FR-HLTH-1). Started by the host timer
# brightwater-restore-test.timer on Sunday at 4:00 AM America/New_York (infra/hosted/systemd), as root:
#   sudo systemctl start brightwater-restore-test.service
# It fetches the newest complete set (dump and manifest) from the bucket through the backup target, never a local
# file (backup.sh keeps none), then runs every check below and reports each one; the test passes only if all pass:
#   1. fetched     the dump's size and SHA-256 equal its manifest's;
#   2. truncated   a copy cut to half its length is restored into restore_check and MUST fail; a half copy that
#                  restores is a failed test (the test proves on every run that it can fail);
#   3. restored    the full dump restores into restore_check (pg_restore --exit-on-error);
#   4. compare     every table's row count and checksum in restore_check equals the manifest's, with no table
#                  missing or extra (checksums.sql, the same code the backup ran, by the checksum method the manifest
#                  names: key-only-v1 when it names none, as the sets made before F-1579; an unknown method fails it);
#   5. import      the import rows equal the FR-IMP-6 targets (import-check.sql);
#   6. record      the manifest equals the backup_record row written in the backup's own transaction.
# It drops restore_check and writes a backup_record row of kind restore_test (result passed or failed).
# Exit 0 passed, 1 failed, 2 refused (settings), 0 with nothing done when BACKUP_TARGET=none or before setup has
# finished (F-1697). A lock wait that times out is a failed test with its record, and drops nothing (F-492).
# BACKUP_RECORD=off (the planted-manifest arms of the proofs and the hosted check) writes no record, so a planted
# run never shows on the System health page; every scheduled run writes one.
set -euo pipefail
BW_PROCESS=restore-test
# shellcheck source=infra/backup/lib.sh
. "$(dirname "$0")/lib.sh"
check_settings
BACKUP_RECORD="${BACKUP_RECORD:-on}"
case "$BACKUP_RECORD" in on|off) ;; *) die "BACKUP_RECORD must be on or off" 2 ;; esac
if [ "$BACKUP_TARGET" = none ]; then log not_set_up "BACKUP_TARGET is none: no restore test"; exit 0; fi

# F-390: declared empty first so the exit trap can run when the db container is missing or does not answer.
DB=""
WORK=""
STARTED=""
LOCATION=""
FAILED=()
RECORDED=0
# F-492: 1 once this run holds the backup lock. Before that, restore_check is the lock holder's and finish keeps it.
LOCKED=0

record() {
  [ "$RECORDED" = 0 ] || return 0
  RECORDED=1
  local result="$1"
  if [ "$BACKUP_RECORD" = off ]; then log not_recorded "BACKUP_RECORD is off: no restore_test record"; return 0; fi
  psql_ "$BW_DB_NAME" -c "INSERT INTO system.backup_record (kind, location, started_real, finished_real, result)
    VALUES ('restore_test', '${LOCATION:-$(target_url)}', coalesce(nullif('$STARTED', '')::timestamptz, clock_timestamp()), clock_timestamp(), '$result')" >/dev/null \
    || { log error "the restore_test record could not be written"; return 1; }
}
drop_check() { psql_ postgres -c 'DROP DATABASE IF EXISTS restore_check WITH (FORCE)' >/dev/null; }
# shellcheck disable=SC2329 # the EXIT trap runs it
finish() {
  local rc=$?
  if [ "$LOCKED" = 1 ]; then drop_check || log warn "could not drop restore_check"; fi
  [ -z "$WORK" ] || rm -rf "$WORK"
  if [ "$RECORDED" = 0 ]; then
    log failed "the restore test stopped early (exit $rc)"
    record failed || true
    [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

DB="$(db_container)"
# F-1697: before setup there is no world to test, and a failed run would show on System health; nothing is written.
# F-1771: a database that does not answer exits inside world_set_up, so finish writes the failed record.
if ! world_set_up; then
  log not_set_up "no world is set up yet (no system.day_snapshot row): no restore test"
  RECORDED=1
  exit 0
fi
# F-492: after the trap, so a lock wait that times out writes its failed restore_test row.
take_lock
LOCKED=1
WORK="$(new_workdir restore)"
STARTED="$(psql_ "$BW_DB_NAME" -c 'SELECT clock_timestamp()')"

check() {  # check <name> <passed 0|1> <message>
  if [ "$2" = 1 ]; then log check_passed "$1: $3"; else log check_failed "$1: $3"; FAILED+=("$1"); fi
}

# The newest complete set in the target.
set_stamp="$(sets | tail -n 1)"
[ -n "$set_stamp" ] || die "no complete backup set in $(target_url)"
LOCATION="$(target_url "$set_stamp/")"
target_get "$set_stamp/$MANIFEST_NAME" "$WORK/$MANIFEST_NAME" || die "could not fetch the manifest of $set_stamp"
target_get "$set_stamp/$DUMP_NAME" "$WORK/$DUMP_NAME" || die "could not fetch the dump of $set_stamp"
log fetched "set $set_stamp from $LOCATION"
manifest="$(cat "$WORK/$MANIFEST_NAME")"

# 1. fetched
want="$(psql_ postgres -v m="$manifest" <<<"SELECT (:'m'::jsonb->'dump'->>'bytes') || ' ' || (:'m'::jsonb->'dump'->>'sha256');")"
got="$(stat -c %s "$WORK/$DUMP_NAME") $(sha256sum "$WORK/$DUMP_NAME" | cut -d' ' -f1)"
if [ "$want" = "$got" ]; then check fetched 1 "${got%% *} bytes, SHA-256 equals the manifest's"
else check fetched 0 "the fetched dump (${got%% *} bytes) does not equal its manifest (${want%% *} bytes, or its SHA-256)"; fi

# 2. truncated: half the bytes, through the same restore as step 3. It must fail.
bytes="$(stat -c %s "$WORK/$DUMP_NAME")"
head -c "$((bytes / 2))" "$WORK/$DUMP_NAME" > "$WORK/half.dump"
drop_check
psql_ postgres -c 'CREATE DATABASE restore_check' >/dev/null
half_rc=0
docker exec -i "$DB" pg_restore -U "$BW_DB_USER" -d restore_check --exit-on-error < "$WORK/half.dump" > "$WORK/half.err" 2>&1 || half_rc=$?
rm -f "$WORK/half.dump"
if [ "$half_rc" -ne 0 ]; then
  check truncated 1 "a copy cut to $((bytes / 2)) of $bytes bytes failed to restore (exit $half_rc), as required: $(grep -m 1 'error' "$WORK/half.err" | head -c 200)"
else check truncated 0 "a copy cut to half restored with exit 0: this restore cannot tell a broken dump from a good one"; fi
drop_check

# 3. restored
psql_ postgres -c 'CREATE DATABASE restore_check' >/dev/null
full_rc=0
docker exec -i "$DB" pg_restore -U "$BW_DB_USER" -d restore_check --exit-on-error < "$WORK/$DUMP_NAME" > "$WORK/full.err" 2>&1 || full_rc=$?
if [ "$full_rc" -eq 0 ]; then check restored 1 "the full dump restored into restore_check"
else check restored 0 "the full dump did not restore (exit $full_rc): $(head -c 300 "$WORK/full.err" | tr '\n' ' ')"; fi

if [ "$full_rc" -eq 0 ]; then
  # 4. compare: every table both ways.
  # The restored side by the checksum method the manifest names (F-1582); an unknown method fails the compare, named.
  cmp_rc=0
  diffs="$( { cat "$BW_LIB_DIR/checksums.sql"; cat <<'SQL'
SELECT '#method ' || pg_temp.bw_checksum_method(:'m'::jsonb);
WITH m AS (SELECT :'m'::jsonb->'tables' AS t), c AS (SELECT pg_temp.bw_checksums(pg_temp.bw_checksum_method(:'m'::jsonb)) AS t)
SELECT coalesce(a.k, b.k) || ': manifest ' || coalesce((a.v->>'rows') || ' rows md5 ' || (a.v->>'md5'), 'has no such table')
       || ', restored ' || coalesce((b.v->>'rows') || ' rows md5 ' || (b.v->>'md5'), 'has no such table')
  FROM jsonb_each((SELECT t FROM m)) a(k, v) FULL JOIN jsonb_each((SELECT t FROM c)) b(k, v) ON a.k = b.k
 WHERE a.v IS DISTINCT FROM b.v ORDER BY 1;
SELECT '#tables ' || count(*) FROM jsonb_object_keys(:'m'::jsonb->'tables');
SQL
  } | psql_ restore_check -v m="$manifest" 2>"$WORK/compare.err")" || cmp_rc=$?
  method="$(sed -n 's/^#method //p' <<<"$diffs")"
  ntables="$(sed -n 's/^#tables //p' <<<"$diffs")"
  mismatches="$(grep -v '^#' <<<"$diffs" || true)"
  if [ "$cmp_rc" -ne 0 ]; then
    check compare 0 "the compare stopped (psql exit $cmp_rc): $(sed -n 's/^.*ERROR: *//p' "$WORK/compare.err" | head -n 1 | head -c 300)"
  elif [ -z "$mismatches" ] && [ "${ntables:-0}" -gt 0 ]; then
    check compare 1 "$ntables tables: every row count and checksum equals the manifest (checksum method $method)"
  else
    while IFS= read -r line; do [ -z "$line" ] || log mismatch "$line"; done <<<"$mismatches"
    check compare 0 "$(grep -c . <<<"$mismatches" || true) of ${ntables:-0} manifest tables differ (each logged as mismatch; checksum method $method)"
  fi

  # 5. import
  imp_bad=0 imp_n=0
  while IFS='|' read -r item target n; do
    [ -n "$item" ] || continue
    imp_n=$((imp_n + 1))
    if [ "$target" != "$n" ]; then imp_bad=$((imp_bad + 1)); log mismatch "import: $item: target $target, restored $n"; fi
  done < <(psql_ restore_check < "$BW_LIB_DIR/import-check.sql")
  if [ "$imp_bad" = 0 ] && [ "$imp_n" -gt 0 ]; then check import 1 "$imp_n FR-IMP-6 counts equal their targets"
  else check import 0 "$imp_bad of $imp_n FR-IMP-6 counts differ from their targets (each logged as mismatch)"; fi
else
  check compare 0 "not run: the dump did not restore"
  check import 0 "not run: the dump did not restore"
fi

# 6. record: the manifest is the one the backup's own transaction stored.
same="$(psql_ "$BW_DB_NAME" -v m="$manifest" -v loc="$LOCATION" <<<"SELECT count(*) FROM system.backup_record
  WHERE kind = 'backup' AND result = 'passed' AND location = :'loc' AND manifest = :'m'::jsonb;")"
if [ "$same" = 1 ]; then check record 1 "the manifest equals the passed backup_record of $set_stamp"
else check record 0 "no passed backup_record of $LOCATION holds this manifest"; fi

drop_check
if [ "${#FAILED[@]}" -eq 0 ]; then
  record passed
  log passed "restore test of $set_stamp passed: fetched, truncated, restored, compare, import, record"
  exit 0
fi
record failed
log failed "restore test of $set_stamp failed: ${FAILED[*]}"
exit 1
