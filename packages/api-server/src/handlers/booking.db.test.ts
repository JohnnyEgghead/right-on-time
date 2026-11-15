// SPDX-License-Identifier: AGPL-3.0-or-later
// The online booking site's calls on the real database (PostgreSQL 18, the migrated schema, the reference seed with its street list), through
// the production kernel as an anonymous caller: API-112, API-113 and API-114 (P5-BOOKING; FR-BOOK-1 to FR-BOOK-3, FR-BOOK-7, FR-BOOK-9 to FR-BOOK-12,
// FR-BOOK-14 to FR-BOOK-16, FR-TEXT-1). The booking itself is the office write's createJob under its locks (G-CI3 races that); these tests prove
// the online channel's rules around it and that a real request queues the confirmation (F-782, F-421). The demo clock is set per test, never slept.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ORIGIN, officeWorld, type OfficeWorld } from '../office-writes/testing.ts';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let columbus: string;
let dayton: string;
let windowIds = new Map<string, string>();

const send = (method: string, path: string, body?: unknown) => world.kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: ORIGIN },
}), { address: '203.0.113.9' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const json = async (r: Response): Promise<Json> => r.json();
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;

/** Park the demo clock at `at` (UTC): the kernel reads it on every request. */
async function clockAt(at: string): Promise<void> {
  await db.admin().query(`UPDATE system.demo_clock SET paused = true, demo_anchor = $1, last_reset_real = now() - interval '1 hour' WHERE id = 1`, [at]);
}
const SEP15_7AM = '2026-09-15T11:00:00Z';

const availability = (streetId: string, from: string, to: string, serviceId = 'furnace_tune_up') => send('POST', '/public/availability', { streetId, serviceId, from, to });
const booking = (o: Record<string, unknown> = {}) => ({
  serviceId: 'furnace_tune_up', streetId: columbus, houseNumber: 2310, date: '2026-09-17', windowId: windowId('two_hour', '10:00'), name: 'Lucia Moreno',
  mobile: '(614) 555-0148', textsOn: true, textLanguage: 'en', timeZone: 'America/New_York', ...o,
});
const windowId = (mode: string, start: string, branch = 'columbus') => windowIds.get(`${branch} ${mode} ${start}`) as string;
const book = (o: Record<string, unknown> = {}) => send('POST', '/public/bookings', booking(o));

beforeAll(async () => {
  world = await officeWorld(db, 3);
  const a = db.admin();
  columbus = (await a.query<{ id: string }>(`SELECT id FROM world.street WHERE branch_id = 'columbus' ORDER BY name, id LIMIT 1`)).rows[0]!.id;
  dayton = (await a.query<{ id: string }>(`SELECT id FROM world.street WHERE branch_id = 'dayton' ORDER BY name, id LIMIT 1`)).rows[0]!.id;
  const w = await a.query<{ id: string; key: string }>(`SELECT id, branch_id || ' ' || mode || ' ' || to_char(start_local, 'HH24:MI') AS key FROM world.arrival_window`);
  windowIds = new Map(w.rows.map((x) => [x.key, x.id]));
}, 120_000);
afterAll(async () => {
  await world?.close();
});
beforeEach(async () => {
  await clockAt(SEP15_7AM);
});

describe('availability (API-112)', () => {
  // why: FR-BOOK-9 the online channel never offers today and closes a day at 5:00 PM the day before, in the branch's zone
  it('offers Wed, Sep 16 until 4:59 PM EDT on Sep 15 and shows it Booking closed from 5:00 PM; today is never offered', async () => {
    const at = async (utc: string) => { await clockAt(utc); return (await json(await availability(columbus, '2026-09-15', '2026-09-17'))).data; };
    const before = await at('2026-09-15T20:59:00Z');
    expect(before.today).toBe('2026-09-15');
    expect(before.days.map((d: Json) => [d.date, d.state, d.reason])).toEqual([['2026-09-15', 'closed', 'booking_closed'], ['2026-09-16', 'open', null], ['2026-09-17', 'open', null]]);
    const after = await at('2026-09-15T21:00:00Z');
    expect(after.days.map((d: Json) => [d.date, d.state, d.reason])).toEqual([['2026-09-15', 'closed', 'booking_closed'], ['2026-09-16', 'closed', 'booking_closed'], ['2026-09-17', 'open', null]]);
    expect(after.days[1].windows).toEqual([]);
  });

  // why: FR-BOOK-9 the online horizon is the next 21 days after today (SD-27)
  it('stops 21 days after today', async () => {
    const d = (await json(await availability(columbus, '2026-09-15', '2026-12-31'))).data;
    expect(d.days.at(-1).date).toBe('2026-10-06');
  });

  // why: FR-BOOK-10 a Sunday is always Closed on Sundays; a Saturday offers only 8-10 AM and 10 AM-12 PM, and only with a working technician
  it('closes Sundays, and a Saturday offers its 2 windows or says No technicians this Saturday', async () => {
    const d = (await json(await availability(columbus, '2026-09-15', '2026-10-06'))).data;
    const sunday = d.days.find((x: Json) => x.date === '2026-09-20');
    expect([sunday.state, sunday.reason, sunday.windows.length]).toEqual(['closed', 'sunday', 0]);
    const saturdays = d.days.filter((x: Json) => x.mode === 'saturday' || x.date === '2026-09-19' || x.date === '2026-09-26' || x.date === '2026-10-03');
    expect(saturdays.length).toBe(3);
    // why: F-960 the seeded Saturdays have working technicians, so each offers its 2 windows; the old either-or arm never reached the other state
    for (const s of saturdays) {
      expect([s.state, s.reason]).toEqual(['open', null]);
      expect(s.windows.map((x: Json) => x.start.slice(11, 16))).toEqual(['08:00', '10:00']);
    }
  });

  // why: F-960 (FR-BOOK-10) with every technician off on 1 Saturday, that Saturday says No technicians this Saturday, offers no window and refuses a booking; the other Saturdays stay open
  it('says No technicians this Saturday for the Saturday every technician has off, and refuses a booking on it', async () => {
    const off = '2026-09-26';
    const by = (await rows<{ id: string }>('SELECT id FROM world."user" LIMIT 1'))[0]!.id;
    await db.admin().query(
      `INSERT INTO world.time_off (technician_id, from_date, to_date, created_by) SELECT t.id, $1::date, $1::date, $2 FROM world.technician t WHERE t.branch_id = 'columbus'`, [off, by]);
    try {
      const d = (await json(await availability(columbus, '2026-09-15', '2026-10-06'))).data;
      const day = (date: string) => d.days.find((x: Json) => x.date === date);
      expect([day(off).state, day(off).reason, day(off).windows]).toEqual(['closed', 'no_technicians', []]);
      for (const open of ['2026-09-19', '2026-10-03']) expect([day(open).state, day(open).windows.length]).toEqual(['open', 2]);
      const refused = await book({ date: off, windowId: windowId('saturday', '08:00'), name: 'Saturday Off', mobile: null });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await rows('SELECT 1 FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE c.name = $1', ['Saturday Off'])).toEqual([]);
    } finally {
      await db.admin().query(`DELETE FROM world.time_off WHERE from_date = $1::date AND to_date = $1::date AND note IS NULL`, [off]);
    }
  });

  // why: FR-BOOK-12 the calendar shows the picked street's branch's windows: the answer names the branch and its zone
  it("derives the branch from the street: a Dayton street answers Dayton's windows", async () => {
    const d = (await json(await availability(dayton, '2026-09-16', '2026-09-16'))).data;
    expect(d.branch).toBe('dayton');
    const ids = new Set(d.days[0].windows.map((w: Json) => w.windowId));
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect((await rows<{ branch_id: string }>('SELECT branch_id FROM world.arrival_window WHERE id = $1', [id]))[0]!.branch_id).toBe('dayton');
  });

  // why: FR-BOOK-12 a street not on the list is validation_failed
  it('refuses a street that is not on the list', async () => {
    const r = await availability('00000000-0000-7000-8000-000000000000', '2026-09-16', '2026-09-16');
    expect([r.status, (await json(r)).code]).toEqual([422, 'validation_failed']);
  });

  // why: FR-BOOK-16 a window shows its places left when they are at or below 3, and Open otherwise; the number is the room the booking write accepts
  it('shows places left at or below 3 and nothing above, and the number is what the write accepts', async () => {
    const win = windowId('two_hour', '12:00');
    await db.admin().query('UPDATE world.arrival_window SET capacity = 2 WHERE id = $1', [win]);
    const day = (await json(await availability(columbus, '2026-09-22', '2026-09-22'))).data.days[0];
    const w = day.windows.find((x: Json) => x.windowId === win);
    expect([w.state, w.placesLeft]).toEqual(['open', 2]);
    expect(day.windows.filter((x: Json) => x.windowId !== win).every((x: Json) => x.placesLeft === null || x.placesLeft <= 3)).toBe(true);
    for (let i = 0; i < 2; i++) expect((await book({ date: '2026-09-22', windowId: win, name: `Cap Fill ${i}`, mobile: null })).status).toBe(201);
    expect((await book({ date: '2026-09-22', windowId: win, name: 'Cap Fill 3', mobile: null })).status).toBe(409);
    const after = (await json(await availability(columbus, '2026-09-22', '2026-09-22'))).data.days[0].windows.find((x: Json) => x.windowId === win);
    expect([after.state, after.placesLeft]).toEqual(['full', null]);
    await db.admin().query('UPDATE world.arrival_window SET capacity = 12 WHERE id = $1', [win]);
  });

  // why: FR-BOOK-15, F-1136 a day with at most half its windows left is marked Only a few windows left; a day with none is Full; a day with more shows no marker
  it('marks a day with 2 windows left as few left, a day with none as Full, and a day with more as neither', async () => {
    const wins = await rows<{ id: string }>(`SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' ORDER BY start_local`);
    const keep = wins.slice(0, 2).map((x) => x.id);
    await db.admin().query(`UPDATE world.arrival_window SET capacity = 0 WHERE branch_id = 'columbus' AND mode = 'two_hour' AND NOT (id = ANY($1))`, [keep]);
    const few = (await json(await availability(columbus, '2026-09-23', '2026-09-23'))).data.days[0];
    expect([few.state, few.fewLeft]).toEqual(['open', true]);
    // 3 of the weekday's 5 windows is more than half: open, no marker
    const keep3 = wins.slice(0, 3).map((x) => x.id);
    await db.admin().query(`UPDATE world.arrival_window SET capacity = CASE WHEN id = ANY($1) THEN 12 ELSE 0 END WHERE branch_id = 'columbus' AND mode = 'two_hour'`, [keep3]);
    const half = (await json(await availability(columbus, '2026-09-23', '2026-09-23'))).data.days[0];
    expect([wins.length, half.windows.filter((x: Json) => x.state === 'open').length, half.fewLeft]).toEqual([5, 3, false]);
    await db.admin().query(`UPDATE world.arrival_window SET capacity = 0 WHERE branch_id = 'columbus' AND mode = 'two_hour'`);
    const none = (await json(await availability(columbus, '2026-09-23', '2026-09-23'))).data.days[0];
    expect([none.state, none.reason, none.fewLeft]).toEqual(['full', 'full', false]);
    await db.admin().query(`UPDATE world.arrival_window SET capacity = 12 WHERE branch_id = 'columbus' AND mode = 'two_hour'`);
    const many = (await json(await availability(columbus, '2026-09-23', '2026-09-23'))).data.days[0];
    expect([many.state, many.fewLeft]).toEqual(['open', false]);
  });

  // why: FR-BOOK-2 the office switches Wed, Sep 16 to a 4-hour day (API-91) and the booking site then offers only the 4 overlapping 4-hour windows; a 2-hour window is refused
  it('offers only the 4 four-hour windows on a 4-hour day, and refuses a 2-hour window booked on it', async () => {
    const sw = await world.kernel.router.handle(new Request('http://web:3000/api/v1/branches/columbus/days/2026-09-24/mode', {
      method: 'PUT', body: JSON.stringify({ mode: 'four_hour', reason: 'Heat wave' }),
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: world.staff.keisha.cookie },
    }), { address: '203.0.113.9' });
    expect(sw.status).toBe(200);
    const peak = (await json(await availability(columbus, '2026-09-16', '2026-09-16'))).data.days[0];
    expect([peak.mode, peak.windows.length]).toEqual(['four_hour', 4]); // the seeded peak day, Wed, Sep 16
    const day = (await json(await availability(columbus, '2026-09-24', '2026-09-24'))).data.days[0];
    expect(day.mode).toBe('four_hour');
    expect(day.windows.map((w: Json) => [w.start.slice(11, 16), w.end.slice(11, 16)])).toEqual([['08:00', '12:00'], ['10:00', '14:00'], ['12:00', '16:00'], ['14:00', '18:00']]);
    const refused = await book({ date: '2026-09-24', windowId: windowId('two_hour', '10:00'), mobile: null });
    expect([refused.status, (await json(refused)).code]).toEqual([409, 'rule_refused']);
    expect((await book({ date: '2026-09-24', windowId: windowId('four_hour', '10:00'), mobile: null })).status).toBe(201);
  });
});

