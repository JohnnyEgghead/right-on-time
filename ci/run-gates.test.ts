// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling (checks ci/run-gates.ts and ci/ci.sh, BUILD_PLAN P1-GATES; no product requirement)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canStart, defaultCap, globToRegExp, loadMap, startOrder, validateMap, type Gate } from './gates-lib.ts';

const runner = path.resolve(import.meta.dirname, 'run-gates.ts');
let root: string;

function gate(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, when: 'merge', critical: false, builders: ['T-1'], activates: 'T-1', activeFromPhase: 1, cmd: 'true', ...extra };
}

function setup(gates: unknown[], markers: string[]) {
  mkdirSync(path.join(root, 'ci', 'active'), { recursive: true });
  for (const m of markers) writeFileSync(path.join(root, 'ci', 'active', m), '');
  writeFileSync(path.join(root, 'ci', 'gates.json'), JSON.stringify({ gates }));
}

/** Alive and not a zombie (a container without an init leaves killed orphans as zombies). */
function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/** F-1819: wait until every pid has stopped (up to 10 s), never a fixed time. */
async function gone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (pids.some((p) => isRunning(p)) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
}

function run(...args: string[]) {
  return runEnv({}, ...args);
}

function runEnv(extra: Record<string, string>, ...args: string[]) {
  const r = spawnSync('node', [runner, ...args], {
    // Hermetic (F-29): drop every CI_* and GATE_* variable the caller exported.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE|BW_PW)_/.test(k))), CI_ROOT: root, CI_TIME_CHECK_CMD: '', ...extra },
    encoding: 'utf8',
  });
  const verdict = () => JSON.parse(readFileSync(path.join(root, '.build', 'ci', 'ci-verdict.json'), 'utf8'));
  return { status: r.status, out: r.stdout + r.stderr, verdict };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'gates-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ci/run-gates.ts', () => {
  it('stops at start-up on a gate entry with no when', () => {
    // why: tooling
    const noWhen: Record<string, unknown> = gate('G-X');
    delete noWhen.when;
    setup([gate('ok'), noWhen], ['ok', 'G-X']);
    const r = run();
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/G-X: when missing/);
    expect(r.out).not.toMatch(/=== ok/);
  });

  it('a start-up error removes the previous verdict instead of leaving its pass (F-22 c)', () => {
    // why: tooling
    setup([gate('ok')], ['ok']);
    expect(run().status).toBe(0);
    const verdictFile = path.join(root, '.build', 'ci', 'ci-verdict.json');
    expect(existsSync(verdictFile)).toBe(true);
    const noWhen: Record<string, unknown> = gate('G-X');
    delete noWhen.when;
    setup([gate('ok'), noWhen], ['ok', 'G-X']);
    expect(run().status).toBe(2);
    expect(existsSync(verdictFile)).toBe(false);
  });

  it('rejects a when outside merge, wave and signoff', () => {
    // why: tooling
    setup([gate('G-X', { when: 'sometimes' })], ['G-X']);
    expect(run().status).toBe(2);
  });

  it('runs the merge set only, and writes the verdict with durations', () => {
    // why: tooling
    setup([gate('m1', { cmd: 'sleep 0.2' }), gate('w1', { when: 'wave', cmd: 'exit 1' })], ['m1', 'w1']);
    const r = run();
    expect(r.status).toBe(0);
    const v = r.verdict();
    expect(v.result).toBe('pass');
    expect(typeof v.totalDurationS).toBe('number');
    expect(v.gates.find((g: { id: string }) => g.id === 'm1').durationS).toBeGreaterThan(0.1);
    expect(v.suitesRun).toEqual(['m1']);
    expect(v.suitesSkipped).toEqual(['w1']);
  });

  it('a full run writes the flat dashboard verdict with every required key', () => {
    // why: tooling
    setup([gate('m1'), gate('w1', { when: 'wave', cmd: 'exit 1' }), gate('s1', { when: 'signoff' })], ['m1', 'w1']);
    const flat = path.join(root, 'out', 'flat.json');
    const r = runEnv({ CI_FLAT_VERDICT_OUT: flat }, '--all');
    expect(r.status).toBe(1);
    const v = JSON.parse(readFileSync(flat, 'utf8'));
    for (const k of ['ts', 'sha', 'verdict', 'pass', 'pending', 'fail', 'total', 'failing', 'byDesignFailing', 'hygieneFailing', 'gates', 'totalDurationS']) {
      expect(v).toHaveProperty(k);
    }
    expect(v).toMatchObject({ verdict: 'fail', pass: 1, pending: 1, fail: 1, total: 3, failing: ['w1'], byDesignFailing: [], hygieneFailing: [] });
    expect(v.gates.map((g: { id: string; status: string }) => `${g.id}:${g.status}`)).toEqual(['m1:pass', 'w1:fail', 's1:inactive']);
    expect(Object.keys(v.gates[0]).sort()).toEqual(['durationS', 'id', 'status']);
    // The shared contract checker accepts it, when the jl-dev plugin is installed here.
    const check = path.join(process.env.HOME ?? '', '.claude/plugins/cache/jl-plugins/jl-dev/0.3.109/contracts/check.py');
    if (existsSync(check)) {
      const c = spawnSync('python3', [check, 'parse', 'ci-verdict', flat], { encoding: 'utf8' });
      expect(c.status).toBe(0);
    }
  });

  it('a merge run writes ci-only-verdict.json and leaves an existing full verdict untouched', () => {
    // why: tooling
    setup([gate('m1')], ['m1']);
    mkdirSync(path.join(root, '.build'), { recursive: true });
    const full = path.join(root, '.build', 'ci-verdict.json');
    writeFileSync(full, '{"full":"keep me"}\n');
    const r = run();
    expect(r.status).toBe(0);
    expect(readFileSync(full, 'utf8')).toBe('{"full":"keep me"}\n');
    const only = JSON.parse(readFileSync(path.join(root, '.build', 'ci-only-verdict.json'), 'utf8'));
    expect(only).toMatchObject({ verdict: 'pass', pass: 1, total: 1, failing: [] });
    expect(r.verdict().result).toBe('pass');
  });

  it('records the engines the run used, and a dropped engine with its reason (F-47)', () => {
    // why: tooling
    setup([gate('m1')], ['m1']);
    expect(run().verdict().engines).toEqual({ run: ['chromium', 'webkit'], dropped: [], why: null });
    const narrowed = runEnv({ BW_PW_ENGINES: 'chromium', BW_PW_ENGINES_WHY: 'no WebKit build here' });
    expect(narrowed.status).toBe(0);
    expect(narrowed.verdict().engines).toEqual({ run: ['chromium'], dropped: ['webkit'], why: 'no WebKit build here' });
    expect(runEnv({ BW_PW_ENGINES: 'chromium' }).status).toBe(2);
  });

  it('writes engines from the gates that ran: a push run of Chromium-only browser gates does not say WebKit ran', () => {
    // why: P3-CI-CADENCE - the old record read the runner env, so a push verdict said webkit ran while page-walkers ran Chromium only
    setup([gate('plain', { when: 'wave', activeFromPhase: 1 }), gate('bro', { when: 'wave', engines: ['chromium'] })], ['plain', 'bro']);
    const push = run('--all').verdict();
    expect(push.scope).toBe('push');
    expect(push.engines.run).toEqual(['chromium']);
    expect(push.engines.dropped).toEqual(['webkit']);
    expect(push.engines.why).toContain('webkit runs in the nightly set');
    // a browser gate that declares both engines keeps the full record, and a set with no browser gate keeps the env record
    setup([gate('bro2', { when: 'wave', engines: ['chromium', 'webkit'] })], ['bro2']);
    expect(run('--all').verdict().engines).toEqual({ run: ['chromium', 'webkit'], dropped: [], why: null });
    setup([gate('plain', { when: 'wave' })], ['plain']);
    expect(run('--all').verdict().engines).toEqual({ run: ['chromium', 'webkit'], dropped: [], why: null });
  });

  it('stops at start-up on an engines list that names an unknown engine', () => {
    // why: tooling - a typo in a gate's engines would write a false record
    setup([gate('bro', { engines: ['firefox'] })], ['bro']);
    expect(run().status).toBe(2);
  });

  it('declares the engines its script narrows to, for the 4 browser gates', () => {
    // why: P3-CI-CADENCE - gates.json engines and the script's BW_PW_ENGINES must agree, or the verdict record is false again
    const real = loadMap(path.resolve(import.meta.dirname, 'gates.json'));
    const declared = (id: string) => real.gates.find((g) => g.id === id)?.engines;
    for (const id of ['page-walkers', 'look-values-comparator']) {
      expect(declared(id), id).toEqual(['chromium']);
      expect(readFileSync(path.resolve(import.meta.dirname, 'gates', `${id}.sh`), 'utf8'), id).toMatch(/^export BW_PW_ENGINES=chromium$/m);
    }
    expect(declared('page-walkers-nightly')).toEqual(['chromium', 'webkit']);
    expect(declared('look-values-comparator-nightly')).toEqual(['webkit']);
    expect(readFileSync(path.resolve(import.meta.dirname, 'gates', 'look-values-comparator-nightly.sh'), 'utf8')).toMatch(/^export BW_PW_ENGINES=webkit$/m);
  });

  it('prints the activating task of an inactive gate and does not fail on it', () => {
    // why: tooling
    setup([gate('G-CI9', { when: 'wave', activates: 'P3-OUTBOX', cmd: null })], []);
    const r = run('--all');
    expect(r.status).toBe(0);
    expect(r.out).toContain('INACTIVE G-CI9: activates when P3-OUTBOX merges');
    expect(r.verdict().gates[0].status).toBe('inactive');
  });

  it('--all runs every gate to the end past a red one, and exits 1', () => {
    // why: tooling
    setup([gate('a', { cmd: 'exit 3' }), gate('b', { when: 'wave', cmd: 'echo ran-b' })], ['a', 'b']);
    const r = run('--all');
    expect(r.status).toBe(1);
    expect(r.out).toContain('ran-b');
    const v = r.verdict();
    expect(v.result).toBe('fail');
    expect(v.gates.map((g: { status: string }) => g.status)).toEqual(['fail', 'pass']);
  });

  it('--records runs only the gates that declare reads', () => {
    // why: tooling
    setup([gate('plain'), gate('rec', { reads: ['docs/build/**'] })], ['plain', 'rec']);
    const r = run('--records');
    expect(r.status).toBe(0);
    expect(r.verdict().suitesRun).toEqual(['rec']);
  });

  it('fails an active gate with cmd null and no script, naming the file to add', () => {
    // why: tooling
    setup([gate('G-Y', { cmd: null })], ['G-Y']);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('ci/gates/G-Y.sh is missing');
    expect(r.verdict().gates[0].reason).toContain('ci/gates/G-Y.sh');
  });

  it('keeps a cmd-null gate inactive when its script exists but its marker does not', () => {
    // why: tooling
    setup([gate('G-Z', { cmd: null, activates: 'P9-X' })], []);
    mkdirSync(path.join(root, 'ci', 'gates'), { recursive: true });
    writeFileSync(path.join(root, 'ci', 'gates', 'G-Z.sh'), 'exit 1\n');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('INACTIVE G-Z: activates when P9-X merges');
  });

  it('runs the convention script of an active cmd-null gate, and its exit code decides', () => {
    // why: tooling
    setup([gate('G-S', { cmd: null })], ['G-S']);
    mkdirSync(path.join(root, 'ci', 'gates'), { recursive: true });
    const script = path.join(root, 'ci', 'gates', 'G-S.sh');
    writeFileSync(script, 'echo ran-script\nexit 0\n');
    const green = run();
    expect(green.status).toBe(0);
    expect(green.out).toContain('ran-script');
    writeFileSync(script, 'exit 1\n');
    expect(run().status).toBe(1);
  });

  it('kills a gate over its time limit, records a timeout reason, and leaves no process', async () => {
    // why: tooling
    const pidFile = path.join(root, 'child.pid');
    setup([gate('G-T', { cmd: `sleep 30 & echo $! > "${pidFile}"; wait`, timeoutS: 1 }), gate('after', { cmd: 'echo ran-after' })], ['G-T', 'after']);
    const t0 = Date.now();
    const r = run();
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/timeout: exceeded 1s/);
    expect(r.out).toContain('ran-after');
    const v = r.verdict();
    expect(v.gates[0].status).toBe('fail');
    expect(v.gates[0].reason).toMatch(/^timeout/);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await gone([pid]);
    expect(isRunning(pid)).toBe(false);
  });

  it('uses defaultTimeoutS from the map when the gate has no timeoutS of its own', () => {
    // why: tooling
    mkdirSync(path.join(root, 'ci', 'active'), { recursive: true });
    writeFileSync(path.join(root, 'ci', 'active', 'slow'), '');
    writeFileSync(path.join(root, 'ci', 'gates.json'), JSON.stringify({ defaultTimeoutS: 1, gates: [gate('slow', { cmd: 'sleep 20' })] }));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/timeout: exceeded 1s/);
  });

  it('stops at start-up on a time limit that is not a positive number', () => {
    // why: tooling
    setup([gate('G-B', { timeoutS: 0 })], ['G-B']);
    const r = run();
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/G-B: timeoutS must be a positive number/);
  });

  it('refuses an unknown flag', () => {
    // why: tooling
    setup([gate('a')], ['a']);
    expect(run('--everything').status).toBe(2);
  });

  it('a usage error removes the previous verdicts, the flat ones too, instead of leaving their pass (F-108)', () => {
    // why: tooling
    setup([gate('ok')], ['ok']);
    expect(run().status).toBe(0);
    const files = ['ci/ci-verdict.json', 'ci-verdict.json', 'ci-only-verdict.json'].map((f) => path.join(root, '.build', f));
    writeFileSync(files[1]!, '{}');
    expect(files.every((f) => existsSync(f))).toBe(true);
    expect(run('--bogus').status).toBe(2);
    expect(files.some((f) => existsSync(f))).toBe(false);
  });
});

