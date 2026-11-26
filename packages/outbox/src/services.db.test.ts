// SPDX-License-Identifier: AGPL-3.0-or-later
// The outbox's in-transaction services on PostgreSQL 18 as the web process's login bw_web (role app): enqueueText
// (section 5.2 steps 1 and 2), reply intake with its target visit (SD-46, FR-TEXT-8, OI-16) and Try now's precondition.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { useMigratedDatabase } from '../../db/src/testing/fixture.ts';
import { enqueueText } from './enqueue.ts';
import { handleReply } from './reply.ts';
import { tryNow } from './try-now.ts';
import { addCustomer, addJob, confirmationValues, count, I, loginPool, seedOutboxWorld, testCatalog, testDayLabels, textRow, type OutboxRef } from './testing/world.ts';

const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin());
  web = loginPool(db.url(), 'bw_web');
});
afterAll(async () => {
  await web?.end();
});

const events = (textId: string) =>
  db.admin().query<{ due_at: Date; kind: string; payload: unknown; state: string }>(`SELECT due_at, kind, payload, state FROM world.scheduled_event WHERE subject = $1`, [textId]).then((r) => r.rows);

describe('enqueueText', () => {
  // why: FR-TEXT-1
  it('writes a queued confirmation due at once in the customer language, and the event of try 1 at that time', async () => {
    const c = await addCustomer(db.admin(), ref, { language: 'es' });
    const job = await addJob(db.admin(), ref, c);
    const r = await inTransaction(web, (tx) => enqueueText(tx, { kind: 'confirmation', customerId: c, jobNumber: job, now: I('2026-09-15T14:00:00Z'), catalog: testCatalog, values: confirmationValues }));
    expect(r).toMatchObject({ ok: true, status: 'queued', heldUntil: null });
    if (!r.ok) return;
    expect(await textRow(db.admin(), r.textId)).toMatchObject({
      kind: 'confirmation', language: 'es', encoding: 'gsm7', status: 'queued', tries: 0, held_until: null,
      body: 'Brightwater: Su visita de Tune-up esta reservada para Wed, Sep 16, 8-10 AM.', characters: 75,
      due_at: new Date('2026-09-15T14:00:00Z'), created_at: new Date('2026-09-15T14:00:00Z'), next_try_at: new Date('2026-09-15T14:00:00Z'),
    });
    expect(await events(r.textId)).toEqual([{ due_at: new Date('2026-09-15T14:00:00Z'), kind: 'text.try', payload: { textId: r.textId, number: 1 }, state: 'due' }]);
  });

  // why: FR-TEXT-7
  it('holds a text due at 10:30 PM in the customer zone, with its try 1 event at the next 8:00 AM there', async () => {
    const c = await addCustomer(db.admin(), ref, { zone: 'America/Phoenix' });
    const r = await inTransaction(web, (tx) => enqueueText(tx, { kind: 'office', customerId: c, jobNumber: null, now: I('2026-09-16T05:30:00Z'), body: 'Hello', sentBy: ref.userId }));
    expect(r).toMatchObject({ ok: true, status: 'held', heldUntil: I('2026-09-16T15:00:00Z') });
    if (!r.ok) return;
    expect(await textRow(db.admin(), r.textId)).toMatchObject({ status: 'held', reason_key: 'text_reason.quiet_hours', sent_by: ref.userId });
    expect((await events(r.textId)).map((e) => e.due_at)).toEqual([new Date('2026-09-16T15:00:00Z')]);
  });

  // why: FR-TEXT-13
  it('writes no text for a customer with texts off or no mobile', async () => {
    const off = await addCustomer(db.admin(), ref, { textsOn: false });
    const none = await addCustomer(db.admin(), ref, { mobile: null });
    const send = (customerId: string) => inTransaction(web, (tx) => enqueueText(tx, { kind: 'reminder', customerId, jobNumber: null, now: I('2026-09-15T22:00:00Z'), catalog: testCatalog, values: { window: '8-10 AM' } }));
    expect(await send(off)).toEqual({ ok: false, reason: 'texts_off' });
    expect(await send(none)).toEqual({ ok: false, reason: 'no_mobile' });
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.outbox_text WHERE customer_id IN ($1, $2)`, [off, none])).toBe(0);
  });

  // why: FR-TEXT-20
  it('refuses an office body over 1 message and stores a UCS-2 body with its encoding and count', async () => {
    const c = await addCustomer(db.admin(), ref);
    const now = I('2026-09-15T15:00:00Z');
    expect(await inTransaction(web, (tx) => enqueueText(tx, { kind: 'office', customerId: c, jobNumber: null, now, body: 'a'.repeat(161), sentBy: ref.userId }))).toEqual({ ok: false, reason: 'message_too_long' });
    const r = await inTransaction(web, (tx) => enqueueText(tx, { kind: 'office', customerId: c, jobNumber: null, now, body: 'Llegará pronto', sentBy: ref.userId }));
    if (!r.ok) throw new Error(r.reason);
    expect(await textRow(db.admin(), r.textId)).toMatchObject({ encoding: 'ucs2', characters: 14, body: 'Llegará pronto' });
  });
});

describe('reply intake (FR-TEXT-8, SD-46)', () => {
  const reply = (customerId: string, body: string, now: string) =>
    inTransaction(web, (tx) => handleReply(tx, { customerId, body, now: I(now), catalog: testCatalog, dayLabels: testDayLabels, linkHost: 'bw.j7l.io' }));

  // why: FR-TEXT-8
  it('C confirms the earliest live scheduled visit dated today or later, with a job_change by the customer', async () => {
    const c = await addCustomer(db.admin(), ref);
    await addJob(db.admin(), ref, c, '2026-09-14'); // yesterday: not a target
    const target = await addJob(db.admin(), ref, c, '2026-09-16');
    await addJob(db.admin(), ref, c, '2026-09-18');
    const r = await reply(c, '  C ', '2026-09-15T14:00:00Z');
    expect(r).toMatchObject({ handling: 'confirmed', jobNumber: target, textId: null });
    const job = await db.admin().query(`SELECT confirmed_at, version FROM world.job WHERE job_number = $1`, [target]);
    expect(job.rows).toEqual([{ confirmed_at: new Date('2026-09-15T14:00:00Z'), version: 1 }]);
    const change = await db.admin().query(`SELECT actor_kind, actor_user_id, kind, from_version, to_version FROM world.job_change WHERE job_number = $1`, [target]);
    expect(change.rows).toEqual([{ actor_kind: 'customer', actor_user_id: null, kind: 'confirmed', from_version: 1, to_version: 1 }]);
    const inbox = await db.admin().query(`SELECT direction, body, handling, job_number, text_id FROM world.inbox_message WHERE id = $1`, [r.replyId]);
    expect(inbox.rows).toEqual([{ direction: 'in', body: '  C ', handling: 'confirmed', job_number: target, text_id: null }]);
  });

  // why: FR-TEXT-8
  it('R sends the R-reply with a new reschedule token for the target visit and the branch office phone', async () => {
    const c = await addCustomer(db.admin(), ref);
    const target = await addJob(db.admin(), ref, c, '2026-09-16');
    const r = await reply(c, 'r', '2026-09-15T14:00:00Z');
    expect(r).toMatchObject({ handling: 'reschedule_sent', jobNumber: target });
    const text = await textRow(db.admin(), r.textId!);
    const token = String(text.link_token);
    expect(token).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(text).toMatchObject({ kind: 'r_reply', job_number: target, status: 'queued' });
    expect(text.body).toBe(`Brightwater: No problem. Pick a new time for your Wed, Sep 16 visit: bw.j7l.io/r/${token} or call (614) 555-0100.`);
    const t = await db.admin().query(`SELECT kind, job_number, created_at, expires_at, ended_at FROM world.link_token WHERE token = $1`, [token]);
    expect(t.rows).toEqual([{ kind: 'reschedule', job_number: target, created_at: new Date('2026-09-15T14:00:00Z'), expires_at: new Date('2026-09-22T14:00:00Z'), ended_at: null }]);
  });

  // why: FR-TEXT-8
  it('with no target visit, C is not understood and R still gets the R-reply for the most recent visit (OI-16)', async () => {
    const c = await addCustomer(db.admin(), ref);
    const old = await addJob(db.admin(), ref, c, '2026-09-10', { status: 'done' });
    expect(await reply(c, 'c', '2026-09-15T14:00:00Z')).toMatchObject({ handling: 'not_understood', jobNumber: null });
    const r = await reply(c, 'R', '2026-09-15T14:00:00Z');
    expect(r).toMatchObject({ handling: 'reschedule_sent', jobNumber: old });
    expect((await textRow(db.admin(), r.textId!)).body).toContain('Thu, Sep 10 visit');
  });

  // why: FR-TEXT-8
  it('stores any other reply as not understood, with no outgoing text', async () => {
    const c = await addCustomer(db.admin(), ref);
    await addJob(db.admin(), ref, c, '2026-09-16');
    const r = await reply(c, 'Can you come earlier?', '2026-09-15T14:00:00Z');
    expect(r).toMatchObject({ handling: 'not_understood', textId: null });
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.outbox_text WHERE customer_id = $1`, [c])).toBe(0);
  });
});

describe('Try now precondition (FR-TEXT-24)', () => {
  // why: FR-TEXT-24
  it('answers not_retryable for a text that has not failed', async () => {
    const c = await addCustomer(db.admin(), ref);
    const r = await inTransaction(web, (tx) => enqueueText(tx, { kind: 'office', customerId: c, jobNumber: null, now: I('2026-09-15T15:00:00Z'), body: 'Hi', sentBy: ref.userId }));
    if (!r.ok) throw new Error(r.reason);
    expect(await inTransaction(web, (tx) => tryNow(tx, { textId: r.textId, by: ref.userId, now: I('2026-09-15T15:00:00Z') }))).toEqual({ ok: false, reason: 'not_retryable' });
  });
});
