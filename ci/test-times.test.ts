// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling (checks ci/test-times.sh and the BW_JUNIT_DIR hand-off of ci/run-gates.ts, F-974; no product requirement)
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, 'test-times.sh');
const runner = path.resolve(import.meta.dirname, 'run-gates.ts');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'test-times-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in test-cost.py that appends its arguments, one call per line. */
function fakeTool(exit = 0): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const tool = path.join(bin, 'test-cost.py');
  writeFileSync(tool, `#!/bin/sh\necho "$@" >> "${path.join(dir, 'calls.txt')}"\nexit ${exit}\n`);
  chmodSync(tool, 0o755);
  return bin;
}

describe('ci/test-times.sh', () => {
  it('records each gate folder once, with the gate id as the label and every junit file', () => {
    // why: F-974
    const bin = fakeTool();
    const junit = path.join(dir, 'junit');
    mkdirSync(path.join(junit, 'unit-tests'), { recursive: true });
    mkdirSync(path.join(junit, 'page-walkers'), { recursive: true });
    mkdirSync(path.join(junit, 'empty-gate'), { recursive: true });
    writeFileSync(path.join(junit, 'unit-tests', 'vitest-1.xml'), '<testsuites/>');
    writeFileSync(path.join(junit, 'page-walkers', 'vitest-2.xml'), '<testsuites/>');
    writeFileSync(path.join(junit, 'page-walkers', 'vitest-3.xml'), '<testsuites/>');
    const hist = path.join(dir, 'hist.jsonl');
    const r = spawnSync('bash', [script, junit, 'abc123', hist], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = readFileSync(path.join(dir, 'calls.txt'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.includes('--label page-walkers'))).toMatch(/vitest-2\.xml.*vitest-3\.xml.*--history .*hist\.jsonl --sha abc123/);
    expect(calls.find((c) => c.includes('--label unit-tests'))).toContain('vitest-1.xml');
    expect(calls.some((c) => c.includes('empty-gate'))).toBe(false);
  });

  it('keeps 50 CI runs (50 x the gate folders) and skips a junit file that does not parse, recording the good ones', () => {
    // why: F-999
    const bin = fakeTool();
    const junit = path.join(dir, 'junit');
    mkdirSync(path.join(junit, 'a'), { recursive: true });
    mkdirSync(path.join(junit, 'b'), { recursive: true });
    writeFileSync(path.join(junit, 'a', 'vitest-1.xml'), '<testsuites/>');
    writeFileSync(path.join(junit, 'a', 'vitest-2.xml'), '<testsuites><testsuite');
    writeFileSync(path.join(junit, 'b', 'vitest-3.xml'), '<testsuites/>');
    const r = spawnSync('bash', [script, junit, 'abc123', path.join(dir, 'hist.jsonl')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('vitest-2.xml does not parse');
    const calls = readFileSync(path.join(dir, 'calls.txt'), 'utf8').trim().split('\n');
    expect(calls.every((c) => c.endsWith('--keep 100'))).toBe(true);
    const a = calls.find((c) => c.includes('--label a')) as string;
    expect(a).toContain('vitest-1.xml');
    expect(a).not.toContain('vitest-2.xml');
  });

  it('says so and exits 0 when test-cost.py is not on PATH, and exits 1 when a record fails', () => {
    // why: F-974
    const junit = path.join(dir, 'junit');
    mkdirSync(path.join(junit, 'g'), { recursive: true });
    writeFileSync(path.join(junit, 'g', 'vitest-1.xml'), '<testsuites/>');
    const bare = path.join(dir, 'nopath');
    mkdirSync(bare);
    const none = spawnSync('/bin/bash', [script, junit], { encoding: 'utf8', env: { PATH: bare } });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('test-cost.py is not on PATH');
    const bin = fakeTool(1);
    const bad = spawnSync('bash', [script, junit], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('record failed for g');
  });
});

describe('ci/run-gates.ts per-test times', () => {
  it('gives every gate its own BW_JUNIT_DIR under .build/junit and hands the folders to test-cost.py', () => {
    // why: F-974
    const bin = fakeTool();
    mkdirSync(path.join(dir, 'ci', 'active'), { recursive: true });
    writeFileSync(path.join(dir, 'ci', 'active', 'a'), '');
    const g = { id: 'a', title: 'a', when: 'merge', critical: false, builders: ['T-1'], activates: 'T-1', activeFromPhase: 1, cmd: 'mkdir -p "$BW_JUNIT_DIR" && echo "<testsuites/>" > "$BW_JUNIT_DIR/vitest-9.xml"' };
    writeFileSync(path.join(dir, 'ci', 'gates.json'), JSON.stringify({ gates: [g] }));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GATE|BW_PW|BW_WAVE)_/.test(k) && k !== 'BW_WAVE_CONTAINER')), CI_ROOT: dir, CI_TIME_CHECK_CMD: '', PATH: `${bin}:${process.env.PATH}` } as Record<string, string>;
    const r = spawnSync('node', [runner], { env, encoding: 'utf8', cwd: dir });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(path.join(dir, '.build', 'junit', 'a', 'vitest-9.xml'))).toBe(true);
    const calls = readFileSync(path.join(dir, 'calls.txt'), 'utf8');
    expect(calls).toContain('--label a');
    expect(calls).toContain(path.join(dir, '.build', 'test-history.jsonl'));
    // in the wave container the host records them, so the runner records nothing there
    rmSync(path.join(dir, 'calls.txt'));
    const wave = spawnSync('node', [runner], { env: { ...env, BW_WAVE_CONTAINER: '1' }, encoding: 'utf8', cwd: dir });
    expect(wave.status, wave.stdout + wave.stderr).toBe(0);
    expect(existsSync(path.join(dir, 'calls.txt'))).toBe(false);
  });
});