// F-408: onlyWhenChanged scopes a wave gate to changed paths, relative to the last recorded full run that ran it green.
describe('ci/run-gates.ts onlyWhenChanged (F-408)', () => {
  const GLOBS = ['infra/backup/**', 'packages/db/migrations/**', 'ci/gates/restore-test.sh'];

  function git(...args: string[]): string {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
    return r.stdout.trim();
  }

  function put(rel: string, text: string) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }

  /** A repo with a scoped critical wave gate (its cmd fails: if it runs it is red) and an unscoped one, committed at a base sha. */
  function scoped(): string {
    setup([gate('scoped', { when: 'wave', critical: true, cmd: 'false', onlyWhenChanged: GLOBS }), gate('plain', { when: 'wave' })], ['scoped', 'plain']);
    put('.gitignore', '.build/\n');
    put('infra/backup/backup.sh', 'a\n');
    put('packages/db/migrations/0001.sql', 'a\n');
    put('docs/x.md', 'a\n');
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    return git('rev-parse', 'HEAD');
  }

  function history(sha: string) {
    put('.build/ci-time.jsonl', JSON.stringify({ scope: 'full', sha, gateStatus: { scoped: 'pass', plain: 'pass' } }) + '\n');
  }

  function change(rel: string) {
    put(rel, 'changed\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
  }

  const status = (r: ReturnType<typeof run>, id: string) => r.verdict().gates.find((g: { id: string }) => g.id === id).status;

  it('a change under packages/db/migrations makes the scoped gate run', () => {
    // why: tooling
    const base = scoped();
    history(base);
    change('packages/db/migrations/0002.sql');
    const r = run('--all');
    expect(status(r, 'scoped')).toBe('fail'); // it ran: its cmd is false
    expect(r.out).toMatch(/scope scoped: runs \(packages\/db\/migrations\/0002\.sql changed since/);
    expect(r.status).toBe(1);
  });

  it('a change under infra/backup makes the scoped gate run', () => {
    // why: tooling
    const base = scoped();
    history(base);
    change('infra/backup/tests/new.test.ts');
    expect(status(run('--all'), 'scoped')).toBe('fail');
  });

  it('an uncommitted or untracked file under a glob makes it run', () => {
    // why: tooling
    const base = scoped();
    history(base);
    put('infra/backup/untracked.sh', 'x\n');
    expect(status(run('--all'), 'scoped')).toBe('fail');
  });

  it('a red run after the green one leaves no base, so the gate runs although the scoped files are unchanged', () => {
    // why: F-413 F-418 - the base sha is real here (in the history), so this passes through the row filter, not the missing-sha branch
    const base = scoped();
    put('.build/ci-time.jsonl', [
      JSON.stringify({ scope: 'full', sha: base, gateStatus: { scoped: 'pass', plain: 'pass' } }),
      JSON.stringify({ scope: 'full', sha: base, gateStatus: { scoped: 'fail', plain: 'pass' } }),
    ].join('\n') + '\n');
    change('docs/x.md');
    const r = run('--all');
    expect(status(r, 'scoped')).toBe('fail');
    expect(r.out).toContain('no recorded green');
  });

  it('an uncommitted edit of a tracked file under a glob makes it run', () => {
    // why: F-418 - the existing case adds only an untracked file; this one edits a file already tracked, with no commit
    const base = scoped();
    history(base);
    put('infra/backup/backup.sh', 'edited, not committed\n');
    expect(status(run('--all'), 'scoped')).toBe('fail');
  });

  it('a change only outside the globs skips it with its own named status and the base sha; the run stays green', () => {
    // why: tooling
    const base = scoped();
    history(base);
    change('docs/x.md');
    const r = run('--all');
    expect(status(r, 'scoped')).toBe('unchanged');
    const g = r.verdict().gates.find((x: { id: string }) => x.id === 'scoped');
    expect(g.base).toBe(base);
    expect(g.reason).toBe(`no change in ${GLOBS.join(', ')} since ${base}`);
    expect(r.out).toContain(`skipped (no change in ${GLOBS.join(', ')} since ${base})`);
    const v = r.verdict();
    expect(v.suitesSkipped).toContain('scoped');
    expect(v.suitesRun).not.toContain('scoped');
    expect(v.result).toBe('pass'); // a critical gate's skip is not red
    expect(r.status).toBe(0);
  });

  it('the status written for a scoped-out gate does not read as not-run to the jl-dev lap brake', () => {
    // why: F-412 - ci-lap-check.py NOT_RUN = skip|not.?run|dropped|absent (case-insensitive); a rename back would flag every scoped wave
    const base = scoped();
    history(base);
    change('docs/x.md');
    const st = run('--all').verdict().gates.find((x: { id: string }) => x.id === 'scoped').status;
    expect(st).toBe('unchanged');
    expect(st).not.toMatch(/skip|not.?run|dropped|absent/i);
  });

  it('no base record makes it run', () => {
    // why: tooling
    scoped();
    change('docs/x.md');
    expect(status(run('--all'), 'scoped')).toBe('fail');
    put('.build/ci-time.jsonl', JSON.stringify({ scope: 'full', sha: 'f'.repeat(40), gateStatus: { scoped: 'unchanged' } }) + '\n');
    expect(status(run('--all'), 'scoped')).toBe('fail'); // a skipped or red row is not a base
  });

  it('a base sha missing from history makes it run', () => {
    // why: tooling
    scoped();
    history('f'.repeat(40));
    change('docs/x.md');
    const r = run('--all');
    expect(status(r, 'scoped')).toBe('fail');
    expect(r.out).toMatch(/is not in this clone's history/);
  });

  it('a shallow clone makes it run', () => {
    // why: tooling
    const base = scoped();
    change('docs/x.md');
    const clone = path.join(root, 'clone');
    const r0 = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, clone], { encoding: 'utf8' });
    expect(r0.status).toBe(0);
    mkdirSync(path.join(clone, '.build'), { recursive: true });
    writeFileSync(path.join(clone, '.build', 'ci-time.jsonl'), JSON.stringify({ scope: 'full', sha: base, gateStatus: { scoped: 'pass' } }) + '\n');
    const r = spawnSync('node', [runner, '--all'], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE|BW_PW)_/.test(k))), CI_ROOT: clone, CI_TIME_CHECK_CMD: '' },
      encoding: 'utf8',
    });
    expect(r.stdout + r.stderr).toMatch(/shallow clone/);
    expect(r.status).toBe(1);
  });

  it('an unscoped gate is unaffected, and the merge set never scopes', () => {
    // why: tooling
    const base = scoped();
    history(base);
    change('docs/x.md');
    const r = run('--all');
    expect(status(r, 'plain')).toBe('pass');
    expect(r.verdict().gates.find((g: { id: string }) => g.id === 'plain').base).toBeUndefined();
    const m = run();
    expect(status(m, 'plain')).toBe('skipped');
    expect(status(m, 'scoped')).toBe('skipped');
  });

  it('onlyWhenChanged on a merge gate or an empty list stops at start-up', () => {
    // why: tooling
    setup([gate('m', { onlyWhenChanged: ['a/**'] })], ['m']);
    expect(run().out).toMatch(/m: onlyWhenChanged is for wave and signoff gates/);
    setup([gate('w', { when: 'wave', onlyWhenChanged: [] })], ['w']);
    const r = run('--all');
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/w: onlyWhenChanged must be a non-empty list/);
  });
});

