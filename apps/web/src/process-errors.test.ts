// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-05 (F-1870, F-1871: the web process's own crash output carries no error message, and a rejection Next survives is survived)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.join(import.meta.dirname, 'testing', 'next-error-delivery.ts');
const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...(env as Record<string, string | undefined>), PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000 });

describe('an error no code handled, in web with the real Next.js listeners installed', () => {
  // why: F-1870: control. Next's own listeners print the message, so the hook's silence below is the hook's doing.
  it('control: without the hook Next prints the message and keeps serving', () => {
    const r = run({ BW_TEST_NO_HOOK: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('still serving');
    expect(`${r.stdout}${r.stderr}`).toMatch(/private words/);
  });

  // why: F-1870, F-1871: with the hook, 1 error line per event (rejection, exception), no message anywhere, and the process keeps serving.
  it('writes 1 safe line per rejection and exception, prints no message and keeps serving', () => {
    const r = run({});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('still serving');
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.level, l.process, l.status, l.errorCode])).toEqual([
      ['error', 'web', 'unhandled rejection', 'TypeError'],
      ['error', 'web', 'uncaught exception', 'RangeError'],
    ]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/private words|6145550100|Main St|Oak Ave/);
    expect(r.stderr).toBe('');
  });
});
