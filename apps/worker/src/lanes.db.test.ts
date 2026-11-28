// SPDX-License-Identifier: AGPL-3.0-or-later
// The dispatcher's 2 claim lanes through the worker as main.ts starts it (F-357, F-382): the real job registry, the
// production pool shape (4 connections as bw_worker), the production billing lane (BILLING_CONCURRENCY wide, the client's
// own timeout) and its normal-running timer, against the real pbs over HTTP held in Not answering. While every billing
// slot waits on pbs, no pooled connection and no billing_item row lock is held, a text.try due now is still delivered at
// once, and no more than BILLING_CONCURRENCY sends are out; each job still ends with 1 attempt and 1 invoice.
// Run by gate G-CI2 (ci/gates/G-CI2/vitest.db.config.ts includes apps/worker/src/*.db.test.ts).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, inTransaction } from '@bw/db';
import { createLogger } from '@bw/log';
import type pg from 'pg';
import { startPbs, type PbsServer } from '../../pbs/src/server.ts';
import { ensureModeRow } from '../../pbs/src/store.ts';
import { SERVICES } from '../../../packages/db/src/seed/reference-data.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { enqueueText } from '../../../packages/outbox/src/index.ts';
import {
  addCustomer, addJob, confirmationValues, I, loginPool, seedOutboxWorld, setDemoClock, testCatalog, textRow, type OutboxRef,
} from '../../../packages/outbox/src/testing/world.ts';
import { HttpBillingClient } from './billing/client.ts';
import { BILLING_CONCURRENCY, WORKER_POOL_MAX } from './billing/link.ts';
import { markFixed } from './billing/fixed.ts';
import { billFinishedJob, billingList } from './billing/queue.ts';
import { MAX_HANDLER_FAILURES } from './dispatcher.ts';
import { startTestWorker, type TestWorker } from './testing/worker.ts';

/** pbs's Not answering hold, real ms: shorter than the link's 30 s timeout, so each held send ends stored_late. */
const HOLD_MS = 8_000;
const NOW = '2026-09-15T14:00:00Z';

const db = useMigratedDatabase();
let ref: OutboxRef;
let pbsPool: pg.Pool;
let pbs: PbsServer & { url: string };
let client: HttpBillingClient;
let worker: TestWorker;
let web: ReturnType<typeof loginPool>;
let relay: http.Server;
/** The owner login, for the stand-in finish and the row-lock probe (each needs 1 transaction). */
let owner: pg.Pool;
/** Invoice sends open at pbs now, and the most at once (counted by a relay in front of pbs). */
const sends = { open: 0, most: 0 };

const asLogin = (url: string, user: string) => {
  const u = new URL(url);
  u.username = user;
  return u.toString();
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => Promise<boolean>, withinMs: number): Promise<number> {
  const t0 = performance.now();
  while (!(await ok())) {
    if (performance.now() - t0 > withinMs) throw new Error(`${what}: not within ${withinMs} ms`);
    await pause(25);
  }
  return performance.now() - t0;
}
const count = async (sql: string, values: unknown[]) => Number((await db.admin().query<{ n: string }>(sql, values)).rows[0]!.n);

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin(), NOW);
  // The seed's service types (as the billing test world inserts them), so each invoice composes.
  for (const t of SERVICES) {
    await db.admin().query(`INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key, invoice_price_cents, job_type, expected_minutes, skill, bookable_online)
                            VALUES ($1, 's', 't', 'p', 'l', $2, $3, $4, $5, $6)`, [t.id, t.cents, t.jobType, t.minutes, t.skill, t.online]);
  }
  pbsPool = createPool({ connectionString: asLogin(db.url(), 'bw_pbs'), max: 8 });
  await ensureModeRow(pbsPool);
  pbs = await startPbs({ pool: pbsPool, log: createLogger({ process: 'pbs', write: () => undefined }), host: '127.0.0.1', port: 0, holdMs: HOLD_MS });
  client = new HttpBillingClient(pbs.url);
  await client.reset(1);
  web = loginPool(db.url(), 'bw_web');
  owner = createPool({ connectionString: db.url(), max: 2 });
  const target = new URL(pbs.url);
  relay = http.createServer((req, res) => {
    const counted = req.method === 'POST' && req.url === '/invoices';
    if (counted) sends.most = Math.max(sends.most, ++sends.open);
    const done = () => {
      if (counted) sends.open -= 1;
    };
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    res.once('close', done);
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  worker = await startTestWorker(db.url(), { PBS_URL: `http://127.0.0.1:${(relay.address() as AddressInfo).port}` });
});
afterAll(async () => {
  await worker?.stop();
  await web?.end();
  relay?.closeAllConnections();
  await new Promise((r) => relay?.close(r));
  await pbs?.close();
  await pbsPool?.end();
  await owner?.end();
});

