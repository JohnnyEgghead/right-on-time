// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-37
// Known-bad proofs for the verdict judgment of ci/wave-run.sh: a missing verdict and a verdict for another
// sha must both be red (exit 1), and a good verdict must be green, so the instrument is not always-red.
// No docker and no browser: the script's --check-verdict mode is what the full run uses.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WANT = 'a'.repeat(40);
// F-1571: the 2 vendored jl-dev scripts are the owner's private copies and are not in the public repo; the tests that run them skip there.
const HAS_VENDOR = existsSync(path.join(import.meta.dirname, 'vendor', 'jl-dev', 'ci-time-check.py'));
let dir: string;

const check = (file: string, sha: string) =>
  spawnSync('bash', ['ci/wave-run.sh', '--check-verdict', file, sha], { encoding: 'utf8' });
const verdict = (name: string, v: object) => {
  const f = path.join(dir, name);
  writeFileSync(f, JSON.stringify(v));
  return f;
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wave-run-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('wave-run flat verdict install (F-102)', () => {
  const install = (file: string, sha: string, dest: string) =>
    spawnSync('bash', ['ci/wave-run.sh', '--install-flat', file, sha, dest], { encoding: 'utf8' });

  it('installs the flat file at dest when its sha matches', () => {
    // why: F-102; the dashboard reads .build/ci-verdict.json, which only this copy-back can fill after a container run
    const src = verdict('flat-ok.json', { sha: WANT, result: 'pass' });
    const dest = path.join(dir, 'out1', 'ci-verdict.json');
    const r = install(src, WANT, dest);
    expect(r.status).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(src, 'utf8'));
  });
  it('leaves an existing dest untouched on a sha mismatch', () => {
    // why: F-102; a stale or other-sha flat file must never replace the dashboard's current verdict
    const dest = path.join(dir, 'keep1.json');
    writeFileSync(dest, 'OLD');
    const r = install(verdict('flat-bad.json', { sha: 'b'.repeat(40) }), WANT, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('WARN');
    expect(readFileSync(dest, 'utf8')).toBe('OLD');
  });
  it('leaves an existing dest untouched when the flat file is missing', () => {
    // why: F-102; a container that wrote no flat file warns and changes nothing
    const dest = path.join(dir, 'keep2.json');
    writeFileSync(dest, 'OLD');
    const r = install(path.join(dir, 'no-such-flat.json'), WANT, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('WARN');
    expect(readFileSync(dest, 'utf8')).toBe('OLD');
  });
});

describe('wave-run verdict judgment', () => {
  it('a missing verdict is red', () => {
    const r = check(path.join(dir, 'absent.json'), WANT);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no ci-verdict.json');
  });
  it('a verdict whose sha is not the requested sha is red', () => {
    const r = check(verdict('other.json', { result: 'pass', sha: 'b'.repeat(40) }), WANT);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not the requested sha');
  });
  it('a verdict with a failed result is red even when the sha matches', () => {
    expect(check(verdict('fail.json', { result: 'fail', sha: WANT }), WANT).status).toBe(1);
  });
  it('a passing merge-set verdict (mode merge) for the requested sha is red: it never ran --all', () => {
    // reason: F-42; --check-verdict on a copied verdict must not certify a per-wave run that skipped the wave gates
    const r = check(verdict('merge.json', { result: 'pass', sha: WANT, mode: 'merge', totalDurationS: 1 }), WANT);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('verdict mode is merge');
    expect(check(verdict('nomode.json', { result: 'pass', sha: WANT }), WANT).status).toBe(1);
  });
  it('a mode-all verdict from a narrowed engine run, or with no engine list, is red (F-47)', () => {
    // reason: F-47; a copied verdict from BW_PW_ENGINES=chromium must not certify a full-engine wave run
    const base = { result: 'pass', sha: WANT, mode: 'all', totalDurationS: 1 };
    const narrowed = check(verdict('narrow.json', { ...base, engines: { run: ['chromium'], dropped: ['webkit'], why: 'no WebKit build' } }), WANT);
    expect(narrowed.status).toBe(1);
    expect(narrowed.stderr).toContain('dropped webkit');
    expect(check(verdict('noeng.json', base), WANT).status).toBe(1);
  });
  it('a push-scope verdict is green on Chromium alone with webkit dropped and a reason, red when it claims WebKit without a gate or drops webkit with no reason', () => {
    // why: REC-TE-1; the push set runs Chromium only, so a push verdict must neither need WebKit nor pass with an unexplained drop
    const base = { result: 'pass', sha: WANT, mode: 'all', scope: 'push', totalDurationS: 1 };
    const chromiumOnly = { run: ['chromium'], dropped: ['webkit'], why: 'push set: webkit runs in the nightly set' };
    expect(check(verdict('push-ok.json', { ...base, engines: chromiumOnly }), WANT).status).toBe(0);
    expect(check(verdict('push-noreason.json', { ...base, engines: { ...chromiumOnly, why: null } }), WANT).status).toBe(1);
    expect(check(verdict('push-nochromium.json', { ...base, engines: { run: ['webkit'], dropped: ['chromium'], why: 'x' } }), WANT).status).toBe(1);
    // the same Chromium-only record without the push scope is still red
    expect(check(verdict('noscope.json', { ...base, scope: undefined, engines: chromiumOnly }), WANT).status).toBe(1);
  });
  it('a nightly verdict is judged as nightly with both engines, and a gates verdict as gates (F-579)', () => {
    // why: F-579; a nightly or --gates wave run was judged as mode all and always ended RED
    const run = (file: string, mode: string) => spawnSync('bash', ['ci/wave-run.sh', '--check-verdict', file, WANT, mode], { encoding: 'utf8' });
    const both = { run: ['chromium', 'webkit'], dropped: [], why: null };
    const base = { result: 'pass', sha: WANT, totalDurationS: 1 };
    expect(run(verdict('n-ok.json', { ...base, mode: 'nightly', scope: 'nightly', engines: both }), 'nightly').status).toBe(0);
    expect(run(verdict('n-chromium.json', { ...base, mode: 'nightly', scope: 'nightly', engines: { run: ['chromium'], dropped: ['webkit'], why: 'x' } }), 'nightly').status).toBe(1);
    expect(run(verdict('n-asall.json', { ...base, mode: 'nightly', scope: 'nightly', engines: both }), 'all').status).toBe(1);
    expect(run(verdict('g-ok.json', { ...base, mode: 'gates' }), 'gates').status).toBe(0);
    expect(run(verdict('g-red.json', { ...base, result: 'fail', mode: 'gates' }), 'gates').status).toBe(1);
    expect(run(verdict('g-asall.json', { ...base, mode: 'gates' }), 'all').status).toBe(1);
  });
  it('control: a passing verdict for the requested sha is green', () => {
    expect(check(verdict('ok.json', { result: 'pass', sha: WANT, mode: 'all', totalDurationS: 1, engines: { run: ['chromium', 'webkit'], dropped: [], why: null } }), WANT).status).toBe(0);
  });
});

describe.skipIf(!HAS_VENDOR)('wave-run host-side time row (F-691)', () => {
  const nightly = (name: string, sha: string, result = 'pass') =>
    verdict(name, { result, sha, mode: 'nightly', scope: 'nightly', totalDurationS: 120, gates: [{ id: 'lint', status: 'pass', durationS: 10 }, { id: 'unit-tests', status: 'pass', durationS: 100 }] });
  const row = (file: string, mode: string, env: Record<string, string> = {}) =>
    spawnSync('bash', ['ci/wave-run.sh', '--time-check', file, mode, path.join(dir, 'hist.jsonl')], { encoding: 'utf8', env: { ...process.env, ...env } });
  const rows = () => readFileSync(path.join(dir, 'hist.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('a nightly verdict appends 1 row with scope nightly, its sha and the change label; a later run appends a second row', () => {
    // why: F-691; the row the container wrote died with the container, so the nightly history had no row after Nov 2
    expect(row(nightly('n1.json', 'b'.repeat(40)), 'nightly', { BW_CI_CHANGE: 'F-602' }).status).toBe(0);
    let r = rows();
    expect(r).toHaveLength(1);
    // F-1036: budgetS follows the plan header (docs/BUILD_PLAN.md), now 2 h (plan v0.24, owner ruling 5b1b574a)
    expect(r[0]).toMatchObject({ scope: 'nightly', sha: 'b'.repeat(40), change: 'F-602', result: 'pass', budgetS: 7200, over: false });
    expect(r[0].gateStatus).toEqual({ lint: 'pass', 'unit-tests': 'pass' });
    expect(row(nightly('n2.json', 'c'.repeat(40), 'fail'), 'nightly').status).toBe(0);
    r = rows();
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ scope: 'nightly', sha: 'c'.repeat(40), change: '' });
  });
  it('a gates or all verdict appends no row, and a missing verdict never fails the step', () => {
    // why: F-587 and F-579; a narrow run must not become a growth baseline, and the wave gate is the GitHub push run
    const before = readFileSync(path.join(dir, 'hist.jsonl'), 'utf8');
    expect(row(verdict('g.json', { result: 'pass', sha: WANT, mode: 'gates', gates: [] }), 'gates').status).toBe(0);
    expect(row(nightly('a.json', 'd'.repeat(40)), 'all').status).toBe(0);
    expect(row(path.join(dir, 'nope.json'), 'nightly').status).toBe(0);
    expect(readFileSync(path.join(dir, 'hist.jsonl'), 'utf8')).toBe(before);
  });
});

