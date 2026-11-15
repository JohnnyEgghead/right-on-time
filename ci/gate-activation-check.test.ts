// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling (checks ci/gate-activation-check.ts and ci/gates-lib.ts, BUILD_PLAN D-15; no product requirement)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findActivationProblems, parseMergedTasks, validateMap, type GateMap } from './gates-lib.ts';

const cli = path.resolve(import.meta.dirname, 'gate-activation-check.ts');
const gate = (id: string, activates: string) => ({
  id, title: id, when: 'wave' as const, critical: false, builders: [activates], activates, activeFromPhase: 1, cmd: null,
});
const map: GateMap = {
  gates: [gate('G-A', 'T-A'), gate('G-B', 'T-B')],
};

describe('findActivationProblems', () => {
  it('passes when every merged activating task has its marker', () => {
    // why: tooling
    expect(findActivationProblems(map, ['G-A'], new Set(['T-A']))).toEqual([]);
  });

  it('fails a gate whose activating task merged with no marker', () => {
    // why: tooling
    const p = findActivationProblems(map, [], new Set(['T-B']));
    expect(p).toEqual(['gate G-B: activating task T-B has merged but ci/active/G-B is absent']);
  });

  it('fails a marker that names no gate', () => {
    // why: tooling
    expect(findActivationProblems(map, ['G-ZZ'], new Set())).toEqual(['marker ci/active/G-ZZ names no gate']);
  });

  it('allows a marker before its task has merged (the lane adds it in its own commit)', () => {
    // why: tooling
    expect(findActivationProblems(map, ['G-B'], new Set())).toEqual([]);
  });
});

describe('parseMergedTasks', () => {
  it('reads Task trailer lines only', () => {
    // why: tooling
    const log = 'Merge lane 3 X\n\nTask: P1-REPO\n\nCo-Authored-By: a\n\nnote: Task: P9-NOPE inline\nTask:   G-S8-DATA-SIZES  \n';
    expect([...parseMergedTasks(log)].sort()).toEqual(['G-S8-DATA-SIZES', 'P1-REPO']);
  });
});

describe('validateMap', () => {
  it('names a gate with no when', () => {
    // why: tooling
    const bad = { gates: [{ ...gate('G-A', 'T-A'), when: undefined }] };
    expect(validateMap(bad).join()).toMatch(/G-A: when missing/);
  });

  it('rejects a duplicate id', () => {
    // why: tooling
    const bad = { gates: [gate('G-A', 'T'), gate('G-A', 'T')] };
    expect(validateMap(bad).join()).toMatch(/duplicate id/);
  });
});

describe('ci/gate-activation-check.ts on a temporary repository', () => {
  let tmp: string;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: tmp, stdio: 'ignore' });
  const run = () =>
    // Hermetic (F-29): drop every CI_* and GATE_* variable the caller exported.
    spawnSync('node', [cli], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE)_/.test(k))), CI_ROOT: tmp, GATE_MAIN_REF: '' },
      encoding: 'utf8',
    });

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'activation-'));
    mkdirSync(path.join(tmp, 'ci', 'active'), { recursive: true });
    writeFileSync(path.join(tmp, 'ci', 'gates.json'), JSON.stringify(map));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'root');
    git('checkout', '-q', '-b', 'lane');
    git('commit', '-q', '--allow-empty', '-m', 'work');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', 'lane', '-m', 'Merge lane T-A\n\nTask: T-A');
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('fails with exit 1 when the merged task has no marker, then passes once it is added', () => {
    // why: tooling
    const red = run();
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('gate G-A: activating task T-A has merged');
    writeFileSync(path.join(tmp, 'ci', 'active', 'G-A'), '');
    const green = run();
    expect(green.status).toBe(0);
    expect(green.stdout).toContain('gate-activation-check: ok');
  });

  it('fails with exit 2 on a GATE_MAIN_REF that does not resolve, never falling back (F-22 b)', () => {
    // why: tooling
    const r = spawnSync('node', [cli], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE)_/.test(k))), CI_ROOT: tmp, GATE_MAIN_REF: 'typo-main' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
  });

  it('fails with exit 2 on a shallow clone, even with every marker absent (F-22 a)', () => {
    // why: tooling
    const shallow = mkdtempSync(path.join(tmpdir(), 'activation-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${tmp}`, shallow], { stdio: 'ignore' });
      mkdirSync(path.join(shallow, 'ci', 'active'), { recursive: true });
      writeFileSync(path.join(shallow, 'ci', 'gates.json'), JSON.stringify(map));
      const r = spawnSync('node', [cli], {
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE)_/.test(k))), CI_ROOT: shallow, GATE_MAIN_REF: '' },
        encoding: 'utf8',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('shallow');
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('fails with exit 1 on a marker that names no gate', () => {
    // why: tooling
    writeFileSync(path.join(tmp, 'ci', 'active', 'G-A'), '');
    writeFileSync(path.join(tmp, 'ci', 'active', 'G-NOPE'), '');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('marker ci/active/G-NOPE names no gate');
    rmSync(path.join(tmp, 'ci', 'active', 'G-NOPE'));
  });
});
