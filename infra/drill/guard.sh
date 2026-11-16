#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P8-RESTORE-DRILL: the drill's only door to AWS and ssh. restore-drill.sh copies this file into <state>/bin with 1 small wrapper per
# tool name (aws, ssh, bw-drill-smoke; in a dry run also curl, docker and launchctl) and puts <state>/bin first on PATH, so every call
# the drill makes, temp-server.sh's and the delete backstop's included, passes here first.
#   aws   allowed: reads (sts get-caller-identity; lightsail get-*) and writes only on the drill's own copies (names bw-load-p4-<date>-
#         <plan>-drill1 or -drill2, key pairs <name>-key; create-instances only with the tag purpose restore-drill). Profile brightwater and
#         Region us-east-1 are required. No S3 call at all: this Mac's profile cannot list the Lightsail bucket (owner answer 1921a7c5).
#         Anything else is refused with exit 97 before any call: the hosted server can be read, never written.
#   ssh   allowed: to admin@<the address in copy1/ip or copy2/ip of the state folder>; and to the hosted server (bin/hosted-host,
#         deploy.sh's target) for 1 exact argument list only: deploy.sh's options plus -n, then bin/hosted-list-cmd, the READ-ONLY bucket
#         listing (aws s3api list-objects-v2 by the server's own resource access, as its backup job reaches the bucket; owner answer
#         1921a7c5). The destination is read as ssh reads it (the first non-option word), and only the options the callers pass are
#         allowed (F-1692, at ssh_tool). Anything else is refused with exit 97. The hosted target is written as <hosted> in every log
#         line, never its address.
#   bw-drill-smoke  the smoke sign-in, ci/smoke/smoke.mjs from the harness folder (BW_DRILL_HARNESS)
# Mode (bin/mode): run makes the call; dry prints it (DRY-RUN ...) and answers from canned Lightsail state (<state>/dry) and the fixture
# scripts of infra/drill/dry-run (<step>.sh, by the BW_DRILL_STEP the driver sets), so a dry run makes no AWS call and no ssh at all.
# Every call goes into <state>/calls.log, any IPv4 address replaced by <address> and the hosted target by <hosted>. Nothing here prints
# a credential. create-key-pair's key goes to its caller's stdout only, no argument the drill passes holds one, and the bucket listing
# authenticates on the server by its own resource access (no key leaves it, none is passed).
set -euo pipefail
bin="$(cd "$(dirname "$0")" && pwd)"
tool="${1:?tool}"
shift
mode="$(cat "$bin/mode")"
calls="$bin/../calls.log"
hosted_host="$(cat "$bin/hosted-host" 2>/dev/null || true)"
# Any IPv4 address becomes <address>, and the hosted ssh target (an address or a name) <hosted>.
scrub() {
  if [ -n "$hosted_host" ]; then awk -v h="$hosted_host" '{ while ((i = index($0, h)) > 0) $0 = substr($0, 1, i - 1) "<hosted>" substr($0, i + length(h)); print }'
  else cat; fi | sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<address>/g'
}
note() { printf '%s %s %s\n' "$(date -u +%H:%M:%SZ)" "$mode" "$*" | scrub >>"$calls"; }
refuse() {
  note "REFUSED $tool $*"
  echo "drill-guard: refused: $tool $(printf '%s ' "$@" | scrub)" >&2
  exit 97
}
dry_say() { printf 'DRY-RUN %s\n' "$*" | scrub | cut -c1-240 >&2; }
inst_re='^bw-load-p4-[0-9]{8}-[a-z0-9]+-drill[12]$'
key_re='^bw-load-p4-[0-9]{8}-[a-z0-9]+-drill[12]-key$'

# fixture <step>: in a dry run, the canned answer of that step (its stdout and exit code), or nothing and 0.
fixture() {
  local dir step="${BW_DRILL_STEP:-}"
  dir="$(cat "$bin/fixtures")"
  for f in "$dir/$step.sh" "$dir/${step%[0-9]}.sh"; do
    if [ -n "$step" ] && [ -f "$f" ]; then bash "$f"; return; fi
  done
  return 0
}

