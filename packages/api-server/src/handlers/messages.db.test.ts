// SPDX-License-Identifier: AGPL-3.0-or-later
// The Messages reads and writes (API-38, API-40, API-41, API-42, API-144, API-145, API-146; FR-TEXT-12, FR-TEXT-13, FR-TEXT-15, FR-TEXT-24,
// FR-TEXT-25) on the real database (PostgreSQL 18, the migrated schema, P2-SEED's reference seed), through the production kernel as the
// web process's login bw_web, with a dispatcher whose session the real session layer created. The log's texts and attempts are planted by
// SQL (the outbox and the worker write them in production; their own tests prove that); the call list's reminder calls are never planted:
// visits are booked through the office's create-job call (API-28) and the rows come from the call outcome call (API-38) and the real
// reminder fire (F-651). Each handler is called over HTTP.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { fireReminder, reminderCallId } from '@bw/outbox';
import { Temporal } from '@bw/time';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { catalogs } from '../../../i18n/src/catalog.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let ana: Staff;
let customerIx = 0;

beforeAll(async () => {
  world = await officeWorld(db, 30);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
  ana = world.staff.ana;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const win = (key: string) => world.windows.get(key) as string;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The kernel's demo clock has a 250 ms cache: a test that moves the clock settles before it calls.
async function setNow(iso: string) {
  await db.admin().query(`UPDATE system.demo_clock SET demo_anchor = $1, paused = true WHERE id = 1`, [iso]);
  await wait(300);
}
async function json<T>(r: Response): Promise<{ status: number; data: T; code?: string }> {
  const body = (await r.json()) as { data: T; code?: string };
  return { status: r.status, data: body.data, ...(body.code ? { code: body.code } : {}) };
}

interface Cust { id: string; name: string }
/** A fresh customer with the given phone facts; the area is the street's city. */
async function customer(opts: { mobile?: string | null; textsOn?: boolean; language?: 'en' | 'es'; zone?: string } = {}): Promise<Cust> {
  const id = world.customers[customerIx++ % world.customers.length] as string;
  await db.admin().query(
    `UPDATE world.customer SET mobile = $2, home_phone = '(614) 555-0100', texts_on = $3, text_language = $4, zone = $5 WHERE id = $1`,
    [id, opts.mobile === undefined ? '(614) 555-0187' : opts.mobile, opts.textsOn ?? true, opts.language ?? 'en', opts.zone ?? 'America/New_York']);
  const n = await rows<{ name: string }>('SELECT name FROM world.customer WHERE id = $1', [id]);
  return { id, name: n[0]!.name };
}

async function book(customerId: string, date: string, window: string): Promise<number> {
  const r = await api.post('/jobs', { customerId, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: win(window), technicianId: null }, keisha);
  if (r.status !== 201) throw new Error(`create ${date} ${window} answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
}

interface PlantedText { customerId: string; jobNumber: number | null; kind?: string; status?: string; at: string; body?: string; tries?: number; reasonKey?: string | null; language?: string; heldUntil?: string | null; deliveredAt?: string | null; nextTry?: string | null }
async function plantText(p: PlantedText): Promise<string> {
  const r = await rows<{ id: string }>(
    `INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, reason_key, held_until, next_try_at, tries, due_at, created_at, delivered_at)
     VALUES ($1, $2, $3, $4, 'gsm7', $5, 40, $6, $7, $8, $9, $10, $11, $11, $12) RETURNING id`,
    [p.customerId, p.jobNumber, p.kind ?? 'confirmation', p.language ?? 'en', p.body ?? 'Brightwater: You are booked!', p.status ?? 'delivered', p.reasonKey ?? null,
      p.heldUntil ?? null, p.nextTry ?? null, p.tries ?? 0, p.at, p.deliveredAt ?? null]);
  return r[0]!.id;
}
const attempt = (textId: string, number: number, at: string, result: 'delivered' | 'failed', reason: string | null) =>
  db.admin().query('INSERT INTO world.text_attempt (text_id, number, at, result, reason) VALUES ($1, $2, $3, $4, $5)', [textId, number, at, result, reason]);

const DAY = '2026-09-15';
const log = (body: Record<string, unknown> = {}, who = keisha) => api.post('/text-searches', { date: DAY, branch: 'columbus', ...body }, who);

interface LogOut {
  texts: { id: string; type: string; status: string; customer: string; context: { bookedAt: string | null; technician: string | null } }[];
  replies: { id: string; handling: string; body: string }[];
  counts: Record<string, number>;
  nextReminders: { visitDay: string; visits: number; reminderTexts: number; callListCount: number; at: string };
  simulatorMode: string; total: number; cursors: { newer: string | null; older: string | null };
}

describe('the text log read (API-40)', () => {
  // why: FR-TEXT-15
  it('lists the day\'s texts and replies newest first with each status, the day\'s counts and the simulator mode', async () => {
    await setNow('2026-09-15T14:30:00Z');
    const a = await customer();
    const b = await customer({ language: 'es' });
    const c = await customer();
    const jobB = await book(b.id, '2026-09-16', 'four_hour 08:00');
    // API-28 sends the confirmation itself (F-671); this case plants its own texts, so the booking's is removed.
    await db.admin().query(`DELETE FROM world.outbox_text WHERE job_number = $1`, [jobB]);
    await plantText({ customerId: a.id, jobNumber: null, kind: 'office', status: 'delivered', at: '2026-09-15T14:00:00Z', deliveredAt: '2026-09-15T14:00:10Z' });
    // A confirmation delivered within a minute of its due time, and one that took 10 minutes.
    await plantText({ customerId: b.id, jobNumber: jobB, kind: 'confirmation', status: 'delivered', at: '2026-09-15T14:05:00Z', deliveredAt: '2026-09-15T14:05:20Z', language: 'es' });
    await plantText({ customerId: c.id, jobNumber: null, kind: 'confirmation', status: 'delivered', at: '2026-09-15T14:10:00Z', deliveredAt: '2026-09-15T14:20:00Z' });
    await plantText({ customerId: a.id, jobNumber: null, kind: 'late', status: 'retrying', tries: 2, at: '2026-09-15T14:15:00Z', nextTry: '2026-09-15T14:31:00Z', reasonKey: 'text_reason.send_failed' });
    await plantText({ customerId: c.id, jobNumber: null, kind: 'reminder', status: 'held', at: '2026-09-15T14:16:00Z', heldUntil: '2026-09-15T15:00:00Z', reasonKey: 'text_reason.quiet_hours' });
    await plantText({ customerId: c.id, jobNumber: null, kind: 'on_the_way', status: 'gave_up', tries: 5, at: '2026-09-15T14:17:00Z', reasonKey: 'text_reason.gave_up' });
    await rows(`INSERT INTO world.inbox_message (customer_id, direction, body, at, handling, job_number) VALUES ($1, 'in', 'C', '2026-09-15T14:25:00Z', 'confirmed', $2), ($1, 'in', 'hola', '2026-09-15T14:26:00Z', 'not_understood', NULL)`, [b.id, jobB]).catch(() => []);
    await db.admin().query(`INSERT INTO world.text_simulator (mode) SELECT 'all_fail' WHERE NOT EXISTS (SELECT 1 FROM world.text_simulator)`);
    await db.admin().query(`UPDATE world.text_simulator SET mode = 'all_fail'`);
    const r = await json<LogOut>(await log());
    expect(r.status).toBe(200);
    expect(r.data.texts.map((t) => [t.type, t.status])).toEqual([
      ['on_the_way', 'gave_up'], ['reminder', 'held'], ['late', 'retrying'], ['confirmation', 'delivered'], ['confirmation', 'delivered'], ['office', 'delivered'],
    ]);
    expect(r.data.replies.map((x) => [x.handling, x.body])).toEqual([['not_understood', 'hola'], ['confirmed', 'C']]);
    expect(r.data.counts).toMatchObject({
      texts: 6, delivered: 3, held: 1, failedRetrying: 1, notSent: 1, replies: 2, confirmations: 2, confirmationsOnTime: 1, repliesConfirmed: 1, repliesReschedule: 0,
    });
    expect(r.data.simulatorMode).toBe('all_fail');
    expect(r.data.total).toBe(8);
    expect(r.data.nextReminders).toMatchObject({ visitDay: '2026-09-16', visits: 1, reminderTexts: 1, callListCount: 0 });
    await db.admin().query(`UPDATE world.text_simulator SET mode = 'up'`);
  });

  // why: FR-TEXT-15
  it('filters by type, status, language and customer, and the filters never change the day\'s counts', async () => {
    const all = await json<LogOut>(await log());
    const late = await json<LogOut>(await log({ type: 'late' }));
    expect(late.data.texts.map((t) => t.type)).toEqual(['late']);
    expect(late.data.replies).toEqual([]);
    expect(late.data.counts.texts).toBe(all.data.counts.texts);
    const replies = await json<LogOut>(await log({ type: 'replies' }));
    expect(replies.data.texts).toEqual([]);
    expect(replies.data.replies).toHaveLength(2);
    const held = await json<LogOut>(await log({ status: 'held' }));
    expect(held.data.texts.map((t) => t.status)).toEqual(['held']);
    const confirmed = await json<LogOut>(await log({ status: 'confirmed' }));
    expect(confirmed.data.texts).toEqual([]);
    expect(confirmed.data.replies.map((x) => x.handling)).toEqual(['confirmed']);
    const es = await json<LogOut>(await log({ language: 'es' }));
    expect(es.data.texts.length).toBeGreaterThan(0);
    const who = all.data.texts.find((t) => t.type === 'late')!.customer;
    const byName = await json<LogOut>(await log({ customer: who.slice(0, 5).toUpperCase() }));
    expect(byName.data.texts.some((t) => t.customer === who)).toBe(true);
    const none = await json<LogOut>(await log({ date: '2026-09-14' }));
    expect(none.data.total).toBe(0);
  });

  // why: FR-TEXT-15
  it('pages with a keyset cursor: Older then Newer returns the same rows, never one twice', async () => {
    const first = await json<LogOut>(await log({ limit: 3 }));
    const ids1 = [...first.data.texts.map((t) => t.id), ...first.data.replies.map((x) => x.id)];
    expect(ids1).toHaveLength(3);
    expect(first.data.cursors.newer).toBeNull();
    expect(first.data.cursors.older).not.toBeNull();
    const second = await json<LogOut>(await log({ limit: 3, cursor: first.data.cursors.older! }));
    const ids2 = [...second.data.texts.map((t) => t.id), ...second.data.replies.map((x) => x.id)];
    expect(ids2).toHaveLength(3);
    expect(ids2.filter((i) => ids1.includes(i))).toEqual([]);
    expect(second.data.cursors.newer).not.toBeNull();
    const back = await json<LogOut>(await log({ limit: 3, cursor: second.data.cursors.newer! }));
    expect([...back.data.texts.map((t) => t.id), ...back.data.replies.map((x) => x.id)].sort()).toEqual([...ids1].sort());
    expect(back.data.cursors.newer).toBeNull();
  });
});

describe('the text detail (API-41) and Try now (API-144)', () => {
  // why: FR-TEXT-12
  it('shows the attempts, the next try and the tries after it on the 5-try schedule, and Try now moves the next try to now and counts as that try', async () => {
    await setNow('2026-09-15T14:30:00Z');
    const c = await customer({ mobile: '(614) 555-0187' });
    const job = await book(c.id, '2026-09-16', 'four_hour 08:00');
    const id = await plantText({ customerId: c.id, jobNumber: job, status: 'retrying', tries: 2, at: '2026-09-15T14:27:00Z', nextTry: '2026-09-15T14:31:00Z', reasonKey: 'text_reason.send_failed' });
    await attempt(id, 1, '2026-09-15T14:27:00Z', 'failed', 'simulator_all_fail');
    await attempt(id, 2, '2026-09-15T14:29:00Z', 'failed', 'simulator_all_fail');
    await db.admin().query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-15T14:31:00Z', 'text.try', $1, $2::jsonb, 'due')`, [id, JSON.stringify({ textId: id, number: 3 })]);
    const d = await json<{ attempts: { number: number; result: string; reasonKey: string }[]; canTryNow: boolean; nextTryAt: string; plannedTries: { number: number; at: string }[]; customerContact: { mobileEnd: string }; job: { bookedVia: string; bookedBy: string } }>(await api.get(`/texts/${id}`, keisha));
    expect(d.status).toBe(200);
    expect(d.data.attempts.map((a) => [a.number, a.result, a.reasonKey])).toEqual([[1, 'failed', 'text_attempt.simulator_all_fail'], [2, 'failed', 'text_attempt.simulator_all_fail']]);
    expect(d.data.canTryNow).toBe(true);
    expect(d.data.nextTryAt).toBe('2026-09-15T10:31:00-04:00[America/New_York]');
    // Tries 4 and 5 at the first try's time plus 9 and 19 minutes: 10:36 AM and 10:46 AM.
    expect(d.data.plannedTries.map((p) => [p.number, p.at])).toEqual([[4, '2026-09-15T10:36:00-04:00[America/New_York]'], [5, '2026-09-15T10:46:00-04:00[America/New_York]']]);
    expect(d.data.customerContact.mobileEnd).toBe('0187');
    expect(d.data.job).toMatchObject({ bookedVia: 'office', bookedBy: keisha.name });

    const t = await json<{ text: { heldUntil: string | null } }>(await api.post(`/texts/${id}/tries`, {}, keisha));
    expect(t.status).toBe(200);
    expect(t.data.text.heldUntil).toBeNull();
    const ev = await rows<{ due_at: Date; payload: { number: number } }>(`SELECT due_at, payload FROM world.scheduled_event WHERE kind = 'text.try' AND subject = $1 AND state = 'due'`, [id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.due_at.toISOString()).toBe('2026-09-15T14:30:00.000Z');
    expect(ev[0]!.payload.number).toBe(3);
  });

  // why: FR-TEXT-24
  it('answers not_retryable for a text that is not failed with tries left, and 404 for a text that does not exist', async () => {
    const c = await customer();
    const done = await plantText({ customerId: c.id, jobNumber: null, status: 'delivered', at: '2026-09-15T14:00:00Z', deliveredAt: '2026-09-15T14:00:01Z' });
    const r = await json<unknown>(await api.post(`/texts/${done}/tries`, {}, keisha));
    expect([r.status, r.code]).toEqual([409, 'not_retryable']);
    const gone = await api.post('/texts/00000000-0000-4000-8000-000000000000/tries', {}, keisha);
    expect(gone.status).toBe(404);
    expect((await api.get('/texts/00000000-0000-4000-8000-000000000000', keisha)).status).toBe(404);
  });

  // why: FR-TEXT-24
  it('Try now at 10:00 PM in the customer\'s zone is held to 8:00 AM and the answer says when', async () => {
    await setNow('2026-09-16T02:00:00Z'); // 10:00 PM EDT Sep 15
    const c = await customer();
    const id = await plantText({ customerId: c.id, jobNumber: null, status: 'retrying', tries: 1, at: '2026-09-15T22:00:00Z', nextTry: '2026-09-15T22:02:00Z' });
    await attempt(id, 1, '2026-09-15T22:00:00Z', 'failed', 'simulator_all_fail');
    await db.admin().query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-15T22:02:00Z', 'text.try', $1, $2::jsonb, 'due')`, [id, JSON.stringify({ textId: id, number: 2 })]);
    const t = await json<{ text: { heldUntil: string } }>(await api.post(`/texts/${id}/tries`, {}, keisha));
    expect(t.status).toBe(200);
    expect(t.data.text.heldUntil).toBe('2026-09-16T08:00:00-04:00[America/New_York]');
    const ev = await rows<{ due_at: Date }>(`SELECT due_at FROM world.scheduled_event WHERE kind = 'text.try' AND subject = $1 AND state = 'due'`, [id]);
    expect(ev[0]!.due_at.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });
});

