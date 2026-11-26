// SPDX-License-Identifier: AGPL-3.0-or-later
// The arrival windows page's read and writes through the production kernel (FR-BOOK-2, FR-BOOK-8, FR-BOOK-17,
// FR-BOOK-18, UC-13): API-90 Booking settings, API-91 Set a day's mode and API-155 Set window capacities, called over the real handlers
// as a signed-in dispatcher or manager (the web process's login bw_web, the real session layer) on real PostgreSQL 18 with P2-SEED's
// reference seed (Columbus's 5 windows at 12, 12, 11, 11, 10, the peak days Wed Sep 16 and Fri Sep 18 switched by Dana Ruiz). Jobs are
// made by API-28, the real write. Run by gate G-CI7 (ci/gates/G-CI7/vitest.db.config.ts); the merge set excludes *.db.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { ORIGIN, caller, listen, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let dana: Staff;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 40);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
  dana = world.staff.dana;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const win = (key: string) => world.windows.get(key) as string;
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const nextCustomer = () => world.customers[customer++ % world.customers.length] as string;

async function put(path: string, body: unknown, who: Staff): Promise<{ status: number; json: Json }> {
  const res = await world.kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: who.cookie },
  }), { address: '203.0.113.9' });
  return { status: res.status, json: await res.json() };
}
const settings = async (from: string | null = '2026-09-14', to: string | null = '2026-09-27', who: Staff = keisha, branch = 'columbus') => {
  const r = await api.get(`/branches/${branch}/booking-settings${from === null ? '' : `?from=${from}&to=${to}`}`, who);
  return { status: r.status, json: (await r.json()) as Json };
};
const setMode = (date: string, mode: string, reason: string | undefined, who: Staff = dana) =>
  put(`/branches/columbus/days/${date}/mode`, reason === undefined ? { mode } : { mode, reason }, who);
const setLimits = (limits: { windowId: string; limit: number }[], who: Staff = keisha) => put('/branches/columbus/window-limits', { limits }, who);

