// SPDX-License-Identifier: AGPL-3.0-or-later
// API-132 Board week (FR-DISP-23, UC-15; SPECIFICATIONS section 6.1 "Week board", SD-27) on the real database (PostgreSQL 18,
// the migrated schema, P2-SEED's reference seed: 12 Columbus technicians, the windows and the 2 sample peak days Wed Sep 16 and
// Fri Sep 18, "Heat advisory"), through the production kernel as the web process's login bw_web, with a dispatcher whose session
// the real session layer created. Jobs are created by API-28 (the real write) and 1 past one by SQL, since the clock stands
// on Tue, Sep 15, 7:00 AM and the write refuses a past day. Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 30);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

interface Cell { date: string; booked: number; capacity: number; installs: number; state: 'has_room' | 'full' | 'day_off' }
interface Week {
  branch: string; week: string; today: string;
  fourHourWindows: { start: string; end: string }[];
  days: { date: string; mode: string; booked: number; capacity: number; peak: boolean; openOnline: number; span: { start: string; end: string } | null; unassigned: number; reason: string | null; switchedBy: string | null; switchedAt: string | null }[];
  technicians: { id: string; name: string; van: string | null; primarySkill: string; installer: boolean; cells: Cell[] }[];
  unassigned: { date: string; count: number }[];
  unassignedJobs: { jobNumber: number; day: string; window: { start: string; end: string }; customer: string; area: string; service: string }[];
}