describe('Add to call list (API-145)', () => {
  // why: FR-TEXT-24
  it('puts the customer on the call list for a failed text with who added them and when, once; a delivered text is refused', async () => {
    await setNow('2026-09-15T15:20:00Z');
    const c = await customer();
    const job = await book(c.id, '2026-09-16', 'four_hour 10:00');
    const failed = await plantText({ customerId: c.id, jobNumber: job, status: 'retrying', tries: 3, at: '2026-09-15T15:00:00Z', nextTry: '2026-09-15T15:30:00Z' });
    const ok = await json<{ entry: { by: string; at: string } }>(await api.post(`/texts/${failed}/call-list`, {}, keisha));
    expect(ok.status).toBe(201);
    expect(ok.data.entry).toMatchObject({ by: keisha.name, at: '2026-09-15T11:20:00-04:00[America/New_York]' });
    const row = await rows<{ reason: string; call_date: string; added_by: string }>(`SELECT reason, call_date::text, added_by FROM world.call_list_entry WHERE text_id = $1`, [failed]);
    expect(row).toEqual([{ reason: 'added_by_office', call_date: '2026-09-15', added_by: keisha.userId }]);
    const again = await json<unknown>(await api.post(`/texts/${failed}/call-list`, {}, ana));
    expect([again.status, again.code]).toEqual([409, 'already_on_call_list']);
    const delivered = await plantText({ customerId: c.id, jobNumber: job, status: 'delivered', at: '2026-09-15T15:00:00Z', deliveredAt: '2026-09-15T15:00:05Z' });
    const refused = await json<unknown>(await api.post(`/texts/${delivered}/call-list`, {}, keisha));
    expect([refused.status, refused.code]).toEqual([409, 'rule_refused']);
  });
});

