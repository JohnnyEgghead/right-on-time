#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P8-RESTORE-DRILL: the operator restore (SPECIFICATIONS section 11.7, "Restore procedure (operator)") of 1 backup set on a fresh
# copy, and the drill's check that the restored database equals the set's manifest. It runs on the copy as root, as the scripts of
# infra/backup do (it sources ../backup/lib.sh, so it lies beside that folder), with BW_PROJECT naming the Compose project.
#   restore-copy.sh restore <set dir>   fetched (the dump's size and SHA-256 equal the manifest's), then pg_restore --clean --if-exists
#                                       --single-transaction --exit-on-error into the live database, then compare and import (below).
#                                       Refused while a service that holds database sessions runs (web, worker, pbs, migrate, setup):
#                                       the procedure stops them first and starts the stack after.
#   restore-copy.sh check <set dir>     compare and import only, on the database as it is (the drill's planted known-bad arms)
#   restore-copy.sh plant <set dir> <out set dir>   a copy of the set whose manifest has its first table checksum changed
# compare: every table's row count and checksum equals the manifest's, with no table missing or extra (checksums.sql, then
# compare.sql: the restore test's own step 4, by the checksum method the manifest names; an unknown method is refused); import: the FR-IMP-6 counts equal their targets (import-check.sql).
# Every line is a JSON event (lib.sh log). Exit 0 every check passed, 1 a check failed, 2 refused.
# It writes no backup_record row: the restored rows must stay exactly the manifest's.
set -euo pipefail
BW_PROCESS=restore-drill
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=infra/backup/lib.sh
. "$here/../backup/lib.sh"

cmd="${1:-}"
set_dir="${2:-}"
case "$cmd" in restore | check | plant) ;; *) die "usage: restore-copy.sh restore|check <set dir> | plant <set dir> <out set dir>" 2 ;; esac
[ -n "$set_dir" ] && [ -f "$set_dir/$MANIFEST_NAME" ] || die "no $MANIFEST_NAME in '${set_dir}'" 2

if [ "$cmd" = plant ]; then
  out="${3:-}"
  [ -n "$out" ] || die "plant needs an out set dir" 2
  install -d "$out"
  cp "$set_dir/$DUMP_NAME" "$out/$DUMP_NAME"
  # The first table's checksum becomes 32 zeros (GNU sed: the first match only); a plant that changed nothing is refused.
  sed -E '0,/"md5": "[0-9a-f]{32}"/s//"md5": "00000000000000000000000000000000"/' "$set_dir/$MANIFEST_NAME" >"$out/$MANIFEST_NAME"
  if cmp -s "$set_dir/$MANIFEST_NAME" "$out/$MANIFEST_NAME"; then die "the plant changed nothing in the manifest" 2; fi
  log planted "a copy of the set whose manifest has its first table checksum changed to zeros"
  exit 0
fi