// F-410 (owner ruling ffd9f9ff): gates side by side. A probe gate marks itself running in run/, records which gates
// it sees running at its start and at its end (1 line each, in seen/<id>), then unmarks itself. Any 2 gates that
// overlapped are seen together by at least one of them, since the later starter sees the earlier one's mark.
describe('ci/run-gates.ts side by side (F-410)', () => {
  const PROBE = [
    'id="$1"; s="$2"; mkdir -p run seen',
    'touch "run/$id"; echo $(ls run) >> "seen/$id"',
    'echo "first-$id"; sleep "$s"; echo "second-$id"',
    'echo $(ls run) >> "seen/$id"; rm -f "run/$id"',
    'exit "${3:-0}"',
  ].join('\n');
  const probe = (id: string, s: number, extra: Record<string, unknown> = {}, rc = 0) => gate(id, { cmd: `bash probe.sh ${id} ${s} ${rc}`, ...extra });
  const par = (...exclusive: string[]) => ({ parallel: { exclusive } });
  function setupPar(gates: Record<string, unknown>[], groups: Record<string, string> = {}) {
    mkdirSync(path.join(root, 'ci', 'active'), { recursive: true });
    for (const g of gates) writeFileSync(path.join(root, 'ci', 'active', String(g.id)), '');
    writeFileSync(path.join(root, 'ci', 'gates.json'), JSON.stringify({ exclusiveGroups: groups, gates }));
    writeFileSync(path.join(root, 'probe.sh'), PROBE + '\n');
  }
  /** Every snapshot each gate took: the ids running at that moment. */
  function seen(): Map<string, string[][]> {
    const dir = path.join(root, 'seen');
    const out = new Map<string, string[][]>();
    for (const f of readdirSync(dir)) out.set(f, readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => l.split(' ').filter(Boolean)));
    return out;
  }
  const together = (s: Map<string, string[][]>, a: string, b: string) =>
    [...s.values()].some((snaps) => snaps.some((ids) => ids.includes(a) && ids.includes(b)));
  const most = (s: Map<string, string[][]>) => Math.max(...[...s.values()].flat().map((ids) => ids.length));

  it('runs declared gates side by side up to the cap, and a gate with no parallel field alone', () => {
    // why: F-410 - the safe default: an undeclared gate never joins the pool; declared ones overlap but never past the cap
    setupPar([probe('a', 0.6, par()), probe('b', 0.6, par()), probe('u', 0.3), probe('c', 0.6, par()), probe('d', 0.6, par())]);
    const r = runEnv({ CI_MAX_PARALLEL: '2' });
    expect(r.status).toBe(0);
    const s = seen();
    expect(most(s)).toBe(2);
    expect(together(s, 'a', 'b') || together(s, 'a', 'c') || together(s, 'a', 'd')).toBe(true);
    for (const other of ['a', 'b', 'c', 'd']) expect(together(s, 'u', other)).toBe(false);
    const v = r.verdict();
    expect(v.maxParallel).toBe(2);
    expect(v.totalDurationS).toBeLessThan(v.gateDurationSumS);
    expect(r.out).toContain('alone (no parallel field): u');
  });

  it('must fail if a gate with no parallel field is ever run beside another gate, at any cap', () => {
    // why: F-410 - a must-fail pin on the safe default: dropping it lets an unchecked gate share resources unseen
    setupPar([probe('p1', 0.6, par()), probe('lone1', 0.4), probe('p2', 0.6, par()), probe('lone2', 0.4), probe('p3', 0.6, par())]);
    expect(runEnv({ CI_MAX_PARALLEL: '8' }).status).toBe(0);
    const s = seen();
    for (const lone of ['lone1', 'lone2']) {
      expect(s.get(lone)?.flat().every((id) => id === lone)).toBe(true);
      for (const other of ['p1', 'p2', 'p3', 'lone1', 'lone2'].filter((o) => o !== lone)) expect(together(s, lone, other)).toBe(false);
    }
    expect(together(s, 'p1', 'p2') || together(s, 'p2', 'p3') || together(s, 'p1', 'p3')).toBe(true);
  });

  it('never overlaps 2 gates that share an exclusive group', () => {
    // why: F-410 - engine-net: a Compose bring-up beside a browser fails the page load (F-290), so group members take turns
    setupPar([probe('x1', 0.8, par('net')), probe('free', 1.2, par()), probe('x2', 0.8, par('net', 'other')), probe('x3', 0.5, par('other'))], { net: 'the namespace', other: 'a lock' });
    expect(runEnv({ CI_MAX_PARALLEL: '4' }).status).toBe(0);
    const s = seen();
    expect(together(s, 'x1', 'x2')).toBe(false);
    expect(together(s, 'x2', 'x3')).toBe(false);
    expect(together(s, 'free', 'x1') || together(s, 'free', 'x2')).toBe(true);
  });

  it('reports results in map order with their statuses and times; a failing and a timed-out gate end only their own group', () => {
    // why: F-410 - verdict readers (ci-time-check, ci-lap-check, check_verdict) need map order; a kill must not reach a neighbor
    const kid = path.join(root, 'kid.pid');
    setupPar([
      probe('slow', 2, par()),
      probe('red', 0.2, par(), 3),
      gate('late', { cmd: `sleep 30 & echo $! > "${kid}"; wait`, timeoutS: 1, ...par() }),
      probe('quick', 0.1, par()),
    ]);
    const r = runEnv({ CI_MAX_PARALLEL: '4' });
    expect(r.status).toBe(1);
    const v = r.verdict();
    expect(v.gates.map((g: { id: string }) => g.id)).toEqual(['slow', 'red', 'late', 'quick']);
    expect(v.gates.map((g: { status: string }) => g.status)).toEqual(['pass', 'fail', 'fail', 'pass']);
    expect(v.gates[2].reason).toBe('timeout: exceeded 1s and was killed');
    expect(v.gates[1].reason).toBeUndefined();
    expect(v.gates[0].durationS).toBeGreaterThanOrEqual(2);
    expect(v.gates[2].durationS).toBeGreaterThanOrEqual(1);
    expect(v.gates[2].durationS).toBeLessThan(4);
    expect(v.gateDurationSumS).toBeCloseTo(v.gates.reduce((a: number, g: { durationS: number }) => a + g.durationS, 0), 1);
    expect(isRunning(Number(readFileSync(kid, 'utf8').trim()))).toBe(false);
    const flat = JSON.parse(readFileSync(path.join(root, '.build', 'ci-only-verdict.json'), 'utf8'));
    expect(flat.gates.map((g: { id: string }) => g.id)).toEqual(['slow', 'red', 'late', 'quick']);
    expect(flat.failing).toEqual(['red', 'late']);
    // Each gate's output is 1 block: its header, its own lines with nothing between, its result line.
    expect(r.out).toMatch(/=== slow \(merge\): bash probe\.sh slow 2 0\nfirst-slow\nsecond-slow\n=== slow: pass in [\d.]+s\n/);
    expect(r.out).toMatch(/first-red\nsecond-red\n=== red: FAIL in/);
    expect(r.out).toMatch(/ci\.sh: gate late timeout: exceeded 1s and was killed\n=== late: FAIL in/);
  });

  it('ends what a gate left running when the gate itself ends (W-47)', () => {
    // why: F-410 - a gate's leftover process could hold a resource the next gate of its group needs
    const kid = path.join(root, 'left.pid');
    setupPar([gate('leaves', { cmd: `(sleep 30 & echo $! > "${kid}") ; exit 0`, ...par() }), probe('other', 0.2, par())]);
    expect(runEnv({ CI_MAX_PARALLEL: '2' }).status).toBe(0);
    expect(isRunning(Number(readFileSync(kid, 'utf8').trim()))).toBe(false);
  });

  it('kills every running gate group when the runner gets SIGTERM, and leaves no process', async () => {
    // why: F-410 - W-47: a stopped run must not leave gates (or what they started) running beside the next run
    const pids = ['g1', 'g2'].map((id) => path.join(root, `${id}.pid`));
    setupPar([
      gate('g1', { cmd: `sleep 30 & echo $! > "${pids[0]}"; wait`, ...par() }),
      gate('g2', { cmd: `sleep 30 & echo $! > "${pids[1]}"; wait`, ...par() }),
      probe('g3', 0.1, par()),
    ]);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE|BW_PW)_/.test(k))), CI_ROOT: root, CI_TIME_CHECK_CMD: '', CI_MAX_PARALLEL: '3' };
    const child = spawn('node', [runner], { env, stdio: 'ignore' });
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    const deadline = Date.now() + 15000;
    while (!pids.every((p) => existsSync(p) && readFileSync(p, 'utf8').trim() !== '') && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    await gone(pids.map((p) => Number(readFileSync(p, 'utf8').trim())));
    for (const p of pids) expect(isRunning(Number(readFileSync(p, 'utf8').trim()))).toBe(false);
    expect(existsSync(path.join(root, '.build', 'ci', 'ci-verdict.json'))).toBe(false);
  });

  it('runs 1 gate at a time in map order with --serial, CI_MAX_PARALLEL=1 or --jobs=1', () => {
    // why: F-410 - the serial runner stays available, unchanged, to rule concurrency out of a red
    const ways: [Record<string, string>, string[]][] = [[{}, ['--serial']], [{ CI_MAX_PARALLEL: '1' }, []], [{ CI_MAX_PARALLEL: '4' }, ['--jobs=1']]];
    for (const [env, args] of ways) {
      setupPar([probe('s1', 0.1, par()), probe('s2', 0.1, par()), probe('s3', 0.1, par())]);
      const r = runEnv(env, ...args);
      expect(r.status).toBe(0);
      expect(most(seen())).toBe(1);
      expect(r.verdict().maxParallel).toBe(1);
      expect(r.out.indexOf('=== s1')).toBeLessThan(r.out.indexOf('=== s2'));
      expect(r.out.indexOf('=== s2')).toBeLessThan(r.out.indexOf('=== s3'));
      rmSync(path.join(root, 'seen'), { recursive: true, force: true });
    }
  });

  it('stops at start-up on a bad cap or a malformed parallel field', () => {
    // why: F-410 - a typo in a group name would silently stop excluding, so an undeclared group is a start-up error
    setupPar([probe('a', 0, par('nope'))], { net: 'the namespace' });
    let r = runEnv({});
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/a: parallel.exclusive names nope, which is not in exclusiveGroups/);
    setupPar([probe('a', 0, { parallel: true })]);
    expect(runEnv({}).out).toMatch(/a: parallel must be \{ "exclusive"/);
    setupPar([probe('a', 0, par())]);
    const bad: [Record<string, string>, string[]][] = [[{ CI_MAX_PARALLEL: '0' }, []], [{ CI_MAX_PARALLEL: 'lots' }, []], [{}, ['--jobs=']]];
    for (const [env, args] of bad) {
      r = runEnv(env, ...args);
      expect(r.status).toBe(2);
      expect(r.out).toMatch(/must be a whole number of gates/);
    }
  });

  it('offers slots longest recorded gate first, an unrecorded gate before them, ties in map order', () => {
    // why: F-410 - the long engine-net chain must start at once or it sets the wall time
    const g = (id: string, index: number) => ({ g: { id } as Gate, index });
    const order = startOrder([g('a', 0), g('b', 1), g('new', 2), g('c', 3), g('d', 4)], new Map([['a', 5], ['b', 50], ['c', 50], ['d', 0.5]]));
    expect(order.map((o) => o.g.id)).toEqual(['new', 'b', 'c', 'a', 'd']);
  });

  it('sizes the default cap at 2 on the 8-CPU, 16.6 GB wave rig and lower on a smaller host', () => {
    // why: F-410 - the engine-net chain outlasts every other gate in 1 lane beside it; a 3rd slot adds only contention
    expect(defaultCap(8, 16.6e9)).toBe(2);
    expect(defaultCap(64, 256 * 2 ** 30)).toBe(2);
    expect(defaultCap(3, 16 * 2 ** 30)).toBe(1);
    expect(defaultCap(2, 64 * 2 ** 30)).toBe(1);
    expect(defaultCap(8, 6 * 2 ** 30)).toBe(1);
  });

  it('canStart: alone when undeclared, under the cap, no shared group', () => {
    // why: F-410 - the start rule itself, apart from process timing
    const mk = (id: string, exclusive?: string[]) => ({ id, ...(exclusive ? { parallel: { exclusive } } : {}) }) as Gate;
    expect(canStart(mk('u'), [], 3)).toBe(true);
    expect(canStart(mk('u'), [mk('p', [])], 3)).toBe(false);
    expect(canStart(mk('p', []), [mk('u')], 3)).toBe(false);
    expect(canStart(mk('p', []), [mk('q', []), mk('r', [])], 2)).toBe(false);
    expect(canStart(mk('p', ['net']), [mk('q', ['net'])], 3)).toBe(false);
    expect(canStart(mk('p', ['net']), [mk('q', ['lock'])], 3)).toBe(true);
  });
});

