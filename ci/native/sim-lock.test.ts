// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1386
// The native suite went red on Nov 10, 2026 when a second lane's run.sh used this Mac's simulator during the nightly's SpanishUITests and
// StepsUITests: its "simctl uninstall" ended the running app and its test runner, installed under the same bundle id, replaced the nightly's
// ("Test crashed with signal kill", 5 times). run.sh now holds xcuitest/sim-lock.sh's lock from before its stack to its exit. Here the real
// sim-lock.sh runs in 2 bash processes at once, each a stand-in for run.sh's simulator section (no simulator, no Xcode), and run.sh itself is
// read for where it takes the lock.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = path.join(import.meta.dirname, '..', '..');
const lockSh = path.join(repo, 'apps/tech-native/xcuitest/sim-lock.sh');
const runSh = path.join(repo, 'apps/tech-native/xcuitest/run.sh');
const udid = '43F6C8A4-67D0-4623-B356-C4F71A2ABA21';
let dir: string;
let log: string;
let script: string;
const started: ChildProcess[] = [];

// run.sh's simulator section, stood in for: take the lock (unless NO_LOCK=1), then log the section's start and end times.
const sectionScript = `#!/usr/bin/env bash
set -euo pipefail
. "$LOCK_SH"
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
if [ "\${NO_LOCK:-0}" != 1 ]; then sim_lock_take "$UDID" "$NAME" || exit $?; fi
echo "start $NAME $(now)" >>"$LOG"
sleep "\${HOLD:-1.5}"
echo "end $NAME $(now)" >>"$LOG"
`;

type Done = { code: number | null; out: string; err: string };
const section = (name: string, env: Record<string, string> = {}) => {
  const p = spawn('bash', [script], {
    env: { ...process.env, LOCK_SH: lockSh, UDID: udid, NAME: name, LOG: log, BW_SIM_LOCK: path.join(dir, 'sim.lock'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // its own process group: a kill below ends it and its children together, as wave-run.sh's bounded() does
  });
  started.push(p);
  let out = '';
  let err = '';
  p.stdout?.on('data', (d) => (out += d));
  p.stderr?.on('data', (d) => (err += d));
  const done = new Promise<Done>((resolve) => p.on('close', (code) => resolve({ code, out, err })));
  return { p, done, out: () => out };
};
const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const at = (what: string) => {
  const l = lines().find((x) => x.startsWith(`${what} `));
  return l === undefined ? undefined : Number(l.split(' ')[2]);
};
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-sim-lock-'));
  log = path.join(dir, 'sections.log');
  script = path.join(dir, 'section.sh');
  writeFileSync(script, sectionScript);
  chmodSync(script, 0o755);
});
afterEach(() => {
  for (const p of started.splice(0)) {
    try {
      if (p.pid !== undefined && p.exitCode === null) process.kill(-p.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('the simulator lock (F-1386)', () => {
  // why: F-1386 a second run on the simulator waits for the first to end, and names the run it waits for
  it('runs 2 simulator sections one after the other, never together', async () => {
    const a = section('A');
    await until(() => at('start A') !== undefined);
    const b = section('B');
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.code).toBe(0);
    expect(rb.code).toBe(0);
    expect(at('start B')!).toBeGreaterThanOrEqual(at('end A')!);
    expect(rb.out).toContain(`is in use by pid ${a.p.pid}, A, since `);
  });

  // why: F-1386 without the lock the 2 sections overlap: this harness sees the collision the lock removes
  it('lets 2 sections overlap when neither takes the lock', async () => {
    const a = section('A', { NO_LOCK: '1' });
    await until(() => at('start A') !== undefined);
    const b = section('B', { NO_LOCK: '1' });
    await Promise.all([a.done, b.done]);
    expect(at('start B')!).toBeLessThan(at('end A')!);
  });

  // why: F-1386 a run that dies frees the lock at once: no stale lock is left for the next run
  it('frees the lock when the holding run is killed', async () => {
    const a = section('A', { HOLD: '30' });
    await until(() => at('start A') !== undefined);
    const b = section('B', { BW_SIM_LOCK_WAIT_S: '20', HOLD: '0' });
    await until(() => b.out().includes('waiting up to 20 s'));
    const killed = Date.now() / 1000;
    process.kill(-a.p.pid!, 'SIGKILL');
    const rb = await b.done;
    expect(rb.code).toBe(0);
    expect(at('start B')! - killed).toBeLessThan(3);
    expect(at('end A')).toBeUndefined();
  });

  // why: F-1386 a wait that runs out fails the run, names the holder, and never runs the section
  it('fails with exit 75 when the wait runs out', async () => {
    const a = section('A', { HOLD: '6' });
    await until(() => at('start A') !== undefined);
    const rb = await section('B', { BW_SIM_LOCK_WAIT_S: '1' }).done;
    expect(rb.code).toBe(75);
    expect(rb.err).toContain(`is still in use after 1 s, by pid ${a.p.pid}, A, since `);
    expect(at('start B')).toBeUndefined();
  });

  // why: F-1386 run.sh takes the lock after its build, before its stack and every simulator call, and holds it to exit
  it('is taken by run.sh before the stack and every simulator call, and held to exit', () => {
    const src = readFileSync(runSh, 'utf8').split('\n');
    const take = src.findIndex((l) => /^sim_lock_take "\$udid" /.test(l));
    expect(take, 'run.sh takes no simulator lock').toBeGreaterThan(-1);
    const build = src.findIndex((l) => l.includes('xcodebuild build-for-testing'));
    expect(build).toBeLessThan(take);
    const sim = src
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /xcrun simctl|xcodebuild test-without-building|^\s*compose (build|up)|signal-relay\.mjs/.test(l) && !/^\s*#/.test(l));
    expect(sim.length).toBeGreaterThan(5);
    for (const { l, i } of sim) expect(i, `before the lock: ${l.trim()}`).toBeGreaterThan(take);
    expect(src.some((l) => /^\s*sim_lock_drop\b/.test(l))).toBe(false);
    // the relay (a server) and the device-net loop are started without fd 9: a run killed alone leaves them, and they must not keep the lock
    expect(src.find((l) => l.includes('node "$app/xcuitest/signal-relay.mjs"'))).toMatch(/ 9>&- &$/);
    expect(src.find((l) => /^done\) .*&$/.test(l))).toBe('done) 9>&- &');
  });
});