describe.skipIf(!HAS_VENDOR)('the push verdict is held to the push budget (F-577)', () => {
  const pushRun = (name: string, totalDurationS: number) =>
    spawnSync('bash', ['ci/wave-run.sh', '--time-check', verdict(name, { result: 'pass', sha: 'a'.repeat(40), mode: 'all', scope: 'push', totalDurationS, gates: [{ id: 'lint', status: 'pass', durationS: totalDurationS }] }), 'all', path.join(dir, 'push-hist.jsonl')], { encoding: 'utf8' });

  it('judges a push verdict against the push budget of 600 s, 700 s over it and 500 s under, and appends no row', () => {
    // why: F-577; the push budget was 18 min, and wave-run judged a push verdict against the full budget
    expect(pushRun('p-over.json', 700).stdout).toContain('over the push budget of 600 s');
    expect(pushRun('p-under.json', 500).stdout).not.toContain('over the push budget');
    expect(existsSync(path.join(dir, 'push-hist.jsonl'))).toBe(false);
  });
  it('the vendored check alone holds --scope push to 600 s', () => {
    const f = verdict('p-direct.json', { result: 'pass', sha: 'b'.repeat(40), mode: 'all', scope: 'push', totalDurationS: 700, gates: [{ id: 'lint', status: 'pass', durationS: 700 }] });
    const r = spawnSync('python3', ['ci/vendor/jl-dev/ci-time-check.py', '--scope', 'push', '--verdict', f, '--history', path.join(dir, 'push-direct.jsonl'), '--plan', 'docs/BUILD_PLAN.md', '--no-append'], { encoding: 'utf8' });
    expect(r.stdout).toContain('over the push budget of 600 s');
  });
});