describe('the text log export (API-146)', () => {
  // why: FR-TEXT-24 F-654 F-657
  it('writes the rows the page shows for the day and the filters, in the page\'s words and language, with a byte order mark', async () => {
    await setNow('2026-09-15T15:00:00Z'); // 11:00 AM EDT: the demo date names the file
    const page = await json<LogOut>(await log({ type: 'confirmation' }));
    const r = await api.post('/text-searches/export', { date: DAY, branch: 'columbus', type: 'confirmation', lang: 'es' }, keisha);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="text-log-columbus-2026-09-15.csv"');
    // The raw bytes: Response.text() would drop a leading byte order mark (the encoding standard), so read them as bytes.
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Hora,Cliente,Tipo,Idioma,Mensaje,Estado');
    expect(lines.length - 1).toBe(page.data.texts.length + page.data.replies.length);
    expect(lines.slice(1).every((l) => l.includes('Confirmación'))).toBe(true);
    const en = await api.post('/text-searches/export', { date: DAY, branch: 'columbus' }, keisha);
    const enLines = (await en.text()).replace(/^﻿/, '').trim().split('\r\n');
    expect(enLines[0]).toBe('Time,Customer,Type,Language,Text,Status');
    expect(enLines.some((l) => l.includes('Failed - retrying - attempt 2 of 5'))).toBe(true);
  });
});