// F-410: the real map. Each declaration was checked against the files the gate runs; these pin the ones a later edit could lose.
describe('ci/gates.json parallel declarations (F-410)', () => {
  const real = loadMap(path.resolve(import.meta.dirname, 'gates.json'));
  const repo = path.resolve(import.meta.dirname, '..');
  const scriptOf = (g: Gate) => path.resolve(import.meta.dirname, 'gates', `${g.id}.sh`);
  // A file that starts or removes a container, starts a Compose stack, builds an image or drives a browser touches the
  // run engine's network namespace (a browser is the side a namespace change breaks: F-290).
  // A Compose call, not the word (billing code composes invoices).
  const ENGINE = /\bdocker\b|\bcompose\s+(?:up|down|build|run|exec|ps|logs|-f|-p)\b|-stack\.sh|vitest\.browser\.config|playwright|\bchromium\b|\bwebkit\b/;
  // F-481: a comment line, not a shell case branch: a line that starts with * is a block-comment line only when the * is
  // followed by a space, a slash or the end (` * text`, ` */`), never `*" --records "*) ;;`.
  const code = (f: string) => readFileSync(f, 'utf8').replace(/^\s*(?:#|\/\/|\/\*|\*(?=[\s/]|$)).*$/gm, '');
  const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
  const TEST_CONFIG = /(?:^|\/)(?:vitest|playwright)[\w.-]*\.config\.[cm]?ts$/;
  type TestProject = { include?: string[]; exclude?: string[]; dir?: string; globalSetup?: string | string[]; setupFiles?: string | string[] };
  type TestConfig = {
    root?: string;
    testDir?: string;
    testMatch?: string | string[];
    test?: TestProject & { projects?: { test?: TestProject }[] };
  };
  const ROOT_CONFIG = path.resolve(repo, 'vitest.config.ts');

  // F-464, F-481: the files a test config runs: its include globs less its excludes (a Playwright config: testMatch under
  // testDir; a vitest config with `projects`: each project's own), its globalSetup and its setupFiles.
  async function configFiles(cfg: string): Promise<string[]> {
    const c = ((await import(pathToFileURL(cfg).href)) as { default: TestConfig }).default;
    const base = c.root ?? repo;
    const out: string[] = [];
    const add = (cwd: string, pats: string[], exclude: string[]) => {
      for (const f of globSync(pats, { cwd, exclude: (d) => d.includes('node_modules') })) {
        const rel = path.relative(base, path.resolve(cwd, f));
        if (!exclude.some((x) => path.matchesGlob(rel, x))) out.push(path.resolve(cwd, f));
      }
    };
    const pw = c.testDir !== undefined;
    if (pw) {
      add(path.resolve(path.dirname(cfg), c.testDir!), [c.testMatch ?? '**/*.@(spec|test).?(c|m)[jt]s?(x)'].flat(), []);
    } else {
      const t = c.test ?? {};
      const projects: TestProject[] = t.projects !== undefined ? t.projects.map((x) => x.test ?? {}) : [t];
      for (const pr of projects) {
        add(pr.dir === undefined ? base : path.resolve(base, pr.dir), pr.include ?? ['**/*.{test,spec}.?(c|m)[jt]s?(x)'], pr.exclude ?? []);
        for (const s of [pr.globalSetup ?? [], pr.setupFiles ?? []].flat()) out.push(path.resolve(base, s));
      }
    }
    return out.filter(isFile);
  }

  // F-481 (3): the workspace packages by name (@bw/time -> packages/time), so an @bw/ import reaches the package's own source.
  const workspace = new Map<string, { dir: string; main: string | undefined }>();
  for (const parent of ['packages', 'apps']) {
    for (const d of readdirSync(path.resolve(repo, parent))) {
      const pj = path.resolve(repo, parent, d, 'package.json');
      if (!isFile(pj)) continue;
      const j = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; main?: string };
      if (j.name !== undefined) workspace.set(j.name, { dir: path.dirname(pj), main: j.main });
    }
  }
  const SOURCE_EXT = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
  /** The file an import specifier names: relative (with or without an extension, or a folder's index) or a workspace package. */
  function resolveImport(from: string, spec: string): string | undefined {
    const tryPath = (p: string): string | undefined =>
      [p, ...SOURCE_EXT.map((e) => p + e), ...SOURCE_EXT.map((e) => path.join(p, 'index' + e))].find(isFile);
    if (spec.startsWith('.')) return tryPath(path.resolve(path.dirname(from), spec));
    const m = /^((?:@[\w-]+\/)?[\w-]+)(\/.*)?$/.exec(spec);
    const pkg = m?.[1] === undefined ? undefined : workspace.get(m[1]);
    if (pkg === undefined) return undefined;
    return m?.[2] !== undefined ? tryPath(path.join(pkg.dir, m[2])) ?? tryPath(path.join(pkg.dir, 'src', m[2])) : pkg.main === undefined ? tryPath(path.join(pkg.dir, 'src', 'index')) : tryPath(path.resolve(pkg.dir, pkg.main));
  }

  // F-481 (1, 2): a vitest call with no --config reads the root vitest.config.ts, and a path argument narrows it to the test
  // files under that path. The calls are read from the script text; a call with its own --config is followed by the generic
  // rule below (every file its config runs).
  const VALUE_FLAGS = new Set(['--config', '-c', '--reporter', '--outputFile', '--project', '-t', '--testNamePattern', '--root', '-r']);
  async function rootConfigCalls(text: string): Promise<string[]> {
    const out: string[] = [];
    for (const call of text.matchAll(/\bvitest\s+run\b([^\n|;&<>]*)/g)) {
      const toks = (call[1] ?? '').trim().split(/\s+/).filter((t) => t !== '');
      if (toks.some((t) => t === '--config' || t.startsWith('--config=') || t === '-c')) continue;
      const paths: string[] = [];
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i]!;
        if (VALUE_FLAGS.has(t)) i++;
        else if (!t.startsWith('-') && !/[$"'`]/.test(t) && existsSync(path.resolve(repo, t))) paths.push(path.resolve(repo, t));
      }
      const files = await configFiles(ROOT_CONFIG);
      out.push(...(paths.length === 0 ? files : files.filter((f) => paths.some((p) => f === p || f.startsWith(p + path.sep)))));
    }
    return out;
  }

  // F-464, F-481: the population is every file a gate runs, not only ci/gates/<id>.sh: the script; each script, module or
  // test config it names by path (against its own folder or the repo root); the files each test config runs; the files a
  // vitest call with no --config runs (the root config, narrowed by its path arguments); the files a .ts file imports (a
  // relative import with or without its extension, an @bw/ package through its workspace folder); and the same again for
  // every file found, to the end.
  async function filesRun(script: string): Promise<string[]> {
    const seen = new Set<string>();
    const todo = [script];
    while (todo.length > 0) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = code(f);
      for (const m of text.matchAll(/[\w./-]+\.(?:sh|[cm]?ts|[cm]?js)\b/g)) {
        const p = [path.resolve(path.dirname(f), m[0]), path.resolve(repo, m[0])].find(isFile);
        if (p === undefined || p.includes('node_modules')) continue;
        todo.push(p);
        if (TEST_CONFIG.test(p)) todo.push(...(await configFiles(p)));
      }
      todo.push(...(await rootConfigCalls(text)));
      if (/\.[cm]?ts$/.test(f)) {
        for (const m of text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g)) {
          const p = resolveImport(f, m[1]!);
          if (p !== undefined && !p.includes('node_modules')) todo.push(p);
        }
      }
    }
    return [...seen];
  }
  const scripted = real.gates.filter((g) => g.cmd === null && existsSync(scriptOf(g)));
  const mapManifest = scriptOf(real.gates.find((g) => g.id === 'map-manifest')!);

  it('is well formed, with every exclusive group declared and explained', () => {
    // why: F-410 - a group named but not declared would stop excluding without a sound
    expect(validateMap(real)).toEqual([]);
    expect(Object.keys(real.exclusiveGroups ?? {})).toEqual(['engine-net', 'heavy']);
  });

  it('never runs 2 heavy gates side by side, and page-walkers beside nothing (F-485)', () => {
    // why: F-485 - page-walkers' image build beside G-CI7's database step took 335 s and G-CI7 288 s (wave run d822332); both hit their limits
    const byId = (id: string) => real.gates.find((g) => g.id === id)!;
    const heavy = real.gates.filter((g) => g.parallel?.exclusive.includes('heavy')).map((g) => g.id).sort();
    expect(heavy).toEqual(['G-CI1', 'G-CI2', 'G-CI4', 'G-CI4-nightly', 'G-CI5', 'G-CI7', 'contract-gates', 'import-target-counts', 'look-values-comparator', 'look-values-comparator-nightly', 'map-manifest', 'restore-test', 'typecheck', 'unit-tests']);
    for (const a of heavy) for (const b of heavy) if (a !== b) expect(canStart(byId(a), [byId(b)], 8), `${a} beside ${b}`).toBe(false);
    // Every engine-net gate builds an image, brings up a stack or drives a browser, so it is heavy too.
    for (const g of real.gates.filter((x) => x.parallel?.exclusive.includes('engine-net'))) expect(heavy).toContain(g.id);
    // page-walkers-nightly (P3-CI-CADENCE) is the same gate's nightly half: the same stack suites, so it runs alone too.
    for (const id of ['page-walkers', 'page-walkers-nightly']) {
      const pw = byId(id);
      expect(pw.parallel, id).toBeUndefined();
      for (const g of real.gates.filter((x) => x.id !== id)) {
        expect(canStart(pw, [g], 8), `${id} beside ${g.id}`).toBe(false);
        expect(canStart(g, [pw], 8), `${g.id} beside ${id}`).toBe(false);
      }
    }
    // Control: a light gate still runs beside a heavy one, so the run keeps its side-by-side time (owner ruling ffd9f9ff).
    expect(canStart(byId('G-CI9'), [byId('G-CI7')], 2)).toBe(true);
    expect(canStart(byId('lint'), [byId('restore-test')], 2)).toBe(true);
    // F-915: typecheck is heavy now (70.17 s alone on the rig, over its 300 s limit beside look-values-comparator-nightly at 806f63a8).
    expect(canStart(byId('typecheck'), [byId('look-values-comparator-nightly')], 2)).toBe(false);
    expect(canStart(byId('typecheck'), [byId('G-CI9')], 2)).toBe(true);
    // F-1164: G-CI2 is heavy now (144.35 s alone on the rig, killed at its 300 s limit beside look-values-comparator-nightly at 40f8433c).
    expect(canStart(byId('G-CI2'), [byId('look-values-comparator-nightly')], 2)).toBe(false);
    expect(canStart(byId('G-CI2'), [byId('lint')], 2)).toBe(true);
  });

  it('follows a gate past its own script into the configs it names and the test files they run', async () => {
    // why: F-464 - the maps config map-manifest.sh runs names no docker, but it includes a test that starts nginx in a container
    // (P6-ROUTE-BAKE: the script itself now also runs a stack script, ci/route-bake-stack.sh, so the indirection is proved on the config)
    const mapsConfig = path.resolve(repo, 'packages/maps/vitest.maps.config.ts');
    expect(ENGINE.test(code(mapsConfig))).toBe(false);
    const files = await filesRun(mapManifest);
    expect(files).toContain(path.resolve(repo, 'ci/route-bake-stack.sh'));
    expect(files).toContain(path.resolve(repo, 'packages/maps/vitest.maps.config.ts'));
    expect(files).toContain(path.resolve(repo, 'infra/tests/maps-nginx.maps.test.ts'));
  });

  it('follows a vitest call with no --config into the root config, a folder argument into its tests, and an @bw/ import into its package (F-481)', async () => {
    // why: F-481 - G-CI4 step 3 ran the whole merge set through the root vitest.config.ts, which the audit never opened
    const nightly = await filesRun(scriptOf(real.gates.find((g) => g.id === 'G-CI4-nightly')!));
    // A test file reached only through the root config's include:
    expect(nightly).toContain(path.resolve(repo, 'packages/time/src/dst.test.ts'));
    // F-633: a vitest config's globalSetup is part of the files a gate runs (the arm at the top of this suite), pinned by the one globalSetup left in the tree.
    expect(nightly).toContain(path.resolve(repo, 'packages/db/src/testing/global-setup.ts'));
    // A folder argument resolves against the config's include: G-CI3 names packages/domain, and only that folder's tests join.
    const g3 = await filesRun(scriptOf(real.gates.find((g) => g.id === 'G-CI3')!));
    expect(g3.some((f) => f.startsWith(path.resolve(repo, 'packages/domain/src') + path.sep) && f.endsWith('.test.ts'))).toBe(true);
    expect(g3).not.toContain(path.resolve(repo, 'packages/time/src/dst.test.ts'));
    // An @bw/ import reaches the package's own source, an extensionless relative import its file.
    expect(resolveImport(path.resolve(repo, 'ci/gates/G-CI4/lib.ts'), '@bw/time')).toBe(path.resolve(repo, 'packages/time/src/index.ts'));
    expect(resolveImport(path.resolve(repo, 'packages/time/src/index.ts'), './clock')).toBe(path.resolve(repo, 'packages/time/src/clock.ts'));
  });

  it('keeps a shell case branch that starts with a star, and drops a block-comment line (F-481)', () => {
    // why: F-481 - ci/ci.sh's case branch `*" --records "*)` was stripped as a comment, hiding the code after it
    const f = path.join(root, 'branch.sh');
    writeFileSync(f, ['# a comment', '/* open', ' * body', ' */', 'case " $* " in', '  *" --records "*) ;;', '  *) node data-assets.ts ensure ;;', 'esac', ''].join('\n'));
    const kept = code(f);
    expect(kept).toContain('--records');
    expect(kept).toContain('data-assets.ts');
    expect(kept).not.toContain('a comment');
    expect(kept).not.toContain('body');
  });

  it('puts every gate that runs a file which starts a container, a stack, an image build or a browser in engine-net, or leaves it alone', async () => {
    // why: F-410, F-290, F-464 - net::ERR_NETWORK_CHANGED: a container start or removal beside a browser fails the page load
    const touches: Gate[] = [];
    const wrong: string[] = [];
    for (const g of scripted) {
      const hits = (await filesRun(scriptOf(g))).filter((f) => ENGINE.test(code(f)));
      if (hits.length === 0) continue;
      touches.push(g);
      if (g.parallel !== undefined && !g.parallel.exclusive.includes('engine-net')) wrong.push(`${g.id}: ${hits.map((h) => path.relative(repo, h)).join(', ')}`);
    }
    expect(wrong, 'gates that touch the run engine but may run beside an engine-net gate').toEqual([]);
    // G-CI4-nightly is in the set because it runs the root vitest.config.ts with no --config (F-481), so every file the root config runs is in the files it runs. G-CI1 is since P5-TWA-OUTBOX's step 3 (ci/outbox-stack.sh: an image build, a Compose stack and 2 browsers).
    // G-CI6 is since P7-SCANS (ci/gates/G-CI6.sh runs ci/e2e-stack.sh: a Compose stack and two browsers); it has no parallel field, so it runs alone.
    // public-files-check is since P8-PUBLIC-FILES only because ci/public-files.ts names the word docker in a README regex (it starts no container, stack or browser); it has no parallel field, so it runs alone.
    // smoke-public-tag is since P7-SMOKE (ci/smoke/smoke-public-tag.sh: a Docker-in-Docker engine, a harness container and a browser); it has no parallel field, so it runs alone.
    // outage-drill is since P8-OUTAGE-DRILL only because infra/tests/outage-drill.test.ts names docker compose in a --dry-run assertion (the driver sends its docker commands over ssh, stubbed in that test, so no container, stack or browser starts here); it has no parallel field, so it runs alone.
    expect(touches.map((g) => g.id).sort()).toEqual(['G-CI1', 'G-CI4-nightly', 'G-CI5', 'G-CI6', 'contract-gates', 'import-target-counts', 'look-values-comparator', 'look-values-comparator-nightly', 'map-manifest', 'outage-drill', 'page-walkers','page-walkers-nightly', 'public-files-check', 'restore-test', 'smoke-public-tag']);
    for (const g of scripted.filter((x) => x.parallel?.exclusive.includes('engine-net'))) expect(touches).toContain(g);
  });

  it('keeps unit-tests in engine-net and heavy (F-525)', () => {
    // why: F-525 - the membership of unit-tests in the groups is unchanged by OA-88
    const unit = real.gates.find((g) => g.id === 'unit-tests')!;
    expect(unit.cmd).toBe('pnpm run test');
    expect(unit.parallel?.exclusive).toEqual(['engine-net', 'heavy']);
  });
});