# healthz: a dry run's answer to a healthz curl (-w): healthz 200, or in step healthz2 the n-th line of the fixtures' healthz2.txt if
# there is one (an HTTP code per line; the last line answers every later call), so a test plants a proxy that answers 502 first.
healthz() {
  local d="$bin/../dry" fx n code
  fx="$(cat "$bin/fixtures")/healthz2.txt"
  if [ "${BW_DRILL_STEP:-}" != healthz2 ] || [ ! -f "$fx" ]; then echo 'healthz 200'; return; fi
  n=$(($(cat "$d/healthz-calls" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$d/healthz-calls"
  code="$(sed -n "${n}p" "$fx")"
  [ -n "$code" ] || code="$(sed '/^$/d' "$fx" | tail -1)"
  echo "healthz $code"
}

# F-1681: the guard reads the arguments the way the AWS CLI acts on them, or refuses them. The CLI takes the LAST of a repeated
# option and also reads --opt=value, so a repeated option, an --opt=value word, a short option, a lone - or --, and a word holding a
# newline are refused outright (none of the drill's calls uses one). Before <service> <operation> only the 1-value global options
# --profile, --region, --query and --output may come; after it, every --option takes the words up to the next option as its values
# (those 4 take exactly 1), and any other bare word is refused. A write names only the options its drill call uses (no
# --cli-input-json or the like can name another resource), and the purpose tag is matched only as a value of --tags.
aws_tool() {
  local svc="" op="" query="" i=0 cur=-1 x
  local -a a=("$@") onames=() ovals=() ocount=()
  # idx <option>: its place in onames, or exit 1 when it was not given.
  idx() { local j; for ((j = 0; j < ${#onames[@]}; j++)); do [ "${onames[j]}" = "$1" ] && { echo "$j"; return 0; }; done; return 1; }
  # val <option>: its value when it was given exactly 1, else nothing.
  val() { local j; j="$(idx "$1")" || return 0; if [ "${ocount[j]}" = 1 ]; then printf '%s' "${ovals[j]}"; fi; }
  # vals <option>: each of its values, 1 per line.
  vals() { local j; j="$(idx "$1")" || return 0; if [ "${ocount[j]}" -gt 0 ]; then printf '%s\n' "${ovals[j]}"; fi; }
  # only <option>...: every option given is a global one or 1 of these.
  only() { local o; for o in "${onames[@]}"; do case " --profile --region --query --output $* " in *" $o "*) ;; *) return 1 ;; esac; done; }
  for x in "${a[@]}"; do case "$x" in *$'\n'*) refuse "$@" ;; esac; done
  while [ "$i" -lt "${#a[@]}" ]; do
    x="${a[i]}"
    case "$x" in
      --*=* | --) refuse "$@" ;;
      --?*)
        if idx "$x" >/dev/null; then refuse "$@"; fi
        if [ -z "$op" ]; then case "$x" in --profile | --region | --query | --output) ;; *) refuse "$@" ;; esac; fi
        onames+=("$x"); ovals+=(""); ocount+=(0); cur=$((${#onames[@]} - 1)) ;;
      -*) refuse "$@" ;;
      *)
        if [ "$cur" -ge 0 ]; then
          if [ "${ocount[cur]}" -gt 0 ]; then ovals[cur]+=$'\n'; fi
          ovals[cur]+="$x"; ocount[cur]=$((ocount[cur] + 1))
          case "${onames[cur]}" in --profile | --region | --query | --output) cur=-1 ;; esac
        elif [ -z "$svc" ]; then svc="$x"
        elif [ -z "$op" ]; then op="$x"
        else refuse "$@"; fi ;;
    esac
    i=$((i + 1))
  done
  [ "$(val --profile)" = brightwater ] && [ "$(val --region)" = us-east-1 ] || refuse "$@"
  query="$(val --query)"
  local write=0
  case "$svc $op" in
    "sts get-caller-identity") ;;
    "lightsail get-instances" | "lightsail get-instance" | "lightsail get-instance-state" | "lightsail get-instance-port-states" | \
      "lightsail get-key-pairs" | "lightsail get-instance-metric-data") ;;
    "lightsail create-key-pair") only --key-pair-name --tags && [[ "$(val --key-pair-name)" =~ $key_re ]] || refuse "$@"; write=1 ;;
    "lightsail create-instances")
      # The purpose tag: exactly 1 value of --tags names purpose, and it is the drill's.
      if ! only --instance-names --availability-zone --blueprint-id --bundle-id --key-pair-name --tags ||
        ! [[ "$(val --instance-names)" =~ $inst_re ]] || [ "$(vals --tags | grep -c purpose)" != 1 ] ||
        [ "$(vals --tags | grep purpose)" != key=purpose,value=restore-drill ]; then refuse "$@"; fi
      write=1 ;;
    "lightsail put-instance-public-ports") only --instance-name --port-infos && [[ "$(val --instance-name)" =~ $inst_re ]] || refuse "$@"; write=1 ;;
    "lightsail delete-instance") only --instance-name && [[ "$(val --instance-name)" =~ $inst_re ]] || refuse "$@"; write=1 ;;
    "lightsail delete-key-pair") only --key-pair-name && [[ "$(val --key-pair-name)" =~ $key_re ]] || refuse "$@"; write=1 ;;
    *) refuse "$@" ;;
  esac
  note "aws${write:+ }$([ "$write" = 1 ] && echo WRITE || echo read) $svc $op $(printf '%s ' "$@")"
  if [ "$mode" = run ]; then exec "$(cat "$bin/real-aws")" "$@"; fi

  # The dry run's Lightsail: <state>/dry/instances (name, bundle, state, address per line) and <state>/dry/keys.
  dry_say "aws $*"
  local d="$bin/../dry" n
  case "$op" in
    get-caller-identity) echo 'arn:aws:iam::000000000000:user/dry-run' ;;
    get-instances)
      case "$query" in
        *publicIpAddress*) cat "$d/instances" ;;
        *bundleId*) cut -f1-3 "$d/instances" ;;
        *) cut -f1 "$d/instances" | paste -sd '\t' - ;;
      esac ;;
    get-key-pairs) paste -sd '\t' "$d/keys" ;;
    get-instance) n="$(val --instance-name)"; awk -F'\t' -v n="$n" '$1 == n { print $4 }' "$d/instances" ;;
    get-instance-state) echo running ;;
    get-instance-port-states) printf '22\topen\t198.51.100.7/32\n443\topen\t198.51.100.7/32\n' ;;
    get-instance-metric-data) ;;
    create-key-pair)
      val --key-pair-name >>"$d/keys"; echo >>"$d/keys"
      printf '%s\n' "-----BEGIN DRY-RUN KEY-----" "not a key" "-----END DRY-RUN KEY-----" ;;
    create-instances)
      n="$(val --instance-names)"
      case "$n" in *-drill1) ip=192.0.2.1 ;; *) ip=192.0.2.2 ;; esac
      printf '%s\tsmall_3_0\trunning\t%s\n' "$n" "$ip" >>"$d/instances"
      echo '{"operations": []}' ;;
    put-instance-public-ports) echo '{"operation": {}}' ;;
    delete-instance)
      n="$(val --instance-name)"
      awk -F'\t' -v n="$n" '$1 != n' "$d/instances" >"$d/instances.new" && mv "$d/instances.new" "$d/instances"
      echo '{"operations": []}' ;;
    delete-key-pair)
      n="$(val --key-pair-name)"
      grep -vxF "$n" "$d/keys" >"$d/keys.new" || true
      mv "$d/keys.new" "$d/keys"
      echo '{"operation": {}}' ;;
  esac
}

