// SPDX-License-Identifier: AGPL-3.0-or-later
// The text.try handler on PostgreSQL 18 through the worker as main.ts starts it (job registry, bw_worker, DbClock on
// the clock row): delivery writes the attempt and the `out` inbox row together; each simulator mode fails exactly the
// sends it names (FR-TEXT-16, SD-44); a canceled or stale try is skipped, never sent (FR-TEXT-19); a text with no visit
// that gives up still opens its alert.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { useMigratedDatabase } from '../../../../packages/db/src/testing/fixture.ts';
import { catalogs } from '../../../../packages/i18n/src/catalog.ts';
import { cancelOnTheWayText, enqueueText, fireReminder, scheduleTry } from '../../../../packages/outbox/src/index.ts';
import {
  addCustomer, addJob, attemptsOf, confirmationValues, count, I, loginPool, seedOutboxWorld, setDemoClock, setSimulator,
  testCatalog, textRow, type OutboxRef,
} from '../../../../packages/outbox/src/testing/world.ts';
import { textLogHandler } from '../../../../packages/api-server/src/handlers/messages.ts';
import type { ApiRequest, HandlerContext } from '../../../../packages/api-server/src/types.ts';
import { startTestWorker, type TestWorker } from '../testing/worker.ts';

const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;
let worker: TestWorker;

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

async function confirmation(customerId: string, now: string): Promise<string> {
  const jobNumber = await addJob(db.admin(), ref, customerId);
  const r = await inTransaction(web, (tx) =>
    enqueueText(tx, { kind: 'confirmation', customerId, jobNumber, now: I(now), catalog: testCatalog, values: confirmationValues }),
  );
  if (!r.ok) throw new Error(r.reason);
  return r.textId;
}

const status = async (id: string) => (await textRow(db.admin(), id)).status;

