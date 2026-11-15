// SPDX-License-Identifier: AGPL-3.0-or-later
// The health check and the board delay sample on the real database (PostgreSQL 18), as the web process serves them:
// GET /healthz answers 200 only while the database answers AND the worker's heartbeat is under 60 s old, and answers 503
// (never 500: the deploy rolls back at once on 500) otherwise; POST /board-delay-samples (API-172) stores a posted seq's
// delay (SD-43). Run by gate G-CI7 (ci/gates/G-CI7/vitest.db.config.ts); the merge set excludes *.db.test.ts.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@bw/config';
import { createPool, inTransaction } from '@bw/db';
import { createLogger } from '@bw/log';
import { Temporal } from '@bw/time';
import { useMigratedDatabase } from '../../db/src/testing/fixture.ts';
import { boardDelaySampleHandler } from './handlers/health.ts';
import type { ApiRequest, HandlerContext } from './types.ts';
import { createWebKernel } from './web.ts';

const db = useMigratedDatabase();
const asLogin = (url: string, user: string, port?: string) => {
  const u = new URL(url);
  u.username = user;
  if (port) u.port = port;
  return u.toString();
};
const log = createLogger({ process: 'web', clock: { realNow: () => Temporal.Instant.from('2026-11-01T12:00:00Z') }, write: () => undefined });

async function healthz(url: string): Promise<Response> {
  const k = createWebKernel({ settings: loadConfig({ DATABASE_URL: url }), log });
  try {
    return await k.router.handle(new Request('http://web:3000/healthz'));
  } finally {
    await k.close();
  }
}

const beat = (age: string) =>
  db.admin().query(`INSERT INTO system.worker_heartbeat (id, beat_real) VALUES (1, now() - $1::interval) ON CONFLICT (id) DO UPDATE SET beat_real = EXCLUDED.beat_real`, [age]);

describe('GET /healthz (API-171, SPECIFICATIONS 7.4)', () => {
  // why: NFR-11, F-99
  it('answers 503 when no heartbeat has ever been written, and 200 once the worker beats', async () => {
    const url = asLogin(db.url(), 'bw_web');
    const none = await healthz(url);
    expect(none.status).toBe(503);
    await beat('0 seconds');
    const fresh = await healthz(url);
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toBe('{"status":"ok"}');
  });

  // why: NFR-11
  it('answers 503 when the heartbeat is 60 s old or more, 200 when it is 59 s old, with no product data in the 503', async () => {
    const url = asLogin(db.url(), 'bw_web');
    await beat('59 seconds');
    expect((await healthz(url)).status).toBe(200);
    await beat('61 seconds');
    const stale = await healthz(url);
    expect(stale.status).toBe(503);
    expect(stale.headers.get('content-type')).toMatch(/problem\+json/);
    const body = (await stale.json()) as { code: string; status: number };
    expect(body).toMatchObject({ code: 'server_error', status: 503 });
    expect(JSON.stringify(body)).not.toMatch(/customer|address|@/);
  });

  // why: F-99, F-215
  it('answers 503, never 500, when the database does not answer (a stopped server)', async () => {
    const r = await healthz(asLogin(db.url(), 'bw_web', '1'));
    expect(r.status).toBe(503);
  });
});

describe('POST /board-delay-samples (API-172, SD-43)', () => {
  const ctx = (events: { emitTime(seq: number): number | undefined } | null, iso: string): HandlerContext =>
    ({ clock: { realNow: () => Temporal.Instant.from(iso) }, events }) as unknown as HandlerContext;
  const req = (seq: number): ApiRequest => ({ contract: 'API-172', params: { seq }, body: { seq } }) as unknown as ApiRequest;

  // why: FR-HLTH-3, SD-43
  it('records a posted seq as ms = receive time minus emit time, answers 204 for a seq it no longer holds, and prunes samples older than 24 hours', async () => {
    const pool = createPool({ connectionString: asLogin(db.url(), 'bw_web'), max: 2 });
    try {
      const emit = Temporal.Instant.from('2026-11-01T12:00:00.000Z').epochMilliseconds;
      const bus = { emitTime: (seq: number) => (seq === 101 ? emit : undefined) };
      const run = (seq: number, at: string) => inTransaction(pool, (tx) => boardDelaySampleHandler(req(seq), tx, ctx(bus, at)));
      await db.admin().query(`INSERT INTO system.delay_sample (seq, emitted_real, acked_real, ms) VALUES (1, '2026-10-30T00:00:00Z', '2026-10-30T00:00:01Z', 1000)`);
      expect(await run(101, '2026-11-01T12:00:02.345Z')).toMatchObject({ ok: true, status: 204 });
      expect(await run(102, '2026-11-01T12:00:03Z')).toMatchObject({ ok: true, status: 204 });
      const rows = await db.admin().query<{ seq: string; ms: number; emitted_real: Date; acked_real: Date }>('SELECT seq, ms, emitted_real, acked_real FROM system.delay_sample ORDER BY seq');
      expect(rows.rows).toEqual([{ seq: '101', ms: 2345, emitted_real: new Date('2026-11-01T12:00:00Z'), acked_real: new Date('2026-11-01T12:00:02.345Z') }]);
    } finally {
      await pool.end();
    }
  });
});