/** A finished job (No parts used, 1 hour) queued for billing at NOW, as the finish paths do (FR-BILL-1). */
async function finishedJob(): Promise<number> {
  const customer = await addCustomer(db.admin(), ref);
  const job = await addJob(db.admin(), ref, customer, '2026-09-15', { service_id: 'furnace_tune_up', status: 'on_site', arrived_at: '2026-09-15T13:00:00Z' });
  await inTransaction(owner, async (tx) => {
    await tx.query(`UPDATE world.job SET status = 'done', ended_at = $2, labor_minutes = 60, no_parts_used = true, version = version + 1 WHERE job_number = $1`, [job, NOW]);
    await billFinishedJob(tx, { jobNumber: job, at: I(NOW) });
  });
  return job;
}

describe('the billing lane beside the serial lane, under Not answering (F-357, F-382)', () => {
  // why: F-382, F-357
  it('holds no connection and no item row lock while 4 sends wait on pbs, and a text.try due now is still delivered', async () => {
    expect(BILLING_CONCURRENCY).toBeLessThan(WORKER_POOL_MAX);
    expect(worker.pool.options.max).toBe(WORKER_POOL_MAX);
    await setDemoClock(db.admin(), NOW);
    await client.setMode({ mode: 'not_answering' });
    const jobs = [await finishedJob(), await finishedJob(), await finishedJob(), await finishedJob()];

    // The worker's own timer claims them: BILLING_CONCURRENCY sends reach pbs, and pbs holds each one.
    await until('the billing lane sends', async () => sends.open >= BILLING_CONCURRENCY, 5_000);
    const t0 = performance.now();

    // 1. Every pooled connection can be lent at once: none is held across the call (the old shape held 1 per send).
    const lent = await Promise.all(Array.from({ length: WORKER_POOL_MAX }, () => worker.pool.connect()));
    for (const c of lent) c.release();
    expect(performance.now() - t0).toBeLessThan(2_000);

    // 2. No billing_item row lock is held: Retry now, Retry all and Mark fixed would not wait on the call.
    await inTransaction(owner, async (tx) => {
      const r = await tx.query('SELECT job_number FROM world.billing_item WHERE job_number = ANY($1) FOR UPDATE NOWAIT', [jobs]);
      expect(r.rows).toHaveLength(4);
    });

    // 3. A text due now is delivered by the serial lane's next pass, while the sends are still held.
    const customer = await addCustomer(db.admin(), ref);
    const text = await inTransaction(web, (tx) =>
      enqueueText(tx, { kind: 'confirmation', customerId: customer, jobNumber: jobs[0]!, now: I(NOW), catalog: testCatalog, values: confirmationValues }));
    if (!text.ok) throw new Error(text.reason);
    await until('the text is delivered', async () => (await textRow(db.admin(), text.textId)).status === 'delivered', 3_000);
    expect(performance.now() - t0).toBeLessThan(HOLD_MS);
    expect(await count('SELECT count(*) AS n FROM world.billing_attempt WHERE job_number = ANY($1)', [jobs])).toBe(0);

    // 4. Parallel across jobs, capped: never more than BILLING_CONCURRENCY sends out at once.
    expect(sends.open).toBe(BILLING_CONCURRENCY);
    expect(sends.most).toBe(BILLING_CONCURRENCY);

    // Each held send ends stored_late; the 4th job runs when a slot frees. Every job: 1 attempt, 1 invoice, in billing.
    await until('every job is in billing', async () =>
      (await count(`SELECT count(*) AS n FROM world.billing_item WHERE job_number = ANY($1) AND state = 'in_billing'`, [jobs])) === 4, 3 * HOLD_MS);
    expect(await count('SELECT count(*) AS n FROM world.billing_attempt WHERE job_number = ANY($1)', [jobs])).toBe(4);
    expect(await count('SELECT count(*) AS n FROM pbs.invoice WHERE job_number = ANY($1)', [jobs])).toBe(4);
    expect(sends.most).toBe(BILLING_CONCURRENCY);
    await client.setMode({ mode: 'up' });
  });
});