describe('booking (API-113) and its summary (API-114)', () => {
  // why: FR-BOOK-1 an online booking makes the job (online, no technician yet, scheduled, version 1, a 22-character token), the customer and the created change; the summary reads it back
  it('books Thu, Sep 17 10 AM-12 PM: job, customer, change and the summary by its token', async () => {
    const r = await book();
    expect(r.status).toBe(201);
    const d = (await json(r)).data;
    expect(d.bookingToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(d.visit.window.start.slice(11, 16)).toBe('10:00');
    const job = (await rows<Json>('SELECT * FROM world.job WHERE booking_token = $1', [d.bookingToken]))[0];
    expect([job.booked_via, job.booked_by, job.technician_id, job.status, job.version]).toEqual(['online', null, null, 'scheduled', 1]);
    const change = (await rows<Json>('SELECT actor_kind, actor_user_id, kind, data FROM world.job_change WHERE job_number = $1', [job.job_number]));
    expect(change.map((c) => [c.kind, c.actor_kind, c.actor_user_id, c.data.via])).toEqual([['created', 'customer', null, 'online']]);
    const c = (await rows<Json>('SELECT source, branch_id, zone, texts_on, text_language, mobile FROM world.customer WHERE id = $1', [job.customer_id]))[0];
    expect([c.source, c.branch_id, c.zone, c.texts_on, c.text_language, c.mobile]).toEqual(['online', 'columbus', 'America/New_York', true, 'en', '+16145550148']);
    const s = await send('GET', `/public/bookings/${d.bookingToken}`);
    expect(s.status).toBe(200);
    const sum = (await json(s)).data;
    expect([sum.visit.jobNumber, sum.visit.name, sum.visit.serviceId, sum.textsOn, sum.textLanguage]).toEqual([job.job_number, 'Lucia Moreno', 'furnace_tune_up', true, 'en']);
    expect(sum.visit.address.houseNumber).toBe(2310);
    expect(sum.inboxUrl).toMatch(/^\/inbox\//);
    expect((await send('GET', '/public/bookings/' + 'x'.repeat(22))).status).toBe(404);
  });

  // why: FR-BOOK-14 the summary carries the service's price text key and screen label key, from the service row
  it('carries the price text of the service in the summary', async () => {
    const d = (await json(await book({ name: 'Price Check', mobile: null }))).data;
    const sum = (await json(await send('GET', `/public/bookings/${d.bookingToken}`))).data;
    const svc = (await rows<Json>(`SELECT price_text_key, screen_label_key FROM world.service_type WHERE id = 'furnace_tune_up'`))[0];
    expect([sum.visit.priceTextKey, sum.visit.serviceLabelKey]).toEqual([svc.price_text_key, svc.screen_label_key]);
  });

  // why: FR-BOOK-1 a customer of the branch with the same folded name and mobile is reused, not made twice
  it('reuses the customer with the same folded name and mobile', async () => {
    await book({ name: 'Rosa  Álvarez', mobile: '614-555-0177' });
    await book({ name: 'rosa alvarez', mobile: '(614) 555 0177', windowId: windowId('two_hour', '12:00') });
    expect((await rows<{ n: string }>(`SELECT count(*) AS n FROM world.customer WHERE name_search = 'rosa alvarez'`))[0]!.n).toBe('1');
  });

  // why: FR-BOOK-12 the visit goes to the address typed: the same name (and no mobile) at a different street or house makes a new customer there; the same address reuses
  it('reuses a customer only at the same address: a different street and house makes a new customer at the typed address', async () => {
    const streetB = (await rows<{ id: string }>(`SELECT id FROM world.street WHERE branch_id = 'columbus' AND id <> $1 ORDER BY name, id LIMIT 1`, [columbus]))[0]!.id;
    const at = async (token: string) => (await rows<Json>('SELECT c.id, c.street_id, c.house_number FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.booking_token = $1', [token]))[0];
    const first = await at((await json(await book({ name: 'Sam Visitor', mobile: null, streetId: columbus, houseNumber: 12 }))).data.bookingToken);
    const other = await at((await json(await book({ name: 'Sam Visitor', mobile: null, streetId: streetB, houseNumber: 99, windowId: windowId('two_hour', '12:00') }))).data.bookingToken);
    expect(other.id).not.toBe(first.id);
    expect([other.street_id, other.house_number]).toEqual([streetB, 99]);
    expect([first.street_id, first.house_number]).toEqual([columbus, 12]);
    const same = await at((await json(await book({ name: 'Sam Visitor', mobile: null, streetId: streetB, houseNumber: 99, windowId: windowId('two_hour', '08:00') }))).data.bookingToken);
    expect(same.id).toBe(other.id);
    expect((await rows<{ n: string }>(`SELECT count(*) AS n FROM world.customer WHERE name_search = 'sam visitor'`))[0]!.n).toBe('2');
  });

  // why: FR-BOOK-9 API-113 after the cutoff answers booking_closed and writes nothing
  it('refuses a booking for Wed, Sep 16 after 5:00 PM on Sep 15 with booking_closed, and writes no job and no customer', async () => {
    await clockAt('2026-09-15T21:01:00Z');
    const before = Number((await rows<{ n: string }>('SELECT count(*) AS n FROM world.job'))[0]!.n);
    const r = await book({ name: 'Too Late', date: '2026-09-16' });
    expect([r.status, (await json(r)).code]).toEqual([409, 'booking_closed']);
    expect(Number((await rows<{ n: string }>('SELECT count(*) AS n FROM world.job'))[0]!.n)).toBe(before);
    expect((await rows<{ n: string }>(`SELECT count(*) AS n FROM world.customer WHERE name = 'Too Late'`))[0]!.n).toBe('0');
    const today = await book({ date: '2026-09-15', name: 'Today' });
    expect((await json(today)).code).toBe('booking_closed');
  });

  // why: FR-BOOK-10 a Sunday cannot be booked online
  it('refuses a Sunday', async () => {
    const r = await book({ date: '2026-09-20', name: 'Sunday Person' });
    expect(r.status).toBe(409);
  });

  // why: FR-BOOK-12 a street not on the list and a house number outside 1 to 99999 are validation_failed; the branch, ZIP and position come from the street
  it('refuses an unknown street and a bad house number, and takes the branch from the street', async () => {
    for (const o of [{ streetId: '00000000-0000-7000-8000-000000000000' }, { houseNumber: 0 }, { houseNumber: 100000 }]) {
      const r = await book({ ...o, name: 'Bad Address' });
      expect([r.status, (await json(r)).code], JSON.stringify(o)).toEqual([422, 'validation_failed']);
    }
    const d = (await json(await book({ streetId: dayton, houseNumber: 7, name: 'Dayton Person', mobile: null, windowId: windowId('two_hour', '10:00', 'dayton') }))).data;
    const job = (await rows<Json>('SELECT j.branch_id, c.street_id, c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.booking_token = $1', [d.bookingToken]))[0];
    expect([job.branch_id, job.street_id]).toEqual(['dayton', dayton]);
    const pt = (await rows<Json>(`SELECT points->(6 % jsonb_array_length(points)) AS p FROM world.street WHERE id = $1`, [dayton]))[0].p;
    expect([job.lon, job.lat]).toEqual(pt);
  });

  // why: FR-BOOK-11 Text me updates in: unticked or no mobile stores texts off and queues no text; the language is stored
  it('stores texts off with no mobile whatever was asked, queues no text for texts off, and stores the language', async () => {
    const none = (await json(await book({ name: 'No Mobile', mobile: null, textsOn: true, textLanguage: 'es' }))).data;
    const off = (await json(await book({ name: 'Texts Off', mobile: '614-555-0191', textsOn: false, textLanguage: 'en', windowId: windowId('two_hour', '12:00') }))).data;
    const on = (await json(await book({ name: 'Texts On', mobile: '614-555-0192', textsOn: true, textLanguage: 'es', windowId: windowId('two_hour', '14:00') }))).data;
    const cust = async (t: string) => (await rows<Json>('SELECT c.texts_on, c.text_language, j.job_number FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.booking_token = $1', [t]))[0];
    expect((await cust(none.bookingToken)).texts_on).toBe(false);
    expect((await cust(off.bookingToken)).texts_on).toBe(false);
    const cOn = await cust(on.bookingToken);
    expect([cOn.texts_on, cOn.text_language]).toEqual([true, 'es']);
    const texts = async (t: string) => Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM world.outbox_text WHERE job_number = $1 AND kind = 'confirmation'`, [(await cust(t)).job_number]))[0]!.n);
    expect([await texts(none.bookingToken), await texts(off.bookingToken), await texts(on.bookingToken)]).toEqual([0, 0, 1]);
    const sum = (await json(await send('GET', `/public/bookings/${none.bookingToken}`))).data;
    expect([sum.textsOn, sum.confirmationText, sum.inboxUrl]).toEqual([false, null, null]);
  });

  // why: FR-TEXT-17 the customer's zone is the browser's zone (customerZoneFor), the branch's when the browser's is no IANA zone
  it("stores the browser's time zone, or the branch's when it is not a zone", async () => {
    const a = (await json(await book({ name: 'Halifax Visitor', mobile: null, timeZone: 'America/Halifax' }))).data;
    const b = (await json(await book({ name: 'Bad Zone', mobile: null, timeZone: 'Mars/Olympus', windowId: windowId('two_hour', '12:00') }))).data;
    const zone = async (t: string) => (await rows<{ zone: string }>('SELECT c.zone FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.booking_token = $1', [t]))[0]!.zone;
    expect([await zone(a.bookingToken), await zone(b.bookingToken)]).toEqual(['America/Halifax', 'America/New_York']);
  });

  // why: FR-BOOK-12 (F-1084, owner ruling Nov 8, "Branch zone") a visitor outside the branch's zone reads the visit's window in the branch's zone, in the booking answer and on the done page, as the calendar and the text tell it
  it("tells the visit's window in the branch's zone for a visitor in another zone", async () => {
    const booked = await json(await book({ name: 'Halifax Visitor Two', mobile: null, timeZone: 'America/Halifax' }));
    const a = booked.data;
    expect(a.visit.zone).toBe('America/New_York');
    expect(a.visit.window.start).toMatch(/^2026-09-17T10:00/);
    const sum = (await json(await send('GET', `/public/bookings/${a.bookingToken}`))).data;
    expect(sum.visit.zone).toBe('America/New_York');
    expect(sum.visit.window.start).toMatch(/^2026-09-17T10:00/);
  });

  // why: F-964 (FR-TEXT-17) a booking that reuses a customer and changes the zone moves the reminder of the customer's other visit, as a zone edit does
  it("moves the reminder of the customer's other visit when a reused customer's zone changes", async () => {
    const first = (await json(await book({ name: 'Zone Mover', mobile: '(614) 555-0177', timeZone: 'America/New_York', date: '2026-09-21' }))).data;
    const dueOf = async (token: string) => (await rows<{ due_at: Date }>(
      `SELECT e.due_at FROM world.scheduled_event e JOIN world.job j ON e.subject = j.job_number::text WHERE e.kind = 'text.reminder' AND e.state = 'due' AND j.booking_token = $1`, [token]))[0]?.due_at.toISOString();
    const before = await dueOf(first.bookingToken);
    expect(before).toBeDefined();
    expect((await book({ name: 'Zone Mover', mobile: '(614) 555-0177', timeZone: 'America/Los_Angeles', date: '2026-09-22', windowId: windowId('two_hour', '12:00') })).status).toBe(201);
    expect(await rows('SELECT 1 FROM world.customer WHERE name = $1', ['Zone Mover'])).toHaveLength(1);
    const after = await dueOf(first.bookingToken);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});

describe('the confirmation text (FR-TEXT-1; F-782, F-421)', () => {
  const textOf = async (token: string) => (await rows<Json>(
    `SELECT t.status, t.due_at, t.held_until, t.body, t.kind FROM world.outbox_text t JOIN world.job j ON j.job_number = t.job_number WHERE j.booking_token = $1 AND t.kind = 'confirmation'`, [token]))[0];

  // why: FR-TEXT-1 a booking at 10:00 AM EDT queues the confirmation in the booking's own transaction, due at once and not held; the reminder is planned with it
  it('queues the confirmation due at 10:00 AM EDT, not held, and plans the reminder', async () => {
    await clockAt('2026-09-15T14:00:00Z');
    const d = (await json(await book({ name: 'Ten Am', mobile: '614-555-0110', date: '2026-09-17' }))).data;
    const t = await textOf(d.bookingToken);
    expect([t.status, new Date(t.due_at).toISOString(), t.held_until]).toEqual(['queued', '2026-09-15T14:00:00.000Z', null]);
    expect(t.body).toContain('You');
    const sum = (await json(await send('GET', `/public/bookings/${d.bookingToken}`))).data;
    expect(sum.confirmationText.status).toBe('queued');
    expect(sum.confirmationText.to).toBe('+16145550110');
  });

  // why: FR-TEXT-1 a booking at 12:30 AM EDT falls in quiet hours: the confirmation is held until 8:00 AM EDT
  it('holds the confirmation of a 12:30 AM EDT booking until 8:00 AM EDT', async () => {
    await clockAt('2026-09-15T04:30:00Z');
    const d = (await json(await book({ name: 'Night Owl', mobile: '614-555-0111', date: '2026-09-17', windowId: windowId('two_hour', '12:00') }))).data;
    const t = await textOf(d.bookingToken);
    expect([t.status, new Date(t.held_until).toISOString()]).toEqual(['held', '2026-09-15T12:00:00.000Z']);
    const sum = (await json(await send('GET', `/public/bookings/${d.bookingToken}`))).data;
    expect([sum.confirmationText.status, sum.confirmationText.heldUntil]).toEqual(['held', '2026-09-15T08:00:00-04:00[America/New_York]']);
  });
});

describe('the last place (FR-BOOK-3)', () => {
  // why: FR-BOOK-3 a window that filled answers window_full with the 3 nearest open windows (same day first), writes nothing, and a full window is never offered
  it('answers window_full with the 3 nearest open windows, none of them the full one, and leaves no row', async () => {
    const win = windowId('two_hour', '12:00');
    await db.admin().query('UPDATE world.arrival_window SET capacity = 1 WHERE id = $1', [win]);
    expect((await book({ date: '2026-09-25', windowId: win, name: 'First Taker', mobile: null })).status).toBe(201);
    const jobs = Number((await rows<{ n: string }>('SELECT count(*) AS n FROM world.job'))[0]!.n);
    const r = await book({ date: '2026-09-25', windowId: win, name: 'Second Taker', mobile: null });
    expect(r.status).toBe(409);
    const p = await json(r);
    expect(p.code).toBe('window_full');
    expect(p.open).toHaveLength(3);
    expect(p.open.every((o: Json) => o.state === 'open' && !(o.date === '2026-09-25' && o.windowId === win))).toBe(true);
    expect(p.open[0].date).toBe('2026-09-25');
    expect(Number((await rows<{ n: string }>('SELECT count(*) AS n FROM world.job'))[0]!.n)).toBe(jobs);
    expect((await rows<{ n: string }>(`SELECT count(*) AS n FROM world.customer WHERE name = 'Second Taker'`))[0]!.n).toBe('0');
    await db.admin().query('UPDATE world.arrival_window SET capacity = 12 WHERE id = $1', [win]);
  });

  // why: FR-BOOK-3 2 concurrent online bookings for the last place: exactly 1 succeeds, the other is window_full (the lock is the office write's; G-CI3 holds the barrier races)
  it('lets exactly 1 of 2 concurrent bookings for the last place succeed', async () => {
    const win = windowId('two_hour', '14:00');
    await db.admin().query('UPDATE world.arrival_window SET capacity = 1 WHERE id = $1', [win]);
    const rs = await Promise.all([
      book({ date: '2026-09-28', windowId: win, name: 'Racer One', mobile: null }),
      book({ date: '2026-09-28', windowId: win, name: 'Racer Two', mobile: null }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await rows<{ n: string }>(`SELECT count(*) AS n FROM world.job WHERE date = '2026-09-28' AND window_id = $1`, [win]))[0]!.n).toBe('1');
    await db.admin().query('UPDATE world.arrival_window SET capacity = 12 WHERE id = $1', [win]);
  });
});