// P3-CI-CADENCE (owner ruling Nov 2, 2026, "Daily + phase close"): the push set, the nightly set, and named re-runs.
describe('ci/run-gates.ts push set, nightly set and --gates (P3-CI-CADENCE)', () => {
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const git = (...args: string[]): string => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
    return r.stdout.trim();
  };
  // One gate per tier. Each writes a file named for itself when it runs, so a run's effect is read from the disk too.
  const touch = (id: string) => `touch ran-${id}`;
  const tiers = () => [
    gate('m', { when: 'merge', cmd: touch('m') }),
    gate('w', { when: 'wave', cmd: touch('w') }),
    gate('n1', { when: 'nightly', cmd: touch('n1') }),
    gate('n2', { when: 'nightly', cmd: touch('n2') }),
    gate('n3', { when: 'nightly', cmd: touch('n3') }),
  ];
  const ran = () => readdirSync(root).filter((f) => f.startsWith('ran-')).map((f) => f.slice(4)).sort();
  const statuses = (r: ReturnType<typeof run>) => Object.fromEntries(r.verdict().gates.map((g: { id: string; status: string }) => [g.id, g.status]));

  it('a run without --nightly runs no when: nightly gate, and a --nightly run runs all 3', () => {
    // why: P3-CI-CADENCE must-fail probe - the push set must never carry a nightly gate; the nightly set must carry all of them
    setup(tiers(), ['m', 'w', 'n1', 'n2', 'n3']);
    for (const args of [[], ['--all'], ['--records']]) {
      const r = run(...args);
      expect(r.status, r.out).toBe(0);
      expect(Object.keys(statuses(r)).filter((id) => statuses(r)[id] === 'pass').some((id) => id.startsWith('n')), `${args.join(' ')} ran a nightly gate`).toBe(false);
      expect(ran().filter((id) => id.startsWith('n')), args.join(' ')).toEqual([]);
    }
    expect(ran()).toEqual(['m', 'w']);
    expect(statuses(run('--all'))).toMatchObject({ m: 'pass', w: 'pass', n1: 'skipped', n2: 'skipped', n3: 'skipped' });
    rmSync(path.join(root, 'ran-m'));
    rmSync(path.join(root, 'ran-w'));
    const r = run('--nightly');
    expect(r.status, r.out).toBe(0);
    expect(statuses(r)).toMatchObject({ m: 'pass', w: 'pass', n1: 'pass', n2: 'pass', n3: 'pass' });
    expect(ran()).toEqual(['m', 'n1', 'n2', 'n3', 'w']);
    expect(r.verdict()).toMatchObject({ mode: 'nightly', scope: 'nightly' });
    expect(run('--all').verdict()).toMatchObject({ mode: 'all', scope: 'push' });
  });

  it('--gates runs only the named gates, by comma list, repeated words or --gates=, nightly ones included', () => {
    // why: P3-CI-CADENCE - the re-run rule: after a red run, run the merge set plus the red gates, not the whole set
    setup(tiers(), ['m', 'w', 'n1', 'n2', 'n3']);
    let r = run('--gates', 'n2');
    expect(r.status, r.out).toBe(0);
    expect(ran()).toEqual(['n2']);
    expect(statuses(r)).toMatchObject({ m: 'skipped', w: 'skipped', n1: 'skipped', n2: 'pass', n3: 'skipped' });
    expect(r.verdict()).toMatchObject({ mode: 'gates', scope: 'gates', suitesRun: ['n2'] });
    rmSync(path.join(root, 'ran-n2'));
    r = run('--gates', 'w,n3');
    expect(ran()).toEqual(['n3', 'w']);
    for (const f of ran()) rmSync(path.join(root, `ran-${f}`));
    r = run('--gates=m', '--gates', 'n1', 'n3');
    expect(r.status, r.out).toBe(0);
    expect(ran()).toEqual(['m', 'n1', 'n3']);
  });

  it('an unknown id stops --gates at start-up with exit 2, runs no gate and leaves no old verdict', () => {
    // why: P3-CI-CADENCE must-fail probe - a typo in a re-run must not run nothing and read as green
    setup(tiers(), ['m', 'w', 'n1', 'n2', 'n3']);
    expect(run('--all').status).toBe(0);
    for (const f of ran()) rmSync(path.join(root, `ran-${f}`));
    const r = run('--gates', 'n2,no-such-gate');
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/start-up error: --gates names no-such-gate, which is not in ci\/gates\.json/);
    expect(ran()).toEqual([]);
    expect(existsSync(path.join(root, '.build', 'ci', 'ci-verdict.json'))).toBe(false);
    expect(existsSync(path.join(root, '.build', 'ci-only-verdict.json'))).toBe(false);
  });

  it('an inactive id stops --gates at start-up with exit 2 and runs no gate', () => {
    // why: F-580 - a named run that runs nothing must not read green: --gates of a gate with no marker is a start-up error
    setup(tiers(), ['m', 'w', 'n1', 'n3']);
    const r = run('--gates', 'n1,n2');
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/start-up error: --gates names n2, which is inactive/);
    expect(ran()).toEqual([]);
    expect(existsSync(path.join(root, '.build', 'ci-only-verdict.json'))).toBe(false);
    // The active ones alone still run.
    expect(run('--gates', 'n1,n3').status).toBe(0);
    expect(ran()).toEqual(['n1', 'n3']);
  });

  it('refuses --gates with no id, and 2 sets in 1 run', () => {
    // why: P3-CI-CADENCE - one set per run, so the verdict names what it covers
    setup(tiers(), ['m']);
    expect(run('--gates').status).toBe(2);
    expect(run('--nightly', '--all').status).toBe(2);
    expect(run('--gates', 'm', '--nightly').status).toBe(2);
    expect(run('--nightly', '--records').status).toBe(2);
  });

  it('--list prints the gates and the sum of their time limits and runs nothing', () => {
    // why: P3-CI-CADENCE - the dry list the lane report records for the push set and the nightly set
    setup([gate('m', { cmd: touch('m'), timeoutS: 10 }), gate('w', { when: 'wave', cmd: touch('w'), timeoutS: 20 }), gate('n1', { when: 'nightly', cmd: touch('n1'), timeoutS: 40 }), gate('off', { when: 'wave' })], ['m', 'w', 'n1']);
    const lists = (...a: string[]) => run('--list', ...a).out.split('\n').find((l) => l.startsWith('LIST ') && l.includes('active gates'));
    expect(lists()).toBe('LIST merge: 1 active gates, timeoutS sum 10: m');
    expect(lists('--all')).toBe('LIST all: 2 active gates, timeoutS sum 30: m w');
    expect(lists('--nightly')).toBe('LIST nightly: 3 active gates, timeoutS sum 70: m w n1');
    expect(lists('--gates', 'n1')).toBe('LIST gates: 1 active gates, timeoutS sum 40: n1');
    expect(ran()).toEqual([]);
    expect(existsSync(path.join(root, '.build'))).toBe(false);
  });

  // F-1410 (owner answer 24ad46b5, Nov 11, 2026, "Run at checkpoints only"): a when: checkpoint gate is out of the nightly set.
  const cpTiers = () => [gate('m', { cmd: touch('m'), timeoutS: 10 }), gate('n1', { when: 'nightly', cmd: touch('n1'), timeoutS: 40 }), gate('c1', { when: 'checkpoint', cmd: touch('c1'), timeoutS: 50 })];

  it('the nightly set leaves a when: checkpoint gate out, and the checkpoint set holds it', () => {
    // why: F-1410 must-fail probe - a plain --nightly run must not run the checkpoint gate; --checkpoint must
    setup(cpTiers(), ['m', 'n1', 'c1']);
    const lists = (...a: string[]) => run('--list', ...a).out.split('\n').find((l) => l.startsWith('LIST ') && l.includes('active gates'));
    expect(lists('--nightly')).toBe('LIST nightly: 2 active gates, timeoutS sum 50: m n1');
    expect(lists('--checkpoint')).toBe('LIST checkpoint: 3 active gates, timeoutS sum 100: m n1 c1');
    expect(lists('--all')).toBe('LIST all: 1 active gates, timeoutS sum 10: m');
    expect(lists('--records')).not.toContain('c1');
    const n = run('--nightly');
    expect(n.status, n.out).toBe(0);
    expect(ran()).toEqual(['m', 'n1']);
    expect(n.verdict().gates.map((g: { id: string }) => g.id)).toContain('c1');
    expect(statuses(n)).toMatchObject({ c1: 'skipped' });
  });

  it('a --checkpoint run runs the checkpoint gate and is recorded as a nightly run', () => {
    // why: F-1410 - the checkpoint run keeps the gate reachable; wave-run.sh judges and records it as nightly
    setup(cpTiers(), ['m', 'n1', 'c1']);
    const r = run('--checkpoint');
    expect(r.status, r.out).toBe(0);
    expect(ran()).toEqual(['c1', 'm', 'n1']);
    expect(statuses(r)).toMatchObject({ m: 'pass', n1: 'pass', c1: 'pass' });
    expect(r.verdict()).toMatchObject({ mode: 'nightly', scope: 'nightly', checkpoint: true });
  });

  it('--gates runs a when: checkpoint gate by name, and --checkpoint excludes the other set flags', () => {
    // why: F-1410 - the gate id stays runnable alone; one set per run
    setup(cpTiers(), ['m', 'n1', 'c1']);
    const r = run('--gates', 'c1');
    expect(r.status, r.out).toBe(0);
    expect(ran()).toEqual(['c1']);
    expect(run('--checkpoint', '--nightly').status).toBe(2);
    expect(run('--checkpoint', '--all').status).toBe(2);
    expect(run('--gates', 'c1', '--checkpoint').status).toBe(2);
  });

  it('a gate with an unknown when value still stops the run at start-up', () => {
    // why: F-1410 - adding checkpoint must not loosen the when check
    setup([gate('m', { cmd: touch('m') }), gate('x', { when: 'sometimes', cmd: touch('x') })], ['m', 'x']);
    expect(run('--checkpoint').status).toBe(2);
    expect(validateMap({ defaultTimeoutS: 300, gates: [gate('x', { when: 'sometimes' })] } as never).join('\n')).toContain('checkpoint');
  });

  it('in the real map look-values-comparator-nightly is when: checkpoint and no other gate is', () => {
    // why: F-1410 - owner answer 24ad46b5: the WebKit look check runs at checkpoints only; the id is unchanged
    const real = loadMap(path.resolve(import.meta.dirname, 'gates.json'));
    expect(real.gates.filter((g) => g.when === 'checkpoint').map((g) => g.id)).toEqual(['look-values-comparator-nightly']);
    expect(real.gates.find((g) => g.id === 'look-values-comparator-nightly')?.when).toBe('checkpoint');
  });

  describe('onlyWhenChanged and the recorded runs', () => {
    const GLOBS = ['packages/import/**', 'ci/gates/import-target-counts.sh'];
    function scoped(): string {
      setup([gate('scoped', { when: 'wave', critical: true, cmd: 'false', onlyWhenChanged: GLOBS }), gate('plain', { when: 'wave' })], ['scoped', 'plain']);
      put('.gitignore', '.build/\n');
      put('packages/import/a.ts', 'a\n');
      put('docs/x.md', 'a\n');
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      return git('rev-parse', 'HEAD');
    }
    const history = (sha: string, scope: string) => put('.build/ci-time.jsonl', JSON.stringify({ scope, sha, gateStatus: { scoped: 'pass', plain: 'pass' } }) + '\n');
    const change = (rel: string) => {
      put(rel, 'changed\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'change');
    };

    it('a push run on a head that changed no input records the gate unchanged naming its base sha; a change under the inputs runs it; --nightly and --gates run it with no change', () => {
      // why: P3-CI-CADENCE must-fail probe - import-target-counts in a push run only when the wave changed its inputs, always at nightly
      const base = scoped();
      history(base, 'push');
      change('docs/x.md');
      let r = run('--all');
      expect(r.status, r.out).toBe(0);
      const g = r.verdict().gates.find((x: { id: string }) => x.id === 'scoped');
      expect(g).toMatchObject({ status: 'unchanged', base });
      expect(g.reason).toContain(base);
      r = run('--nightly');
      expect(statuses(r).scoped, 'a nightly run is unscoped').toBe('fail');
      r = run('--gates', 'scoped');
      expect(statuses(r).scoped, 'a named gate is unscoped').toBe('fail');
      change('packages/import/a.ts');
      r = run('--all');
      expect(statuses(r).scoped, 'a change under packages/import runs it').toBe('fail');
    });

    it('a recorded push run or nightly run is a base for the next push run, as a full run was', () => {
      // why: P3-CI-CADENCE - ci-time.jsonl rows now carry scope push or nightly; a base must be read from them
      for (const scope of ['push', 'nightly', 'full']) {
        rmSync(path.join(root, '.git'), { recursive: true, force: true });
        const base = scoped();
        history(base, scope);
        change('docs/x.md');
        expect(statuses(run('--all')).scoped, scope).toBe('unchanged');
      }
      rmSync(path.join(root, '.git'), { recursive: true, force: true });
      const base = scoped();
      history(base, 'merge');
      change('docs/x.md');
      expect(statuses(run('--all')).scoped, 'a merge row is not a base').toBe('fail');
    });
  });

  it.skipIf(!existsSync(path.resolve(import.meta.dirname, 'vendor', 'jl-dev', 'ci-time-check.py')))('ci-time-check records the row under scope push for --all and scope nightly for --nightly, and none in the wave container', () => {
    // why: P3-CI-CADENCE - "Record ci-time.jsonl rows with scope: push or scope: nightly"; F-691, F-694 - in the wave container the row of record is the host's
    const vendor = path.resolve(import.meta.dirname, 'vendor', 'jl-dev', 'ci-time-check.py');
    setup(tiers(), ['m', 'w', 'n1', 'n2', 'n3']);
    mkdirSync(path.join(root, 'ci', 'vendor', 'jl-dev'), { recursive: true });
    writeFileSync(path.join(root, 'ci', 'vendor', 'jl-dev', 'ci-time-check.py'), readFileSync(vendor));
    // F-825: this test runs in that container too, so the runner it starts is told which place it is in, never left to inherit it.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE|BW_PW)_/.test(k) && k !== 'BW_WAVE_CONTAINER')) as Record<string, string>;
    env.CI_ROOT = root;
    for (const [flag, scope] of [['--all', 'push'], ['--nightly', 'nightly']] as const) {
      const r = spawnSync('node', [runner, flag], { env, cwd: root, encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(`ci-time-check: ok - ${scope}`);
    }
    const wave = spawnSync('node', [runner, '--nightly'], { env: { ...env, BW_WAVE_CONTAINER: '1' }, cwd: root, encoding: 'utf8' });
    expect(wave.status, wave.stdout + wave.stderr).toBe(0);
    expect(wave.stdout).toContain('ci-time-check: ok - nightly');
    const rows = readFileSync(path.join(root, '.build', 'ci', 'ci-time.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((x: { scope: string }) => x.scope)).toEqual(['push', 'nightly']);
    expect(rows[0]).toMatchObject({ result: 'pass', gateStatus: { m: 'pass', w: 'pass', n1: 'skipped' } });
    expect(rows[1]).toMatchObject({ result: 'pass', gateStatus: { m: 'pass', n1: 'pass', n3: 'pass' } });
  });

  describe('a stopped run and a timed-out stack gate (F-466, F-467)', () => {
    const par = (...exclusive: string[]) => ({ parallel: { exclusive } });
    function setupPar(gates: Record<string, unknown>[], groups: Record<string, string> = {}) {
      mkdirSync(path.join(root, 'ci', 'active'), { recursive: true });
      for (const g of gates) writeFileSync(path.join(root, 'ci', 'active', String(g.id)), '');
      writeFileSync(path.join(root, 'ci', 'gates.json'), JSON.stringify({ exclusiveGroups: groups, gates }));
    }

    it('prints what each running gate held when the runner gets SIGTERM, and keeps it in a per-gate log', async () => {
      // why: F-466 - a stopped run lost everything its gates printed, so the gates that hung left nothing to debug
      setupPar([gate('g1', { cmd: 'echo out-of-g1; echo err-of-g1 >&2; sleep 30', ...par() }), gate('g2', { cmd: 'echo out-of-g2; sleep 30', ...par() })]);
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE|BW_PW)_/.test(k))), CI_ROOT: root, CI_TIME_CHECK_CMD: '', CI_MAX_PARALLEL: '2' };
      const child = spawn('node', [runner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
      const logs = ['g1', 'g2'].map((id) => path.join(root, '.build', 'ci', 'gate-logs', `${id}.log`));
      const deadline = Date.now() + 15000;
      while (!logs.every((l) => existsSync(l) && readFileSync(l, 'utf8').includes('out-of-')) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
      child.kill('SIGTERM');
      expect(await exited).toBe(143);
      expect(out).toContain('=== g1: stopped by SIGTERM while running');
      expect(out).toContain('out-of-g1');
      expect(out).toContain('err-of-g1');
      expect(out).toContain('out-of-g2');
      expect(readFileSync(logs[0]!, 'utf8')).toContain('out-of-g1');
    });

    it('holds a timed-out gate slot until the Compose projects it started are gone, and releases it at the cap', async () => {
      // why: F-467 - the reaper tears the stack down about a second after the kill; the next engine-net gate must not start in that window
      const bin = path.join(root, 'bin');
      mkdirSync(bin, { recursive: true });
      // A stand-in docker: `compose ls` lists the names in state/projects, one per line.
      writeFileSync(
        path.join(bin, 'docker'),
        ['#!/bin/bash', 'if [ "$1 $2" = "compose ls" ]; then', '  printf "["; sep=""; while read -r n; do printf "%s{\\"Name\\":\\"%s\\"}" "$sep" "$n"; sep=","; done < "$STATE/projects"; echo "]"', '  exit 0', 'fi', 'exit 1', ''].join('\n'),
        { mode: 0o755 },
      );
      mkdirSync(path.join(root, 'state'));
      writeFileSync(path.join(root, 'state', 'projects'), 'other-lane\n');
      const stub = { PATH: `${bin}:${process.env.PATH}`, STATE: path.join(root, 'state') };
      // The stack gate adds its project and hangs past its limit; its reaper (its own process group, as ci/setup-stack.sh starts it)
      // removes the project 3 s after the gate's shell is gone.
      writeFileSync(path.join(root, 'reaper.sh'), 'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; sleep 3\ngrep -v bw-stack-1 "$STATE/projects" > "$STATE/p2"; mv "$STATE/p2" "$STATE/projects"; date +%s > "$STATE/gone"\n');
      const spawnReaper = `node -e 'require("node:child_process").spawn("bash", ["reaper.sh", process.env.GATE_PID], { detached: true, stdio: "ignore" }).unref()'`;
      const stackGate = gate('stack', { cmd: `echo bw-stack-1 >> "$STATE/projects"; GATE_PID=$$ ${spawnReaper}; sleep 30`, timeoutS: 1, ...par('engine-net') });
      const next = gate('next', { cmd: 'date +%s > "$STATE/next-started"', ...par('engine-net') });
      setupPar([stackGate, next], { 'engine-net': 'the engine namespace' });
      const r = runEnv(stub, '--serial');
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/gate stack timed out; its Compose projects are gone after/);
      const gone = Number(readFileSync(path.join(root, 'state', 'gone'), 'utf8'));
      const nextStarted = Number(readFileSync(path.join(root, 'state', 'next-started'), 'utf8'));
      expect(nextStarted, 'the next engine-net gate started before the stack was removed').toBeGreaterThanOrEqual(gone);
      // Past the cap the slot is released anyway, named in the output; the other lane's project never counts.
      writeFileSync(path.join(root, 'state', 'projects'), 'other-lane\n');
      rmSync(path.join(root, 'state', 'gone'));
      const stuck = gate('stack', { cmd: `echo bw-stack-1 >> "$STATE/projects"; sleep 30`, timeoutS: 1, ...par('engine-net') });
      setupPar([stuck, next], { 'engine-net': 'the engine namespace' });
      const r2 = runEnv({ ...stub, CI_SETTLE_CAP_S: '2' }, '--serial');
      expect(r2.status).toBe(1);
      expect(r2.out).toMatch(/still up after 2s; the slot is released anyway/);
      expect(r2.out).toContain('bw-stack-1');
      expect(r2.out).not.toMatch(/projects \(other-lane/);
    });
  });
});

// P3-CI-CADENCE: the real map's nightly tier and the edits D-15 lists.
describe('ci/gates.json nightly tier (P3-CI-CADENCE, D-15)', () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const real = loadMap(path.resolve(import.meta.dirname, 'gates.json')) as ReturnType<typeof loadMap> & { _doc: string };
  const byId = (id: string) => real.gates.find((g) => g.id === id)!;
  const NIGHTLY = ['G-CI4-nightly', 'page-walkers-nightly', 'look-values-comparator-nightly'];

  it('has exactly the 3 nightly gates, each naming P3-CI-CADENCE as builder and activator, with its marker and its script', () => {
    // why: D-15 - the nightly tier adds exactly 3 gate ids, each active from its lane
    expect(validateMap(real)).toEqual([]);
    // F-1201: native-suite is the 1 more nightly gate, runner mac (the mac half of ci/wave-run.sh); pinned in the runner mac test below.
    // F-1410: look-values-comparator-nightly is when: checkpoint now (owner answer 24ad46b5); it stays in this tier's id list.
    expect(real.gates.filter((g) => (g.when === 'nightly' || g.when === 'checkpoint') && g.runner !== 'mac').map((g) => g.id)).toEqual(NIGHTLY);
    for (const id of NIGHTLY) {
      const g = byId(id);
      expect(g.builders, id).toEqual(['P3-CI-CADENCE']);
      expect(g.activates, id).toBe('P3-CI-CADENCE');
      expect(existsSync(path.join(repo, 'ci', 'active', id)), `marker for ${id}`).toBe(true);
      expect(g.cmd, id).toBeNull();
      expect(existsSync(path.join(repo, 'ci', 'gates', `${id}.sh`)), `script for ${id}`).toBe(true);
      expect(g.onlyWhenChanged, id).toBeUndefined();
    }
  });

  it('states the D-15 edits: the _doc first sentence (F-487), and the restore-test title (F-500)', () => {
    // why: F-487, F-500 - two titles the plan names; a wrong title misled the owner once (F-500)
    expect(real._doc.split('. ')[0]).toContain('later lanes edit this file only as BUILD_PLAN section 3 D-15 lists');
    expect(real._doc).not.toContain('No later lane edits this file');
    expect(real._doc).toContain('merge | wave | signoff | nightly');
    expect(byId('restore-test').title).toBe('restore test (local backup stack)');
  });

  it('scopes import-target-counts to its inputs: a change under packages/import runs it, a doc change does not', () => {
    // why: P3-CI-CADENCE - onlyWhenChanged for the push run; its inputs are the ruling's list
    const g = byId('import-target-counts');
    const res = (g.onlyWhenChanged ?? []).map(globToRegExp);
    const hit = (f: string) => res.some((re) => re.test(f));
    for (const f of ['packages/import/src/index.ts', 'packages/setup/src/run.ts', 'packages/generator/src/cli.ts', 'packages/db/src/seed/world.ts', 'packages/db/migrations/0001.sql', 'packages/db/src/client.ts', 'ci/gates/import-target-counts.sh', 'ci/gates/import-target-counts/cli.ts', 'ci/setup-stack.sh']) {
      expect(hit(f), f).toBe(true);
    }
    for (const f of ['docs/BUILD_PLAN.md', 'apps/web/src/page.tsx', 'infra/backup/backup.sh', 'ci/run-gates.ts']) expect(hit(f), f).toBe(false);
    expect(byId('restore-test').onlyWhenChanged, 'restore-test keeps its own rule').toContain('infra/backup/**');
  });

  it('narrows the 3 push gates to their halves: Chromium only, the English passes, the time package', () => {
    // why: P3-CI-CADENCE - the push halves must not carry what moved to nightly
    const read = (id: string) => readFileSync(path.join(repo, 'ci', 'gates', `${id}.sh`), 'utf8');
    for (const id of ['page-walkers', 'look-values-comparator']) expect(read(id), id).toMatch(/^export BW_PW_ENGINES=chromium$/m);
    expect(read('page-walkers')).toMatch(/^export BW_APP_WALK_PASSES=english$/m);
    expect(read('G-CI4')).toMatch(/vitest run --project unit packages\/time /);
    expect(read('G-CI4')).not.toMatch(/every merge-set test under TZ/);
    for (const id of ['look-values-comparator-nightly']) expect(read(id), id).toMatch(/^export BW_PW_ENGINES=webkit$/m);
    expect(read('page-walkers-nightly')).toContain('BW_PW_ENGINES=webkit');
    expect(read('page-walkers-nightly')).toContain('BW_APP_WALK_PASSES=spanish');
    expect(read('page-walkers-nightly')).toContain('bash ci/import-stack.sh');
    // F-943: the booking stack suite runs in both halves (Chromium here, WebKit in the nightly)
    // why: F-962 the pin matches the executable line with its exit capture, so a commented-out line or an appended "|| true" does not pass it
    for (const id of ['page-walkers', 'page-walkers-nightly']) expect(read(id), id).toMatch(/^bash ci\/booking-stack\.sh \|\| rc=/m);
    // F-967: the inbox stack suite runs in both halves too, after the booking stack
    for (const id of ['page-walkers', 'page-walkers-nightly']) expect(read(id), id).toMatch(/^bash ci\/inbox-stack\.sh \|\| rc=/m); // F-977: the executable line with its exit capture, as F-962
    // P5-TWA-MAP-ME: the map and Me stack suite runs in both halves too, after the inbox stack
    for (const id of ['page-walkers', 'page-walkers-nightly']) expect(read(id), id).toMatch(/^bash ci\/mapme-stack\.sh \|\| rc=/m); // F-977: same rule
    expect(read('G-CI4-nightly')).toMatch(/^\s*TZ="\$zone" BW_EXPECT_TZ="\$zone" pnpm exec vitest run --reporter=json/m);
    expect(read('G-CI4-nightly')).not.toContain('packages/time ');
  });

  // why: F-1038 the P5-TWA-JOB stack suite ran in no gate, so the pin matches the executable lines with their exit capture, as F-977 does for the other stack suites
  it('runs the job screens and Today stack suites in the nightly half', () => {
    const nightly = readFileSync(path.join(repo, 'ci', 'gates', 'page-walkers-nightly.sh'), 'utf8');
    expect(nightly).toMatch(/^bash ci\/tech-job-stack\.sh \|\| rc=/m);
    expect(nightly).toMatch(/^bash ci\/today-stack\.sh \|\| rc=/m);
  });

  // why: F-1534 the P7-TRAINING walkthrough stack ran in no gate, so a screen or label change could break the written steps with no red
  it('runs the training walkthrough stack suite in the nightly half', () => {
    const nightly = readFileSync(path.join(repo, 'ci', 'gates', 'page-walkers-nightly.sh'), 'utf8');
    expect(nightly).toMatch(/^bash ci\/training-stack\.sh \|\| rc=/m);
  });

  // why: F-1038 (F-996, F-974) a vitest config that sets no junitReporters() writes no junit file under BW_JUNIT_DIR, so its tests never reach the per-test history: every tracked vitest config calls it
  it('has every tracked vitest config call junitReporters()', () => {
    const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).stdout.split('\0');
    const configs = listed.filter((f) => /(^|\/)vitest[^/]*config[^/]*\.(ts|mts|js)$/.test(f) && existsSync(path.join(repo, f)));
    expect(configs.length).toBeGreaterThan(40);
    expect(configs.filter((f) => !readFileSync(path.join(repo, f), 'utf8').includes('junitReporters')), 'configs with no junitReporters()').toEqual([]);
  });
});

