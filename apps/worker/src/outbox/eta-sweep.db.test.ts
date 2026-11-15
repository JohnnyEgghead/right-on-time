// SPDX-License-Identifier: AGPL-3.0-or-later
// The ETA sweep and the late text (SPECIFICATIONS SD-15, section 6.4; FR-TEXT-5, UC-05, OA-53) on PostgreSQL 18 as bw_worker,
// with the shipped catalog: 1 late text per visit when the ETA is 20 or more minutes after the last arrival time texted, else
// after the planned arrival; the sweep every 5 demo minutes, 1 due event at a time. Run by gate G-CI9 (the outbox folder).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { createLogger } from '@bw/log';
import { useMigratedDatabase } from '../../../../packages/db/src/testing/fixture.ts';
import { catalogs } from '../../../../packages/i18n/src/catalog.ts';
import { renderTemplate, catalogTexts, type TextContext } from '../../../../packages/outbox/src/index.ts';
import { scheduleEvent } from '../../../../packages/outbox/src/events.ts';
import { addCustomer, addJob, I, loginPool, seedOutboxWorld, setDemoClock, type OutboxRef } from '../../../../packages/outbox/src/testing/world.ts';
import { startTestWorker, type TestWorker } from '../testing/worker.ts';
import { errorCodeOf, ETA_SWEEP, runEtaSweep } from './eta-sweep.ts';

const db = useMigratedDatabase();
const ctx: TextContext = { catalogs, linkHost: 'bw.j7l.io' };
let ref: OutboxRef;
let technicianId: string;
let pool: ReturnType<typeof loginPool>;

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin());
  technicianId = (await db.admin().query<{ id: string }>(`SELECT id FROM world.technician LIMIT 1`)).rows[0]!.id;
  pool = loginPool(db.url(), 'bw_worker');
});
afterAll(async () => {
  await pool?.end();
});

const sweep = (at: string) => inTransaction(pool, (tx) => runEtaSweep(tx, ctx, I(at)));
const lateTexts = (job: number) => db.admin().query<{ body: string }>(`SELECT body FROM world.outbox_text WHERE job_number = $1 AND kind = 'late'`, [job]).then((r) => r.rows);
const fields = (job: number) => db.admin().query<{ late_text_sent_at: Date | null; late_text_was_arrival: Date | null; texted_arrival: Date | null }>(
  'SELECT late_text_sent_at, late_text_was_arrival, texted_arrival FROM world.job WHERE job_number = $1', [job]).then((r) => r.rows[0]!);
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/** A job of a new customer with texts on, for the technician, 1 EDT wall window. */
async function visit(date: string, from: string, to: string, over: Record<string, unknown> = {}, customer: Parameters<typeof addCustomer>[2] = {}): Promise<number> {
  const c = await addCustomer(db.admin(), ref, customer);
  return addJob(db.admin(), ref, c, date, {
    technician_id: technicianId, window_start: `${date}T${from}:00-04:00`, window_end: `${date}T${to}:00-04:00`, ...over,
  });
}

describe('one job that cannot be texted does not stop the sweep (F-514)', () => {
  // why: F-514 (the F-469 class) a throw from one job's late text rolled back every late text of the sweep, retried each pass; now the
  // other job still gets its text, the failing one is counted as skipped, and nothing throws
  it('texts the second late job and counts the first as skipped when the first job\'s text throws', async () => {
    const date = '2026-09-21';
    const broken: TextContext = { ...ctx, catalogs: { ...catalogs, es: Object.fromEntries(Object.entries(catalogs.es).filter(([k]) => k !== 'text.late')) } as typeof catalogs };
    const first = await visit(date, '08:00', '10:00', { planned_arrival: `${date}T08:15:00-04:00` }, { language: 'es' });
    const second = await visit(date, '12:00', '14:00', { planned_arrival: `${date}T12:15:00-04:00` });
    // F-558: the skip is logged, 1 line per caught throw, with the job number and the error, no text or name
    const lines: string[] = [];
    const log = createLogger({ process: 'worker', write: (l) => lines.push(l) });
    const report = await inTransaction(pool, (tx) => runEtaSweep(tx, broken, I(`${date}T17:00:00Z`), log));
    expect(report).toMatchObject({ lateTexts: 1, skipped: 1 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', process: 'worker', status: 'unhandled error', jobNumber: first });
    // F-561: the code is a fixed word (this throw carries no code), never the error's message
    expect(JSON.parse(lines[0]!).errorCode).toBe('late_text_failed');
    expect(await lateTexts(first)).toHaveLength(0);
    expect(await lateTexts(second)).toHaveLength(1);
    expect((await fields(first)).late_text_sent_at).toBeNull();
    expect((await fields(second)).late_text_sent_at).not.toBeNull();
  });
});

describe('the code a skipped late text logs (F-561)', () => {
  // why: F-561 free text never reaches a log line: a SQLSTATE or Node code passes, anything else is the fixed word
  it('keeps a code of the right shape and replaces a message, a phone number or a missing code with late_text_failed', () => {
    expect(errorCodeOf(Object.assign(new Error('x'), { code: '23505' }))).toBe('23505');
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'call (614) 555-0148' }))).toBe('late_text_failed');
    expect(errorCodeOf(new Error('no template for customer 4'))).toBe('late_text_failed');
    expect(errorCodeOf('plain string')).toBe('late_text_failed');
    expect(errorCodeOf(null)).toBe('late_text_failed');
  });
});