const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;
const nextCustomer = () => world.customers[customer++ % world.customers.length] as string;
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const week = async (w = '2026-09-14', who: Staff = keisha, branch = 'columbus'): Promise<Week> => {
  const r = await api.get(`/board/week?branch=${branch}&week=${w}`, who);
  if (r.status !== 200) throw new Error(`board week answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as { data: Week }).data;
};
async function book(date: string, window: string, technician: string | null, service = 'furnace_tune_up'): Promise<number> {
  const r = await api.post('/jobs', {
    customerId: nextCustomer(), serviceId: service, equipmentId: null, problem: null, date, windowId: win(window), technicianId: technician ? tech(technician) : null,
  }, keisha);
  if (r.status !== 201) throw new Error(`create ${date} ${window} ${technician} ${service} answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
}

describe('the week board read (API-132)', () => {
  // why: FR-DISP-23 the week of Sep 14 is Monday to Saturday, Wed and Fri are the peak days with who switched them and why, the others are 2-hour days
  it('answers Monday to Saturday of Sep 14 with Wed and Fri as peak days, their reason, who switched them and when', async () => {
    const w = await week();
    expect(w).toMatchObject({ branch: 'columbus', week: '2026-09-14', today: '2026-09-15' });
    expect(w.days.map((d) => d.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']);
    expect(w.days.map((d) => d.peak)).toEqual([false, false, true, false, true, false]);
    expect(w.days.map((d) => d.mode)).toEqual(['two_hour', 'two_hour', 'four_hour', 'two_hour', 'four_hour', 'two_hour']);
    expect(w.fourHourWindows).toEqual([{ start: '08:00', end: '12:00' }, { start: '10:00', end: '14:00' }, { start: '12:00', end: '16:00' }, { start: '14:00', end: '18:00' }]);
    for (const d of w.days.filter((x) => x.peak)) {
      expect(d.reason).toBe('Heat advisory');
      expect(d.switchedBy).toEqual(expect.any(String));
      expect(d.switchedAt).toBe('2026-09-14T16:10:00-04:00[America/New_York]');
    }
    for (const d of w.days.filter((x) => !x.peak)) expect([d.reason, d.switchedBy, d.switchedAt]).toEqual([null, null, null]);
  });

  // why: FR-DISP-23 a Saturday is a half-day with a span; FR-BOOK-5 a technician's capacity is 5, 6 or 3, an installer's 1; a day off is a day off
  it('gives each technician one cell per day with SD-27 capacity (5, 6 on a peak day, 3 on a Saturday, 1 for an installer) and Day off when they do not work', async () => {
    const w = await week();
    expect(w.technicians).toHaveLength(12);
    expect(w.technicians.map((t) => t.name.split(' ')[1])).toEqual(
      ['Bell', 'Carter', 'Doyle', 'Hoffman', 'Kowalski', 'Mitchell', 'Nguyen', 'Ortega', 'Reinhart', 'Santos', 'Schaefer', 'Yoder']);
    const ortega = w.technicians.find((t) => t.name === 'Luis Ortega')!;
    expect(ortega.van).toBe('18');
    expect(ortega.cells.map((c) => c.capacity)).toEqual([5, 5, 6, 5, 6, 3]); // works Saturdays that week
    expect(ortega.cells.map((c) => c.state)).toEqual(['has_room', 'has_room', 'has_room', 'has_room', 'has_room', 'has_room']);
    const bell = w.technicians.find((t) => t.name === 'Marcus Bell')!;
    expect(bell.cells[5]).toMatchObject({ capacity: 0, state: 'day_off' }); // no Saturdays
    const yoder = w.technicians.find((t) => t.name === 'Chris Yoder')!;
    expect(yoder.installer).toBe(true);
    expect(yoder.cells.map((c) => [c.capacity, c.state])).toEqual([[1, 'has_room'], [1, 'has_room'], [1, 'has_room'], [1, 'has_room'], [0, 'day_off'], [0, 'day_off']]);
    expect(w.days[5]).toMatchObject({ mode: 'two_hour', span: { start: '08:00', end: '12:00' } });
    expect(w.days[0]!.span).toBeNull();
    // a day's capacity is the sum of its cells
    w.days.forEach((d, i) => expect(d.capacity).toBe(w.technicians.reduce((n, t) => n + t.cells[i]!.capacity, 0)));
  });

  // why: FR-DISP-23 a cell's booked count equals that technician's live jobs that day; the Unassigned row, the totals and the unassigned list come from the same jobs
  it('counts each cell as the technician\'s live jobs that day, leaves canceled jobs out, and totals the Unassigned jobs as booked', async () => {
    const o = 'Luis Ortega';
    await book('2026-09-16', 'four_hour 08:00', o);
    await book('2026-09-16', 'four_hour 10:00', o);
    const gone = await book('2026-09-16', 'four_hour 12:00', o);
    await book('2026-09-17', 'two_hour 08:00', o);
    await book('2026-09-17', 'two_hour 08:00', null, 'water_heater');
    await book('2026-09-19', 'two_hour 08:00', o);
    await db.admin().query(`UPDATE world.job SET status = 'canceled' WHERE job_number = $1`, [gone]);
    // a past job (Monday), by SQL
    await db.admin().query(
      `INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, technician_id, status, version,
                              expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
       VALUES ($1, 'columbus', 'furnace_tune_up', '2026-09-14', 'America/New_York', $2, '2026-09-14T08:00:00-04:00', '2026-09-14T10:00:00-04:00', $3,
               'done', 1, 60, 'office', '2026-09-10T12:00:00Z', 'not_sent', false, false, false)`, [nextCustomer(), win('two_hour 08:00'), tech(o)]);

    const w = await week();
    const ortega = w.technicians.find((t) => t.name === o)!;
    expect(ortega.cells.map((c) => c.booked)).toEqual([1, 0, 2, 1, 0, 1]);
    // the API count of every cell equals the database's own count of that technician's live jobs that day
    const counted = await rows<{ technician_id: string; date: string; n: string }>(
      `SELECT technician_id, date::text AS date, count(*) AS n FROM world.job
        WHERE branch_id = 'columbus' AND status <> 'canceled' AND technician_id IS NOT NULL AND date BETWEEN '2026-09-14' AND '2026-09-19'
        GROUP BY 1, 2`);
    for (const t of w.technicians) {
      for (const c of t.cells) {
        const want = counted.find((x) => x.technician_id === t.id && x.date === c.date);
        expect([t.name, c.date, c.booked]).toEqual([t.name, c.date, Number(want?.n ?? 0)]);
      }
    }
    // Unassigned: Thu has 1, and it counts as booked in Thu's total
    expect(w.unassigned).toEqual([0, 0, 0, 1, 0, 0].map((count, i) => ({ date: w.days[i]!.date, count })));
    const booked = (i: number) => w.technicians.reduce((n, t) => n + t.cells[i]!.booked, 0);
    expect(w.days.map((d, i) => d.booked - d.unassigned - booked(i))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(w.days[3]!.booked).toBe(booked(3) + 1);
    expect(w.unassignedJobs).toHaveLength(1);
    expect(w.unassignedJobs[0]).toMatchObject({ day: '2026-09-17', service: 'water_heater', customer: expect.any(String), area: expect.any(String) });
    expect(w.unassignedJobs[0]!.window.start).toMatch(/^2026-09-17T08:00:00-04:00\[America\/New_York\]$/);
  });

  // why: FR-DISP-23 a cell is full at its capacity and an installer's day with an install job reads as one install; FR-BOOK-5
  it('marks a cell Full at its capacity and counts an installer\'s install jobs', async () => {
    const o = 'Ashley Nguyen';
    for (const window of ['four_hour 08:00', 'four_hour 08:00', 'four_hour 08:00', 'four_hour 10:00', 'four_hour 10:00', 'four_hour 10:00']) await book('2026-09-18', window, o);
    await book('2026-09-15', 'two_hour 12:00', 'Chris Yoder', 'sump_pump_install');
    const w = await week();
    const yoder = w.technicians.find((t) => t.name === 'Chris Yoder')!;
    expect(yoder.cells[1]).toMatchObject({ booked: 1, capacity: 1, installs: 1, state: 'full' });
    expect(w.technicians.find((t) => t.name === o)!.cells[4]).toMatchObject({ booked: 6, capacity: 6, state: 'full' });
  });

  // why: FR-DISP-23 openOnline is what the booking site still accepts: 0 on today and past days, else dayRoom (FR-BOOK-9, SD-27)
  it('answers openOnline 0 for past days and today, and the working non-installers\' room for a later day', async () => {
    const w = await week();
    expect(w.days[0]!.openOnline).toBe(0);
    expect(w.days[1]!.openOnline).toBe(0); // the online channel never offers today
    const wed = w.days[2]!;
    // Wed, a 4-hour day: 11 non-installers x 6 minus the live non-install jobs that day
    const jobs = w.technicians.reduce((n, t) => n + t.cells[2]!.booked, 0) + wed.unassigned;
    expect(wed.openOnline).toBe(11 * 6 - jobs);
    expect(w.days[5]!.openOnline).toBeLessThanOrEqual(w.days[5]!.capacity);
  });

  // why: FR-DISP-23 every call needs a signed-in office user; the week names a Monday and a branch that exists
  it('refuses a signed-out caller, a week that is not a Monday and an unknown branch', async () => {
    const out = await world.kernel.router.handle(new Request('http://web:3000/api/v1/board/week?branch=columbus&week=2026-09-14'), { address: '203.0.113.9' });
    expect(out.status).toBe(401);
    const notMonday = await api.get('/board/week?branch=columbus&week=2026-09-15', keisha);
    expect(notMonday.status).toBe(422);
    expect(((await notMonday.json()) as { code: string }).code).toBe('validation_failed');
    const unknown = await api.get('/board/week?branch=nowhere&week=2026-09-14', keisha);
    expect(unknown.status).toBe(404);
  });
});
