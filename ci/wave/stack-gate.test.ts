// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline proofs (no docker) for the stack-gate fixes: the default-settings check judges a non-default setting red
// (F-134), URL mode without a project to verify is refused (F-134), and a project name outside bw-contract-* is
// refused before any work (F-132). The docker halves (verification against a running stack, teardown after a
// process-group SIGKILL) are proved by ci/wave/stack-teardown-check.ts and the wave run.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOverrides, envProblems, expectedEnv } from './stack-settings.ts';

const compose = readFileSync('infra/compose.yaml', 'utf8');
const toList = (want: Record<string, string | null>) => Object.entries(want).map(([k, v]) => `${k}=${v ?? ''}`);

// why: F-134
describe('default-settings check (F-134)', () => {
  const expected = expectedEnv(compose);
  const defaults = Object.fromEntries(Object.entries(expected).map(([s, w]) => [s, [...toList(w), 'PATH=/usr/bin']]));

  it('reads the defaults from infra/compose.yaml for all 5 services', () => {
    // why: F-134
    expect(Object.keys(expected).sort()).toEqual(['db', 'pbs', 'proxy', 'web', 'worker']);
    expect(expected.web?.DEMO_MODE).toBe('off');
    expect(expected.worker?.ACCESS_CODE_ON).toBe('off');
    expect(expected.pbs?.APP_ORIGIN).toBe('http://localhost:8080');
    expect(expected.proxy?.ROUTES).toBe('open');
    expect(expected.db?.POSTGRES_USER).toBe('brightwater');
    for (const w of Object.values(expected)) expect(Object.values(w)).not.toContain(null);
  });

  it('control: a stack at its defaults has 0 problems', () => {
    // why: F-134
    expect(envProblems(expected, defaults)).toEqual([]);
  });

  it('a non-default setting, a missing setting and a missing service are each red', () => {
    // why: F-134
    const web = (defaults.web ?? []).map((e) => (e.startsWith('DEMO_MODE=') ? 'DEMO_MODE=on' : e));
    const worker = (defaults.worker ?? []).filter((e) => !e.startsWith('NIGHTLY_RESET='));
    const problems = envProblems(expected, { ...defaults, web, worker, pbs: null });
    expect(problems).toContain('web: DEMO_MODE="on", default "off"');
    expect(problems).toContain('worker: NIGHTLY_RESET is not set (default "off")');
    expect(problems).toContain('pbs: no running container');
  });

  it('a value form it cannot judge is red, never skipped', () => {
    // why: F-134
    const odd = expectedEnv('services:\n  web:\n    environment:\n      A: ${B:-x}\n');
    expect(envProblems(odd, { web: ['A=x'] })).toContain('web: A has a value form this check cannot judge');
  });
});

// why: FR-AUTH-6, FR-AUTH-5 (the P2-AUTH stack runs with the gate and demo mode on: only the named settings may differ, and a secret is never printed)
describe('default-settings check with named overrides (P2-AUTH stack)', () => {
  const expected = expectedEnv(compose);
  const over = applyOverrides(expected, { ACCESS_CODE_ON: 'on', DEMO_MODE: 'on', ACCESS_CODE: '*' });
  const actual = Object.fromEntries(
    Object.entries(over).map(([s, w]) => [s, [...toList(w).map((e) => (e === 'ACCESS_CODE=*' ? 'ACCESS_CODE=a-secret-value' : e)), 'PATH=/usr/bin']]),
  );

  it('expects the named settings and keeps every other value at its default', () => {
    expect(over.web?.ACCESS_CODE_ON).toBe('on');
    expect(over.worker?.DEMO_MODE).toBe('on');
    expect(over.web?.NIGHTLY_RESET).toBe('off');
    expect(envProblems(over, actual)).toEqual([]);
  });

  it('a non-overridden setting that differs is still red, and an empty secret is red without printing it', () => {
    const web = (actual.web ?? []).map((e) => (e.startsWith('NIGHTLY_RESET=') ? 'NIGHTLY_RESET=on' : e.startsWith('ACCESS_CODE=') ? 'ACCESS_CODE=' : e));
    const problems = envProblems(over, { ...actual, web });
    expect(problems).toContain('web: NIGHTLY_RESET="on", default "off"');
    expect(problems).toContain('web: ACCESS_CODE is empty, a value was set for this suite');
    expect(problems.join('\n')).not.toContain('a-secret-value');
  });
});

describe('contract-gates.sh refusals, before any work', () => {
  // A dead docker socket: even if a refusal regressed, these runs could never reach a real engine or project.
  const NO_DOCKER = { DOCKER_HOST: 'unix:///nonexistent/stack-gate-test.sock' };
  const gate = (env: Record<string, string>) =>
    spawnSync('bash', ['ci/gates/contract-gates.sh'], { encoding: 'utf8', env: { ...process.env, ...NO_DOCKER, ...env }, timeout: 20_000 });

  // why: F-134
  it('URL mode without a project to verify is refused, not passed (F-134)', () => {
    const r = gate({ BW_CONTRACT_BASE_URL: 'http://127.0.0.1:9', BW_CONTRACT_PROJECT: '' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot be');
    expect(r.stdout).not.toContain('contract-gates 1/3');
  });

  // why: F-132
  it('an own project outside bw-contract-* is refused, so down -v cannot reach the own copy (F-132)', () => {
    for (const name of ['brightwater', 'bw-contractx', 'bw-contract-UPPER', 'bw-contract-']) {
      const r = gate({ BW_CONTRACT_BASE_URL: '', BW_CONTRACT_PROJECT: name });
      expect(r.status, name).toBe(2);
      expect(r.stderr, name).toContain('is refused');
      expect(r.stdout, name).not.toContain('contract-gates 1/3');
    }
  });

  // why: F-132
  it('the reaper mode refuses a project outside bw-contract-*', () => {
    const r = spawnSync('bash', ['ci/gates/contract-gates.sh', '--reap', String(process.pid), 'brightwater', 'img', '/nonexistent'], {
      encoding: 'utf8',
      env: { ...process.env, ...NO_DOCKER },
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
  });
});
