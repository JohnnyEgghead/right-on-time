// SPDX-License-Identifier: AGPL-3.0-or-later
// The triggers of the customer texts on PostgreSQL 18 as the web login bw_web (SPECIFICATIONS section 6.4, SD-45;
// REQUIREMENTS FR-TEXT-1, -2, -3, -6, -13, -17, -18; OI-4, OI-31), with the REAL catalog templates and slot formatter.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { useMigratedDatabase } from '../../db/src/testing/fixture.ts';
import { catalogs as realCatalogs } from '../../i18n/src/catalog.ts';
import { enqueueText } from './enqueue.ts';
import { customerZoneFor, fireReminder, planReminder, replanCustomerReminders, reminderDueAt, sendConfirmation, sendOnTheWay, TEXT_REMINDER, type ReminderPlan, type TextContext } from './triggers.ts';
import { textCatalogOf } from './slots.ts';
import { parseReminderCallId, reminderCallId } from './call-list.ts';
import { addCustomer, addJob, count, I, loginPool, seedOutboxWorld, textRow, type OutboxRef } from './testing/world.ts';

const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;
let techId: string;

// The fixture service's text label key is t.k; it joins the real catalogs here.
const catalogs = { en: { ...realCatalogs.en, 't.k': 'furnace tune-up' }, es: { ...realCatalogs.es, 't.k': 'ajuste de calefactor' } };
const ctx: TextContext = { catalogs, linkHost: 'bw.j7l.io' };

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin());
  techId = (await db.admin().query<{ id: string }>(`SELECT id FROM world.technician LIMIT 1`)).rows[0]!.id;
  web = loginPool(db.url(), 'bw_web');
});
afterAll(async () => {
  await web?.end();
});

const events = (kind: string, subject: string) =>
  db.admin().query<{ due_at: Date; state: string }>(`SELECT due_at, state FROM world.scheduled_event WHERE kind = $1 AND subject = $2 ORDER BY due_at`, [kind, subject]).then((r) => r.rows);

