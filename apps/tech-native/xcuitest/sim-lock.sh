# SPDX-License-Identifier: AGPL-3.0-or-later
# F-1386: this Mac's lock on 1 simulator, sourced by run.sh. Every lane on this Mac drives the same simulator (run.sh's default BW_SIM_UDID)
# with the same bundle ids, so a second run.sh started while one is testing uninstalls that run's app (its "simctl uninstall") and installs
# its own test runner over the running one: the first run's tests end in "Test crashed with signal kill" (native-suite red, Nov 10, 2026).
#   sim_lock_take <udid> <label>   waits for the lock on simulator <udid>, takes it, and writes <label> into the lock file (the holder's name)
#   sim_lock_drop                  lets the lock go before this shell exits (run.sh holds it to exit)
# The lock is BSD flock(2) on fd 9, the open file this shell keeps: it is held until this shell, and every child that kept fd 9, has exited,
# so a run that dies frees it and no stale lock is left to clean up. A child that outlives the run (a server) is started with 9>&-.
# Env: BW_SIM_LOCK (the lock file; default bw-sim-<udid>.lock in the user's temp folder, getconf DARWIN_USER_TEMP_DIR on macOS: the same
# folder for every lane whatever TMPDIR is set to), BW_SIM_LOCK_WAIT_S (the longest wait, default 3600 s: longer than any 1 class's test
# cap). Sets sim_lock (the file) and sim_lock_waited (the seconds waited). Returns 0 with the lock held, 75 when the wait ran out (the holder
# is named), 73 when the lock file cannot be opened, 2 for a udid that is not a simulator id.

# sim_lock_try <seconds>: flock fd 9, waiting at most <seconds> (0: no wait). perl, as run.sh uses it, so macOS and Linux run the same code.
sim_lock_try() {
  perl -MFcntl=:flock -e '
    open(my $fh, ">>&=", 9) or exit 73;
    my $end = time + $ARGV[0];
    until (flock($fh, LOCK_EX | LOCK_NB)) {
      exit 75 if time >= $end;
      select(undef, undef, undef, 0.2);
    }
    exit 0;
  ' "$1"
}

sim_lock_take() {
  local udid="$1" label="$2" wait_s="${BW_SIM_LOCK_WAIT_S:-3600}" dir t0 rc
  [[ "$udid" =~ ^[0-9A-Fa-f-]+$ ]] || { echo "run: FAIL '$udid' is not a simulator id (F-1386 lock)" >&2; return 2; }
  dir="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
  [ -n "$dir" ] || dir="${TMPDIR:-/tmp}"
  sim_lock="${BW_SIM_LOCK:-${dir%/}/bw-sim-$udid.lock}"
  exec 9>>"$sim_lock" || { echo "run: FAIL the simulator lock $sim_lock cannot be opened (F-1386)" >&2; return 73; }
  t0=$SECONDS
  rc=0
  sim_lock_try 0 || rc=$?
  if [ "$rc" = 75 ]; then
    echo "run: the simulator $udid is in use by $(cat "$sim_lock" 2>/dev/null || true); waiting up to $wait_s s for it (F-1386, $sim_lock)"
    rc=0
    sim_lock_try "$wait_s" || rc=$?
  fi
  if [ "$rc" != 0 ]; then
    if [ "$rc" = 75 ]; then
      echo "run: FAIL the simulator $udid is still in use after $wait_s s, by $(cat "$sim_lock" 2>/dev/null || true) (F-1386, $sim_lock)" >&2
    else
      echo "run: FAIL the simulator lock $sim_lock could not be taken (exit $rc, F-1386)" >&2
    fi
    exec 9>&-
    return "$rc"
  fi
  # shellcheck disable=SC2034 # read by run.sh, which sources this file
  sim_lock_waited=$((SECONDS - t0))
  # The holder's name, for a run that waits: written through a new open file, so the lock (on fd 9's open file) is untouched.
  printf 'pid %s, %s, since %s\n' "$$" "$label" "$(date '+%b %-d, %-I:%M:%S %p %Z')" >"$sim_lock"
}

sim_lock_drop() { exec 9>&-; }
