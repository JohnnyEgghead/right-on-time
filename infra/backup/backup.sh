#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P3-BACKUP: the nightly backup (SPECIFICATIONS section 11.7; NFR-07, NFR-10). Started by the host timer
# brightwater-backup.timer at 2:30 AM America/New_York (infra/hosted/systemd), as root:
#   sudo systemctl start brightwater-backup.service
# Steps, in 1 database session:
#   1. BEGIN ISOLATION LEVEL REPEATABLE READ and export its snapshot (pg_export_snapshot);
#   2. per-table row counts and checksums of world, pbs and system in that snapshot (checksums.sql, the method it names as
#      written, recorded in the manifest's checksum_method);
#   3. pg_dump -Fc --snapshot=<id>: the dump sees exactly the rows that were counted;
#   4. upload the dump, then its manifest (counts, checksums, the dump's size and SHA-256), through the target;
#   5. retention (retention.sh): sets older than BACKUP_KEEP_DAYS days are deleted;
#   6. INSERT the backup_record row (kind backup, result passed, manifest) in that same transaction, and COMMIT.
# A failure anywhere rolls the transaction back, removes what this run uploaded, writes a backup_record row with
# result failed, logs the event backup_failed and exits 1, so the unit fails; the SD-30 alert rule "the last
# backup failed" reads that row (the alert checks of P3-ALERTS open the backup_failed alert from it).
# With BACKUP_TARGET=none (an own copy) it does nothing and exits 0.
set -euo pipefail
BW_PROCESS=backup
# shellcheck source=infra/backup/lib.sh
. "$(dirname "$0")/lib.sh"
check_settings
if [ "$BACKUP_TARGET" = none ]; then log not_set_up "BACKUP_TARGET is none: no backup"; exit 0; fi
take_lock

# F-390: declared empty first so the exit trap can run (and log backup_failed) when the db container is missing.
DB=""
WORK=""
STAMP=""
STARTED=""
UPLOADED=()
COMMITTED=0
PG_PID=""

# Defined before the trap: finish calls it, and finish can run before the snapshot session exists (F-390).
# close_session: end psql's input; with no COMMIT sent, the transaction rolls back.
close_session() {
  if [ -n "${PG[1]:-}" ]; then eval "exec ${PG[1]}>&-"; fi
  if [ -n "$PG_PID" ]; then wait "$PG_PID" 2>/dev/null || true; PG_PID=""; fi
}

