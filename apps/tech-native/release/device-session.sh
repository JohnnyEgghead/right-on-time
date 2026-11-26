#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The Mac half of the TestFlight device session (P6-TESTFLIGHT): captures the iPhone's device log while the owner runs the steps in
# .build/owner/P6-TESTFLIGHT-SESSION.md. The owner holds the phone (cable in for the capture, Wi-Fi on); this script never touches the app.
#   bash apps/tech-native/release/device-session.sh start <device-udid> <evidence-dir>   names the device, starts the log capture
#   bash apps/tech-native/release/device-session.sh mark <word> <evidence-dir>           one line with the Mac's UTC time in marks.txt
#   bash apps/tech-native/release/device-session.sh terminate <device-udid> <evidence-dir>  F-1228: ends the app from the Mac like the system does (devicectl --kill), then marks app-ended
#   bash apps/tech-native/release/device-session.sh stop <evidence-dir> [<required-mark>...]  stops the capture it started, checks the evidence
#     F-1356: each session declares the marks it needs as arguments. A required mark is a mark word, or several alternatives joined by | (any one counts,
#     e.g. "step 1 pass|step 1 fail": the owner marked the step, whichever way). Build 3: stop <dir> backgrounded. Build 4: stop <dir> "step 1 pass|step 1 fail" ... "done".
#     F-1357: the argument contract fails closed at the call. start, mark and terminate take exactly 3 words; a mark word with spaces is ONE quoted
#     argument: mark "step 1 pass" <evidence-dir> (unquoted, the extra words are refused, never written into a folder named by the 2nd word). stop with
#     no required mark is refused (exit 2): a session declares what it needs.
# Find the UDID with: xcrun devicectl list devices
# The owner's phone, jPhone (iPhone 16 Pro): UDID 00008140-...801C. Owner cue words typed in the terminal map to marks: build number -> build, home -> backgrounded, wifi off -> wifi-off, end app -> the terminate subcommand (writes the app-ended mark only when the app was ended), open again -> open-again, wifi on -> wifi-on, done -> done (then stop).
# Evidence (all in <evidence-dir>): device.txt (name, model, iOS; no serial number), device.log (the syslog lines of the app, the upload
# daemon and the process manager), marks.txt. F-66: a capture that failed fails the session. start exits non-zero when no source names the
# device or the capture did not start; stop exits non-zero when device.log is empty, holds no line of the app, or marks.txt lacks a mark
# the session declared required (named in the failure). Nothing is skipped quietly.
set -euo pipefail
cmd="${1:-}"
# F-1357: an extra word (an unquoted mark, a stray argument) is refused before anything is written.
case "$cmd" in
  start | mark | terminate) [ "$#" -eq 3 ] || { echo "device-session: refused: $cmd takes exactly 3 words, got $#. A mark word with spaces is 1 quoted argument: mark \"step 1 pass\" <evidence-dir>" >&2; exit 2; } ;;
  stop) [ "$#" -ge 3 ] || { echo "device-session: refused: stop needs the evidence dir and at least 1 required mark (the session declares the marks it needs, F-1357): stop <evidence-dir> \"step 1 pass|step 1 fail\" ... done" >&2; exit 2; } ;;
esac
case "$cmd" in
  start) udid="${2:?usage: start <device-udid> <evidence-dir>}"; ev="${3:?usage: start <device-udid> <evidence-dir>}" ;;
  mark) word="${2:?usage: mark <word> <evidence-dir>}"; ev="${3:?usage: mark <word> <evidence-dir>}" ;;
  terminate) udid="${2:?usage: terminate <device-udid> <evidence-dir>}"; ev="${3:?usage: terminate <device-udid> <evidence-dir>}" ;;
  stop) ev="${2:?usage: stop <evidence-dir> [<required-mark>...]}"; shift 2; required=("$@") ;;
  *) echo "device-session: usage: start|mark|terminate|stop (see the file header)" >&2; exit 2 ;;
esac
mkdir -p "$ev"

utc() { date -u '+%Y-%m-%dT%H:%M:%S.000Z'; }

case "$cmd" in
  start)
    command -v idevicesyslog >/dev/null || { echo "device-session: FAIL idevicesyslog is not installed (brew install libimobiledevice)" >&2; exit 1; }
    json="$ev/devicectl-device.json"
    xcrun devicectl device info details --device "$udid" --json-output "$json" >/dev/null 2>"$ev/devicectl.err" \
      || { echo "device-session: FAIL devicectl does not name the device $udid (F-66); see $ev/devicectl.err" >&2; exit 1; }
    python3 -I - "$json" "$ev/device.txt" <<'PY' || { echo "device-session: FAIL devicectl output names no device (F-66)" >&2; exit 1; }