take_lock
DB=""
WORK=""
# shellcheck disable=SC2329 # the EXIT trap runs it
finish() {
  local rc=$?
  rm -rf "$WORK"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
DB="$(db_container)"
WORK="$(new_workdir restore-drill)"
manifest="$(cat "$set_dir/$MANIFEST_NAME")"
# The checksum method the manifest names (F-1582, checksums.sql): refused before anything is restored when this code does not know it.
method="$({ cat "$BW_LIB_DIR/checksums.sql"; echo "SELECT pg_temp.bw_checksum_method(:'m'::jsonb);"; } | psql_ postgres -v m="$manifest" 2>"$WORK/method.err")" \
  || die "refused: $(sed -n 's/^.*ERROR: *//p' "$WORK/method.err" | head -n 1 | head -c 300)" 2
log checksum_method "the manifest's checksums are $method"
FAILED=()
check() { # check <name> <passed 0|1> <message>
  if [ "$2" = 1 ]; then log check_passed "$1: $3"; else log check_failed "$1: $3"; FAILED+=("$1"); fi
}
stop_failed() {
  log failed "restore drill check of $set_dir failed: ${FAILED[*]}"
  exit 1
}

if [ "$cmd" = restore ]; then
  [ -f "$set_dir/$DUMP_NAME" ] || die "no $DUMP_NAME in $set_dir" 2
  busy="$(docker ps --filter "label=com.docker.compose.project=$BW_PROJECT" --format '{{.Label "com.docker.compose.service"}}' \
    | grep -xE 'web|worker|pbs|migrate|setup' | sort -u | tr '\n' ' ' || true)"
  [ -z "$busy" ] || die "refused: stop the services that hold database sessions first (running: ${busy% })" 2

  # fetched: the dump is the one the manifest describes.
  want="$(psql_ postgres -v m="$manifest" <<<"SELECT (:'m'::jsonb->'dump'->>'bytes') || ' ' || (:'m'::jsonb->'dump'->>'sha256');")"
  got="$(stat -c %s "$set_dir/$DUMP_NAME") $(sha256sum "$set_dir/$DUMP_NAME" | cut -d' ' -f1)"
  if [ "$want" = "$got" ]; then check fetched 1 "${got%% *} bytes, SHA-256 equals the manifest's"
  else check fetched 0 "the dump (${got%% *} bytes) does not equal its manifest (${want%% *} bytes, or its SHA-256)"; stop_failed; fi

  # restored: the operator procedure's pg_restore --clean, in 1 transaction, so a failure leaves the database as it was.
  t0="$(date +%s)"
  rc=0
  docker exec -i "$DB" pg_restore -U "$BW_DB_USER" -d "$BW_DB_NAME" --clean --if-exists --single-transaction --exit-on-error \
    <"$set_dir/$DUMP_NAME" >"$WORK/restore.err" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then check restored 1 "pg_restore --clean into $BW_DB_NAME in $(($(date +%s) - t0)) s"
  else check restored 0 "pg_restore exited $rc: $(head -c 300 "$WORK/restore.err" | tr '\n' ' ')"; stop_failed; fi
fi

# compare: every table both ways.
# F-1686: a psql error is a failed compare (restore-test.sh's cmp_rc), never a bare exit 3 with no failed event.
cmp_rc=0
diffs="$({ cat "$BW_LIB_DIR/checksums.sql" "$here/compare.sql"; } | psql_ "$BW_DB_NAME" -v m="$manifest" 2>"$WORK/compare.err")" || cmp_rc=$?
if [ "$cmp_rc" -ne 0 ]; then check compare 0 "the compare stopped (psql exit $cmp_rc): $(sed -n 's/^.*ERROR: *//p' "$WORK/compare.err" | head -n 1 | head -c 300)"; stop_failed; fi
ntables="$(sed -n 's/^#tables //p' <<<"$diffs")"
mismatches="$(grep -v '^#' <<<"$diffs" || true)"
totals="$(psql_ postgres -v m="$manifest" <<<"SELECT count(*) || ' tables, ' || coalesce(sum((v->>'rows')::bigint), 0) || ' rows' FROM jsonb_each(:'m'::jsonb->'tables') e(k, v);")"
if [ -z "$mismatches" ] && [ "${ntables:-0}" -gt 0 ]; then check compare 1 "$totals: every row count and checksum equals the manifest (checksum method $method)"
else
  while IFS= read -r line; do [ -z "$line" ] || log mismatch "$line"; done <<<"$mismatches"
  check compare 0 "$(grep -c . <<<"$mismatches" || true) of ${ntables:-0} manifest tables differ (each logged as mismatch)"
fi

# import: the FR-IMP-6 counts.
imp_bad=0 imp_n=0
while IFS='|' read -r item target n; do
  [ -n "$item" ] || continue
  imp_n=$((imp_n + 1))
  if [ "$target" != "$n" ]; then imp_bad=$((imp_bad + 1)); log mismatch "import: $item: target $target, restored $n"; fi
done < <(psql_ "$BW_DB_NAME" <"$BW_LIB_DIR/import-check.sql")
if [ "$imp_bad" = 0 ] && [ "$imp_n" -gt 0 ]; then check import 1 "$imp_n FR-IMP-6 counts equal their targets"
else check import 0 "$imp_bad of $imp_n FR-IMP-6 counts differ from their targets (each logged as mismatch)"; fi

[ "${#FAILED[@]}" -eq 0 ] || stop_failed
log passed "restore drill check of $set_dir passed: $totals"
exit 0
