#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# P6-TESTFLIGHT-4: fills the owner's session page template with the staging values, the password among them, and renders it as one HTML
# page for the owner's browser. The owner asked for 1 document with the instructions and the values they use (Nov 8-9), so the password
# is ON the page; it is merged here, by the shell, from a mode 600 file, so it never reaches an agent's context, stdout or the repo.
#   BW_STAGING_DIR=<state folder> bash apps/tech-native/release/render-session.sh <template.md> <name> [--password-file <file>] [--no-open] KEY=VALUE...
# Tokens in the template are {{KEY}}. {{PASSWORD}} comes from the password file (default $BW_STAGING_DIR/maria-password.txt, which
# infra/deploy/staging.sh world writes); every other token comes from a KEY=VALUE argument. Writes <state folder>/<name>.md and
# <state folder>/<name>.html (mode 600) and prints only the html path. Exit 0 rendered; 1 refused (a token left unfilled, an unknown
# KEY, a missing file, the renderer failed; the message names tokens, never values); 2 usage or a state folder inside the repo.
# BW_MD2HTML overrides the renderer (default: the jl-md-viewer skill's md2html.py); --no-open renders without opening a browser.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd -P)"

usage() { echo "render-session: usage: BW_STAGING_DIR=<dir> render-session.sh <template.md> <name> [--password-file <file>] [--no-open] KEY=VALUE..." >&2; exit 2; }
[ "$#" -ge 2 ] || usage
template="$1"; name="$2"; shift 2
case "$name" in */* | "" | .*) echo "render-session: refused: the name must be a plain word" >&2; exit 2 ;; esac
dir="${BW_STAGING_DIR:?set BW_STAGING_DIR to a state folder outside the repo}"
pwfile=""; open=1; pairs=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --password-file) [ "$#" -ge 2 ] || usage; pwfile="$2"; shift 2 ;;
    --no-open) open=0; shift ;;
    *=*) pairs+=("$1"); shift ;;
    *) usage ;;
  esac
done

# The state folder is resolved first (as staging.sh does) and refused when it is inside the repo; nothing is written before that.
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
  echo "render-session: refused: the state folder is inside the repo ($root) or a git work tree" >&2; exit 2
fi
dir="$real"
chmod 700 "$dir"
[ -n "$pwfile" ] || pwfile="$dir/maria-password.txt"
[ -r "$template" ] || { echo "render-session: refused: no template at $template" >&2; exit 1; }
[ -s "$pwfile" ] || { echo "render-session: refused: no password file at $pwfile" >&2; exit 1; }
md2html="${BW_MD2HTML:-$HOME/.claude/skills/jl-md-viewer/scripts/md2html.py}"
[ -r "$md2html" ] || { echo "render-session: refused: no renderer at $md2html" >&2; exit 1; }

umask 077
merged="$dir/$name.md"
html="$dir/$name.html"
rm -f "$merged" "$html"
# One pass over the template: a value is never searched for tokens, so a value cannot add one. The password is read from the file here
# and goes only into the merged file. Unfilled tokens and unknown KEYs name the token, never a value.
python3 -I -c '
import re, sys
template, pwfile, out = sys.argv[1:4]
vals = {}
for p in sys.argv[4:]:
    k, v = p.split("=", 1)
    vals[k] = v
vals["PASSWORD"] = open(pwfile, encoding="utf-8").read().strip()
text = open(template, encoding="utf-8").read()
tokens = set(re.findall(r"\{\{([A-Z0-9_]+)\}\}", text))
missing = sorted(tokens - vals.keys())
unknown = sorted(vals.keys() - tokens)
if missing or unknown:
    if missing: sys.stderr.write("render-session: refused: tokens left unfilled: " + ", ".join(missing) + "\n")
    if unknown: sys.stderr.write("render-session: refused: no such token in the template: " + ", ".join(unknown) + "\n")
    sys.exit(1)
fd = open(out, "w", encoding="utf-8")
fd.write(re.sub(r"\{\{([A-Z0-9_]+)\}\}", lambda m: vals[m.group(1)], text))
fd.close()
' "$template" "$pwfile" "$merged" "${pairs[@]+"${pairs[@]}"}"

flags=()
[ "$open" -eq 1 ] || flags+=(--no-open)
python3 -I "$md2html" "$merged" -o "$html" --quiet "${flags[@]+"${flags[@]}"}" >/dev/null 2>&1 || { rm -f "$merged" "$html"; echo "render-session: refused: the renderer failed" >&2; exit 1; }
[ -s "$html" ] || { rm -f "$merged" "$html"; echo "render-session: refused: the renderer wrote no page" >&2; exit 1; }
chmod 600 "$merged" "$html"
echo "$html"
