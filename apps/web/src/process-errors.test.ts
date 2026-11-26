// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-05 (F-1870, F-1871: the web process's own crash output carries no error message, and a rejection Next survives is survived)
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLogger } from '@bw/log';
import { describe, expect, it } from 'vitest';
import { logProcessErrorsAndKeepServing, type ErrorProcess } from './process-errors.ts';

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

describe('an error the closed stdout causes, in web (F-1939)', () => {
  // why: F-1939: a write to a closed stdout failed, the hook's error line was another write, and the process spun and ignored SIGTERM.
  it('uses little CPU and exits 0 when its stdout pipe is closed, and does not spin', async () => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'testing', 'closed-stdout.ts')], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.destroy();
    let err = '';
    let cpu: { user: number; system: number } | null = null;
    child.on('message', (m) => { cpu = m as { user: number; system: number }; });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
    const ended = await new Promise<number | null>((resolve) => {
      const guard = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 8_000);
      child.once('exit', (code) => { clearTimeout(guard); resolve(code); });
    });
    expect(ended, err).toBe(0);
    expect(cpu, 'the CPU time the child reported').not.toBeNull();
    // 1.5 s of pause: a looping process has used about all of it (1,500,000 microseconds); an idle one a tenth.
    const used = cpu as unknown as { user: number; system: number };
    expect(used.user + used.system).toBeLessThan(600_000);
  }, 15_000);
});

describe('an EPIPE in web, by the socket it came from', () => {
  const setup = () => {
    const lines: string[] = [];
    const proc = new EventEmitter();
    const stdout = new EventEmitter();
    const log = createLogger({ process: 'web', write: (l) => lines.push(l) });
    logProcessErrorsAndKeepServing(log, proc as unknown as ErrorProcess, {}, stdout);
    return { lines, proc, stdout };
  };
  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

  // why: F-1984: an EPIPE of a socket other than stdout was dropped without its one error line.
  it('logs 1 line for an uncaught EPIPE that did not come from stdout', () => {
    const { lines, proc } = setup();
    proc.emit('uncaughtException', epipe());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: 'error', status: 'uncaught exception' });
  });

  // why: F-1984: the stdout EPIPE stays dropped on the stream itself, and any other stdout error is thrown.
  it('drops a stdout EPIPE with no line and throws any other stdout error', () => {
    const { lines, stdout } = setup();
    expect(() => stdout.emit('error', epipe())).not.toThrow();
    expect(lines).toEqual([]);
    expect(() => stdout.emit('error', Object.assign(new Error('x'), { code: 'EIO' }))).toThrow('x');
  });
});