describe('the confirmation (FR-TEXT-1, SD-45, OI-4)', () => {
  // why: FR-TEXT-1
  it('is written at the moment of booking with the visit\'s own words, due at once, and its try 1 event is that minute', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const now = I('2026-09-15T14:00:00Z'); // 10:00 AM EDT
    const r = await inTransaction(web, (tx) => sendConfirmation(tx, ctx, { jobNumber: job, now }));
    expect(r).toMatchObject({ ok: true, status: 'queued', heldUntil: null });
    if (!r.ok) return;
    const row = await textRow(db.admin(), r.textId);
    expect(row).toMatchObject({ kind: 'confirmation', language: 'en', status: 'queued', due_at: new Date('2026-09-15T14:00:00Z'), next_try_at: new Date('2026-09-15T14:00:00Z') });
    expect(row.body).toBe("Brightwater: You're booked! Wed, Sep 16, technician arrives 8-10 AM EDT. Service: furnace tune-up. Reply C to confirm or R to reschedule.");
  });

  // why: FR-TEXT-1
  it('booked at 12:30 AM EDT is held to 8:00 AM EDT (quiet hours), the try 1 event at 8:00 AM', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const r = await inTransaction(web, (tx) => sendConfirmation(tx, ctx, { jobNumber: job, now: I('2026-09-15T04:30:00Z') }));
    expect(r).toMatchObject({ ok: true, status: 'held', heldUntil: I('2026-09-15T12:00:00Z') });
  });

  // why: FR-TEXT-6, F-419
  it('is sent in the customer\'s language: a Spanish customer gets the Spanish confirmation, in GSM-7 basic', async () => {
    const c = await addCustomer(db.admin(), ref, { language: 'es', name: 'Rosa Delgado' });
    const job = await addJob(db.admin(), ref, c, '2026-09-19'); // a Saturday
    const r = await inTransaction(web, (tx) => sendConfirmation(tx, ctx, { jobNumber: job, now: I('2026-09-15T14:00:00Z') }));
    if (!r.ok) throw new Error(r.reason);
    const row = await textRow(db.admin(), r.textId);
    expect(row).toMatchObject({ language: 'es', encoding: 'gsm7' });
    expect(row.body).toBe('Brightwater: ¡Cita reservada! 19 de sep, el técnico llega de 8 a 10 AM EDT. Servicio: ajuste de calefactor. Responda C para confirmar o R para cambiar.');
  });

  // why: FR-TEXT-13
  it('writes nothing for a customer with texts off (OI-31) or no mobile, whichever the template', async () => {
    const off = await addCustomer(db.admin(), ref, { textsOn: false });
    const jobOff = await addJob(db.admin(), ref, off, '2026-09-16', { technician_id: techId });
    const none = await addCustomer(db.admin(), ref, { mobile: null });
    const jobNone = await addJob(db.admin(), ref, none, '2026-09-16', { technician_id: techId });
    const now = I('2026-09-15T14:00:00Z');
    const results = await inTransaction(web, async (tx) => [
      await sendConfirmation(tx, ctx, { jobNumber: jobOff, now }),
      await sendConfirmation(tx, ctx, { jobNumber: jobNone, now }),
      await sendOnTheWay(tx, ctx, { jobNumber: jobOff, eta: I('2026-09-16T14:40:00Z'), now }),
      await sendOnTheWay(tx, ctx, { jobNumber: jobNone, eta: I('2026-09-16T14:40:00Z'), now }),
      await enqueueText(tx, { kind: 'late', customerId: off, jobNumber: jobOff, now, catalog: textCatalogOf(catalogs), values: { tech: 'Maria', arrival: '11:25 AM' } }),
      await enqueueText(tx, { kind: 'office', customerId: off, jobNumber: null, now, body: 'Hello', sentBy: ref.userId }),
    ]);
    expect(results.map((r) => ('ok' in r ? (r.ok ? 'ok' : r.reason) : r.sent ? 'sent' : r.reason))).toEqual(['texts_off', 'no_mobile', 'texts_off', 'no_mobile', 'texts_off', 'texts_off']);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.outbox_text WHERE customer_id IN ($1, $2)`, [off, none])).toBe(0);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.link_token WHERE job_number IN ($1, $2)`, [jobOff, jobNone])).toBe(0);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.job WHERE job_number IN ($1, $2) AND texted_arrival IS NOT NULL`, [jobOff, jobNone])).toBe(0);
  });
});

describe('the on-the-way text (FR-TEXT-3, FR-TEXT-11, FR-TEXT-18)', () => {
  // why: FR-TEXT-3; F-490
  it('names the arrival time rounded to 5 minutes and a live map link on the text link host, and sets texted_arrival', async () => {
    const c = await addCustomer(db.admin(), ref, { name: 'Harold Jenkins' });
    const job = await addJob(db.admin(), ref, c, '2026-09-15', { technician_id: techId });
    const r = await inTransaction(web, (tx) => sendOnTheWay(tx, ctx, { jobNumber: job, eta: I('2026-09-15T14:42:10Z'), now: I('2026-09-15T14:28:00Z') }));
    if (!r.sent) throw new Error(r.reason);
    const row = await textRow(db.admin(), r.textId);
    expect(row.body).toBe(`Brightwater: Maria is on the way! Arriving about 10:40 AM. Follow the van: bw.j7l.io/m/${r.token} (this link stops working when Maria arrives).`);
    expect(row).toMatchObject({ kind: 'on_the_way', link_token: r.token });
    expect(r.token).toMatch(/^[0-9A-Za-z]{8}$/);
    const tok = await db.admin().query(`SELECT kind, job_number, ended_at FROM world.link_token WHERE token = $1`, [r.token]);
    expect(tok.rows).toEqual([{ kind: 'live_map', job_number: job, ended_at: null }]);
    const j = await db.admin().query(`SELECT texted_arrival FROM world.job WHERE job_number = $1`, [job]);
    expect(j.rows).toEqual([{ texted_arrival: new Date('2026-09-15T14:40:00Z') }]);
  });

  // why: FR-TEXT-18
  it('writes only the text link host in the rendered link, whatever host the setting names', async () => {
    const c = await addCustomer(db.admin(), ref, { language: 'es' });
    const job = await addJob(db.admin(), ref, c, '2026-09-15', { technician_id: techId });
    const r = await inTransaction(web, (tx) => sendOnTheWay(tx, { ...ctx, linkHost: 'bw.j7l.io' }, { jobNumber: job, eta: I('2026-09-15T16:48:00Z'), now: I('2026-09-15T16:30:00Z') }));
    if (!r.sent) throw new Error(r.reason);
    const body = (await textRow(db.admin(), r.textId)).body as string;
    expect(body).toContain('12:50 PM');
    expect(body.match(/[a-z0-9.-]+\.[a-z]{2,}\//g)).toEqual(['bw.j7l.io/']);
    expect(body).toBe(`Brightwater: ¡Maria va en camino! Llega a eso de las 12:50 PM. Siga la camioneta: bw.j7l.io/m/${r.token} (este enlace caduca cuando Maria llegue).`);
  });
});

describe('the reminder planner (FR-TEXT-2, FR-TEXT-13, FR-TEXT-17)', () => {
  // why: FR-TEXT-17
  it('a booking at 10:29 AM Eastern by a Pacific customer schedules its reminder for 6:00 PM Pacific (the evening before)', async () => {
    const c = await addCustomer(db.admin(), ref, { zone: 'America/Los_Angeles', name: 'Deborah Lin' });
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const plan = await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now: I('2026-09-15T14:29:00Z') }));
    expect(plan).toEqual({ planned: true, dueAt: I('2026-09-16T01:00:00Z'), moved: false, atOnce: false }); // 6:00 PM PDT Sep 15 = 9:00 PM EDT
    expect(await events(TEXT_REMINDER, String(job))).toEqual([{ due_at: new Date('2026-09-16T01:00:00Z'), state: 'due' }]);
  });

  // why: FR-TEXT-2
  it('is 6:00 PM in the customer zone for Eastern too, exact across a daylight-saving change', () => {
    expect(reminderDueAt('2026-09-16', 'America/New_York')).toEqual(I('2026-09-15T22:00:00Z'));
    expect(reminderDueAt('2026-11-02', 'America/New_York')).toEqual(I('2026-11-01T23:00:00Z')); // the evening of Nov 1: EST again
    expect(reminderDueAt('2026-10-31', 'America/New_York')).toEqual(I('2026-10-30T22:00:00Z')); // still EDT
  });

  // why: FR-TEXT-17
  it('an office edit of the customer\'s zone moves the next reminder; a reschedule moves it too; a cancel drops it', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-17');
    const now = I('2026-09-15T14:00:00Z');
    await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now }));
    expect(await events(TEXT_REMINDER, String(job))).toEqual([{ due_at: new Date('2026-09-16T22:00:00Z'), state: 'due' }]);
    await db.admin().query(`UPDATE world.customer SET zone = 'America/Los_Angeles' WHERE id = $1`, [c]);
    expect(await inTransaction(web, (tx) => replanCustomerReminders(tx, { customerId: c, now }))).toBe(1);
    expect(await events(TEXT_REMINDER, String(job))).toEqual([{ due_at: new Date('2026-09-17T01:00:00Z'), state: 'due' }]);
    await db.admin().query(`UPDATE world.job SET date = '2026-09-18' WHERE job_number = $1`, [job]);
    const moved = await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now }));
    expect(moved).toMatchObject({ planned: true, moved: true });
    expect(await events(TEXT_REMINDER, String(job))).toEqual([{ due_at: new Date('2026-09-18T01:00:00Z'), state: 'due' }]);
    await db.admin().query(`UPDATE world.job SET status = 'canceled' WHERE job_number = $1`, [job]);
    expect(await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now }))).toEqual({ planned: false, why: 'not_scheduled' });
    expect(await events(TEXT_REMINDER, String(job))).toEqual([{ due_at: new Date('2026-09-18T01:00:00Z'), state: 'skipped' }]);
  });

  // why: FR-TEXT-13, F-446
  it('a visit booked at 7:15 PM for the next morning gets its reminder at once (owner ruling 86ecd5ae), planned for now and marked at once', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const now = I('2026-09-15T23:15:00Z'); // 7:15 PM EDT
    const plan = await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now }));
    expect(plan).toEqual({ planned: true, dueAt: now, moved: false, atOnce: true });
    expect(await events(TEXT_REMINDER, String(job))).toEqual([{ due_at: new Date('2026-09-15T23:15:00Z'), state: 'due' }]);
    const payload = await db.admin().query(`SELECT payload FROM world.scheduled_event WHERE kind = $1 AND subject = $2`, [TEXT_REMINDER, String(job)]);
    expect(payload.rows[0]?.payload).toEqual({ jobNumber: job, atOnce: true, visitDate: '2026-09-16' });
    // The at-once event fires: the reminder text is made, not skipped as moved.
    const fired = await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: now, now, atOnce: { visitDate: '2026-09-16' } }));
    expect(fired).toMatchObject({ result: 'sent' });
    // The same event for a visit that moved to another day since is stale.
    await db.admin().query(`UPDATE world.job SET date = '2026-09-18' WHERE job_number = $1`, [job]);
    expect(await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: now, now, atOnce: { visitDate: '2026-09-16' } }))).toEqual({ result: 'skipped', why: 'moved' });
  });

  // why: FR-TEXT-2 owner ruling 86ecd5ae F-650: a reminder held by quiet hours into the visit day says today
  it('a visit booked at 9:30 PM in the customer zone for the next morning gets its reminder at 8:00 AM that morning, and it says today, in English and Spanish', async () => {
    const now = I('2026-09-16T01:30:00Z'); // 9:30 PM EDT, Sep 15: quiet hours
    const bodies: string[] = [];
    for (const language of ['en', 'es'] as const) {
      const c = await addCustomer(db.admin(), ref, { language });
      const job = await addJob(db.admin(), ref, c, '2026-09-16');
      expect(await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now }))).toEqual({ planned: true, dueAt: now, moved: false, atOnce: true });
      const fired = await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: now, now, atOnce: { visitDate: '2026-09-16' } }));
      if (fired.result !== 'sent') throw new Error(`fired ${JSON.stringify(fired)}`);
      const row = await textRow(db.admin(), fired.textId);
      expect(row).toMatchObject({ status: 'held', held_until: new Date('2026-09-16T12:00:00Z') }); // the first moment quiet hours allow
      bodies.push(row.body as string);
    }
    expect(bodies).toEqual([
      'Brightwater reminder: your technician arrives today, 8-10 AM EDT. Reply C to confirm or R to reschedule.',
      'Recordatorio de Brightwater: su técnico llega hoy, de 8 a 10 AM EDT. Responda C para confirmar o R para cambiar.',
    ]);
    // Booked at 8:30 PM instead, the reminder goes out at once that evening and still says tomorrow.
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const evening = I('2026-09-16T00:30:00Z'); // 8:30 PM EDT
    await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now: evening }));
    const fired = await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: evening, now: evening, atOnce: { visitDate: '2026-09-16' } }));
    if (fired.result !== 'sent') throw new Error(`fired ${JSON.stringify(fired)}`);
    expect(await textRow(db.admin(), fired.textId)).toMatchObject({ status: 'queued', body: expect.stringContaining('arrives tomorrow, 8-10 AM EDT') });
  });

  // why: FR-TEXT-13 F-653: 1 call list row per visit and call date
  it('a reschedule the same evening after the reminder fired, keeping the visit on the next day, fires again and leaves 1 call list row with its outcome', async () => {
    const off = await addCustomer(db.admin(), ref, { textsOn: false });
    const job = await addJob(db.admin(), ref, off, '2026-09-16');
    const first = I('2026-09-15T23:15:00Z'); // 7:15 PM EDT
    await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now: first }));
    expect(await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: first, now: first, atOnce: { visitDate: '2026-09-16' } })))
      .toEqual({ result: 'call_list', reason: 'texts_off' });
    // The dispatcher closes the event it ran (this test calls the handler's service directly).
    await db.admin().query(`UPDATE world.scheduled_event SET state = 'done', run_at = $2 WHERE kind = $1 AND subject = $3 AND state = 'due'`, [TEXT_REMINDER, first.toString(), String(job)]);
    await db.admin().query(`UPDATE world.call_list_entry SET outcome = 'no_answer', outcome_at = '2026-09-15T23:20:00Z' WHERE job_number = $1`, [job]);
    // The office moves the visit to a later window on the same day: the event already fired, so the planner plans a new one.
    await db.admin().query(`UPDATE world.job SET window_start = '2026-09-16T12:00:00-04:00', window_end = '2026-09-16T14:00:00-04:00' WHERE job_number = $1`, [job]);
    const again = I('2026-09-15T23:40:00Z');
    expect(await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now: again }))).toMatchObject({ planned: true, moved: false, atOnce: true });
    expect(await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: again, now: again, atOnce: { visitDate: '2026-09-16' } })))
      .toEqual({ result: 'call_list', reason: 'texts_off' });
    const rows = await db.admin().query(`SELECT id, call_date::text AS call_date, outcome FROM world.call_list_entry WHERE job_number = $1`, [job]);
    expect(rows.rows).toEqual([{ id: reminderCallId(job, '2026-09-15'), call_date: '2026-09-15', outcome: 'no_answer' }]);
    // The database holds the rule for any other writer too.
    await expect(db.admin().query(
      `INSERT INTO world.call_list_entry (branch_id, call_date, customer_id, job_number, reason, added_at) VALUES ($1, '2026-09-15', $2, $3, 'no_mobile', now())`,
      [ref.branchId, off, job])).rejects.toThrow(/call_list_entry_reminder_once/);
    expect(parseReminderCallId(reminderCallId(job, '2026-09-15'))).toEqual({ jobNumber: job, callDate: '2026-09-15' });
  });

  // why: F-826, FR-TEXT-2: the database holds 1 due reminder per job, and a run's record or another job's reminder is outside the rule
  it('the database refuses a second due reminder for a job, and allows one beside a reminder that has run', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-24');
    await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now: I('2026-09-15T14:00:00Z') }));
    const plant = () => db.admin().query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-23T22:30:00Z', $1, $2, '{}', 'due')`, [TEXT_REMINDER, String(job)]);
    await expect(plant()).rejects.toMatchObject({ code: '23505', constraint: 'scheduled_event_reminder_once' });
    await db.admin().query(`UPDATE world.scheduled_event SET state = 'done' WHERE kind = $1 AND subject = $2`, [TEXT_REMINDER, String(job)]);
    await plant();
    expect((await events(TEXT_REMINDER, String(job))).map((e) => e.state).sort()).toEqual(['done', 'due']);
  });

  // why: F-826, FR-TEXT-2: 2 writers at once, neither seeing the other's row: the second waits, then moves the first's event, and neither fails
  it('2 planners at once leave 1 due reminder: the second answers moved and its write stands', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-24');
    const first = await web.connect();
    let second: Promise<ReminderPlan> | undefined;
    try {
      await first.query('BEGIN');
      expect(await planReminder(first, { jobNumber: job, now: I('2026-09-15T14:00:00Z') })).toMatchObject({ planned: true, moved: false });
      // Later than the regular 6:00 PM: the second writer's event is at once, so its due time shows whose write stood.
      second = inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now: I('2026-09-23T23:15:00Z') }));
      await expect.poll(async () => Number((await db.admin().query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO world.scheduled_event%'`)).rows[0]!.n)).toBe(1);
      await first.query('COMMIT');
    } finally {
      first.release();
    }
    expect(await second).toMatchObject({ planned: true, moved: true, atOnce: true });
    expect(await events(TEXT_REMINDER, String(job))).toEqual([{ due_at: new Date('2026-09-23T23:15:00Z'), state: 'due' }]);
  });

  // why: F-826: the migration's own clean-up: a live double from before F-824's fix does not stop the index being made, and the planner's own row stays
  it('migration 0018 keeps the first of a live double and skips the rest', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = String(await addJob(db.admin(), ref, c, '2026-09-24'));
    await db.admin().query('DROP INDEX world.scheduled_event_reminder_once');
    for (const due of ['2026-09-23T23:00:00Z', '2026-09-23T22:00:00Z']) {
      await db.admin().query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ($1, $2, $3, '{}', 'due')`, [due, TEXT_REMINDER, job]);
    }
    await db.admin().query(readFileSync(new URL('../../db/migrations/0018_reminder_event_once.sql', import.meta.url), 'utf8'));
    expect(await events(TEXT_REMINDER, job)).toEqual([
      { due_at: new Date('2026-09-23T22:00:00Z'), state: 'due' },
      { due_at: new Date('2026-09-23T23:00:00Z'), state: 'skipped' },
    ]);
  });

  // why: FR-TEXT-2, FR-TEXT-17 F-824: exactly 1 reminder per visit; a zone edit moves a reminder still to go and never makes a second one
  it.each([
    ['still ahead', 'America/Los_Angeles', '2026-09-15T23:30:00Z'], // 7:30 PM EDT; 6:00 PM Pacific is 9:00 PM EDT
    ['already past', 'America/Chicago', '2026-09-16T00:30:00Z'], // 8:30 PM EDT; 6:00 PM Central was 7:00 PM EDT
  ])('a zone edit after the reminder went out plans no second one when the new 6:00 PM is %s, and moves the next visit\'s', async (_name, zone, at) => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const later = await addJob(db.admin(), ref, c, '2026-09-20');
    const planned = I('2026-09-15T14:00:00Z');
    await inTransaction(web, async (tx) => {
      await planReminder(tx, { jobNumber: job, now: planned });
      await planReminder(tx, { jobNumber: later, now: planned });
    });
    const fired = I('2026-09-15T22:00:00Z');
    expect(await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: fired, now: fired }))).toMatchObject({ result: 'sent' });
    // The dispatcher closes the event it ran (this test calls the handler's service directly).
    await db.admin().query(`UPDATE world.scheduled_event SET state = 'done', run_at = $2 WHERE kind = $1 AND subject = $3 AND state = 'due'`, [TEXT_REMINDER, fired.toString(), String(job)]);
    await db.admin().query(`UPDATE world.customer SET zone = $2 WHERE id = $1`, [c, zone]);
    expect(await inTransaction(web, (tx) => replanCustomerReminders(tx, { customerId: c, now: I(at) }))).toBe(1);
    expect(await events(TEXT_REMINDER, String(job))).toEqual([{ due_at: new Date('2026-09-15T22:00:00Z'), state: 'done' }]);
    expect(await events(TEXT_REMINDER, String(later))).toEqual([{ due_at: new Date(reminderDueAt('2026-09-20', zone).toString()), state: 'due' }]);
  });

  // why: FR-TEXT-13, F-446
  it('an at-once reminder for a customer with texts off or no mobile is a call list entry dated today, and no text', async () => {
    const off = await addCustomer(db.admin(), ref, { textsOn: false });
    const none = await addCustomer(db.admin(), ref, { mobile: null });
    const jobOff = await addJob(db.admin(), ref, off, '2026-09-16');
    const jobNone = await addJob(db.admin(), ref, none, '2026-09-16');
    const now = I('2026-09-15T23:15:00Z');
    for (const job of [jobOff, jobNone]) await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now }));
    const out = await inTransaction(web, async (tx) => [
      await fireReminder(tx, ctx, { jobNumber: jobOff, eventDueAt: now, now, atOnce: { visitDate: '2026-09-16' } }),
      await fireReminder(tx, ctx, { jobNumber: jobNone, eventDueAt: now, now, atOnce: { visitDate: '2026-09-16' } }),
    ]);
    expect(out).toEqual([{ result: 'call_list', reason: 'texts_off' }, { result: 'call_list', reason: 'no_mobile' }]);
    const rows = await db.admin().query(`SELECT call_date::text AS call_date, reason FROM world.call_list_entry WHERE job_number IN ($1, $2) ORDER BY job_number`, [jobOff, jobNone]);
    expect(rows.rows).toEqual([{ call_date: '2026-09-15', reason: 'texts_off' }, { call_date: '2026-09-15', reason: 'no_mobile' }]);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.outbox_text WHERE customer_id IN ($1, $2) AND kind = 'reminder'`, [off, none])).toBe(0);
  });

  // why: FR-TEXT-2
  it('plans no reminder once the visit\'s own day has begun in the customer zone (no evening before is left)', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c, '2026-09-16');
    const plan = await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now: I('2026-09-16T05:00:00Z') })); // 1:00 AM EDT, Sep 16
    expect(plan).toEqual({ planned: false, why: 'already_past' });
    expect(await events(TEXT_REMINDER, String(job))).toEqual([]);
  });

  // why: FR-TEXT-13
  it('at fire time a customer with no mobile, or texts off, gets a call list entry dated the day before and no text', async () => {
    const none = await addCustomer(db.admin(), ref, { mobile: null });
    const off = await addCustomer(db.admin(), ref, { textsOn: false });
    const jobNone = await addJob(db.admin(), ref, none, '2026-09-16');
    const jobOff = await addJob(db.admin(), ref, off, '2026-09-16');
    const due = reminderDueAt('2026-09-16', 'America/New_York');
    const out = await inTransaction(web, async (tx) => [
      await fireReminder(tx, ctx, { jobNumber: jobNone, eventDueAt: due, now: due }),
      await fireReminder(tx, ctx, { jobNumber: jobOff, eventDueAt: due, now: due }),
    ]);
    expect(out).toEqual([{ result: 'call_list', reason: 'no_mobile' }, { result: 'call_list', reason: 'texts_off' }]);
    const rows = await db.admin().query(`SELECT customer_id, call_date::text AS call_date, reason FROM world.call_list_entry WHERE job_number IN ($1, $2) ORDER BY job_number`, [jobNone, jobOff]);
    expect(rows.rows).toEqual([
      { customer_id: none, call_date: '2026-09-15', reason: 'no_mobile' },
      { customer_id: off, call_date: '2026-09-15', reason: 'texts_off' },
    ]);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.outbox_text WHERE customer_id IN ($1, $2)`, [none, off])).toBe(0);
  });

  // why: FR-TEXT-17
  it('takes the browser zone at online booking when it is an IANA zone, else the branch zone (imported and office customers)', () => {
    expect(customerZoneFor({ browserZone: 'America/Los_Angeles', branchZone: 'America/New_York' })).toBe('America/Los_Angeles');
    expect(customerZoneFor({ branchZone: 'America/New_York' })).toBe('America/New_York');
    expect(customerZoneFor({ browserZone: 'Not/AZone', branchZone: 'America/New_York' })).toBe('America/New_York');
    expect(customerZoneFor({ browserZone: '', branchZone: 'America/New_York' })).toBe('America/New_York');
  });
});
