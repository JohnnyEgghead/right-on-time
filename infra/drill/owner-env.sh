# SPDX-License-Identifier: AGPL-3.0-or-later
# F-1605: the owner's own values for the drills (the UptimeRobot monitor id, where the records and the evidence go) are not written in
# the public files. Each comes from the environment, else from the owner file, else a public default (or a refusal, for the monitor).
# The owner file is $BW_OWNER_ENV, default infra/owner.env: a private file (scripts/private-paths.txt leaves it out of the public
# repo), so a public copy has none and is given its own values in the environment.
# Owner file lines: KEY=VALUE with KEY starting BW_ (capitals, digits, _); # comments and blank lines skipped; no quotes, no expansion.
# A variable already set in the environment wins over the file. Nothing is printed.
#   . infra/drill/owner-env.sh; bw_owner_env <repo root>
#   bw_need_host <repo root>             sets BW_HOST (user@address of the hosted server) or refuses with a message
#   bw_root_path <repo root> <path>      prints <path>, under the repo root when it is relative
bw_owner_env() {
  local f line k v
  # F-1609: infra/owner.local.env (ignored by git, mode 600) holds the hosted server's address, BW_HOST, so no committed file does.
  for f in "${BW_OWNER_ENV:-$1/infra/owner.env}" "${BW_OWNER_ENV_LOCAL:-$1/infra/owner.local.env}"; do
    [ -f "$f" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}" # F-1686: a CRLF file's carriage return is not part of the value (owner-env.cjs strips it too)
      case "$line" in '' | '#'*) continue ;; esac
      case "$line" in *=*) ;; *) continue ;; esac # a line without = is skipped, as owner-env.cjs skips it
      k="${line%%=*}"
      v="${line#*=}"
      [[ "$k" =~ ^BW_[A-Z0-9_]+$ ]] || continue
      [ -n "${!k+x}" ] || export "$k=$v"
    done <"$f"
  done
}
# F-1609: the hosted server, as user@address. From BW_HOST in the environment or the owner's private files; else a clear refusal (exit status 1).
bw_need_host() {
  bw_owner_env "$1"
  [ -n "${BW_HOST:-}" ] && return 0
  echo "BW_HOST is not set. Set BW_HOST=user@server-address in the environment, or put that line in the owner's private file infra/owner.local.env (ignored by git, mode 600). The server address is never in a committed file." >&2
  return 1
}
bw_root_path() { case "$2" in /*) printf '%s' "$2" ;; *) printf '%s/%s' "$1" "$2" ;; esac; }
