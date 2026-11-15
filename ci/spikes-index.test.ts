// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling (checks ci/spikes-index.sh, BUILD_PLAN D-13; no product requirement)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, 'spikes-index.sh');
let tmp: string;
let env: NodeJS.ProcessEnv;
let out: string;

function run(...args: string[]) {
  return spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'spikes-'));
  const dir = path.join(tmp, 'spikes');
  mkdirSync(dir);
  // planted out of ID order on purpose
  writeFileSync(path.join(dir, 'G-S2-TWA.md'), '# S2\nVerdict: FAIL\nMeasured: 3 | 4 ms\n');
  writeFileSync(path.join(dir, 'G-S1-SSE.md'), '# S1\nVerdict: PASS\nMeasured: 120 ms\n');
  out = path.join(tmp, 'SPIKES.md');
  env = { ...process.env, SPIKES_DIR: dir, SPIKES_OUT: out, SPIKES_REQUIRED: 'G-S1-SSE G-S2-TWA', SPIKES_S1_ID: '' };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('ci/spikes-index.sh', () => {
  // why: tooling
  it('writes byte-identical output on 2 runs, in ID order', () => {
    expect(run().status).toBe(0);
    const first = readFileSync(out);
    expect(run().status).toBe(0);
    expect(readFileSync(out).equals(first)).toBe(true);
    const text = first.toString('utf8');
    expect(text.indexOf('G-S1-SSE')).toBeGreaterThan(-1);
    expect(text.indexOf('G-S1-SSE')).toBeLessThan(text.indexOf('G-S2-TWA'));
    expect(text).toContain('| G-S2-TWA | FAIL | 3 \\| 4 ms |');
  });

  // why: tooling
  it('--check exits 0 on an untouched generated file', () => {
    run();
    expect(run('--check').status).toBe(0);
  });

  // why: tooling
  it('--check exits 1 on a hand edit to the generated file', () => {
    run();
    appendFileSync(out, 'hand edit\n');
    expect(run('--check').status).toBe(1);
    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);
  });

  // why: tooling (F-1: an unreadable Verdict must fail, not index as "(none)")
  it('accepts the bold label and exits 1 naming a record with no Verdict line', () => {
    const dir = path.join(tmp, 'spikes2');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'A-BOLD.md'), '# A\n**Verdict:** PASS\n**Measured:** 5 ms\n');
    const out2 = path.join(tmp, 'SPIKES2.md');
    const env2 = { ...process.env, SPIKES_DIR: dir, SPIKES_OUT: out2, SPIKES_REQUIRED: '', SPIKES_S1_ID: '' };
    const ok = spawnSync('bash', [script], { env: env2, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(readFileSync(out2, 'utf8')).toContain('| A-BOLD | PASS | 5 ms |');
    writeFileSync(path.join(dir, 'B-NOVERDICT.md'), '# B\nVerdit: PASS\nMeasured: 1\n');
    const bad = spawnSync('bash', [script], { env: env2, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('B-NOVERDICT.md');
    expect(spawnSync('bash', [script, '--check'], { env: env2, encoding: 'utf8' }).status).toBe(1);
  });

  /** A fresh record folder, its generated file written, and a --check run that judges it (F-118). */
  function judged(files: Record<string, string>, required: string) {
    const dir = mkdtempSync(path.join(tmp, 'judged-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    const e = { ...process.env, SPIKES_DIR: dir, SPIKES_OUT: path.join(tmp, path.basename(dir) + '.out.md'), SPIKES_REQUIRED: required, SPIKES_S1_ID: 'G-S1-SSE' };
    expect(spawnSync('bash', [script], { env: e, encoding: 'utf8' }).status).toBe(0);
    return () => spawnSync('bash', [script, '--check'], { env: e, encoding: 'utf8' });
  }

  // why: F-118 S1 at 6.2 s with no rule applied: a record reading Verdict PASS with Measured p95 6.2 s regenerated and passed --check
  it('--check exits 1 on S1 reading PASS with p95 at or over 5 s, and passes it under 5 s or reading FAIL', () => {
    const bad = judged({ 'G-S1-SSE.md': '# S1\nVerdict: PASS - ok\nMeasured: p95 6.2 s over 1980 deliveries\n' }, 'G-S1-SSE')();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('p95 6.2 s');
    expect(judged({ 'G-S1-SSE.md': '# S1\nVerdict: PASS\nMeasured: p95 0.029 s over 1980 deliveries\n' }, 'G-S1-SSE')().status).toBe(0);
    expect(judged({ 'G-S1-SSE.md': '# S1\nVerdict: PASS\nMeasured: p95 29 ms\n' }, 'G-S1-SSE')().status).toBe(0);
    expect(judged({ 'G-S1-SSE.md': '# S1\nVerdict: FAIL - D1\nMeasured: p95 6.2 s\n' }, 'G-S1-SSE')().status).toBe(0);
    expect(judged({ 'G-S1-SSE.md': '# S1\nVerdict: PASS\nMeasured: fast\n' }, 'G-S1-SSE')().status, 'a PASS with no p95 to judge').toBe(1);
  });

  // why: F-118 S8 missing: deleting its record and regenerating SPIKES.md also passed --check, because nothing compared the indexed IDs with A3 section 4
  it('--check exits 1 naming a required spike record that is missing', () => {
    const both = { 'G-S1-SSE.md': '# S1\nVerdict: PASS\nMeasured: p95 0.029 s\n', 'G-S8-DATA-SIZES.md': '# S8\nVerdict: PASS\nMeasured: 5 sizes\n' };
    expect(judged(both, 'G-S1-SSE G-S8-DATA-SIZES')().status).toBe(0);
    const missing = judged({ 'G-S1-SSE.md': both['G-S1-SSE.md'] }, 'G-S1-SSE G-S8-DATA-SIZES')();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('G-S8-DATA-SIZES.md is missing');
  });

  // why: F-118 the committed records pass the 2 rules: all 8 of A3 section 4's spikes are indexed and S1 is under 5 s
  it('--check passes on the repository records', () => {
    const r = spawnSync('bash', [script, '--check'], { env: { ...process.env, SPIKES_DIR: undefined, SPIKES_OUT: undefined, SPIKES_REQUIRED: undefined, SPIKES_S1_ID: undefined } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