async function book(date: string, window: string): Promise<number> {
  const r = await api.post('/jobs', {
    customerId: nextCustomer(), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: win(`two_hour ${window}`), technicianId: null,
  }, keisha);
  if (r.status !== 201) throw new Error(`create ${date} ${window} answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as Json).data.job.jobNumber;
}

describe('the booking settings read (API-90)', () => {
  // why: FR-BOOK-17 the Columbus page loads with 5 window numbers (12, 12, 11, 11, 10) in start order, the 2-hour windows only
  it('answers the 5 Columbus 2-hour windows with their limits in start order and today as Tue, Sep 15', async () => {
    const { status, json } = await settings();
    expect(status).toBe(200);
    expect(json.data.today).toBe('2026-09-15');
    expect(json.data.windows.map((w: Json) => [w.start, w.end, w.limit, w.bookedToday])).toEqual([
      ['08:00', '10:00', 12, 0], ['10:00', '12:00', 12, 0], ['12:00', '14:00', 11, 0], ['14:00', '16:00', 11, 0], ['16:00', '18:00', 10, 0],
    ]);
    expect(json.data.twoHourWindows).toHaveLength(5);
    expect(json.data.fourHourWindows).toEqual([{ start: '08:00', end: '12:00' }, { start: '10:00', end: '14:00' }, { start: '12:00', end: '16:00' }, { start: '14:00', end: '18:00' }]);
    expect(json.data.rules).toEqual({ onlineCutoff: '17:00', reminder: '18:00', quietFrom: '21:00', quietTo: '08:00', capacities: { twoHour: 5, fourHour: 6, saturday: 3 } });
  });

  // why: FR-BOOK-18 Wed Sep 16 and Fri Sep 18 are 4-hour days with the reason, who switched them and when; FR-BOOK-2 the 4 windows a peak day offers
  it('marks Sep 16 and Sep 18 as 4-hour days with the reason, the person and the time, and each day offers its own windows', async () => {
    const { json } = await settings();
    const days = json.data.days as Json[];
    expect(days.map((d) => d.date)).toEqual(Array.from({ length: 14 }, (_, i) => `2026-09-${String(14 + i).padStart(2, '0')}`));
    expect(days.map((d) => d.mode)).toEqual([
      'two_hour', 'two_hour', 'four_hour', 'two_hour', 'four_hour', 'two_hour', 'closed',
      'two_hour', 'two_hour', 'two_hour', 'two_hour', 'two_hour', 'two_hour', 'closed',
    ]);
    const wed = days[2];
    expect([wed.reason, wed.switchedBy, wed.switchedAt]).toEqual(['Heat advisory', 'Dana Ruiz', '2026-09-14T16:10:00-04:00[America/New_York]']);
    expect(wed.windows).toHaveLength(4);
    expect(days[3].windows).toHaveLength(5);
    // FR-BOOK-10: a Saturday is a half-day with its 2 morning windows and no 4-hour mode.
    expect(days[5].windows).toEqual([{ start: '08:00', end: '10:00' }, { start: '10:00', end: '12:00' }]);
    expect(days[6]).toMatchObject({ mode: 'closed', capacity: 0, windows: [] });
    expect([days[3].reason, days[3].switchedBy, days[3].switchedAt]).toEqual([null, null, null]);
  });

  // why: FR-DISP-23 the page's booked and capacity are the week board's own numbers for the same day (one capacity rule, SD-27)
  it('gives each day the booked and capacity numbers the week board gives it', async () => {
    await book('2026-09-17', '08:00');
    const mine = ((await settings('2026-09-14', '2026-09-19')).json.data.days as Json[]).map((d) => [d.date, d.booked, d.capacity]);
    const wk = ((await (await api.get('/board/week?branch=columbus&week=2026-09-14', keisha)).json()) as Json).data.days as Json[];
    expect(mine).toEqual(wk.map((d) => [d.date, d.booked, d.capacity]));
    expect(mine.find((d) => d[0] === '2026-09-17')![1]).toBe(1);
    // The dialog's "customers already booked" counts a customer once: the same customer booked twice that day is 2 jobs and 1 customer.
    const again = await api.post('/jobs', {
      customerId: (await rows<{ customer_id: string }>('SELECT customer_id FROM world.job WHERE branch_id = $1 AND date = $2 LIMIT 1', ['columbus', '2026-09-17']))[0]!.customer_id,
      serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-09-17', windowId: win('two_hour 12:00'), technicianId: null,
    }, keisha);
    expect(again.status, JSON.stringify(await again.clone().json())).toBe(201);
    const thu = (await settings('2026-09-17', '2026-09-17')).json.data.days[0];
    expect([thu.booked, thu.bookedCount]).toEqual([2, 1]);
  });

  // why: FR-BOOK-17 a range over 70 days or a malformed one is refused with validation_failed, an unknown branch with not_found
  it('refuses a range that ends before it starts or runs past 70 days, and a branch that does not exist', async () => {
    expect((await settings('2026-09-20', '2026-09-14')).status).toBe(422);
    expect((await settings('2026-09-14', '2026-12-31')).status).toBe(422);
    expect((await settings('2026-09-14', '2026-09-27', keisha, 'nowhere')).status).toBe(404);
    // With no range the answer is the 2 weeks the calendar draws: the week holding today (Tue, Sep 15) and the next.
    const dflt = (await settings(null)).json.data.days as Json[];
    expect([dflt.length, dflt[0].date, dflt[13].date]).toEqual([14, '2026-09-14', '2026-09-27']);
    expect((await api.get('/branches/columbus/booking-settings?from=2026-09-14', keisha)).status).toBe(422);
  });
});

describe('the day switch (API-91)', () => {
  // why: FR-BOOK-2 the office switches Thu Sep 17 to 4-hour windows and the week board then shows it as a peak day; FR-BOOK-18 it records the reason, the person and the time
  it('switches Thu, Sep 17 to 4-hour windows with a reason and records who and when, which the week board shows', async () => {
    const heard = await listen(db.url());
    const r = await setMode('2026-09-17', 'four_hour', '  Heat advisory, 94F forecast ');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.day).toMatchObject({
      date: '2026-09-17', mode: 'four_hour', reason: 'Heat advisory, 94F forecast', switchedBy: 'Dana Ruiz', switchedAt: '2026-09-15T07:00:00-04:00[America/New_York]',
    });
    expect(r.json.data.day.windows).toHaveLength(4);
    const wk = ((await (await api.get('/board/week?branch=columbus&week=2026-09-14', keisha)).json()) as Json).data.days as Json[];
    expect(wk.find((d) => d.date === '2026-09-17')).toMatchObject({ peak: true, reason: 'Heat advisory, 94F forecast', switchedBy: 'Dana Ruiz' });
    // EVT-09: the write publishes settings.changed (kind day_mode), so every open board and page re-reads.
    await heard.waitFor(1);
    expect(heard.notices.map((n) => [n.name, n.ids['kind']])).toContainEqual(['settings.changed', 'day_mode']);
    await heard.end();
  });

  // why: UC-13 + FR-BOOK-8 a 10 AM to 12 PM booking made on a 2-hour day still holds that window after the day switches, on the board and in its job record
  it('leaves a 10 AM-12 PM booking in its 2-hour window when its day is switched to 4-hour windows (UC-13)', async () => {
    const back = await setMode('2026-09-16', 'two_hour', undefined);
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expect(back.json.data.day).toMatchObject({ mode: 'two_hour', reason: null, switchedBy: null, switchedAt: null });
    const n = await book('2026-09-16', '10:00');
    const before = await rows<{ window_start: Date; window_end: Date; window_id: string }>('SELECT window_start, window_end, window_id FROM world.job WHERE job_number = $1', [n]);
    const sw = await setMode('2026-09-16', 'four_hour', 'Heat advisory');
    expect(sw.status).toBe(200);
    const after = await rows<{ window_start: Date; window_end: Date; window_id: string }>('SELECT window_start, window_end, window_id FROM world.job WHERE job_number = $1', [n]);
    expect(after).toEqual(before);
    const board = ((await (await api.get('/board?branch=columbus&date=2026-09-16', keisha)).json()) as Json).data;
    expect(board.dayMode).toBe('four_hour');
    const shown = [...board.technicians.flatMap((t: Json) => t.jobs), ...board.unassigned].find((j: Json) => j.jobNumber === n);
    expect(shown, 'the board shows the job').toBeTruthy();
    // The window the board shows is 10:00 to 12:00 branch time: 2 hours.
    expect(Date.parse(shown.window.end.replace(/\[.*$/, '')) - Date.parse(shown.window.start.replace(/\[.*$/, ''))).toBe(2 * 3_600_000);
    expect(shown.window.start).toMatch(/T10:00:00-04:00/);
    expect((await settings('2026-09-16', '2026-09-16')).json.data.days[0]).toMatchObject({ mode: 'four_hour', booked: 1, bookedCount: 1 });
  });

  // why: FR-BOOK-2 after a switch booking offers only the 4-hour windows (API-29) and refuses a 2-hour window (API-28, rule_refused) but takes a 4-hour one; a switch back offers the 2-hour windows again
  it('offers only the 4 windows after a switch and refuses a 2-hour booking, and offers the 5 again after a switch back', async () => {
    const date = '2026-09-25';
    const offered = async () => {
      const r = await api.get(`/availability?branch=columbus&serviceId=furnace_tune_up&from=${date}&to=${date}&channel=office`, keisha);
      const d = ((await r.json()) as Json).data.days[0];
      return [d.mode, d.windows.map((w: Json) => [w.start.slice(11, 16), w.end.slice(11, 16)])];
    };
    const place = (windowId: string) => api.post('/jobs', { customerId: nextCustomer(), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId, technicianId: null }, keisha);
    const two = [['08:00', '10:00'], ['10:00', '12:00'], ['12:00', '14:00'], ['14:00', '16:00'], ['16:00', '18:00']];
    expect(await offered()).toEqual(['two_hour', two]);
    expect((await setMode(date, 'four_hour', 'Heat advisory')).status).toBe(200);
    expect(await offered()).toEqual(['four_hour', [['08:00', '12:00'], ['10:00', '14:00'], ['12:00', '16:00'], ['14:00', '18:00']]]);
    const refused = await place(win('two_hour 10:00'));
    const p = (await refused.json()) as Json;
    expect([refused.status, p.code, p.key]).toEqual([409, 'rule_refused', 'rule.windowNotOffered']);
    expect((await place(win('four_hour 10:00'))).status).toBe(201);
    expect((await setMode(date, 'two_hour', undefined)).status).toBe(200);
    expect(await offered()).toEqual(['two_hour', two]);
  });

  // why: F-751 a customer booked into a 4-hour window after the switch is not one who keeps a 2-hour window: bookedCount counts 2-hour windows only
  it('counts only the customers booked in 2-hour windows after a switch', async () => {
    const date = '2026-10-02';
    const place = (windowId: string) => api.post('/jobs', { customerId: nextCustomer(), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId, technicianId: null }, keisha);
    const day = async () => (await settings(date, date)).json.data.days[0];
    expect((await place(win('two_hour 10:00'))).status).toBe(201);
    expect((await setMode(date, 'four_hour', 'Heat advisory')).status).toBe(200);
    expect((await place(win('four_hour 10:00'))).status).toBe(201);
    expect(await day()).toMatchObject({ booked: 2, bookedCount: 1 });
  });

  // why: FR-BOOK-2 a past day is day_past, a Sunday day_closed, a Saturday refuses 4-hour windows (rule_refused, X-2a), a 4-hour switch needs a reason (validation_failed)
  it('refuses the past, a Sunday, 4-hour windows on a Saturday and a switch with no reason', async () => {
    expect([(await setMode('2026-09-14', 'four_hour', 'x')).status, (await setMode('2026-09-14', 'four_hour', 'x')).json.code]).toEqual([409, 'day_past']);
    expect((await setMode('2026-09-20', 'four_hour', 'x')).json.code).toBe('day_closed');
    const sat = await setMode('2026-09-19', 'four_hour', 'x');
    expect([sat.status, sat.json.code, sat.json.key ?? sat.json.detail?.key]).toEqual([409, 'rule_refused', 'rule.saturdayHalfDay']);
    expect((await setMode('2026-09-22', 'four_hour', undefined)).status).toBe(422);
    expect((await setMode('2026-09-22', 'four_hour', '   ')).status).toBe(422);
    expect(await rows('SELECT 1 FROM world.day_mode WHERE date IN ($1, $2, $3)', ['2026-09-19', '2026-09-20', '2026-09-22'])).toEqual([]);
  });

  // why: FR-BOOK-2 a day that already uses 2-hour windows switched to 2-hour windows writes nothing (no row, no event)
  it('writes no row when a 2-hour day is switched to 2-hour windows', async () => {
    const r = await setMode('2026-09-23', 'two_hour', undefined);
    expect(r.status).toBe(200);
    expect(await rows('SELECT 1 FROM world.day_mode WHERE date = $1', ['2026-09-23'])).toEqual([]);
  });
});

describe('the window capacities (API-155)', () => {
  // why: FR-BOOK-17 the office changes a window's capacity and saves, booking then follows it (office create refuses the place past it); the other windows keep theirs
  it('saves a new capacity and then refuses the booking past it', async () => {
    const heard = await listen(db.url());
    const w = win('two_hour 16:00');
    const ok = await setLimits([{ windowId: w, limit: 2 }]);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.data.windows.map((x: Json) => x.limit)).toEqual([12, 12, 11, 11, 2]);
    await book('2026-09-22', '16:00');
    await book('2026-09-22', '16:00');
    const third = await api.post('/jobs', {
      customerId: nextCustomer(), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-09-22', windowId: w, technicianId: null,
    }, keisha);
    expect([third.status, ((await third.json()) as Json).code]).toEqual([409, 'window_full']);
    await heard.waitFor(1);
    expect(heard.notices.map((n) => [n.name, n.ids['kind']])).toContainEqual(['settings.changed', 'window_limits']);
    await heard.end();
  });

  // why: FR-BOOK-17 a capacity below a window's bookings on an upcoming day is refused with the window, the day and the count, and nothing in the same save is written
  it('refuses a capacity below the bookings, names the window, the day and the count, and writes none of the save', async () => {
    const w = win('two_hour 16:00');
    const other = win('two_hour 08:00');
    const r = await setLimits([{ windowId: other, limit: 7 }, { windowId: w, limit: 1 }]);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('capacity_below_bookings');
    expect(r.json).toMatchObject({ windowId: w, start: '16:00', end: '18:00', date: '2026-09-22', bookings: 2 });
    expect(await rows('SELECT capacity FROM world.arrival_window WHERE id = $1', [other])).toEqual([{ capacity: 12 }]);
    expect(await rows('SELECT capacity FROM world.arrival_window WHERE id = $1', [w])).toEqual([{ capacity: 2 }]);
    // A limit equal to the bookings is allowed.
    expect((await setLimits([{ windowId: w, limit: 2 }])).status).toBe(200);
  });

  // why: FR-BOOK-17 a past day's bookings do not hold a capacity up: only today and later count
  it('does not count the bookings of a day before today', async () => {
    // 2-4 PM: no earlier case books it, so the moved job is the window's only booking and nothing upcoming holds the limit up (F-747).
    const w = win('two_hour 14:00');
    const n = await book('2026-09-24', '14:00');
    await db.admin().query(`UPDATE world.job SET date = '2026-09-10', window_start = window_start - interval '14 days', window_end = window_end - interval '14 days' WHERE job_number = $1`, [n]);
    expect((await setLimits([{ windowId: w, limit: 0 }])).status).toBe(200);
    expect((await setLimits([{ windowId: w, limit: 11 }])).status).toBe(200);
  });

  // why: FR-BOOK-17 a 4-hour window has no limit and another branch's window or a repeated window is no save at all (validation_failed); a negative limit is not a whole number of at least 0
  it('refuses a 4-hour window, a repeated window, another branch\'s window and a negative or fractional limit', async () => {
    const four = win('four_hour 08:00');
    expect((await setLimits([{ windowId: four, limit: 3 }])).status).toBe(422);
    expect((await setLimits([{ windowId: win('two_hour 08:00'), limit: 3 }, { windowId: win('two_hour 08:00'), limit: 4 }])).status).toBe(422);
    const dayton = (await rows<{ id: string }>(`SELECT id FROM world.arrival_window WHERE branch_id = 'dayton' AND mode = 'two_hour' LIMIT 1`))[0]!.id;
    expect((await setLimits([{ windowId: dayton, limit: 3 }])).status).toBe(422);
    expect((await setLimits([{ windowId: win('two_hour 08:00'), limit: -1 }])).status).toBe(422);
    expect((await setLimits([{ windowId: win('two_hour 08:00'), limit: 2.5 }])).status).toBe(422);
  });

  // why: FR-BOOK-17 both writes and the read are for office people: a signed-out call is unauthenticated
  it('answers a call with no session as unauthenticated', async () => {
    const res = await world.kernel.router.handle(new Request('http://web:3000/api/v1/branches/columbus/booking-settings?from=2026-09-14&to=2026-09-15'), { address: '203.0.113.9' });
    expect(res.status).toBe(401);
  });
});
