#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Must-fail checks for device-session.sh (F-1380, F-1403, F-1357). Uses a fake capture dir and a fake capture process; never touches a phone.
#   F-1380: a stop refused for a missing required mark leaves the capture running (capture.pid kept, no stop mark); a retry after the mark exits 0.
#   F-1403: a missing STEP mark (a required mark with alternatives) is refused too, and either alternative ("step 1 fail") satisfies "step 1 pass|step 1 fail".
#   F-1357: the argument contract fails closed: an unquoted mark (extra words) and a stop with no required mark are refused and write nothing.
#   bash apps/tech-native/release/device-session.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ds="$here/device-session.sh"
root="$(mktemp -d)"
fake=""
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$root"' EXIT
fails=0
fail() { echo "FAIL: $1"; fails=$((fails + 1)); }

# A fresh evidence dir with a running fake capture, a device.log line of the app and the given marks (words only, 1 per line).
fixture() {
  ev="$root/ev$1"
  mkdir -p "$ev"
  sleep 60 >/dev/null 2>&1 &
  fake=$!
  echo "$fake" >"$ev/capture.pid"
  echo "RightOnTime test line" >"$ev/device.log"
  echo "2026-01-01T00:00:00.000Z start" >"$ev/marks.txt"
  shift
  local n=1 w
  for w in "$@"; do
    echo "2026-01-01T00:00:0$n.000Z $w" >>"$ev/marks.txt"
    n=$((n + 1))
  done
}
refused_intact() { # <case> : the refused stop left the session as it was
  [ -f "$ev/capture.pid" ] || fail "$1: refused stop deleted capture.pid"
  kill -0 "$fake" 2>/dev/null || fail "$1: refused stop ended the capture"
  ! grep -q ' stop$' "$ev/marks.txt" || fail "$1: refused stop wrote the stop mark"
}

# 1. A missing single-word mark (done) is refused by name; a retry after adding it exits 0.
fixture 1 "step 1 pass"
bash "$ds" stop "$ev" "step 1 pass|step 1 fail" "done" 2>"$ev/err"; rc=$?
[ "$rc" -ne 0 ] || fail "missing done: stop exited 0"
grep -q "no 'done' mark" "$ev/err" || fail "missing done: refusal does not name the mark"
refused_intact "missing done"
echo "2026-01-01T00:00:09.000Z done" >>"$ev/marks.txt"
bash "$ds" stop "$ev" "step 1 pass|step 1 fail" "done" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] || fail "missing done: retry exited $rc"
[ ! -f "$ev/capture.pid" ] || fail "missing done: capture.pid kept after the good stop"
grep -q ' stop$' "$ev/marks.txt" || fail "missing done: no stop mark after the good stop"
echo "ok: 1 missing done refused, capture intact, retry exit 0"

# 2. A missing step mark (both alternatives absent) is refused by its full alternative list.
fixture 2 "step 1 pass" "done"
bash "$ds" stop "$ev" "step 1 pass|step 1 fail" "step 2 pass|step 2 fail" "done" 2>"$ev/err"; rc=$?
[ "$rc" -ne 0 ] || fail "missing step 2: stop exited 0"
grep -q "no 'step 2 pass|step 2 fail' mark" "$ev/err" || fail "missing step 2: refusal does not name the step"
refused_intact "missing step 2"
echo "ok: 2 missing step mark refused, capture intact"

# 3. The other alternative satisfies the requirement ("step 1 fail" for "step 1 pass|step 1 fail"); so does the first.
fixture 3 "step 1 fail" "step 2 pass" "done"
bash "$ds" stop "$ev" "step 1 pass|step 1 fail" "step 2 pass|step 2 fail" "done" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] || fail "alternative 'step 1 fail': stop exited $rc"
echo "ok: 3 either alternative satisfies the requirement (exit 0)"

# 4. A fail-then-pass step (both marks present) also counts.
fixture 4 "step 1 fail" "step 1 pass" "done"
bash "$ds" stop "$ev" "step 1 pass|step 1 fail" "done" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] || fail "fail then pass: stop exited $rc"
echo "ok: 4 fail then pass exit 0"

# 5. F-1357: an unquoted mark (extra words) is refused, writes no mark and creates no folder named by a word.
fixture 5
here_cwd="$root/cwd"
mkdir -p "$here_cwd"
(cd "$here_cwd" && bash "$ds" mark step 1 pass "$ev" >"$ev/out" 2>"$ev/err"); rc=$?
[ "$rc" -eq 2 ] || fail "unquoted mark: exit $rc, want 2"
grep -q 'quoted' "$ev/err" || fail "unquoted mark: usage does not name the quoting"
[ "$(wc -l <"$ev/marks.txt" | tr -d ' ')" -eq 1 ] || fail "unquoted mark: a mark line was written"
[ -z "$(ls -A "$here_cwd")" ] || fail "unquoted mark: wrote a folder in the cwd: $(ls "$here_cwd")"
bash "$ds" mark "step 1 pass" "$ev" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] || fail "quoted mark: exit $rc"
grep -q ' step 1 pass$' "$ev/marks.txt" || fail "quoted mark: the line 'step 1 pass' is not in marks.txt"
echo "ok: 5 unquoted mark refused (exit 2, nothing written), quoted mark written whole"

# 6. F-1357: a stop with no required mark is refused (exit 2), capture intact.
fixture 6 "step 1 pass" "done"
bash "$ds" stop "$ev" 2>"$ev/err"; rc=$?
[ "$rc" -eq 2 ] || fail "stop with no list: exit $rc, want 2"
grep -q 'required mark' "$ev/err" || fail "stop with no list: refusal does not name the missing list"
refused_intact "stop with no list"
echo "ok: 6 stop with no required mark refused (exit 2), capture intact"

[ "$fails" -eq 0 ] || { echo "device-session.test: $fails failure(s)"; exit 1; }
echo "device-session.test: all cases passed"