describe('the late text (FR-TEXT-5, UC-05, OA-53)', () => {
  // why: FR-TEXT-5
  it('after an on-the-way text of about 10:40 AM, a new estimate of about 11:25 AM sends exactly 1 late text with 11:25 AM, and a second delay sends none', async () => {
    const n = await visit('2026-09-15', '10:00', '12:00', {
      status: 'on_the_way', on_the_way_at: '2026-09-15T10:30:00-04:00', texted_arrival: '2026-09-15T10:40:00-04:00', planned_arrival: '2026-09-15T10:20:00-04:00',
    });
    // 10:59 AM: the estimate (on the way + 2 minutes, passed) is 11:01, 21 minutes after the 10:40 AM texted; 11:22 AM gives 11:24, rounded to 11:25.
    await sweep('2026-09-15T15:22:00Z');
    const texts = await lateTexts(n);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain('11:25 AM');
    expect(texts[0]!.body).toBe(renderTemplate(catalogTexts(catalogs), 'late', 'en', { tech: 'Maria', arrival: '11:25 AM' }).body);
    const f = await fields(n);
    expect([iso(f.late_text_was_arrival), iso(f.late_text_sent_at), iso(f.texted_arrival)])
      .toEqual(['2026-09-15T14:40:00.000Z', '2026-09-15T15:22:00.000Z', '2026-09-15T15:25:00.000Z']);
    // A second delay on the same visit: none.
    await sweep('2026-09-15T16:10:00Z');
    expect(await lateTexts(n)).toHaveLength(1);
  });

  // why: UC-05
  it('a technician 20 minutes late gets the customer exactly 1 late text with the new arrival time, and 19 minutes late gets none', async () => {
    const mk = (date: string) => visit(date, '10:00', '12:00', {
      status: 'on_the_way', on_the_way_at: `${date}T10:30:00-04:00`, texted_arrival: `${date}T10:40:00-04:00`, planned_arrival: `${date}T10:20:00-04:00`,
    });
    const nineteen = await mk('2026-09-28');
    const twenty = await mk('2026-09-29');
    await sweep('2026-09-28T14:57:00Z'); // 10:57 AM: the estimate is 10:59, 19 minutes after the 10:40 AM texted
    expect(await lateTexts(nineteen)).toHaveLength(0);
    await sweep('2026-09-29T14:58:00Z'); // 10:58 AM: the estimate is 11:00, 20 minutes after
    const texts = await lateTexts(twenty);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain('11:00 AM');
    await sweep('2026-09-29T15:30:00Z'); // a later delay on the same visit: still 1
    expect(await lateTexts(twenty)).toHaveLength(1);
  });

  // why: FR-TEXT-5
  it("a job planned for 12:40 PM with no On my way sent gets exactly 1 late text when the new estimate is about 1:05 PM", async () => {
    const n = await visit('2026-09-16', '12:00', '14:00', { planned_arrival: '2026-09-16T12:40:00-04:00' });
    await sweep('2026-09-16T16:50:00Z'); // 12:50 PM: the estimate 12:52 is 12 minutes after the plan
    expect(await lateTexts(n)).toHaveLength(0);
    await sweep('2026-09-16T17:03:00Z'); // 1:03 PM: the estimate 1:05 PM is 25 minutes after the plan
    const texts = await lateTexts(n);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain('1:05 PM');
    const f = await fields(n);
    expect([iso(f.late_text_was_arrival), iso(f.texted_arrival)]).toEqual(['2026-09-16T16:40:00.000Z', '2026-09-16T17:05:00.000Z']);
  });

  // why: FR-TEXT-5
  it('measures a planted delay against the last arrival time texted, not the planned arrival: 15 minutes after it sends nothing, 21 sends exactly 1', async () => {
    const mk = (date: string) => visit(date, '08:00', '12:00', {
      status: 'on_the_way', on_the_way_at: `${date}T10:30:00-04:00`, texted_arrival: `${date}T10:40:00-04:00`, planned_arrival: `${date}T09:00:00-04:00`,
    });
    const fifteen = await mk('2026-09-17');
    const twentyOne = await mk('2026-09-19');
    // 10:53 AM: the estimate (on the way + 2 minutes, passed) is 10:55 AM, 15 minutes after the 10:40 AM texted (115 after the 9:00 AM plan).
    await sweep('2026-09-17T14:53:00Z');
    expect(await lateTexts(fifteen)).toHaveLength(0);
    // 10:59 AM: the estimate is 11:01 AM, 21 minutes after 10:40 AM.
    await sweep('2026-09-19T14:59:00Z');
    expect(await lateTexts(twentyOne)).toHaveLength(1);
    expect(await lateTexts(fifteen)).toHaveLength(0);
    // F-518: the sweep and sendLate each decide, so each half is pinned by what is stored: the baseline sendLate measured against is the
    // 10:40 AM texted time, not the 9:00 AM plan, and the 15-minute job is stamped with nothing.
    const f = await fields(twentyOne);
    expect([iso(f.late_text_was_arrival), iso(f.texted_arrival)]).toEqual(['2026-09-19T14:40:00.000Z', '2026-09-19T15:00:00.000Z']);
    expect((await fields(fifteen)).late_text_sent_at).toBeNull();
  });

  // why: FR-TEXT-5
  it('sends no late text to a customer with texts off, stamps nothing, and sends once texts are on again', async () => {
    const n = await visit('2026-09-24', '08:00', '12:00', { planned_arrival: '2026-09-24T08:30:00-04:00' }, { textsOn: false });
    await sweep('2026-09-24T14:00:00Z'); // 10:00 AM: 90 minutes after the plan
    expect(await lateTexts(n)).toHaveLength(0);
    expect((await fields(n)).late_text_sent_at).toBeNull();
    await db.admin().query(`UPDATE world.customer SET texts_on = true WHERE id = (SELECT customer_id FROM world.job WHERE job_number = $1)`, [n]);
    await sweep('2026-09-24T14:05:00Z');
    expect(await lateTexts(n)).toHaveLength(1);
  });

  // why: SD-15
  it('looks at today only: a delayed job of another day gets nothing', async () => {
    const n = await visit('2026-09-21', '08:00', '12:00', { planned_arrival: '2026-09-21T08:30:00-04:00' });
    await sweep('2026-09-22T14:00:00Z');
    expect(await lateTexts(n)).toHaveLength(0);
  });
});

describe('the sweep event (SD-15)', () => {
  // why: SD-15
  it('runs through the worker, writes its successor 5 demo minutes after the run, and keeps exactly 1 sweep due', async () => {
    const worker: TestWorker = await startTestWorker(db.url());
    try {
      await scheduleEvent(db.admin(), { kind: ETA_SWEEP, dueAt: I('2026-10-01T14:00:00Z'), subject: 'eta', payload: {} });
      await setDemoClock(db.admin(), '2026-10-01T14:00:00Z');
      await worker.drain();
      const due = async () => (await db.admin().query<{ due_at: Date }>(`SELECT due_at FROM world.scheduled_event WHERE kind = $1 AND state = 'due'`, [ETA_SWEEP])).rows;
      expect((await due()).map((r) => r.due_at.toISOString())).toEqual(['2026-10-01T14:05:00.000Z']);
      await worker.drain();
      expect(await due()).toHaveLength(1);
      await setDemoClock(db.admin(), '2026-10-01T14:05:00Z');
      await worker.drain();
      expect((await due()).map((r) => r.due_at.toISOString())).toEqual(['2026-10-01T14:10:00.000Z']);
    } finally {
      await worker.stop();
    }
  });
});
