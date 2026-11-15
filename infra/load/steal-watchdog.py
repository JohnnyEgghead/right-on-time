#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""P7-LOAD real-speed mid-run abort watchdog (owner rule, Nov 12 2026; kept in the repo for the hosted mode, owner answer f3d84787).

Every 5 minutes: the server's vmstat steal over the last 5 minutes (60 samples at 5 s) and CloudWatch's latest
BurstCapacityPercentage and CPUUtilization. Aborts when 2 consecutive windows average over 5% steal, or burst
credit reads 0 with CPU held at about 20%. Abort = TERM the run (run-day.sh collects), then the abort action, then
write ABORTED. Exits by itself when the run ends. Never prints the server address.
  --on-abort delete  (the temporary copy) run temp-server.sh delete after the TERM (safe to repeat)
  --on-abort none    (the hosted server, hosted-day.sh) nothing more: the hosted run's own trap restores the server
BW_WATCHDOG_TICK and BW_WATCHDOG_WINDOW (seconds; 5 and 300) exist for the offline tests only.
Usage: python3 -I steal-watchdog.py <state dir> <worktree root> [--on-abort delete|none]
"""
import datetime, json, os, signal, subprocess, sys, time

state, root = sys.argv[1], sys.argv[2]
on_abort = 'delete'
if len(sys.argv) > 3:
    if sys.argv[3:5] not in (['--on-abort', 'delete'], ['--on-abort', 'none']):
        sys.exit('steal-watchdog: --on-abort delete|none')
    on_abort = sys.argv[4]
log_path = os.path.join(state, 'watchdog.log')
pid = int(open(os.path.join(state, 'run.pid')).read().strip())
name = open(os.path.join(state, 'instance-name')).read().strip()
TICK = float(os.environ.get('BW_WATCHDOG_TICK', '5'))
WINDOW = float(os.environ.get('BW_WATCHDOG_WINDOW', '300'))
STEAL_LIMIT = 5.0


def now_local():
    return datetime.datetime.now().astimezone().strftime('%b %-d, %-I:%M:%S %p %Z')


def log(line):
    with open(log_path, 'a') as f:
        f.write(f'{now_local()} {line}\n')


def alive(p):
    try:
        os.kill(p, 0)
        return True
    except OSError:
        return False


def ssh(cmd):
    ip = open(os.path.join(state, 'ip')).read().strip()
    r = subprocess.run(['ssh', '-i', os.path.join(state, 'key.pem'), '-o', f'UserKnownHostsFile={state}/known_hosts',
                        '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes',
                        f'admin@{ip}', cmd], capture_output=True, text=True, timeout=90)
    if r.returncode != 0:
        raise RuntimeError(f'ssh rc {r.returncode}')
    return r.stdout


def steal_window():
    out = ssh("grep -m1 swpd /tmp/bw-vmstat.log; grep -v -e procs -e swpd /tmp/bw-vmstat.log | tail -n 60")
    lines = out.strip().splitlines()
    head = lines[0].split()
    i_st, i_us, i_sy = head.index('st'), head.index('us'), head.index('sy')
    rows = [l.split() for l in lines[1:]]
    rows = [r for r in rows if len(r) > i_st]
    if not rows:
        raise RuntimeError('no vmstat rows')
    n = len(rows)
    st = sum(float(r[i_st]) for r in rows) / n
    cpu = sum(float(r[i_us]) + float(r[i_sy]) for r in rows) / n
    return st, cpu, n


def cloudwatch():
    end = datetime.datetime.now(datetime.timezone.utc)
    start = end - datetime.timedelta(minutes=30)
    res = {}
    for m in ('BurstCapacityPercentage', 'CPUUtilization'):
        r = subprocess.run(['aws', '--profile', 'brightwater', '--region', 'us-east-1', 'lightsail', 'get-instance-metric-data',
                            '--instance-name', name, '--metric-name', m, '--period', '300',
                            '--start-time', start.strftime('%Y-%m-%dT%H:%M:%SZ'), '--end-time', end.strftime('%Y-%m-%dT%H:%M:%SZ'),
                            '--unit', 'Percent', '--statistics', 'Average', '--output', 'json'],
                           capture_output=True, text=True, timeout=90)
        if r.returncode != 0:
            res[m] = None
            continue
        pts = sorted(json.loads(r.stdout).get('metricData', []), key=lambda d: d['timestamp'])
        res[m] = {d['timestamp']: d['average'] for d in pts}
    return res.get('BurstCapacityPercentage') or {}, res.get('CPUUtilization') or {}


def held_at_baseline(burst, cpu, since):
    # The last 2 datapoints that start after the run began both read burst 0 with CPU 17 to 23% ("held at about 20%").
    ts = sorted(t for t in burst if t in cpu and datetime.datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp() >= since)
    last = ts[-2:]
    return len(last) == 2 and all(burst[t] <= 0.0 and 17.0 <= cpu[t] <= 23.0 for t in last), [(burst[t], round(cpu[t], 2)) for t in last]


def abort(reason, history):
    log(f'ABORT: {reason}')
    with open(os.path.join(state, 'ABORTED'), 'w') as f:
        f.write(f'ABORTED at {now_local()}\nreason: {reason}\nwindows (local end time, steal %, cpu us+sy %, burst %, cloudwatch cpu %):\n')
        for h in history:
            f.write('  ' + ' | '.join(str(x) for x in h) + '\n')
    os.kill(pid, signal.SIGTERM)  # run-day.sh trap: collect <label>-<first>-stopped (then delete, on the temporary copy)
    for _ in range(120):
        if not alive(pid):
            break
        time.sleep(TICK)
    if on_abort == 'none':
        with open(os.path.join(state, 'ABORTED'), 'a') as f:
            f.write(f'run stopped ({"exited" if not alive(pid) else "STILL RUNNING"}) at {now_local()}; the hosted run restores the server\n')
        log('abort action none')
        sys.exit(0)
    env = dict(os.environ, BW_LOAD_DIR=state)
    r = subprocess.run(['bash', os.path.join(root, 'infra/load/temp-server.sh'), 'delete'], capture_output=True, text=True, env=env, timeout=600)
    tail = (r.stdout.strip().splitlines() or [''])[-1]
    deleted = 'deleted at' in tail or r.returncode == 0
    with open(os.path.join(state, 'ABORTED'), 'a') as f:
        f.write(f'watchdog delete rc {r.returncode}: {"deleted" if deleted else "DELETE FAILED"} ({now_local()})\n')
    log(f'delete rc {r.returncode}')
    sys.exit(0)


def main():
    started = time.time()
    log(f'start, run pid {pid}')
    over = 0
    history = []
    while True:
        for _ in range(max(1, int(WINDOW // TICK))):
            if not alive(pid):
                log('run ended; watchdog exits')
                with open(os.path.join(state, 'watchdog-ended'), 'w') as f:
                    f.write(f'ENDED (run exited) at {now_local()}; windows {len(history)}; steal over {STEAL_LIMIT}% windows '
                            f'{sum(1 for h in history if isinstance(h[1], float) and h[1] > STEAL_LIMIT)}\n')
                return
            time.sleep(TICK)
        try:
            st, cpu, n = steal_window()
        except Exception as e:  # noqa: BLE001
            log(f'steal read failed: {e}')
            st, cpu, n = None, None, 0
        try:
            bmap, cmap = cloudwatch()
            held, pair = held_at_baseline(bmap, cmap, started)
            burst, cw_cpu = (pair[-1] if pair else (None, None))
        except Exception as e:  # noqa: BLE001
            log(f'cloudwatch read failed: {e}')
            burst, cw_cpu, held, pair = None, None, False, []
        history.append((now_local(), round(st, 2) if st is not None else None, round(cpu, 2) if cpu is not None else None, burst, cw_cpu))
        log(f'window steal {st if st is None else round(st, 2)}% cpu {cpu if cpu is None else round(cpu, 2)}% samples {n} '
            f'burst {burst} cw_cpu {cw_cpu}')
        if st is not None:
            over = over + 1 if st > STEAL_LIMIT else 0
        if over >= 2:
            abort(f'2 consecutive 5-minute windows over {STEAL_LIMIT}% steal ({history[-2][1]}%, {history[-1][1]}%)', history)
        if held:
            abort(f'BurstCapacityPercentage 0 with CloudWatch CPU held at the 20% baseline in 2 consecutive datapoints {pair}', history)


if __name__ == '__main__':
    main()
