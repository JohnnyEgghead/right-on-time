// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-AUTH-5, FR-AUTH-6 (F-286: the start-up inputs of the access surface do not fail quietly)
import { loadConfig } from '@bw/config';
import { createLogger } from '@bw/log';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './kernel/headers.ts';
import type { Router } from './kernel/mount.ts';
import { createWebKernel, startSync, syncGuard, syncWithRetry } from './web.ts';

describe('start-up of the access surface', () => {
  // why: FR-AUTH-6 (a failed access code sync is tried again, not logged once and forgotten)
  it('retries a failing sync after each delay and rethrows the last failure when every try fails', async () => {
    let tries = 0;
    await syncWithRetry(async () => { if (++tries < 3) throw new Error('db not ready'); }, [1, 1, 1, 1]);
    expect(tries).toBe(3);
    let all = 0;
    await expect(syncWithRetry(async () => { all++; throw new Error('still down'); }, [1, 1])).rejects.toThrow('still down');
    expect(all).toBe(3);
  });

  // why: FR-AUTH-5 (demo mode on with no seed would list nobody; the process refuses to start instead)
  it('refuses to start with DEMO_MODE=on and no SAMPLE_PASSWORD_SEED', () => {
    const settings = loadConfig({ DATABASE_URL: 'postgres://web@127.0.0.1:1/none', DEMO_MODE: 'on' });
    expect(() => createWebKernel({ settings, log: createLogger({ process: 'web', write: () => undefined }) })).toThrow(/SAMPLE_PASSWORD_SEED/);
  });
});

const quiet = createLogger({ process: 'web', write: () => undefined });