describe('runner mac gates (F-1201)', () => {
  const touch = (id: string) => `touch ran-${id}`;
  const ran = () => readdirSync(root).filter((f) => f.startsWith('ran-')).map((f) => f.slice(4)).sort();
  const gates = () => [
    gate('m', { when: 'merge', cmd: touch('m') }),
    gate('w', { when: 'wave', cmd: touch('w') }),
    gate('mac-w', { when: 'wave', cmd: touch('mac-w'), runner: 'mac' }),
    gate('mac-n', { when: 'nightly', cmd: touch('mac-n'), runner: 'mac' }),
  ];

  it('no set of ci.sh runs a runner mac gate; it is skipped and named; --gates runs it by name', () => {
    // why: F-1201 must-fail probe - the merge set, the push set and the Spectre nightly container must never run the native suite, which needs this Mac
    setup(gates(), ['m', 'w', 'mac-w', 'mac-n']);
    for (const args of [[], ['--all'], ['--nightly'], ['--records']]) {
      const r = run(...args);
      expect(r.status, r.out).toBe(0);
      const st = Object.fromEntries(r.verdict().gates.map((g: { id: string; status: string }) => [g.id, g.status]));
      expect(st, args.join(' ')).toMatchObject({ 'mac-w': 'skipped', 'mac-n': 'skipped' });
      expect(ran().filter((id) => id.startsWith('mac')), args.join(' ')).toEqual([]);
    }
    expect(run('--nightly').out).toMatch(/^MAC mac-n: runner mac, not run here/m);
    expect(run('--all').out).not.toMatch(/^MAC mac-n/m);
    const r = runEnv({ BW_WAVE_CONTAINER: '' }, '--gates', 'mac-n'); // outside the wave container (these tests also run inside it)
    expect(r.status, r.out).toBe(0);
    expect(ran()).toContain('mac-n');
  });

  it('a --gates run in the wave container skips a named runner mac gate and names it, as the nightly does, and runs the rest', () => {
    // why: F-1430 must-fail probe - a narrow run naming native-suite ran it in the Spectre half too, where it failed in 25 s with no Xcode, so its verdict was red
    setup(gates(), ['m', 'w', 'mac-w', 'mac-n']);
    const r = runEnv({ BW_WAVE_CONTAINER: '1' }, '--gates', 'w,mac-n');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/^MAC mac-n: runner mac, not run here/m);
    expect(ran()).toEqual(['w']);
    const v = r.verdict();
    expect(v.result).toBe('pass');
    expect(Object.fromEntries(v.gates.map((g: { id: string; status: string }) => [g.id, g.status]))).toMatchObject({ w: 'pass', 'mac-n': 'skipped' });
    expect(runEnv({ BW_WAVE_CONTAINER: '1' }, '--gates', 'mac-n', '--list').out).toMatch(/^LIST gates: 0 active gates/m);
  });

  it('rejects a runner that is not linux or mac', () => {
    // why: F-1201 a misspelt runner would silently put a mac gate in the Spectre sets
    expect(validateMap({ gates: [gate('x', { runner: 'macos' })] })).toEqual(['x: runner must be one of linux | mac (absent means linux)']);
    expect(validateMap({ gates: [gate('x', { runner: 'mac' }), gate('y', { runner: 'linux' })] })).toEqual([]);
  });

  it('the map has exactly 2 runner mac gates, native-no-demo and native-suite, each active from P6-XCUITEST', () => {
    // why: F-1201 FR-IOS-1, FR-IOS-4 the native gates run in the mac half (owner ruling Nov 4, 2026 item 3): the suite in the nightly, never the merge set
    const repo = path.resolve(import.meta.dirname, '..');
    const real = loadMap(path.resolve(import.meta.dirname, 'gates.json'));
    const mac = real.gates.filter((g) => g.runner === 'mac');
    expect(mac.map((g) => g.id)).toEqual(['native-no-demo', 'native-suite']);
    for (const g of mac) {
      expect(g.activates, g.id).toBe('P6-XCUITEST');
      expect(existsSync(path.join(repo, 'ci', 'active', g.id)), `marker for ${g.id}`).toBe(true);
    }
    const suite = mac[1] as Gate;
    expect(suite.when).toBe('nightly');
    expect(suite.cmd).toBe('bash apps/tech-native/xcuitest/suite.sh');
    expect(existsSync(path.join(repo, 'apps', 'tech-native', 'xcuitest', 'suite.sh'))).toBe(true);
    expect(existsSync(path.join(repo, 'ci', 'gates', 'native-no-demo.sh'))).toBe(true);
  });
});