describe('the call list (API-42) and call outcomes (API-38)', () => {
  // why: FR-TEXT-13 F-651: API-42 for a date lists the next day's visits, all day
  it('at 10:00 AM lists the next day\'s no-mobile and texts-off visits booked that morning, before any reminder has run, and the card counts the same calls', async () => {
    await setNow('2026-09-15T14:00:00Z'); // 10:00 AM EDT, Sep 15
    const none = await customer({ mobile: null });
    const off = await customer({ textsOn: false, language: 'es' });
    const jobNone = await book(none.id, '2026-09-16', 'four_hour 08:00');
    const jobOff = await book(off.id, '2026-09-16', 'four_hour 10:00');
    await db.admin().query(`UPDATE world.job SET technician_id = $2 WHERE job_number = $1`, [jobOff, world.technicians.values().next().value]);
    // Nothing has written a call list row for them: the 6:00 PM reminder event has not run.
    expect(await rows(`SELECT id FROM world.call_list_entry WHERE job_number IN ($1, $2)`, [jobNone, jobOff])).toEqual([]);
    type CallsOut = {
      reminderCalls: { entryId: string; customer: string; phone: string; reason: string; language: string; visit: { jobNumber: number; technician: string | null; day: string }; outcome: { kind: string; by: string } | null }[];
      failedTexts: { reason: string; addedBy: string | null; textType: string | null }[];
      progress: { total: number; called: number }; count: number; dayTotals: { visitDay: string; visits: number; reminderTexts: number; callListCount: number };
    };
    const read = async () => {
      const r = await json<CallsOut>(await api.get('/call-list?branch=columbus&date=2026-09-15', keisha));
      expect(r.status).toBe(200);
      return r.data;
    };
    const d = await read();
    const mine = d.reminderCalls.filter((x) => [jobNone, jobOff].includes(x.visit.jobNumber));
    expect(mine.map((x) => [x.reason, x.language, x.phone, x.visit.day])).toEqual([['no_mobile', 'en', '(614) 555-0100', '2026-09-16'], ['texts_off', 'es', '(614) 555-0187', '2026-09-16']]);
    expect(mine.map((x) => x.entryId)).toEqual([reminderCallId(jobNone, '2026-09-15'), reminderCallId(jobOff, '2026-09-15')]);
    expect(mine[1]!.visit.technician).not.toBeNull();
    // The Tomorrow's reminders card (CTL-OFC-09-12) counts exactly the next day's calls the list holds.
    expect(d.dayTotals).toMatchObject({ visitDay: '2026-09-16' });
    expect(d.reminderCalls.filter((x) => x.visit.day === '2026-09-16').length).toBe(d.dayTotals.callListCount);
    expect(d.dayTotals.visits).toBe(d.dayTotals.reminderTexts + d.dayTotals.callListCount);
    expect(d.failedTexts.some((f) => f.reason === 'added_by_office' && f.addedBy === keisha.name && f.textType !== null)).toBe(true);
    expect(d.progress.total).toBe(d.reminderCalls.length + d.failedTexts.length);
    expect(d.count).toBe(d.progress.total - d.progress.called);
    // A call made at 10:05 AM is recorded on the row the list named, which is written then, once.
    await setNow('2026-09-15T14:05:00Z');
    const na = await json<{ outcome: { kind: string; by: string } }>(await api.post(`/jobs/${jobNone}/call-outcomes`, { outcome: 'no_answer', entryId: mine[0]!.entryId }, keisha));
    expect([na.status, na.data.outcome]).toEqual([200, { kind: 'no_answer', by: keisha.name, at: expect.any(String) }]);
    expect(await rows(`SELECT id, call_date::text AS call_date, reason FROM world.call_list_entry WHERE job_number = $1`, [jobNone]))
      .toEqual([{ id: mine[0]!.entryId, call_date: '2026-09-15', reason: 'no_mobile' }]);
    // At 6:00 PM the reminder events fire: the list keeps the same rows, ids and outcome, and the card still agrees.
    const sixPm = Temporal.Instant.from('2026-09-15T22:00:00Z');
    for (const job of [jobNone, jobOff]) {
      await fireReminder(db.admin(), { catalogs, linkHost: 'bw.j7l.io' }, { jobNumber: job, eventDueAt: sixPm, now: sixPm });
    }
    await setNow('2026-09-15T22:30:00Z');
    const after = await read();
    const mineAfter = after.reminderCalls.filter((x) => [jobNone, jobOff].includes(x.visit.jobNumber));
    expect(mineAfter.map((x) => [x.entryId, x.outcome?.kind ?? null])).toEqual([[mine[0]!.entryId, 'no_answer'], [mine[1]!.entryId, null]]);
    expect(await rows(`SELECT job_number FROM world.call_list_entry WHERE job_number IN ($1, $2) ORDER BY job_number`, [jobNone, jobOff])).toHaveLength(2);
    expect(after.reminderCalls.filter((x) => x.visit.day === '2026-09-16').length).toBe(after.dayTotals.callListCount);
  });

  // why: FR-TEXT-25
  it('records No answer with who and when and keeps the customer to call again; Confirmed replaces it and gives the visit confirmation; a Confirmed is never turned into No answer', async () => {
    const list = async () => (await json<{ reminderCalls: { visit: { jobNumber: number }; outcome: { kind: string; by: string } | null }[]; count: number; progress: Record<string, number> }>(await api.get('/call-list?branch=columbus&date=2026-09-15', keisha))).data;
    const target = (await list()).reminderCalls.find((x) => x.outcome === null)!;
    const job = target.visit.jobNumber;
    const before = (await list()).count;
    const na = await json<{ outcome: { kind: string; by: string }; confirmedAt: string | null }>(await api.post(`/jobs/${job}/call-outcomes`, { outcome: 'no_answer' }, keisha));
    expect(na.status).toBe(200);
    expect(na.data.outcome).toMatchObject({ kind: 'no_answer', by: keisha.name });
    expect(na.data.confirmedAt).toBeNull();
    // The customer stays to call again: the row has an outcome, so the count of calls left drops by one for the first call.
    expect((await list()).progress.noAnswer).toBeGreaterThanOrEqual(1);
    const ok = await json<{ outcome: { kind: string; by: string }; confirmedAt: string }>(await api.post(`/jobs/${job}/call-outcomes`, { outcome: 'confirmed' }, ana));
    expect(ok.data.outcome).toMatchObject({ kind: 'confirmed', by: ana.name });
    expect(ok.data.confirmedAt).toEqual(expect.any(String));
    expect((await list()).reminderCalls.find((x) => x.visit.jobNumber === job)!.outcome).toMatchObject({ kind: 'confirmed', by: ana.name });
    expect((await list()).count).toBe(before - 1);
    expect((await rows<{ confirmed_at: Date | null }>('SELECT confirmed_at FROM world.job WHERE job_number = $1', [job]))[0]!.confirmed_at).not.toBeNull();
    const back = await json<unknown>(await api.post(`/jobs/${job}/call-outcomes`, { outcome: 'no_answer' }, keisha));
    expect([back.status, back.code]).toEqual([409, 'rule_refused']);
    // Each call appends its own job_change row of kind call_outcome.
    const changes = await rows<{ data: { outcome: string } }>(`SELECT data FROM world.job_change WHERE job_number = $1 AND kind = 'call_outcome' ORDER BY at, id`, [job]);
    expect(changes.map((c) => c.data.outcome)).toEqual(['no_answer', 'confirmed']);
    const none = await api.post('/jobs/999999/call-outcomes', { outcome: 'no_answer' }, keisha);
    expect(none.status).toBe(404);
  });

  // why: FR-TEXT-25
  it('records Reschedule only after the visit has been moved (API-24), keeps the moved visit on the day\'s list with that outcome, and a Reschedule can become Confirmed', async () => {
    await setNow('2026-09-15T15:00:00Z'); // 11:00 AM EDT: the list shows the visit before any row is written
    const off = await customer({ textsOn: false });
    const jobNumber = await book(off.id, '2026-09-16', 'four_hour 12:00');
    const entryId = reminderCallId(jobNumber, '2026-09-15');
    const listed = async () => (await json<{ reminderCalls: { entryId: string; visit: { day: string }; outcome: { kind: string } | null }[] }>(
      await api.get('/call-list?branch=columbus&date=2026-09-15', keisha))).data.reminderCalls.find((x) => x.entryId === entryId);
    expect(await listed()).toMatchObject({ visit: { day: '2026-09-16' }, outcome: null });
    const refused = await json<unknown>(await api.post(`/jobs/${jobNumber}/call-outcomes`, { outcome: 'reschedule', entryId }, keisha));
    expect([refused.status, refused.code]).toEqual([409, 'rule_refused']);
    expect(await rows('SELECT id FROM world.call_list_entry WHERE job_number = $1', [jobNumber])).toEqual([]); // the refusal wrote nothing
    const job = (await rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [jobNumber]))[0]!;
    const moved = await api.post(`/jobs/${jobNumber}/schedule`, { date: '2026-09-17', windowId: win('two_hour 12:00'), baseVersion: job.version }, keisha);
    expect(moved.status).toBe(200);
    const ok = await json<{ outcome: { kind: string } }>(await api.post(`/jobs/${jobNumber}/call-outcomes`, { outcome: 'reschedule', entryId }, keisha));
    expect(ok.status).toBe(200);
    expect(ok.data.outcome.kind).toBe('reschedule');
    expect(await listed()).toMatchObject({ visit: { day: '2026-09-17' }, outcome: { kind: 'reschedule' } });
    const na = await json<unknown>(await api.post(`/jobs/${jobNumber}/call-outcomes`, { outcome: 'no_answer', entryId }, keisha));
    expect(na.code).toBe('rule_refused');
    const conf = await json<{ outcome: { kind: string } }>(await api.post(`/jobs/${jobNumber}/call-outcomes`, { outcome: 'confirmed', entryId }, keisha));
    expect(conf.data.outcome.kind).toBe('confirmed');
    // An id the list never gave, or one for another job, is not found.
    const stray = await json<unknown>(await api.post(`/jobs/${jobNumber}/call-outcomes`, { outcome: 'confirmed', entryId: reminderCallId(jobNumber + 1, '2026-09-15') }, keisha));
    expect(stray.status).toBe(404);
  });

  // why: F-686, UD-53 a row with no entry is written only for the id API-42 gave and only for today's call date
  it('writes no call list row for a call with no entryId, or for an entryId whose call date is not today', async () => {
    await setNow('2026-09-15T15:00:00Z');
    const off = await customer({ textsOn: false });
    const jobNumber = await book(off.id, '2026-09-16', 'four_hour 12:00');
    const bare = await api.post(`/jobs/${jobNumber}/call-outcomes`, { outcome: 'confirmed' }, keisha);
    expect(bare.status).toBe(404);
    const job = (await rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [jobNumber]))[0]!;
    expect((await api.post(`/jobs/${jobNumber}/schedule`, { date: '2026-09-17', windowId: win('two_hour 12:00'), baseVersion: job.version }, keisha)).status).toBe(200);
    for (const callDate of ['2026-09-14', '2026-09-16']) {
      const r = await api.post(`/jobs/${jobNumber}/call-outcomes`, { outcome: 'reschedule', entryId: reminderCallId(jobNumber, callDate) }, keisha);
      expect(r.status).toBe(404);
    }
    expect(await rows('SELECT id FROM world.call_list_entry WHERE job_number = $1', [jobNumber])).toEqual([]);
  });
});

