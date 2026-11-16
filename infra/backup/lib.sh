# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash disable=SC2034 # sourced: its names are used by the scripts that source it
# P3-BACKUP: shared by backup.sh, restore-test.sh and retention.sh (SPECIFICATIONS section 11.7) and the backup
# target seam (section 4.8, SD-36). Sourced, never run. Linux host only (GNU coreutils and find, bash 4+): the
# hosted server runs these from systemd as root; the local proofs run them in a Debian 13 container
# (infra/backup/tests/runner.Dockerfile) with the host's Docker socket.
#
# Settings (environment; on the server systemd reads /opt/brightwater/.env, written by infra/deploy/deploy.sh):
#   BACKUP_TARGET      none (the own-copy default: the scripts do nothing) | lightsail | local (tests only)
#   BACKUP_BUCKET      lightsail: the bucket name (brightwater-backup-use1)
#   BACKUP_REGION      lightsail: the server's Region (us-east-1); a non-US Region is refused (NFR-10)
#   BACKUP_ENDPOINT_URL  lightsail, tests only: an S3-compatible endpoint instead of AWS
#   BACKUP_LOCAL_DIR   local: the folder that stands in for the bucket
#   BACKUP_PREFIX      the key prefix of the backup sets (default backups/)
#   BACKUP_KEEP_DAYS   retention (default 14, NFR-07)
#   BW_PROJECT         the Compose project whose db service is backed up (default brightwater)
#   BW_BACKUP_WORK     the host folder for dumps in flight (default /var/lib/brightwater-backup, root only)
#   BW_BACKUP_LOCK     the lock file that keeps backup, restore test and retention apart
#                      (default /run/lock/brightwater-backup.lock)
#   BW_BACKUP_LOCK_WAIT  seconds to wait for that lock before giving up (default 3600; the proofs set it short, F-492)
#
# Layout in the target: <prefix><stamp>/brightwater.dump and <prefix><stamp>/manifest.json, stamp =
# YYYYMMDDTHHMMSSZ (UTC, the backup's start). The manifest is uploaded last, so a set without one never
# finished. Retention judges a set's age by its stamp, the time it was taken.
#
# Nothing here prints a secret: the database is reached through "docker exec" on the db container's local
# socket (no password involved), and the lightsail target authenticates by the instance's resource access
# (no key on the server; section 4.8).

set -euo pipefail

BACKUP_TARGET="${BACKUP_TARGET:-none}"
BACKUP_PREFIX="${BACKUP_PREFIX:-backups/}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
BW_PROJECT="${BW_PROJECT:-brightwater}"
BW_BACKUP_WORK="${BW_BACKUP_WORK:-/var/lib/brightwater-backup}"
BW_BACKUP_LOCK="${BW_BACKUP_LOCK:-/run/lock/brightwater-backup.lock}"
BW_BACKUP_LOCK_WAIT="${BW_BACKUP_LOCK_WAIT:-3600}"
BW_DB_USER=brightwater
BW_DB_NAME=brightwater
DUMP_NAME=brightwater.dump
MANIFEST_NAME=manifest.json
BW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# log <event> [message]: 1 JSON line on stdout (the journal on the server). Events are fixed words; a message
# never carries a value from the environment.
log() {
  local event="$1" msg="${2:-}"
  msg="${msg//\\/\\\\}"; msg="${msg//\"/\\\"}"
  printf '{"at":"%s","process":"%s","event":"%s","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "${BW_PROCESS:-backup}" "$event" "$msg"
}
die() { log error "$1"; exit "${2:-1}"; }