describe('a try through the simulator gateway', () => {
  // why: FR-TEXT-14
  it('delivers: attempt 1, status delivered, and the out inbox row with the body exactly as sent, at the try time', async () => {
    const c = await addCustomer(db.admin(), ref);
    const id = await confirmation(c, '2026-09-15T14:00:00Z');
    await at('2026-09-15T14:00:00Z');
    expect(await attemptsOf(db.admin(), id)).toEqual([[1, '2026-09-15T14:00:00Z', 'delivered']]);
    const row = await textRow(db.admin(), id);
    expect(row).toMatchObject({ status: 'delivered', tries: 1, delivered_at: new Date('2026-09-15T14:00:00Z'), next_try_at: null });
    const inbox = await db.admin().query(`SELECT customer_id, direction, body, at FROM world.inbox_message WHERE text_id = $1`, [id]);
    expect(inbox.rows).toEqual([{ customer_id: c, direction: 'out', body: row.body, at: new Date('2026-09-15T14:00:00Z') }]);
  });

  // why: FR-TEXT-16
  it('"Fail sends to this customer" fails that customer\'s sends only', async () => {
    const target = await addCustomer(db.admin(), ref);
    const other = await addCustomer(db.admin(), ref);
    await setSimulator(db.admin(), 'fail_customer', { customerId: target });
    const a = await confirmation(target, '2026-09-15T15:00:00Z');
    const b = await confirmation(other, '2026-09-15T15:00:00Z');
    await at('2026-09-15T15:00:00Z');
    expect(await status(a)).toBe('retrying');
    expect(await status(b)).toBe('delivered');
    const reason = await db.admin().query(`SELECT reason FROM world.text_attempt WHERE text_id = $1`, [a]);
    expect(reason.rows).toEqual([{ reason: 'simulator_fail_customer' }]);
    await setSimulator(db.admin(), 'up');
    await at('2026-09-15T15:02:00Z');
    expect(await attemptsOf(db.admin(), a)).toEqual([[1, '2026-09-15T15:00:00Z', 'failed'], [2, '2026-09-15T15:02:00Z', 'delivered']]);
  });

  // why: FR-TEXT-16
  it('"Fail the next N sends" fails exactly N sends, counted down in the send transaction, then is up again', async () => {
    await setSimulator(db.admin(), 'fail_next_n', { n: 2 });
    const c = await addCustomer(db.admin(), ref);
    const ids = [await confirmation(c, '2026-09-15T16:00:00Z'), await confirmation(c, '2026-09-15T16:00:00Z'), await confirmation(c, '2026-09-15T16:00:00Z')];
    await at('2026-09-15T16:00:00Z');
    const statuses: unknown[] = [];
    for (const id of ids) statuses.push(await status(id));
    expect(statuses).toEqual(['retrying', 'retrying', 'delivered']);
    const sim = await db.admin().query(`SELECT mode, n_left FROM world.text_simulator`);
    expect(sim.rows).toEqual([{ mode: 'up', n_left: null }]);
  });

  // why: FR-TEXT-19
  it('skips the try of an on-the-way text canceled by the arrival, so it is never sent', async () => {
    await setSimulator(db.admin(), 'up');
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c);
    const r = await inTransaction(web, (tx) =>
      enqueueText(tx, { kind: 'on_the_way', customerId: c, jobNumber: job, now: I('2026-09-15T17:00:00Z'), catalog: testCatalog, values: { tech: 'Maria', arrival: '1:20 PM', mapLink: 'bw.j7l.io/m/AbC12345' } }),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(await inTransaction(web, (tx) => cancelOnTheWayText(tx, job))).toEqual([r.textId]);
    await at('2026-09-15T17:00:00Z');
    expect(await textRow(db.admin(), r.textId)).toMatchObject({ status: 'canceled', reason_key: 'text_reason.arrived_first', tries: 0 });
    expect(await attemptsOf(db.admin(), r.textId)).toEqual([]);
    const ev = await db.admin().query(`SELECT state, result FROM world.scheduled_event WHERE subject = $1`, [r.textId]);
    expect(ev.rows).toEqual([{ state: 'skipped', result: 'not_sendable' }]);
  });

  // why: FR-TEXT-12
  it('skips a stale try event whose number is not the next try, so a replayed event never repeats or adds a try', async () => {
    const c = await addCustomer(db.admin(), ref);
    const id = await confirmation(c, '2026-09-15T18:00:00Z');
    await at('2026-09-15T18:00:00Z');
    await inTransaction(web, (tx) => scheduleTry(tx, I('2026-09-15T18:05:00Z'), { textId: id, number: 1 }));
    await at('2026-09-15T18:05:00Z');
    expect((await attemptsOf(db.admin(), id)).length).toBe(1);
    const ev = await db.admin().query(`SELECT result FROM world.scheduled_event WHERE subject = $1 ORDER BY due_at`, [id]);
    expect(ev.rows.map((x) => x.result)).toEqual(['delivered', 'not_sendable']);
  });

  // why: UC-06
  it('opens the alert for an office text about no visit that gives up (the call list needs a visit)', async () => {
    await setSimulator(db.admin(), 'all_fail');
    const c = await addCustomer(db.admin(), ref);
    const r = await inTransaction(web, (tx) => enqueueText(tx, { kind: 'office', customerId: c, jobNumber: null, now: I('2026-09-15T19:00:00Z'), body: 'Your part arrived.', sentBy: ref.userId }));
    if (!r.ok) throw new Error(r.reason);
    for (const m of [0, 2, 4, 9, 19]) await at(I('2026-09-15T19:00:00Z').add({ minutes: m }).toString());
    expect(await status(r.textId)).toBe('gave_up');
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.alert WHERE subject = $1 AND state = 'open'`, [r.textId])).toBe(1);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.call_list_entry WHERE text_id = $1`, [r.textId])).toBe(0);
    // F-1277: the alert opens the text log, not the call list the text is not on.
    expect((await db.admin().query<{ link: string }>(`SELECT link_target AS link FROM world.alert WHERE subject = $1`, [r.textId])).rows[0]!.link).toMatch(/^\/office\/messages\?date=/);
    await setSimulator(db.admin(), 'up');
  });

  // why: F-447, FR-HLTH-4
  it('emails each active manager once when a text gives up and the type\'s managers\' email switch is on', async () => {
    await db.admin().query(
      `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
       VALUES ('gaveup-manager@example.test', 'Gave Up Manager', 'gave up manager', 'manager', 'columbus', 'en', 'active', true, false)`);
    await db.admin().query(
      `INSERT INTO world.alert_setting (type, bell, managers_email) VALUES ('text_gave_up', true, true)
       ON CONFLICT (type) DO UPDATE SET managers_email = true`);
    await setSimulator(db.admin(), 'all_fail');
    const c = await addCustomer(db.admin(), ref);
    const r = await inTransaction(web, (tx) => enqueueText(tx, { kind: 'office', customerId: c, jobNumber: null, now: I('2026-09-15T21:00:00Z'), body: 'Your part arrived.', sentBy: ref.userId }));
    if (!r.ok) throw new Error(r.reason);
    for (const m of [0, 2, 4, 9, 19]) await at(I('2026-09-15T21:00:00Z').add({ minutes: m }).toString());
    expect(await status(r.textId)).toBe('gave_up');
    const mail = await db.admin().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM world.alert a JOIN world.alert_email_link l ON l.alert_id = a.id
        JOIN world."user" u ON u.id = l.manager_id WHERE a.subject = $1 AND u.email = 'gaveup-manager@example.test'`, [r.textId]);
    expect(mail.rows[0]!.n).toBe(1);
    await setSimulator(db.admin(), 'up');
  });
});

describe('the reminder\'s day word at the moment of its send (F-650, owner ruling 86ecd5ae)', () => {
  // why: FR-TEXT-2 F-650: the words are true when the text goes out
  it('a reminder made at 8:55 PM says tomorrow; its try held by quiet hours to 8:00 AM on the visit day is sent saying today, and the log shows what was sent', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const made = I('2026-09-16T00:55:00Z'); // 8:55 PM EDT, Sep 15
    const ctx = { catalogs: { en: { ...catalogs.en, 't.k': 'furnace tune-up' }, es: { ...catalogs.es, 't.k': 'ajuste de calefactor' } }, linkHost: 'bw.j7l.io' };
    const fired = await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: made, now: made, atOnce: { visitDate: '2026-09-16' } }));
    if (fired.result !== 'sent') throw new Error(`fired ${JSON.stringify(fired)}`);
    expect((await textRow(db.admin(), fired.textId)).body).toBe('Brightwater reminder: your technician arrives tomorrow, 8-10 AM EDT. Reply C to confirm or R to reschedule.');
    // Tries 1 to 3 fail before 9:00 PM; try 4 (9:04 PM) falls in quiet hours and moves to 8:00 AM on the visit day.
    await setSimulator(db.admin(), 'fail_customer', { customerId: c });
    for (const t of ['2026-09-16T00:55:00Z', '2026-09-16T00:57:00Z', '2026-09-16T00:59:00Z']) await at(t); // each try at its own time (a try runs at max(due, now))
    expect((await attemptsOf(db.admin(), fired.textId)).map(([n, , r]) => [n, r])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'failed']]);
    expect(await textRow(db.admin(), fired.textId)).toMatchObject({ status: 'retrying', next_try_at: new Date('2026-09-16T12:00:00Z') });
    await setSimulator(db.admin(), 'up');
    await at('2026-09-16T12:00:00Z');
    const today = 'Brightwater reminder: your technician arrives today, 8-10 AM EDT. Reply C to confirm or R to reschedule.';
    expect(await textRow(db.admin(), fired.textId)).toMatchObject({ status: 'delivered', tries: 4, body: today });
    const inbox = await db.admin().query(`SELECT body FROM world.inbox_message WHERE text_id = $1`, [fired.textId]);
    expect(inbox.rows).toEqual([{ body: today }]);
  });

  // why: F-685, FR-TEXT-2: a held or retried reminder is not sent once its visit is canceled or moved off the day after (or the day of) the send
  it.each([
    ['canceled', `status = 'canceled'`],
    ['moved to Sep 20', `date = DATE '2026-09-20'`],
  ])('a held reminder whose visit was %s at 9:45 PM is canceled at 8:00 AM, with the visit-changed reason, and nothing is sent', async (_name, change) => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const made = I('2026-09-16T00:55:00Z'); // 8:55 PM EDT, Sep 15
    const ctx = { catalogs, linkHost: 'bw.j7l.io' };
    // F-784: the worker's own pass runs each second, at the clock row. The row still reads the case before's 8:00 AM, past this text's first
    // try, so the sends fail and the clock is back BEFORE the text exists: a pass in between would make try 1 at 8:00 AM, due again at 8:02 AM.
    await setSimulator(db.admin(), 'fail_customer', { customerId: c });
    await setDemoClock(db.admin(), made.toString());
    const fired = await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: made, now: made, atOnce: { visitDate: '2026-09-16' } }));
    if (fired.result !== 'sent') throw new Error(`fired ${JSON.stringify(fired)}`);
    for (const t of ['2026-09-16T00:55:00Z', '2026-09-16T00:57:00Z', '2026-09-16T00:59:00Z']) await at(t);
    expect(await textRow(db.admin(), fired.textId)).toMatchObject({ status: 'retrying', next_try_at: new Date('2026-09-16T12:00:00Z') });
    await db.admin().query(`UPDATE world.job SET ${change} WHERE job_number = $1`, [job]);
    await setSimulator(db.admin(), 'up');
    await at('2026-09-16T12:00:00Z');
    expect(await textRow(db.admin(), fired.textId)).toMatchObject({ status: 'canceled', reason_key: 'text_reason.visit_changed', next_try_at: null });
    expect((await attemptsOf(db.admin(), fired.textId)).length).toBe(3);
    expect((await db.admin().query(`SELECT 1 FROM world.inbox_message WHERE text_id = $1`, [fired.textId])).rows).toEqual([]);
  });
});

/** API-40 the text log as the kernel runs it for Dana Ruiz (the reference fixture's manager), as bw_web: the ids of the day's texts. */
async function textLogIds(branch: string, date: string): Promise<string[]> {
  const now = I('2026-09-17T12:30:00Z');
  const req = {
    contract: 'API-40', params: { branch, date }, body: null, worldEpoch: 1, demoNow: now,
    caller: { kind: 'staff', userId: ref.userId, role: 'manager', client: 'web', via: 'password' },
  } as unknown as ApiRequest;
  const hctx = { settings: {}, clock: { realNow: () => now }, accessKey: null, secure: false, presented: null, events: null } as unknown as HandlerContext;
  const r = await inTransaction(web, (tx) => textLogHandler(req, tx, hctx));
  if (!r.ok) throw new Error(`text log answered ${r.status} ${r.code}`);
  return r.data.texts.map((x) => x.id);
}

describe('the no-visit gave-up alert opens the day the text log lists the text on (F-1298)', () => {
  // why: F-1298, F-1277: the link's day is the day the text was written, the day the text log keys on, not the day it gave up
  it('an office text written at 8:50 PM gives up at 8:00 AM the next day (try 5 held by quiet hours); Open the text opens the day that lists it', async () => {
    await setSimulator(db.admin(), 'all_fail');
    const c = await addCustomer(db.admin(), ref, { zone: 'America/New_York' });
    const written = I('2026-09-17T00:50:00Z'); // 8:50 PM EDT, Sep 16
    const r = await inTransaction(web, (tx) => enqueueText(tx, { kind: 'office', customerId: c, jobNumber: null, now: written, body: 'Your part arrived.', sentBy: ref.userId }));
    if (!r.ok) throw new Error(r.reason);
    for (const m of [0, 2, 4, 9]) await at(written.add({ minutes: m }).toString());
    // Try 5 is due at 9:09 PM, in quiet hours, so it moves to 8:00 AM EDT on Sep 17 (FR-TEXT-7).
    expect(await textRow(db.admin(), r.textId)).toMatchObject({ status: 'retrying', tries: 4, next_try_at: new Date('2026-09-17T12:00:00Z') });
    await at('2026-09-17T12:00:00Z');
    expect(await status(r.textId)).toBe('gave_up');
    const link = (await db.admin().query<{ link: string }>(`SELECT link_target AS link FROM world.alert WHERE type = 'text_gave_up' AND subject = $1`, [r.textId])).rows[0]!.link;
    expect(link).toBe('/office/messages?date=2026-09-16');
    const day = new URLSearchParams(link.split('?')[1]).get('date')!;
    // The real reader: the text log for the link's day lists the text; the day it gave up does not.
    expect(await textLogIds(ref.branchId, day)).toContain(r.textId);
    expect(await textLogIds(ref.branchId, '2026-09-17')).not.toContain(r.textId);
    await setSimulator(db.admin(), 'up');
  });
});