describe('a billing send that fails every run in the parallel lane (F-2006 K-02)', () => {
  // why: F-2006 K-02 the parallel lane had no give-up, so a billing event whose handler always failed was retried every pass for ever, unseen; F-2105 the given-up item was off the office list, so Mark fixed refused it
  it('is given up at the 5th failed run: its item waits for a person on the office list, Mark fixed takes it, its alert is open and its event has ended', async () => {
    await setDemoClock(db.admin(), NOW);
    await client.setMode({ mode: 'up' });
    const job = await finishedJob();
    // Every record of this job's send fails in the database (a full disk, a broken table), so each run's handler fails.
    await db.admin().query(`CREATE FUNCTION world.test_refuse_attempt() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.job_number = ${job} THEN RAISE EXCEPTION 'no room' USING ERRCODE = '53100'; END IF;
        RETURN NEW;
      END $f$`);
    await db.admin().query(`CREATE TRIGGER test_refuse_attempt BEFORE INSERT ON world.billing_attempt FOR EACH ROW EXECUTE FUNCTION world.test_refuse_attempt()`);
    const item = async () => (await db.admin().query<{ state: string }>('SELECT state FROM world.billing_item WHERE job_number = $1', [job])).rows[0]!.state;
    for (let pass = 0; pass < 40 && (await item()) !== 'waiting_person'; pass += 1) await worker.drain();

    expect(await item()).toBe('waiting_person');
    const alerts = await db.admin().query<{ state: string }>(`SELECT state FROM world.alert WHERE type = 'billing_waiting_person' AND subject = $1`, [String(job)]);
    expect(alerts.rows).toEqual([{ state: 'open' }]);
    const events = await db.admin().query<{ id: string; state: string; result: string | null }>(
      `SELECT id, state, result FROM world.scheduled_event WHERE subject = $1 AND kind LIKE 'billing.%' AND state = 'due'`, [String(job)]);
    expect(events.rows).toEqual([]);
    const gaveUp = await db.admin().query<{ id: string; n: number }>(
      `SELECT id, (payload->>'failures')::int AS n FROM world.scheduled_event WHERE subject = $1 AND result = 'handler_failed'`, [String(job)]);
    expect(gaveUp.rows.map((r) => r.n)).toEqual([MAX_HANDLER_FAILURES]);
    const mine = worker.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.eventId === gaveUp.rows[0]!.id);
    expect(mine.map((l) => [l.status, l.errorCode])).toEqual([
      ...[1, 2, 3, 4, 5].map(() => ['event failed', '53100']), ['event gave up', '53100'],
    ]);
    // F-2105: the given-up item (0 tries) is on the office billing list its alert links to, and Mark fixed accepts it.
    const { waiting } = await billingList(worker.pool, { branchId: ref.branchId, now: I(NOW) });
    expect(waiting.filter((w) => w.jobNumber === job).map((w) => [w.state, w.tries])).toEqual([['waiting_person', 0]]);
    expect(await markFixed({ pool: worker.pool, client }, { jobNumber: job, reason: 'Entered in billing by hand', by: ref.userId, at: I(NOW) }))
      .toEqual({ ok: true });
    await db.admin().query('DROP TRIGGER test_refuse_attempt ON world.billing_attempt');
  });
});