describe('an office-created job booked after 6:00 PM the evening before (F-446, owner ruling 86ecd5ae)', () => {
  // why: FR-TEXT-13 owner ruling 86ecd5ae F-446: Send it right away
  it('API-28 at 7:15 PM for the next morning plans the reminder at once; the same booking at 10:00 AM plans it for 6:00 PM', async () => {
    await setNow('2026-09-15T23:15:00Z'); // 7:15 PM EDT
    const c = await customer({ textsOn: false });
    const job = await book(c.id, '2026-09-16', 'four_hour 08:00');
    const ev = await rows<{ due_at: Date; payload: { atOnce?: boolean; visitDate?: string } }>(`SELECT due_at, payload FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject = $1 AND state = 'due'`, [String(job)]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.due_at.toISOString()).toBe('2026-09-15T23:15:00.000Z');
    expect(ev[0]!.payload).toMatchObject({ atOnce: true, visitDate: '2026-09-16' });
    await setNow('2026-09-15T14:00:00Z'); // 10:00 AM EDT
    const c2 = await customer();
    const job2 = await book(c2.id, '2026-09-17', 'two_hour 08:00');
    const ev2 = await rows<{ due_at: Date; payload: { atOnce?: boolean } }>(`SELECT due_at, payload FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject = $1 AND state = 'due'`, [String(job2)]);
    expect(ev2[0]!.due_at.toISOString()).toBe('2026-09-16T22:00:00.000Z');
    expect(ev2[0]!.payload.atOnce).toBeUndefined();
  });
});