import json, sys
d = json.load(open(sys.argv[1]))["result"]
name = d.get("deviceProperties", {}).get("name") or d.get("name")
hw = d.get("hardwareProperties", {})
os_ = d.get("deviceProperties", {}).get("osVersionNumber")
if not name or not hw.get("marketingName") or not os_:
    sys.exit(1)
open(sys.argv[2], "w").write(f"device: {name}, {hw['marketingName']} ({hw.get('productType', '?')}), iOS {os_}\n")
print(open(sys.argv[2]).read().strip())
PY
    rm -f "$json"
    : >"$ev/marks.txt"
    echo "$(utc) start" >>"$ev/marks.txt"
    # The unified log lines worth keeping: the app, the upload daemon, and the process manager's state lines for the app.
    idevicesyslog -u "$udid" -p "RightOnTime|nsurlsessiond|runningboardd|backboardd" >"$ev/device.log" 2>"$ev/idevicesyslog.err" &
    echo $! >"$ev/capture.pid"
    sleep 3
    kill -0 "$(cat "$ev/capture.pid")" 2>/dev/null || { echo "device-session: FAIL the log capture stopped at once; see $ev/idevicesyslog.err" >&2; exit 1; }
    echo "device-session: capturing (pid $(cat "$ev/capture.pid")), $(date '+%b %-d, %-I:%M %p %Z')"
    ;;
  mark)
    echo "$(utc) $word" >>"$ev/marks.txt"
    echo "device-session: marked $word"
    ;;
  terminate)
    # A swipe-away in the app switcher is a user force quit: Apple cancels the app's background transfers, so the test would not run.
    # devicectl --kill ends the process like a system kill and leaves the transfers with iOS. Match: the process whose executable
    # ends in /RightOnTime.app/RightOnTime (the app binary, not its extensions). Exactly one must match.
    plist="$ev/devicectl-processes.json"
    xcrun devicectl device info processes --device "$udid" --json-output "$plist" >/dev/null 2>"$ev/devicectl.err" \
      || { echo "device-session: FAIL devicectl could not list processes on $udid; see $ev/devicectl.err" >&2; exit 1; }
    pids="$(python3 -I -c 'import json,sys
for p in json.load(open(sys.argv[1]))["result"]["runningProcesses"]:
    if p.get("executable", "").endswith("/RightOnTime.app/RightOnTime"): print(p["processIdentifier"])' "$plist")" \
      || { echo "device-session: FAIL could not read the process list" >&2; exit 1; }
    rm -f "$plist"
    n="$(printf '%s' "$pids" | grep -c . || true)"
    [ "$n" -eq 1 ] || { echo "device-session: FAIL $n processes match RightOnTime.app (need exactly 1); app not ended" >&2; exit 1; }
    xcrun devicectl device process terminate --device "$udid" --pid "$pids" --kill >/dev/null 2>"$ev/devicectl.err" \
      || { echo "device-session: FAIL devicectl refused to end pid $pids; see $ev/devicectl.err; app not ended" >&2; exit 1; }
    echo "$(utc) app-ended" >>"$ev/marks.txt"
    echo "device-session: ended the app (pid $pids), marked app-ended"
    ;;
  stop)
    [ -f "$ev/capture.pid" ] || { echo "device-session: FAIL no capture was started here (F-66)" >&2; exit 1; }
    pid="$(cat "$ev/capture.pid")"
    # F-1356: the session's own required marks. A mark line is "<UTC time> <word>"; compare the words whole.
    # F-1380: checked BEFORE the capture is ended, so a stop refused for a missing mark leaves the session intact and a retry works.
    words="$(sed 's/^[^ ]* //' "$ev/marks.txt")"
    missing=0
    for req in ${required[@]+"${required[@]}"}; do
      found=0
      IFS='|' read -r -a alts <<<"$req"
      for alt in "${alts[@]}"; do
        if [ -n "$alt" ] && grep -q -F -x -e "$alt" <<<"$words"; then found=1; fi
      done
      [ "$found" -eq 1 ] || { echo "device-session: FAIL marks.txt has no '$req' mark (F-1356); capture left running, add the mark and stop again" >&2; missing=1; }
    done
    [ "$missing" -eq 0 ] || exit 1
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    rm -f "$ev/capture.pid"
    echo "$(utc) stop" >>"$ev/marks.txt"
    lines="$(wc -l <"$ev/device.log" | tr -d ' ')"
    app="$(grep -c 'RightOnTime' "$ev/device.log" || true)"
    echo "device-session: device.log $lines lines, $app naming the app"
    fail=0
    [ "$lines" -gt 0 ] || { echo "device-session: FAIL device.log is empty (F-66)" >&2; fail=1; }
    [ "$app" -gt 0 ] || { echo "device-session: FAIL device.log holds no line of the app (F-66)" >&2; fail=1; }
    exit "$fail"
    ;;
esac