# check_settings: refuse a target the scripts cannot use before anything is written.
check_settings() {
  case "$BACKUP_TARGET" in
    lightsail)
      [ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is not set" 2
      [ -n "${BACKUP_REGION:-}" ] || die "BACKUP_REGION is not set" 2
      # NFR-10: backups stay in the United States, and SD-36 uses only the server's Region.
      [[ "$BACKUP_REGION" =~ ^us-(east|west)-[0-9]+$ ]] || die "BACKUP_REGION $BACKUP_REGION is not a US Region (NFR-10)" 2
      [[ "$BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "BACKUP_BUCKET is not a bucket name" 2
      ;;
    local)
      [ -n "${BACKUP_LOCAL_DIR:-}" ] || die "BACKUP_LOCAL_DIR is not set" 2
      ;;
    none) ;;
    *) die "BACKUP_TARGET $BACKUP_TARGET is not none, lightsail or local" 2 ;;
  esac
  [[ "$BACKUP_PREFIX" =~ ^[a-z0-9][A-Za-z0-9/_-]*/$ ]] || die "BACKUP_PREFIX must be letters, digits, _ - and / ending in /" 2
  [[ "$BACKUP_KEEP_DAYS" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_KEEP_DAYS must be a whole number of days" 2
}

# ---- the backup target seam (section 4.8): put, get, list, remove -----------------------------------------
# target_put <name> <file>; target_get <name> <to>; target_list (name<TAB>at<TAB>bytes per object under the
# prefix, at = the store's modified time, ISO 8601 UTC); target_remove <name>. <name> is relative to the prefix.

aws_() {
  local args=(--region "$BACKUP_REGION")
  [ -z "${BACKUP_ENDPOINT_URL:-}" ] || args+=(--endpoint-url "$BACKUP_ENDPOINT_URL")
  aws "${args[@]}" "$@"
}

target_url() {
  case "$BACKUP_TARGET" in
    lightsail) printf 's3://%s/%s%s' "$BACKUP_BUCKET" "$BACKUP_PREFIX" "${1:-}" ;;
    local) printf 'file://%s/%s%s' "$BACKUP_LOCAL_DIR" "$BACKUP_PREFIX" "${1:-}" ;;
  esac
}

target_put() {
  case "$BACKUP_TARGET" in
    lightsail) aws_ s3 cp --only-show-errors "$2" "$(target_url "$1")" ;;
    local) mkdir -p "$(dirname "$BACKUP_LOCAL_DIR/$BACKUP_PREFIX$1")" && cp "$2" "$BACKUP_LOCAL_DIR/$BACKUP_PREFIX$1" ;;
  esac
}

target_get() {
  case "$BACKUP_TARGET" in
    lightsail) aws_ s3 cp --only-show-errors "$(target_url "$1")" "$2" ;;
    local) cp "$BACKUP_LOCAL_DIR/$BACKUP_PREFIX$1" "$2" ;;
  esac
}

target_list() {
  case "$BACKUP_TARGET" in
    lightsail)
      # The CLI pages through every result; an empty prefix prints "None".
      aws_ s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix "$BACKUP_PREFIX" \
        --query 'Contents[].[Key,LastModified,Size]' --output text \
        | awk -F'\t' -v p="$BACKUP_PREFIX" 'NF == 3 && index($1, p) == 1 { print substr($1, length(p) + 1) "\t" $2 "\t" $3 }'
      ;;
    local)
      [ -d "$BACKUP_LOCAL_DIR/$BACKUP_PREFIX" ] || return 0
      find "$BACKUP_LOCAL_DIR/$BACKUP_PREFIX" -type f -printf '%P\t%TY-%Tm-%TdT%TH:%TM:%.2TSZ\t%s\n'
      ;;
  esac
}

target_remove() {
  case "$BACKUP_TARGET" in
    lightsail) aws_ s3 rm --only-show-errors "$(target_url "$1")" ;;
    # An empty set folder goes too, as a bucket has no folders: a set is gone when its last object is.
    local) rm -f "$BACKUP_LOCAL_DIR/$BACKUP_PREFIX$1" && rmdir --ignore-fail-on-non-empty "$(dirname "$BACKUP_LOCAL_DIR/$BACKUP_PREFIX$1")" ;;
  esac
}