describe('a database that does not answer within the start-up window (F-316)', () => {
  const inner: Router = {
    routes: [{ contract: 'API-171', method: 'GET', path: '/healthz' }],
    owns: (p) => p === '/healthz',
    handle: async () => new Response('ok', { status: 200 }),
  };
  const until = async (cond: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

  // why: FR-AUTH-6, SD-6 (a process that gave up on the sync answers 503 as a kernel Problem with the 11.5 headers, names the cause once, and heals when the database answers)
  it('answers 503 as a Problem with the 11.5 headers, logs once, then recovers in the background', async () => {
    let down = true;
    let tries = 0;
    let logged = 0;
    const sync = startSync({
      run: async () => { tries++; if (down) throw new Error('db down'); },
      codeOn: true, delaysMs: [1, 1], recoverEveryMs: 5, onFail: () => { logged++; },
    });
    const guarded = syncGuard(inner, sync, quiet);
    const r = await guarded.handle(new Request('http://x/healthz'), { address: '127.0.0.1' } as never);
    expect(r.status).toBe(503);
    expect(r.headers.get('content-type')).toBe('application/problem+json');
    expect(r.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await r.json()).toMatchObject({ status: 503, code: 'server_error', meta: { contract: 'API-171' } });
    await new Promise((r2) => setTimeout(r2, 30));
    expect(logged).toBe(1);
    expect(tries).toBeGreaterThan(3);
    down = false;
    await until(() => !sync.failed());
    expect(sync.failed()).toBe(false);
    expect((await guarded.handle(new Request('http://x/healthz'), { address: '127.0.0.1' } as never)).status).toBe(200);
    sync.stop();
  });

  // why: F-1655 (the 503 names the contract of the route the router matches: a route with a parameter, and the method's own row of a shared path)
  it('labels the 503 with the matched route\'s contract, for a parameterized route and by method', async () => {
    const wide: Router = {
      routes: [
        { contract: 'API-171', method: 'GET', path: '/healthz' },
        { contract: 'API-90', method: 'GET', path: '/api/v1/jobs/{id}' },
        { contract: 'API-91', method: 'POST', path: '/api/v1/jobs/{id}' },
        { contract: 'API-92', method: 'GET', path: '/api/v1/jobs/{id}/notes/{note}' },
      ],
      owns: (p) => p === '/healthz' || p.startsWith('/api/'),
      handle: async () => new Response('ok', { status: 200 }),
    };
    const sync = startSync({ run: async () => { throw new Error('db down'); }, codeOn: true, delaysMs: [1], recoverEveryMs: 1_000, onFail: () => undefined });
    const guarded = syncGuard(wide, sync, quiet);
    const label = async (method: string, path: string) =>
      ((await (await guarded.handle(new Request(`http://x${path}`, { method }), { address: '127.0.0.1' } as never)).json()) as { meta: { contract: string } }).meta.contract;
    expect(await label('GET', '/api/v1/jobs/42')).toBe('API-90');
    expect(await label('POST', '/api/v1/jobs/42')).toBe('API-91');
    expect(await label('GET', '/api/v1/jobs/42/notes/7')).toBe('API-92');
    expect(await label('GET', '/healthz')).toBe('API-171');
    sync.stop();
  });

  // why: FR-AUTH-6 (with the access code off a failed sync never fails a call)
  it('never answers 503 with the access code off', async () => {
    const sync = startSync({ run: async () => { throw new Error('down'); }, codeOn: false, delaysMs: [1], recoverEveryMs: 1_000, onFail: () => undefined });
    await sync.ready;
    expect(sync.failed()).toBe(false);
    sync.stop();
  });
});

describe('a failed access code sync is logged with its cause (F-1848)', () => {
  const PRIVATE = 'Harold Jenkins 6145550100 at 12 Oak St';
  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    return { lines, log: createLogger({ process: 'web', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }) };
  };
  const inner: Router = {
    routes: [{ contract: 'API-90', method: 'GET', path: '/api/v1/jobs/{id}' }],
    owns: (p) => p.startsWith('/api/'),
    handle: async () => new Response('ok', { status: 200 }),
  };

  // why: F-1848: onFail got no error, each guarded 503 logged nothing, and a healed sync was never said to have healed.
  it('passes the error to onFail, logs each guarded 503 with the cause code, and logs the recovery once', async () => {
    const { lines, log } = capture();
    let down = true;
    const failure = Object.assign(new Error(PRIVATE), { code: '57P03' });
    const seen: unknown[] = [];
    let recovered = 0;
    const sync = startSync({
      run: async () => { if (down) throw failure; },
      codeOn: true, delaysMs: [1], recoverEveryMs: 5,
      onFail: (e) => { seen.push(e); }, onRecover: () => { recovered++; },
    });
    const guarded = syncGuard(inner, sync, log);
    for (let i = 0; i < 2; i++) expect((await guarded.handle(new Request('http://x/api/v1/jobs/42'))).status).toBe(503);
    expect(seen).toEqual([failure]);
    expect(sync.cause()).toBe('57P03');
    expect(lines.map((l) => [l.level, l.contract, l.route, l.status, l.errorCode])).toEqual([
      ['error', 'API-90', '/api/v1/jobs/{id}', 503, '57P03'], ['error', 'API-90', '/api/v1/jobs/{id}', 503, '57P03'],
    ]);
    down = false;
    for (let i = 0; i < 200 && sync.failed(); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await guarded.handle(new Request('http://x/api/v1/jobs/42'))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(recovered).toBe(1);
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toMatch(/Harold|6145550100|Oak/);
    sync.stop();
  });

  // why: F-1848: the web process's own wiring names the cause: a database that refuses the connection logs ECONNREFUSED, not server_error.
  it('logs the web kernel\'s failed sync and its guarded 503 with the connection error\'s code', async () => {
    const { lines, log } = capture();
    const settings = loadConfig({ DATABASE_URL: 'postgres://web@127.0.0.1:1/none', ACCESS_CODE_ON: 'on', ACCESS_CODE: 'a-test-access-code', ACCESS_COOKIE_KEY: 'k'.repeat(43) });
    const kernel = createWebKernel({ settings, log });
    try {
      const r = await kernel.router.handle(new Request('http://x/healthz'), { address: '127.0.0.1' } as never);
      expect(r.status).toBe(503);
      const failed = lines.filter((l) => l.status === 'access code sync failed');
      expect(failed.map((l) => [l.level, l.errorCode])).toEqual([['error', 'ECONNREFUSED']]);
      expect(lines.filter((l) => l.status === 503).map((l) => [l.level, l.contract, l.errorCode])).toEqual([['error', 'API-171', 'ECONNREFUSED']]);
    } finally {
      await kernel.close();
    }
  }, 30_000);

  // why: F-1872: the recovery line at web.ts onRecover was never asserted, so deleting its wiring passed every test; this drives the kernel's own sync to a recovery.
  it('logs the web kernel\'s recovery once, as an info line with no field but the status', async () => {
    const { lines, log } = capture();
    let down = true;
    const settings = loadConfig({ DATABASE_URL: 'postgres://web@127.0.0.1:1/none', ACCESS_CODE_ON: 'on', ACCESS_CODE: 'a-test-access-code', ACCESS_COOKIE_KEY: 'k'.repeat(43) });
    const kernel = createWebKernel({
      settings, log,
      syncSeam: { run: async () => { if (down) throw Object.assign(new Error(PRIVATE), { code: '57P03' }); }, delaysMs: [1], recoverEveryMs: 5 },
    });
    try {
      expect((await kernel.router.handle(new Request('http://x/healthz'), { address: '127.0.0.1' } as never)).status).toBe(503);
      expect(lines.filter((l) => l.status === 'access code sync failed').map((l) => l.errorCode)).toEqual(['57P03']);
      down = false;
      for (let i = 0; i < 200 && !lines.some((l) => l.status === 'access code sync recovered'); i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 30));
      const healed = lines.filter((l) => l.status === 'access code sync recovered');
      expect(healed.map((l) => [l.level, l.process, Object.keys(l).sort().join(',')])).toEqual([['info', 'web', 'level,process,realTime,status']]);
      expect(JSON.stringify(lines)).not.toMatch(/Harold|6145550100|Oak/);
    } finally {
      await kernel.close();
    }
  }, 30_000);
});