finish() {
  local rc=$?
  if [ "$COMMITTED" != 1 ]; then
    # Closing the session rolls the snapshot transaction back; nothing of this run stays in the database.
    close_session
    local n
    for n in "${UPLOADED[@]}"; do target_remove "$n" >/dev/null 2>&1 || log warn "could not remove $n after the failure"; done
    if psql_ "$BW_DB_NAME" -c "INSERT INTO system.backup_record (kind, location, started_real, finished_real, result)
        VALUES ('backup', '$(target_url "${STAMP:+$STAMP/}")', coalesce(nullif('$STARTED', '')::timestamptz, clock_timestamp()),
                clock_timestamp(), 'failed')" >/dev/null; then
      log backup_failed "the backup failed (exit $rc); a failed backup_record row is written"
    else
      log backup_failed "the backup failed (exit $rc) and its failed record could not be written"
    fi
    [ "$rc" -ne 0 ] || rc=1
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

DB="$(db_container)"
WORK="$(new_workdir backup)"

# The snapshot session: psql reads statements from this script and answers each with its rows, then a marker.
coproc PG { docker exec -i "$DB" psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$BW_DB_USER" -d "$BW_DB_NAME" 2>"$WORK/psql.err"; }
PG_PID=$!
sql() {
  printf '%s\n\\echo __BW_END__\n' "$1" >&"${PG[1]}"
  local line out=""
  while IFS= read -r -t 3600 line <&"${PG[0]}"; do
    if [ "$line" = __BW_END__ ]; then printf '%s' "$out"; return 0; fi
    out+="${out:+$'\n'}$line"
  done
  log error "the database session ended: $(head -c 400 "$WORK/psql.err" | tr '\n' ' ')"
  return 1
}

snap_and_start="$(sql "BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_export_snapshot() || '|' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDD\"T\"HH24MISS\"Z\"') || '|' || clock_timestamp();")"
SNAPSHOT="${snap_and_start%%|*}"
rest="${snap_and_start#*|}"
STAMP="${rest%%|*}"
STARTED="${rest#*|}"
[[ "$SNAPSHOT" =~ ^[0-9A-F-]+$ ]] || die "no snapshot id from the database"
log started "snapshot exported; set $STAMP"

sql "$(cat "$BW_LIB_DIR/checksums.sql")" >/dev/null
# The checksums by the method new backups write, and that method's name in the manifest (F-1582).
sql "CREATE TEMP TABLE bw_tables AS SELECT pg_temp.bw_checksum_method_written() AS method, pg_temp.bw_checksums(pg_temp.bw_checksum_method_written()) AS t;" >/dev/null
tables="$(sql "SELECT count(*) || ' tables, ' || sum((v->>'rows')::bigint) || ' rows' FROM bw_tables, jsonb_each(t) e(k, v);")"
log counted "$tables"

docker exec "$DB" pg_dump -U "$BW_DB_USER" -d "$BW_DB_NAME" -Fc --snapshot="$SNAPSHOT" > "$WORK/$DUMP_NAME" 2>"$WORK/pg_dump.err" \
  || die "pg_dump failed: $(head -c 400 "$WORK/pg_dump.err" | tr '\n' ' ')"
BYTES="$(stat -c %s "$WORK/$DUMP_NAME")"
SHA="$(sha256sum "$WORK/$DUMP_NAME" | cut -d' ' -f1)"
[ "$BYTES" -gt 0 ] || die "pg_dump wrote an empty dump"
log dumped "$BYTES bytes"

sql "SELECT jsonb_build_object('format', 1, 'set', '$STAMP', 'database', '$BW_DB_NAME', 'taken_real', '$STARTED'::timestamptz,
  'dump', jsonb_build_object('name', '$DUMP_NAME', 'bytes', $BYTES, 'sha256', '$SHA'), 'checksum_method', method, 'tables', t)::text FROM bw_tables;" > "$WORK/$MANIFEST_NAME"

target_put "$STAMP/$DUMP_NAME" "$WORK/$DUMP_NAME" || die "the dump upload failed"
UPLOADED+=("$STAMP/$DUMP_NAME")
target_put "$STAMP/$MANIFEST_NAME" "$WORK/$MANIFEST_NAME" || die "the manifest upload failed"
UPLOADED+=("$STAMP/$MANIFEST_NAME")
log uploaded "$(target_url "$STAMP/")"
rm -f "$WORK/$DUMP_NAME"

# Retention after the upload, inside the lock this run holds (BW_LOCK_HELD skips retention's own lock).
# A retention failure is not the backup's (F-394): the set just uploaded is good and is kept; the next run retries the delete.
BW_LOCK_HELD=1 bash "$BW_LIB_DIR/retention.sh" || log warn "retention failed; this backup is kept and the next run retries the delete"
KEPT="$(sets | wc -l | tr -d ' ')" || KEPT=0

sql "INSERT INTO system.backup_record (kind, location, started_real, finished_real, result, size_bytes, nights_kept, manifest)
  SELECT 'backup', '$(target_url "$STAMP/")', '$STARTED', clock_timestamp(), 'passed', $BYTES, $KEPT, '$(sed "s/'/''/g" "$WORK/$MANIFEST_NAME")'::jsonb;" >/dev/null
sql "COMMIT;" >/dev/null
COMMITTED=1
close_session
log passed "backup $STAMP: $BYTES bytes, $KEPT sets kept"
