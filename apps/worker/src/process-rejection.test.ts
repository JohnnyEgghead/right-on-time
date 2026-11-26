// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1845 through the real entry points: the web, worker and pbs processes each start as Compose starts them (node on
// the entry file, a database URL that refuses), and a preload rejects 1 promise nobody handles once the process has
// added its listener. Each must write 1 error-level line with the cause code, never the message (not on stdout and not
// on stderr, where Node's default would print it), and exit 1 so the restart policy restarts it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const preload = path.join(import.meta.dirname, 'testing', 'reject-once-hooked.ts');

const ENTRIES = [
  // A checkout with no Next.js build exits 1 in the tick the web process starts, before Node handles a pending
  // rejection, so the preload calls the listener the real entry added (the worker and pbs runs prove Node's own path).
  // BW_WEB_PREVIEW=1 makes the run look for the preview build, which a fresh checkout does not hold, so a built apps/web/.next
  // does not start a real server here (F-1940).
  { process: 'web', entry: 'apps/web/src/server.ts', user: 'bw_web', env: { BW_TEST_CALL_LISTENER: '1', BW_WEB_PREVIEW: '1' }, exits: false },
  { process: 'worker', entry: 'apps/worker/src/main.ts', user: 'bw_worker', env: {}, exits: true },
  { process: 'pbs', entry: 'apps/pbs/src/main.ts', user: 'bw_pbs', env: {}, exits: true },
] as const;

describe('an unhandled rejection in each process (F-1845)', () => {
  for (const p of ENTRIES) {
    // why: F-1845, NFR-05: an unhandled rejection was a crash with the message on stderr and no line in the app log.
    it(`${p.process}: logs 1 error line with the cause code, no message, and exits 1`, () => {
      const run = spawnSync(process.execPath, ['--import', preload, path.join(root, p.entry)], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', PORT: '0', DATABASE_URL: `postgres://${p.user}@127.0.0.1:1/brightwater`, ...p.env },
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
      });
      // F-1871: web keeps serving through a rejection (the exit 1 here is the missing Next build's, so it proves nothing); worker and pbs exit 1.
      if (p.exits) expect(run.status, run.stderr).toBe(1);
      const lines = run.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
      const hit = lines.filter((l) => l.status === 'unhandled rejection');
      expect(hit).toHaveLength(1);
      expect(hit[0]).toMatchObject({ level: 'error', process: p.process, errorCode: 'TypeError' });
      expect(Object.keys(hit[0]!).sort()).toEqual(['errorCode', 'level', 'process', 'realTime', 'status']);
      expect(`${run.stdout}${run.stderr}`).not.toMatch(/private words|6145550100|Main St/);
    }, 30_000);
  }
});

// F-1870: an exception no code caught. Without a hook Node prints its message and stack to stderr before it exits.
describe('an uncaught exception in worker and pbs (F-1870)', () => {
  for (const p of ENTRIES.filter((e) => e.exits)) {
    // why: F-1870: PRIVACY.md says the log never carries an error message; Node's default crash output quotes it on stderr.
    it(`${p.process}: logs 1 error line with the cause code, no message on either stream, and exits 1`, () => {
      const run = spawnSync(process.execPath, ['--import', preload, path.join(root, p.entry)], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', PORT: '0', DATABASE_URL: `postgres://${p.user}@127.0.0.1:1/brightwater`, BW_TEST_EVENT: 'exception' },
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(run.status, run.stderr).toBe(1);
      const lines = run.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
      const hit = lines.filter((l) => l.status === 'uncaught exception');
      expect(hit).toHaveLength(1);
      expect(hit[0]).toMatchObject({ level: 'error', process: p.process, errorCode: 'TypeError' });
      expect(`${run.stdout}${run.stderr}`).not.toMatch(/private words|6145550100|Main St/);
    }, 30_000);
  }
});