# F-1695: ssh -G prints the user and host ssh would really use (the config files, a Host block included) without connecting. A real run
# refuses a call whose resolved user or host is not the one in the words the guard checked, so a Host block cannot move a drill call.
resolved_ok() {
  [ "$mode" = run ] || return 0
  local want_user="$1" want_host="$2" out u h
  shift 2
  out="$("$(cat "$bin/real-ssh")" -G "$@" 2>/dev/null </dev/null)" || refuse "$@"
  u="$(printf '%s\n' "$out" | awk '$1 == "user" { print $2; exit }')"
  h="$(printf '%s\n' "$out" | awk '$1 == "hostname" { print tolower($2); exit }')"
  [ "$u" = "$want_user" ] && [ "$h" = "$(printf '%s' "$want_host" | tr '[:upper:]' '[:lower:]')" ] || refuse "$@"
}

# hosted_list: the hosted server's READ-ONLY bucket listing, only as the exact argument list of the drill (anything else exit 97).
# Dry run: bucket-<n>.txt of the fixtures for the n-th listing if there is one (a test plants a change that way), else bucket.txt.
hosted_list() {
  local -a want=(-n -i "$(cat "$bin/hosted-key")" -o BatchMode=yes -o ConnectTimeout=15 "$hosted_host" "$(cat "$bin/hosted-list-cmd")")
  [ "$#" -eq "${#want[@]}" ] || refuse "$@"
  local j
  local -a got=("$@")
  for ((j = 0; j < ${#want[@]}; j++)); do [ "${want[j]}" = "${got[j]}" ] || refuse "$@"; done
  resolved_ok "${hosted_host%@*}" "${hosted_host#*@}" "$@"
  note "ssh hosted READ-ONLY $(cat "$bin/hosted-list-cmd")"
  if [ "$mode" = run ]; then exec "$(cat "$bin/real-ssh")" "$@" </dev/null; fi
  dry_say "ssh hosted READ-ONLY: $(cat "$bin/hosted-list-cmd")"
  local d="$bin/../dry" n fx
  n=$(($(cat "$d/bucket-calls" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$d/bucket-calls"
  fx="$(cat "$bin/fixtures")"
  if [ -f "$fx/bucket-$n.txt" ]; then cat "$fx/bucket-$n.txt"; else cat "$fx/bucket.txt"; fi
}

# F-1692: the guard reads the arguments the way OpenSSH does, or refuses them. ssh reads options (getopt, letters combinable, a
# value-taking letter takes the rest of its word or the next word), then its destination (the first non-option word), then options
# again, and the first non-option word after those starts the remote command (the rest of the words, joined by spaces). Only the
# options the drill's callers pass are allowed in either run: -n, -i <key file>, and -o <key>=<value> for the keys BatchMode,
# ConnectTimeout, UserKnownHostsFile, StrictHostKeyChecking and ServerAliveInterval (deploy.sh's options, which the hosted listing
# reuses, and temp-server.sh's). Every other option is refused, so no -l, -J, -F, -W, -p or -o Hostname/User/ProxyJump/ProxyCommand
# can move the call; so are --, a lone -, a missing value and a newline in an option or the destination. The destination must be the
# hosted target (then hosted_list checks the whole argument list) or admin@<the address in copy1/ip or copy2/ip>, exactly: any other
# word, another spelling of the hosted server or an ssh:// URI included, is refused.
ssh_tool() {
  local i=0 j x c dest="" label="" key
  local -a a=("$@") cmd=()
  while [ "$i" -lt "${#a[@]}" ]; do
    x="${a[i]}"
    case "$x" in *$'\n'*) refuse "$@" ;; esac
    case "$x" in
      - | --*) refuse "$@" ;;
      -?*)
        j=1
        while [ "$j" -lt "${#x}" ]; do
          c="${x:j:1}"
          case "$c" in
            n) j=$((j + 1)) ;;
            i | o)
              if [ "$((j + 1))" -lt "${#x}" ]; then key="${x:j+1}"; else i=$((i + 1)); [ "$i" -lt "${#a[@]}" ] || refuse "$@"; key="${a[i]}"; fi
              case "$key" in *$'\n'*) refuse "$@" ;; esac
              if [ "$c" = o ]; then
                key="${key#"${key%%[![:space:]]*}"}"; key="${key%%[=[:space:]]*}"
                case "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" in
                  batchmode | connecttimeout | userknownhostsfile | stricthostkeychecking | serveraliveinterval) ;;
                  *) refuse "$@" ;;
                esac
              fi
              j="${#x}" ;;
            *) refuse "$@" ;;
          esac
        done ;;
      *)
        if [ -z "$dest" ]; then dest="$x"; else cmd=("${a[@]:i}"); break; fi ;;
    esac
    i=$((i + 1))
  done
  [ -n "$dest" ] || refuse "$@"
  if [ -n "$hosted_host" ] && [ "$dest" = "$hosted_host" ]; then hosted_list "$@"; return; fi
  for n in 1 2; do
    if [ -s "$bin/../copy$n/ip" ] && [ "$dest" = "admin@$(cat "$bin/../copy$n/ip")" ]; then label="copy$n"; fi
  done
  [ -n "$label" ] || refuse "$@"
  resolved_ok "${dest%@*}" "${dest#*@}" "$@"
  note "ssh $label $(printf '%s' "${cmd[*]}" | tr '\n' ' ' | cut -c1-300)"
  if [ "$mode" = run ]; then exec "$(cat "$bin/real-ssh")" "$@"; fi
  dry_say "ssh $label: $(printf '%s' "${cmd[*]}" | tr '\n' ' ')"
  cat >/dev/null 2>&1 || true
  fixture
}

case "$tool" in
  aws) aws_tool "$@" ;;
  ssh) ssh_tool "$@" ;;
  bw-drill-smoke)
    note "smoke ${SMOKE_BASE:-}"
    if [ "$mode" = run ]; then exec node "${BW_DRILL_HARNESS:?}/smoke.mjs"; fi
    dry_say "smoke sign-in at ${SMOKE_BASE:-}"
    fixture ;;
  curl)
    note "curl $*"
    dry_say "curl $*"
    case " $* " in *" -w "*) healthz ;; *) echo 198.51.100.7 ;; esac ;;
  docker)
    note "docker $*"
    dry_say "docker $*"
    case "${1:-}" in save) echo dry-run-image ;; esac ;;
  launchctl) note "launchctl $*"; dry_say "launchctl $*" ;;
  *) echo "drill-guard: unknown tool $tool" >&2; exit 2 ;;
esac