describe.skipIf(!HAS_VENDOR)('the vendored time check dedupes on the verdict, not on the sha (F-694)', () => {
  const check = (file: string, hist: string) =>
    spawnSync('python3', ['ci/vendor/jl-dev/ci-time-check.py', '--scope', 'nightly', '--verdict', file, '--history', hist, '--plan', 'docs/BUILD_PLAN.md', '--label', 'nightly'], { encoding: 'utf8' });
  const sha = 'e'.repeat(40);
  const v = (name: string, ts: string) => verdict(name, { result: 'pass', sha, mode: 'nightly', scope: 'nightly', ts, totalDurationS: 120, gates: [{ id: 'lint', status: 'pass', durationS: 10 }] });

  it('a re-run of the same sha appends a second row, and the same verdict checked twice appends once', () => {
    // why: F-694; a same-sha nightly re-run (a narrow fix proof) appended no row, so the history lost the run
    const hist = path.join(dir, 'dedupe.jsonl');
    const first = v('d1.json', '2026-11-06T10:00:00Z');
    expect(check(first, hist).status).toBe(0);
    expect(check(first, hist).status).toBe(0);
    expect(readFileSync(hist, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(check(v('d2.json', '2026-11-06T12:00:00Z'), hist).status).toBe(0);
    expect(readFileSync(hist, 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it('names a sibling tool that is not vendored instead of saying it did not run', () => {
    // why: F-694; the lap check printed "did not run: [Errno 2]" on every nightly in this tree
    const over = verdict('over.json', { result: 'pass', sha: 'f'.repeat(40), mode: 'nightly', scope: 'nightly', ts: '2026-11-06T13:00:00Z', totalDurationS: 99_999, gates: [{ id: 'lint', status: 'pass', durationS: 99_999 }] });
    const r = check(over, path.join(dir, 'over.jsonl'));
    expect(r.stdout).toContain('ci-lap-check.py is not vendored in this tree');
    expect(r.stdout).not.toContain('did not run');
  });
});

describe('wave-run CI container core file limit (F-1165, F-501)', () => {
  const limits = (soft: string, hard: string) => `Limit                     Soft Limit           Hard Limit           Units     \nMax cpu time              unlimited            unlimited            seconds   \nMax core file size        ${soft.padEnd(20)} ${hard.padEnd(20)} bytes     \n`;
  const judge = (text: string) => spawnSync('bash', ['ci/wave-run.sh', '--core-limit-check'], { input: text, encoding: 'utf8' }).status;
  it('passes only a core file limit of exactly 1 byte, soft and hard', () => {
    // why: F-1165 - Spectre pipes every core to Windows unless RLIMIT_CORE is exactly 1; Docker's default (soft 0, hard unlimited) let 4 WebKit crashes write 6 GB each during nightly 40f8433c
    expect(judge(limits('1', '1'))).toBe(0);
    expect(judge(limits('0', 'unlimited'))).toBe(1);
    expect(judge(limits('0', '1'))).toBe(1);
    expect(judge(limits('unlimited', 'unlimited'))).toBe(1);
    expect(judge('Limit Soft Limit Hard Limit Units\n')).toBe(1);
  });
  it('starts the CI container with the limit and checks it through docker exec before any gate', () => {
    // why: F-1165 - every gate runs through docker exec, so the check reads the limit the way a gate gets it
    const live = readFileSync('ci/wave-run.sh', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const run = live.indexOf('--network "container:$ENGINE" --ulimit core=1 ');
    const check = live.indexOf('exec "$NAME" cat /proc/self/limits | core_limit_ok');
    expect(run).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(run);
    expect(check).toBeLessThan(live.indexOf('bash ci/ci.sh --all'));
  });
});

describe('wave-run setup builds every web image a stack gate builds (F-485)', () => {
  it('builds each build-argument set a gate script uses before ci.sh runs, and leaves a failed preview build to the gate', () => {
    // why: F-485 - the BW_WEB_PREVIEW=1 image, built inside page-walkers, took 335 s beside G-CI7 and pushed the gate past its limit
    const live = readFileSync('ci/wave-run.sh', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const gatesStart = live.indexOf('bash ci/ci.sh --all');
    expect(gatesStart).toBeGreaterThan(-1);
    const scripts = [
      ...readdirSync('ci').filter((f) => f.endsWith('-stack.sh')).map((f) => `ci/${f}`),
      ...readdirSync('ci/gates').filter((f) => f.endsWith('.sh')).map((f) => `ci/gates/${f}`),
      'infra/backup/tests/stack.sh',
    ];
    const argSets = new Set<string>();
    for (const s of scripts) for (const m of readFileSync(s, 'utf8').matchAll(/^\s*compose build((?: --build-arg \S+)*) web\b/gm)) argSets.add((m[1] ?? '').trim());
    expect([...argSets].sort()).toEqual(['', '--build-arg BW_WEB_PREVIEW=1']);
    for (const args of argSets) {
      const at = args === '' ? live.indexOf('docker compose -f infra/compose.yaml build --quiet\n') : live.indexOf(`build --quiet ${args} web`);
      expect(at, `setup build for ${args || 'the release image'}`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(gatesStart);
    }
    // A failed preview build is printed, never a red setup with no verdict: the gate builds it again and reports it.
    expect(live).toMatch(/build --quiet --build-arg BW_WEB_PREVIEW=1 web \\\n\s+\|\| echo /);
  });
});

// F-1201: the mac half alone (--mac-half), end to end in a throwaway repo that holds wave-run.sh, the mac half's plan and a fixture map.
// A docker on PATH that records each call proves nothing starts on Spectre.
describe('wave-run --mac-half (F-1201)', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const g = (id: string, extra: Record<string, unknown>) => ({ id, title: id, when: 'wave', critical: false, builders: ['T'], activates: 'T', activeFromPhase: 1, ...extra });
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  function rig(gates: object[], markers: string[]) {
    const r = path.join(dir, `mac-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(r, 'ci', 'active'), { recursive: true });
    for (const f of ['wave-run.sh', 'mac-half.ts', 'gates-lib.ts', 'is-main.ts']) writeFileSync(path.join(r, 'ci', f), readFileSync(path.join(repoRoot, 'ci', f)));
    writeFileSync(path.join(r, 'ci', 'gates.json'), JSON.stringify({ defaultTimeoutS: 300, gates }));
    for (const m of markers) writeFileSync(path.join(r, 'ci', 'active', m), '');
    writeFileSync(path.join(r, 'tracked.txt'), 'one\n');
    mkdirSync(path.join(r, 'bin'));
    writeFileSync(path.join(r, 'bin', 'docker'), `#!/bin/sh\necho "$@" >> "${r}/docker-calls"\nexit 1\n`, { mode: 0o755 });
    git(r, 'init', '-q');
    git(r, 'add', 'ci', 'tracked.txt');
    git(r, 'commit', '-q', '-m', 'fixture');
    return r;
  }
  const mac = (r: string, args: string[], env: Record<string, string> = {}) => {
    const out = path.join(r, 'out');
    const res = spawnSync('bash', [path.join(r, 'ci', 'wave-run.sh'), '--mac-half', ...args], {
      cwd: r, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(r, 'bin')}:${process.env['PATH'] ?? ''}`, WAVE_OUT_DIR: out, BW_CI_ARGS: '', ...env },
    });
    return { status: res.status, out: res.stdout + res.stderr, ran: (id: string) => existsSync(path.join(r, `ran-${id}`)), docker: existsSync(path.join(r, 'docker-calls')), logs: out };
  };
  const both = () => [g('lin', { cmd: 'touch ran-lin' }), g('mac-w', { cmd: 'touch ran-mac-w', runner: 'mac' }), g('mac-n', { when: 'nightly', cmd: 'touch ran-mac-n', runner: 'mac' })];

  it('a nightly mac half runs every runner mac gate on this checkout and no linux gate, and calls no docker', () => {
    // why: F-1201 the native suite runs in the nightly as the mac half of wave-run.sh (owner ruling Nov 4, 2026 item 3); nothing starts on Spectre
    const r = rig(both(), ['lin', 'mac-w', 'mac-n']);
    const res = mac(r, [], { BW_CI_ARGS: '--nightly' });
    expect(res.status, res.out).toBe(0);
    expect(res.out).toMatch(/^mac gate set \(nightly\): mac-w mac-n$/m);
    expect(res.out).toMatch(/^mac gate mac-n: PASS/m);
    expect(res.out).toContain('MAC HALF GREEN');
    expect([res.ran('mac-w'), res.ran('mac-n'), res.ran('lin')]).toEqual([true, true, false]);
    expect(res.docker, 'docker was called').toBe(false);
    expect(existsSync(path.join(res.logs, 'mac', 'mac-n.log'))).toBe(true);
  });

  it('a --checkpoint mac half runs a when: checkpoint mac gate, and a --nightly one leaves it out', () => {
    // why: F-1410 (owner answer 24ad46b5) - wave-run.sh judges --checkpoint as nightly and its mac half takes the checkpoint set
    const r = rig([g('mac-n', { when: 'nightly', cmd: 'touch ran-mac-n', runner: 'mac' }), g('mac-c', { when: 'checkpoint', cmd: 'touch ran-mac-c', runner: 'mac' })], ['mac-n', 'mac-c']);
    const n = mac(r, [], { BW_CI_ARGS: '--nightly' });
    expect(n.status, n.out).toBe(0);
    expect([n.ran('mac-n'), n.ran('mac-c')]).toEqual([true, false]);
    const c = mac(r, [], { BW_CI_ARGS: '--checkpoint' });
    expect(c.status, c.out).toBe(0);
    expect(c.out).toMatch(/^mac gate set \(checkpoint\): mac-n mac-c$/m);
    expect(c.ran('mac-c')).toBe(true);
  });

  it('a run that is not nightly leaves the nightly mac gate out, and an inactive mac gate is named, never run', () => {
    // why: F-1201 the when rule is ci.sh's: the suite (when nightly) never runs outside the nightly
    const r = rig(both(), ['mac-w']);
    const res = mac(r, []);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toMatch(/^mac gate set \(all\): mac-w$/m);
    expect(res.ran('mac-n')).toBe(false);
    const n = mac(r, [], { BW_CI_ARGS: '--nightly' });
    expect(n.out).toMatch(/^INACTIVE mac-n \(mac\): activates when T merges/m);
    expect(n.ran('mac-n')).toBe(false);
  });

  it('a red or timed-out mac gate makes the mac half red, and every other mac gate still runs', () => {
    // why: F-1201 must-fail probe - a red native suite must make the nightly red, never a silent pass
    const r = rig([g('mac-red', { cmd: 'echo boom; exit 3', runner: 'mac' }), g('mac-slow', { cmd: 'sleep 20', timeoutS: 1, runner: 'mac' }), g('mac-ok', { cmd: 'touch ran-mac-ok', runner: 'mac' })], ['mac-red', 'mac-slow', 'mac-ok']);
    const t0 = Date.now();
    const res = mac(r, []);
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/^mac gate mac-red: FAIL exit 3/m);
    expect(res.out).toMatch(/^ {4}boom$/m);
    expect(res.out).toMatch(/RED: mac gate mac-slow timed out after 1s/);
    expect(res.ran('mac-ok')).toBe(true);
    expect(res.out).toContain('MAC HALF RED');
    expect(Date.now() - t0).toBeLessThan(15000);
  });

  it('a checkout at another sha, or with tracked changes outside .build, runs no mac gate and is red', () => {
    // why: F-1201 the suite builds the app from this Mac's working tree, so a mac half for a sha must run on exactly that code
    const r = rig(both(), ['mac-w']);
    const first = git(r, 'rev-parse', 'HEAD');
    writeFileSync(path.join(r, 'tracked.txt'), 'two\n');
    let res = mac(r, []);
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/RED: mac half: this Mac's checkout has tracked changes/);
    expect(res.ran('mac-w')).toBe(false);
    git(r, 'commit', '-q', '-am', 'second');
    res = mac(r, [first]);
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/RED: mac half: this Mac's checkout is at [0-9a-f]{40}, not /);
    expect(res.ran('mac-w')).toBe(false);
    mkdirSync(path.join(r, '.build'));
    writeFileSync(path.join(r, '.build', 'state.md'), 'x');
    git(r, 'add', '.build');
    git(r, 'commit', '-q', '-m', 'records');
    writeFileSync(path.join(r, '.build', 'state.md'), 'y');
    res = mac(r, []);
    expect(res.status, res.out).toBe(0);
    expect(res.ran('mac-w')).toBe(true);
    expect(res.docker).toBe(false);
  });

  it('a tracked change under .claude/agent-memory or .askq does not stop the mac half, and one under code still does', () => {
    // why: F-1210 the mac half's record paths are the GitHub push run's paths-ignore; a memory edit between record commits is no red
    const r = rig(both(), ['mac-w']);
    for (const f of ['.claude/agent-memory/m.md', '.askq/q.json']) {
      mkdirSync(path.dirname(path.join(r, f)), { recursive: true });
      writeFileSync(path.join(r, f), 'x');
    }
    git(r, 'add', '.claude', '.askq');
    git(r, 'commit', '-q', '-m', 'records');
    for (const f of ['.claude/agent-memory/m.md', '.askq/q.json']) writeFileSync(path.join(r, f), 'y');
    let res = mac(r, []);
    expect(res.status, res.out).toBe(0);
    expect(res.ran('mac-w')).toBe(true);
    writeFileSync(path.join(r, 'tracked.txt'), 'changed\n');
    res = mac(r, []);
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/tracked changes/);
  });

  it('a mac gate killed at its cap is waited for while its EXIT trap tears down, so no stack is left', () => {
    // why: F-1203 cap-fires probe - run.sh stops its Compose stack in an EXIT trap; bash -c dies at TERM and hides run.sh from a tree walk made after it
    const r = rig([g('mac-cap', { cmd: 'bash stack.sh', timeoutS: 1, runner: 'mac' })], ['mac-cap']);
    writeFileSync(path.join(r, 'stack.sh'), "trap 'sleep 3; touch stack-down' EXIT\ntrap 'exit 143' TERM\ntouch stack-up\nsleep 30 &\nwait\n");
    const res = mac(r, []);
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/RED: mac gate mac-cap timed out after 1s/);
    expect(existsSync(path.join(r, 'stack-up'))).toBe(true);
    expect(existsSync(path.join(r, 'stack-down')), 'the teardown was cut short or still runs').toBe(true);
  });

  // Ruling item 3 (Nov 10, 2026): --halves-selftest runs the real mac half and the real wait loop against a stand-in container half.
  const halves = (r: string, secs: number, rc: number, extraEnv: Record<string, string> = {}) => {
    const out = path.join(r, 'out');
    const res = spawnSync('bash', [path.join(r, 'ci', 'wave-run.sh'), '--halves-selftest', String(secs), String(rc)], {
      cwd: r, encoding: 'utf8', env: { ...process.env, WAVE_OUT_DIR: out, BW_CI_ARGS: '', BW_WAVE_POLL_S: '1', ...extraEnv },
    });
    const text = res.stdout + res.stderr;
    return { status: res.status, out: text, at: (re: RegExp) => text.search(re), ran: (id: string) => existsSync(path.join(r, `ran-${id}`)) };
  };

  it('the mac half starts at run start and its gate runs while the container half is still going, and the hold lifts when it ends', () => {
    // why: ruling item 3 - the mac half used to start after the Spectre half, so the nightly was the sum of both; the hold on commits to main ends with the mac half
    const r = rig([g('native-suite', { cmd: 'touch ran-native-suite', runner: 'mac' })], ['native-suite']);
    const res = halves(r, 6, 0);
    expect(res.status, res.out).toBe(0);
    const started = res.at(/^MAC HALF STARTED/m);
    const ended = res.at(/^MAC HALF ENDED \(rc 0/m);
    const containerEnd = res.at(/^=== container run finished/m);
    expect(started).toBeGreaterThan(-1);
    expect(ended, 'the end line must appear while the container half still runs').toBeGreaterThan(started);
    expect(containerEnd).toBeGreaterThan(ended);
    expect(res.ran('native-suite')).toBe(true);
    expect(res.out).toMatch(/^mac half measured: \d+s wall, \d+s of it past the Spectre half's end; per gate: native-suite=\d+s/m);
    expect(res.out).toMatch(/^HALVES GREEN$/m);
  });

  it('the verdict needs both halves: a red container half or a red mac half is red, green needs both', () => {
    // why: ruling item 3 - running the halves together must not let either one carry the verdict alone
    const green = rig([g('mac-ok', { cmd: 'touch ran-mac-ok', runner: 'mac' })], ['mac-ok']);
    const redMac = rig([g('mac-bad', { cmd: 'exit 3', runner: 'mac' })], ['mac-bad']);
    expect(halves(green, 1, 1).out).toMatch(/^HALVES RED$/m);
    expect(halves(redMac, 1, 0).out).toMatch(/^HALVES RED$/m);
    expect(halves(redMac, 1, 1).status).toBe(1);
    const both = halves(green, 1, 0);
    expect(both.status, both.out).toBe(0);
    expect(both.out).toMatch(/^HALVES GREEN$/m);
  });

  it('a mac half that ends after the container half is waited for, and the hold line comes after the container line', () => {
    // why: ruling item 3 - the verdict still waits for the slower half
    const r = rig([g('mac-slow', { cmd: 'sleep 4; touch ran-mac-slow', runner: 'mac' })], ['mac-slow']);
    const res = halves(r, 1, 0);
    expect(res.status, res.out).toBe(0);
    expect(res.ran('mac-slow')).toBe(true);
    expect(res.at(/^=== container run finished/m)).toBeLessThan(res.at(/^MAC HALF ENDED/m));
  });

  it('add-mac-time adds the mac half seconds to the verdict copy, its total and a mac-half gate, and ignores a zero', () => {
    // why: F-1210 the mac half ran after the verdict was copied, so about 41 minutes of the nightly were in no ci-time.jsonl row
    const f = path.join(dir, 'mac-verdict.json');
    writeFileSync(f, JSON.stringify({ result: 'pass', totalDurationS: 100, gates: [{ id: 'lint', status: 'pass', durationS: 100 }] }));
    const run = (secs: string) => spawnSync('bash', [path.join(repoRoot, 'ci', 'wave-run.sh'), '--add-mac-time', f, secs], { encoding: 'utf8' });
    expect(run('0').status).toBe(0);
    expect(JSON.parse(readFileSync(f, 'utf8')).totalDurationS).toBe(100);
    expect(run('2440').status).toBe(0);
    let v = JSON.parse(readFileSync(f, 'utf8'));
    // F-1375: the halves run side by side, so with no overrun the total is the container's alone, and the mac-half row keeps its own seconds
    expect(v.totalDurationS).toBe(100);
    expect(v.gates.at(-1)).toEqual({ id: 'mac-half', durationS: 2440, status: 'pass' });
    writeFileSync(f, JSON.stringify({ result: 'pass', totalDurationS: 100, gates: [{ id: 'lint', status: 'pass', durationS: 100 }] }));
    expect(spawnSync('bash', [path.join(repoRoot, 'ci', 'wave-run.sh'), '--add-mac-time', f, '2440', 'pass', '', '40'], { encoding: 'utf8' }).status).toBe(0);
    v = JSON.parse(readFileSync(f, 'utf8'));
    expect(v.totalDurationS).toBe(140);
    expect(v.gates.at(-1)).toEqual({ id: 'mac-half', durationS: 2440, status: 'pass' });
  });

  it('add-mac-time names each mac gate\'s own seconds (native-suite, native-no-demo) in the verdict, and the total takes only the mac half', () => {
    // why: F-1372 the verdict carried only the summed mac-half row, so native-suite's measured time was in no verdict
    const f = path.join(dir, 'mac-verdict-gates.json');
    const t = path.join(dir, 'gate-times.tsv');
    writeFileSync(f, JSON.stringify({ result: 'pass', totalDurationS: 100, gates: [{ id: 'lint', status: 'pass', durationS: 100 }] }));
    writeFileSync(t, 'native-no-demo\t240\tpass\nnative-suite\t2200\tpass\n');
    const res = spawnSync('bash', [path.join(repoRoot, 'ci', 'wave-run.sh'), '--add-mac-time', f, '2440', 'pass', t, '40'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const v = JSON.parse(readFileSync(f, 'utf8'));
    expect(v.gates.find((g: { id: string }) => g.id === 'native-suite')).toEqual({ id: 'native-suite', durationS: 2200, status: 'pass' });
    expect(v.gates.find((g: { id: string }) => g.id === 'native-no-demo')).toEqual({ id: 'native-no-demo', durationS: 240, status: 'pass' });
    expect(v.gates.at(-1)).toEqual({ id: 'mac-half', durationS: 2440, status: 'pass' });
    expect(v.totalDurationS).toBe(140);
  });

  it('add-mac-time replaces the container\'s skipped row of the same gate id in place, so no id appears twice', () => {
    // why: F-1387 the container verdict already holds a skipped 0 s row for each mac gate; appending left 2 rows per id and a first-match reader read 0 s
    const f = path.join(dir, 'mac-verdict-dup.json');
    const t = path.join(dir, 'gate-times-dup.tsv');
    writeFileSync(f, JSON.stringify({ result: 'pass', totalDurationS: 100, gates: [
      { id: 'lint', status: 'pass', durationS: 100 }, { id: 'native-suite', status: 'skipped', durationS: 0 }, { id: 'native-no-demo', status: 'skipped', durationS: 0 },
    ] }));
    writeFileSync(t, 'native-no-demo\t240\tpass\nnative-suite\t2200\tfail\n');
    expect(spawnSync('bash', [path.join(repoRoot, 'ci', 'wave-run.sh'), '--add-mac-time', f, '2440', 'fail', t, '0'], { encoding: 'utf8' }).status).toBe(0);
    const gates = JSON.parse(readFileSync(f, 'utf8')).gates as { id: string; durationS: number; status: string }[];
    const ids = gates.map((x) => x.id);
    expect(new Set(ids).size, ids.join(',')).toBe(ids.length);
    expect(gates.find((x) => x.id === 'native-suite')).toEqual({ id: 'native-suite', durationS: 2200, status: 'fail' });
    expect(gates[1]).toEqual({ id: 'native-suite', durationS: 2200, status: 'fail' });
    expect(gates.at(-1)).toEqual({ id: 'mac-half', durationS: 2440, status: 'fail' });
  });

  it('a mac half that never started is red, not a pass', () => {
    // why: F-1373 mac_half_finish returned 0 with no line when no mac half was started, so a lost start read as a pass
    const r = rig([g('mac-n', { cmd: 'touch ran-mac-n', runner: 'mac' })], ['mac-n']);
    const res = halves(r, 0, 0, { BW_HALVES_NO_START: '1' });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/RED: the mac half never started/);
    expect(res.out).toMatch(/^HALVES RED$/m);
    expect(res.ran('mac-n')).toBe(false);
  });

  it('the real path starts the mac half before the clone and finishes it after the container wait', () => {
    // why: F-1373 --halves-selftest has its own start and wait, so no test ran the real path's calls; this pins their order in the non-comment text
    const lines = readFileSync(path.join(repoRoot, 'ci', 'wave-run.sh'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l));
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const start = lines.findIndex((l) => /mac_half_start "\$EXPECT" "\$SHA"/.test(l) && l.includes('SETUP_ONLY'));
    const clone = at('git clone --quiet --no-hardlinks');
    const wait = at('await_container "$EXEC_PID"');
    const finish = lines.findIndex((l, i) => i > wait && l.includes('mac_half_finish'));
    expect(start).toBeGreaterThan(-1);
    expect(clone).toBeGreaterThan(start);
    expect(wait).toBeGreaterThan(clone);
    expect(finish).toBeGreaterThan(wait);
  });

  it('the hold-lifted line prints when the mac half ends, even while the host-side setup runs with no wait loop', () => {
    // why: F-1374 the ENDED line printed only from the wait loop, so a mac half ending during setup held main until the container exec started
    const r = rig([g('mac-q', { cmd: 'touch ran-mac-q', runner: 'mac' })], ['mac-q']);
    const script = path.join(r, 'ci', 'wave-run.sh');
    const res = spawnSync('bash', ['-c', 'bash "$0" --halves-selftest 1 0 2>&1 | while IFS= read -r l; do printf "%s %s\\n" "$(date +%s)" "$l"; done', script], {
      cwd: r, encoding: 'utf8', env: { ...process.env, WAVE_OUT_DIR: path.join(r, 'out'), BW_CI_ARGS: '', BW_WAVE_POLL_S: '1', BW_HALVES_SETUP_S: '5' },
    });
    const ts = (re: RegExp) => Number((res.stdout.split('\n').find((l) => re.test(l)) ?? 'x').split(' ')[0]);
    const ended = ts(/MAC HALF ENDED/);
    const finished = ts(/=== container run finished/);
    expect(ended, res.stdout).toBeGreaterThan(0);
    expect(finished - ended, res.stdout).toBeGreaterThanOrEqual(3);
  });

  it('an early exit with the mac half running stops it and prints the STOPPED line, with no ENDED line', () => {
    // why: F-1374 on an early exit no line said the hold was over; the rig printed only 'stopping the mac half'
    const r = rig([g('mac-r', { cmd: 'sleep 30', runner: 'mac' })], ['mac-r']);
    const res = halves(r, 0, 0, { BW_HALVES_EXIT_EARLY: '1' });
    expect(res.status, res.out).toBe(1);
    expect(res.out).toMatch(/^MAC HALF STOPPED: commits on main may resume$/m);
    expect(res.out).not.toMatch(/^MAC HALF ENDED/m);
  });

  it('the seconds the mac half ran past the Spectre half are counted, and a mac half inside it counts 0', () => {
    // why: F-1375 the mac half's whole wall went into totalDurationS though the halves run side by side
    const slow = rig([g('mac-s', { cmd: 'sleep 5', runner: 'mac' })], ['mac-s']);
    const over = /(\d+)s of it past the Spectre half/.exec(halves(slow, 1, 0).out);
    expect(over, 'no overrun in the measured line').not.toBeNull();
    expect(Number(over![1])).toBeGreaterThanOrEqual(3);
    const fast = rig([g('mac-f', { cmd: 'touch ran-mac-f', runner: 'mac' })], ['mac-f']);
    expect(halves(fast, 4, 0).out).toMatch(/, 0s of it past the Spectre half/);
  });

  it('the real path hands the overrun, not the mac half wall, to add_mac_time', () => {
    // why: F-1375 the real caller is not run here (no container), so its argument is pinned in the non-comment text
    const text = readFileSync(path.join(repoRoot, 'ci', 'wave-run.sh'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(text).toMatch(/add_mac_time "\$VERDICT" "\$MAC_HALF_S" "\$MAC_HALF_STATUS" "\$OUT\/mac\/gate-times.tsv" "\$MAC_OVERRUN_S"/);
  });

  it('a mac half run writes each gate\'s seconds to gate-times.tsv for the verdict', () => {
    // why: F-1372 the per-gate seconds must come from the run itself, by gate id
    const r = rig([g('mac-a', { cmd: 'touch ran-mac-a', runner: 'mac' })], ['mac-a']);
    const res = halves(r, 0, 0);
    expect(res.status, res.out).toBe(0);
    const tsv = readFileSync(path.join(r, 'out', 'mac', 'gate-times.tsv'), 'utf8');
    expect(tsv).toMatch(/^mac-a\t\d+\tpass$/m);
  });

  it('add-mac-time writes the mac half\'s own result, so a failing mac half does not read pass', () => {
    // why: F-1242 the mac-half gate was always written as pass, so a red mac gate showed green in the nightly row's gateStatus
    const f = path.join(dir, 'mac-verdict-red.json');
    writeFileSync(f, JSON.stringify({ result: 'pass', totalDurationS: 100, gates: [{ id: 'lint', status: 'pass', durationS: 100 }] }));
    const res = spawnSync('bash', [path.join(repoRoot, 'ci', 'wave-run.sh'), '--add-mac-time', f, '300', 'fail'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(JSON.parse(readFileSync(f, 'utf8')).gates.at(-1)).toEqual({ id: 'mac-half', durationS: 300, status: 'fail' });
  });

  it('add-mac-time with a failing mac half also makes the copy\'s own result fail, and writes the gate at 0 s', () => {
    // why: F-1249 ci-time-check.py takes the nightly row's result from the copy's top-level result: a red mac half left it pass, so the row could be a growth baseline; an early red (checkout off the sha) has 0 s and wrote no gate
    const f = path.join(dir, 'mac-verdict-red-result.json');
    writeFileSync(f, JSON.stringify({ result: 'pass', totalDurationS: 100, gates: [{ id: 'lint', status: 'pass', durationS: 100 }] }));
    expect(spawnSync('bash', [path.join(repoRoot, 'ci', 'wave-run.sh'), '--add-mac-time', f, '300', 'fail'], { encoding: 'utf8' }).status).toBe(0);
    expect(JSON.parse(readFileSync(f, 'utf8')).result).toBe('fail');
    writeFileSync(f, JSON.stringify({ result: 'pass', totalDurationS: 100, gates: [{ id: 'lint', status: 'pass', durationS: 100 }] }));
    expect(spawnSync('bash', [path.join(repoRoot, 'ci', 'wave-run.sh'), '--add-mac-time', f, '0', 'fail'], { encoding: 'utf8' }).status).toBe(0);
    const v = JSON.parse(readFileSync(f, 'utf8'));
    expect(v.gates.at(-1)).toEqual({ id: 'mac-half', durationS: 0, status: 'fail' });
    expect(v.result).toBe('fail');
    // a pass at 0 s stays a no-op, and a pass never changes the result
    writeFileSync(f, JSON.stringify({ result: 'pass', totalDurationS: 100, gates: [] }));
    spawnSync('bash', [path.join(repoRoot, 'ci', 'wave-run.sh'), '--add-mac-time', f, '0', 'pass'], { encoding: 'utf8' });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ result: 'pass', totalDurationS: 100, gates: [] });
  });

  it('a narrow --gates verdict takes a named mac gate\'s row from the mac half: green on its pass, red on its fail, and kept only after', () => {
    // why: F-1430 must-fail probe - the narrow run naming native-suite read its 25 s Spectre fail (no Xcode) while the mac half passed it in 2774 s
    const sh = path.join(repoRoot, 'ci', 'wave-run.sh');
    const t = path.join(dir, 'gate-times-narrow.tsv');
    writeFileSync(t, 'native-suite\t2774\tpass\n');
    // The container's verdict of a --gates run as ci/run-gates.ts writes it in the wave container: the named mac gate skipped, the rest run.
    const container = () => verdict('narrow.json', { result: 'pass', mode: 'gates', scope: 'gates', sha: WANT, totalDurationS: 7720, gates: [
      { id: 'page-walkers', status: 'pass', durationS: 2034 }, { id: 'native-suite', status: 'skipped', durationS: 0 },
    ] });
    const judge = (f: string) => spawnSync('bash', [sh, '--check-verdict', f, WANT, 'gates'], { encoding: 'utf8' });
    const green = container();
    expect(spawnSync('bash', [sh, '--add-mac-time', green, '2774', 'pass', t, '0'], { encoding: 'utf8' }).status).toBe(0);
    expect(JSON.parse(readFileSync(green, 'utf8')).gates.find((x: { id: string }) => x.id === 'native-suite')).toEqual({ id: 'native-suite', durationS: 2774, status: 'pass' });
    expect(judge(green).status, judge(green).stderr).toBe(0);
    writeFileSync(t, 'native-suite\t2774\tfail\n');
    const red = container();
    expect(spawnSync('bash', [sh, '--add-mac-time', red, '2774', 'fail', t, '0'], { encoding: 'utf8' }).status).toBe(0);
    expect(JSON.parse(readFileSync(red, 'utf8')).gates.find((x: { id: string }) => x.id === 'native-suite')).toEqual({ id: 'native-suite', durationS: 2774, status: 'fail' });
    expect(judge(red).status).toBe(1);
    // The real path (no container here, so pinned in the non-comment text): the mac rows go into every verdict but the push one, and the
    // narrow verdict is kept under NARROW-RUNS only after them.
    const lines = readFileSync(sh, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l));
    const add = lines.findIndex((l) => /add_mac_time "\$VERDICT" "\$MAC_HALF_S"/.test(l));
    const kept = lines.findIndex((l) => l.includes('.build/evidence/NARROW-RUNS/ci-verdict-'));
    expect(lines[add]).toMatch(/^\[ "\$EXPECT" = all \] \|\| add_mac_time /);
    expect(kept, 'the narrow verdict is kept after the mac rows are in').toBeGreaterThan(add);
  });
});