# sets: the stamps of the complete sets (dump and manifest both present), oldest first.
sets() {
  target_list | awk -F'\t' -v d="$DUMP_NAME" -v m="$MANIFEST_NAME" '
    { n = split($1, p, "/"); if (n != 2 || !is_stamp(p[1])) next; seen[p[1], p[2]] = 1; stamps[p[1]] = 1 }
    function is_stamp(s) { return length(s) == 16 && s ~ /^[0-9]+T[0-9]+Z$/ && substr(s, 9, 1) == "T" }
    END { for (s in stamps) if (seen[s, d] && seen[s, m]) print s }' | sort
}

# ---- the database: the Compose project's db container, through its local socket --------------------------
db_container() {
  local id
  id="$(docker ps -q --filter "label=com.docker.compose.project=$BW_PROJECT" --filter label=com.docker.compose.service=db | head -n 1)"
  # stderr, not stdout: DB="$(db_container)" would otherwise put the reason in the variable and leave the journal empty (F-390).
  [ -n "$id" ] || { log error "no running db container in Compose project $BW_PROJECT" >&2; exit 1; }
  printf '%s' "$id"
}

# psql_ <db> [psql args...]: a quiet, unaligned psql that stops at the first error.
psql_() {
  local db="$1"; shift
  docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$DB" psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$BW_DB_USER" -d "$db" "$@"
}

# lock: 1 backup job at a time on this host (backup, restore test, retention).
# F-492: backup.sh and restore-test.sh set their EXIT trap before this, so a lock wait that times out still runs their
# cleanup (a failed record). Only restore-test.sh sets LOCKED=1 after it, and drops shared things (restore_check) only then: without
# the lock, those belong to the job that holds it. backup.sh shares nothing, so it has no such flag (F-1774).
take_lock() {
  [[ "$BW_BACKUP_LOCK_WAIT" =~ ^[0-9]+$ ]] || die "BW_BACKUP_LOCK_WAIT must be a whole number of seconds" 2
  mkdir -p "$(dirname "$BW_BACKUP_LOCK")"
  exec 9>"$BW_BACKUP_LOCK"
  flock -w "$BW_BACKUP_LOCK_WAIT" 9 || die "another backup job held the lock for $BW_BACKUP_LOCK_WAIT seconds"
}

# F-1697: world_set_up returns 0 once setup has finished (a system.day_snapshot row, SD-12: the same mark SD-30's
# backup_failed rule counts from, F-434), 1 when it has not. So a timer that fires before setup (Persistent=true on a
# first deploy) backs up and restore-tests nothing. Call it as "if ! world_set_up; then ...", in the script's own shell.
# F-1771: a database that does not answer, a query that errors, or an answer that is not t or f is an error: it exits
# the script (die, so the caller's EXIT trap writes its failed record), never returns 1. Each query is checked by its
# own status, as errexit is off inside an if condition and inside a command substitution; and a call from a subshell
# (DB="$(...)"-style) is refused, as its exit would end only the subshell.
world_set_up() {
  [ "$BASH_SUBSHELL" = 0 ] || die "world_set_up must run in the script's own shell, not a subshell"
  local q t
  for q in "SELECT to_regclass('system.day_snapshot') IS NOT NULL" "SELECT EXISTS (SELECT 1 FROM system.day_snapshot)"; do
    t="$(psql_ "$BW_DB_NAME" -c "$q")" || die "the database did not answer whether a world is set up"
    case "$t" in
      t) ;;
      f) return 1 ;;
      *) die "the database gave no t or f when asked whether a world is set up" ;;
    esac
  done
  return 0
}

new_workdir() {
  install -m 0700 -d "$BW_BACKUP_WORK"
  mktemp -d "$BW_BACKUP_WORK/$1.XXXXXX"
}

# keep_days_cutoff: the stamp exactly BACKUP_KEEP_DAYS days before now; a set with an earlier stamp is expired.
keep_days_cutoff() { date -u -d "-$BACKUP_KEEP_DAYS days" +%Y%m%dT%H%M%SZ; }
