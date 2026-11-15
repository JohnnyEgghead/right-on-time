#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P3-BACKUP: 14-day retention (SPECIFICATIONS sections 4.8 and 11.7; NFR-07). backup.sh runs it after each
# upload; it can also run alone (the hosted check's planted-object arm):  sudo bash retention.sh
# Deletes every object of each set whose stamp (the time the backup was taken, UTC) is more than
# BACKUP_KEEP_DAYS days before now. It judges age by the stamp, not the store's modified time, so a set keeps
# its age wherever it is copied, and a planted set with an old stamp is judged like a real one. Objects outside
# the <stamp>/<file> layout are never deleted; they are counted and logged. Exit 1 if any delete fails.
set -euo pipefail
BW_PROCESS=retention
# shellcheck source=infra/backup/lib.sh
. "$(dirname "$0")/lib.sh"
check_settings
if [ "$BACKUP_TARGET" = none ]; then log not_set_up "BACKUP_TARGET is none: no retention"; exit 0; fi
[ "${BW_LOCK_HELD:-0}" = 1 ] || take_lock

cutoff="$(keep_days_cutoff)"
listing="$(target_list)"
deleted=0 kept=0 other=0 failed=0
declare -A kept_sets=()
while IFS=$'\t' read -r name _at _bytes; do
  [ -n "$name" ] || continue
  stamp="${name%%/*}"
  if [[ ! "$name" =~ ^[0-9]{8}T[0-9]{6}Z/[^/]+$ ]]; then other=$((other + 1)); continue; fi
  if [[ "$stamp" < "$cutoff" ]]; then
    if target_remove "$name"; then deleted=$((deleted + 1)); log deleted "$name (older than $BACKUP_KEEP_DAYS days)"
    else failed=$((failed + 1)); log error "could not delete $name"; fi
  else
    kept=$((kept + 1)); kept_sets[$stamp]=1
  fi
done <<<"$listing"
log retention "cutoff $cutoff: deleted $deleted objects, kept $kept objects in ${#kept_sets[@]} sets, $other objects outside the layout left alone"
[ "$failed" = 0 ] || exit 1
