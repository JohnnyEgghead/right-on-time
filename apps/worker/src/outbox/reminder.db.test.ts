// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer texts through the worker as main.ts starts it (job registry, bw_worker, DbClock on the clock row):
// the confirmation within 1 minute of booking or held to 8:00 AM (FR-TEXT-1), and the 6:00 PM reminder of the evening
// before in each customer's zone, or a call list entry (FR-TEXT-2, FR-TEXT-13, FR-TEXT-17).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { useMigratedDatabase } from '../../../../packages/db/src/testing/fixture.ts';
import { catalogs as realCatalogs } from '../../../../packages/i18n/src/catalog.ts';
import { planReminder, sendConfirmation, type TextContext } from '../../../../packages/outbox/src/index.ts';
import { addCustomer, addJob, count, I, loginPool, seedOutboxWorld, setDemoClock, textRow, type OutboxRef } from '../../../../packages/outbox/src/testing/world.ts';
import { startTestWorker, type TestWorker } from '../testing/worker.ts';

const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;
let worker: TestWorker;
const ctx: TextContext = { catalogs: { en: { ...realCatalogs.en, 't.k': 'furnace tune-up' }, es: { ...realCatalogs.es, 't.k': 'ajuste de calefactor' } }, linkHost: 'bw.j7l.io' };

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin());
  web = loginPool(db.url(), 'bw_web');
  worker = await startTestWorker(db.url());
});
afterAll(async () => {
  await worker?.stop();
  await web?.end();
});

async function at(t: string): Promise<void> {
  await setDemoClock(db.admin(), t);
  await worker.drain();
}

const reminders = (customerId: string) =>
  db.admin().query<{ id: string; created_at: Date; status: string; body: string }>(
    `SELECT id, created_at, status, body FROM world.outbox_text WHERE customer_id = $1 AND kind = 'reminder' ORDER BY created_at`, [customerId]).then((r) => r.rows);

describe('the confirmation through the worker (FR-TEXT-1)', () => {
  // why: FR-TEXT-1
  it('a booking at 10:00 AM is in the customer inbox by 10:01 AM', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    await setDemoClock(db.admin(), '2026-09-15T14:00:00Z');
    const r = await inTransaction(web, (tx) => sendConfirmation(tx, ctx, { jobNumber: job, now: I('2026-09-15T14:00:00Z') }));
    if (!r.ok) throw new Error(r.reason);
    await at('2026-09-15T14:00:30Z');
    const row = await textRow(db.admin(), r.textId);
    expect(row.status).toBe('delivered');
    expect((row.delivered_at as Date).getTime()).toBeLessThanOrEqual(new Date('2026-09-15T14:01:00Z').getTime());
    const inbox = await db.admin().query(`SELECT direction, body FROM world.inbox_message WHERE text_id = $1`, [r.textId]);
    expect(inbox.rows).toEqual([{ direction: 'out', body: row.body }]);
  });

  // why: FR-TEXT-1
  it('a booking at 12:30 AM EDT gets its confirmation at 8:00 AM EDT, not before', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-17');
    await setDemoClock(db.admin(), '2026-09-16T04:30:00Z');
    const r = await inTransaction(web, (tx) => sendConfirmation(tx, ctx, { jobNumber: job, now: I('2026-09-16T04:30:00Z') }));
    if (!r.ok) throw new Error(r.reason);
    await at('2026-09-16T11:59:59Z');
    expect((await textRow(db.admin(), r.textId)).status).toBe('held');
    await at('2026-09-16T12:00:00Z');
    const row = await textRow(db.admin(), r.textId);
    expect(row).toMatchObject({ status: 'delivered', delivered_at: new Date('2026-09-16T12:00:00Z') });
  });
});

describe('the reminder event through the worker (FR-TEXT-2, FR-TEXT-13, FR-TEXT-17)', () => {
  // why: FR-TEXT-2; F-490
  it('gives each Sep 16 Eastern customer exactly 1 reminder at 6:00 PM, a Pacific customer hers when the clock passes 9:00 PM EDT', async () => {
    const ny = await addCustomer(db.admin(), ref);
    const nyEs = await addCustomer(db.admin(), ref, { language: 'es' });
    const la = await addCustomer(db.admin(), ref, { zone: 'America/Los_Angeles', name: 'Deborah Lin' });
    const noMobile = await addCustomer(db.admin(), ref, { mobile: null });
    const off = await addCustomer(db.admin(), ref, { textsOn: false });
    const jobs: Record<string, number> = {};
    await setDemoClock(db.admin(), '2026-09-15T13:00:00Z'); // 9:00 AM EDT
    for (const [k, c] of Object.entries({ ny, nyEs, la, noMobile, off })) {
      jobs[k] = await addJob(db.admin(), ref, c, '2026-09-16');
      await inTransaction(web, (tx) => planReminder(tx, { jobNumber: jobs[k]!, now: I('2026-09-15T13:00:00Z') }));
    }
    await at('2026-09-15T21:59:59Z');
    expect(await reminders(ny)).toEqual([]);
    await at('2026-09-15T22:05:00Z'); // 6:05 PM EDT
    const [a] = await reminders(ny);
    expect(await reminders(ny)).toHaveLength(1);
    expect(a!.body).toBe('Brightwater reminder: your technician arrives tomorrow, 8-10 AM EDT. Reply C to confirm or R to reschedule.');
    expect(a!.created_at).toEqual(new Date('2026-09-15T22:05:00Z'));
    expect((await reminders(nyEs))[0]!.body).toBe('Recordatorio de Brightwater: su técnico llega mañana, de 8 a 10 AM EDT. Responda C para confirmar o R para cambiar.');
    expect(await reminders(la)).toEqual([]); // 3:05 PM Pacific: not yet
    // FR-TEXT-13: no mobile and texts off are on the Sep 15 call list and get no reminder text.
    const calls = await db.admin().query(`SELECT customer_id, call_date::text AS call_date, reason FROM world.call_list_entry WHERE job_number IN ($1, $2) ORDER BY job_number`, [jobs.noMobile, jobs.off]);
    expect(calls.rows).toEqual([
      { customer_id: noMobile, call_date: '2026-09-15', reason: 'no_mobile' },
      { customer_id: off, call_date: '2026-09-15', reason: 'texts_off' },
    ]);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.outbox_text WHERE customer_id IN ($1, $2)`, [noMobile, off])).toBe(0);
    await at('2026-09-16T01:00:00Z'); // 9:00 PM EDT = 6:00 PM PDT
    expect(await reminders(la)).toHaveLength(1);
    expect((await reminders(la))[0]!.created_at).toEqual(new Date('2026-09-16T01:00:00Z'));
    await at('2026-09-16T02:00:00Z'); // a later pass makes no second reminder for anyone
    expect(await reminders(ny)).toHaveLength(1);
    expect(await reminders(la)).toHaveLength(1);
  });
});
