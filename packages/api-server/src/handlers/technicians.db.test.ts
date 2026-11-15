// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-33, FR-TEXT-11, FR-AUTH-12 (the Technicians page's calls API-31, API-32, API-33, API-147, API-148 and API-169, P4-TECHNICIANS)
// The Technicians page's calls (SPECIFICATIONS FR-DISP-33, FR-TEXT-11, SD-28, SD-29, OI-44) on the real database (PostgreSQL 18, the migrated
// schema, P2-SEED's reference seed: 12 Columbus technicians), through the production kernel as the web process's login bw_web with the
// dispatcher's and the manager's real sessions. Jobs are made by API-28 (the real write); the clock stands on Tue, Sep 15, 7:00 AM. Run by
// gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { inTransaction } from '@bw/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { realNow } from '@bw/time';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import { lockTechnicianDays } from '../office-writes/locks.ts';
import { caller, listen, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 40);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

interface Row {
  id: string; name: string; phone: string; van: { id: string; number: string } | null; skills: string[]; workingHours: { start: string; end: string }; workingDays: number[];
  saturdays: string; todayLoad: number; capacity: number; workingToday: boolean; nameInTexts: string; since: number;
  rightNow: { status: string; timing: string | null; jobNumber: number | null; customerName: string | null } | null;
  timeOff: { id: string; from: string; to: string; note: string | null }[]; userStatus: string;
  apps: { web: { lastSyncAt: string; waitingCount: number; device: string; version: string } | null; native: unknown }; employeeNumber: string | null; branch: string;
}
interface List { branch: string; today: string; technicians: Row[]; vans: { id: string; number: string }[]; skills: string[]; saturdayHours: { start: string; end: string } | null }

const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;
const nextCustomer = () => world.customers[customer++ % world.customers.length] as string;
const sql = async <T>(text: string, params: unknown[] = []) => (await db.admin().query<T>(text, params)).rows;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test answers are read by field, as the sibling db tests do
const json = async (r: Response) => (await r.json()) as { data?: any; code?: string; [k: string]: unknown };
const list = async (branch = 'columbus'): Promise<List> => {
  const r = await api.get(`/technicians?branch=${branch}`, keisha);
  if (r.status !== 200) throw new Error(`technician list answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return (await json(r)).data;
};
const rowOf = async (name: string): Promise<Row> => (await list()).technicians.find((t) => t.name === name) as Row;
/** Lock waits on an advisory lock right now: a write stopped at a technician-day. */
const advisoryWaiters = async () => Number((await sql<{ n: string }>(
  `SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`))[0]?.n);
async function until(what: string, cond: () => Promise<boolean>, tries = 400): Promise<void> {
  for (let i = 0; !(await cond()); i++) {
    if (i >= tries) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function book(date: string, window: string, technician: string): Promise<number> {
  const r = await api.post('/jobs', { customerId: nextCustomer(), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: win(window), technicianId: tech(technician) }, keisha);
  if (r.status !== 201) throw new Error(`create ${date} ${window} answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return (await json(r)).data.job.jobNumber;
}

describe('the technician list (API-31)', () => {
  // why: FR-DISP-33 each technician's van, skills, branch, hours, load, since year, user status and last app report come from stored rows
  it('lists the 12 Columbus technicians with their van, skills, hours, since year, user status and the reports the apps sent', async () => {
    await sql(
      `INSERT INTO world.app_sync_report (technician_id, app, last_sync_real, waiting_count, device, version, reported_at)
       VALUES ($1, 'web', '2026-09-15T10:19:00-04:00', 2, 'Safari on iPhone', '1.0.1', '2026-09-15T10:19:30-04:00')`, [tech('Kevin Doyle')]);
    const l = await list();
    expect(l.branch).toBe('columbus');
    expect(l.today).toBe('2026-09-15');
    expect(l.technicians).toHaveLength(12);
    // the frame's order: by the last word of the name
    expect(l.technicians.map((t) => t.name.split(' ').at(-1))).toEqual([...l.technicians.map((t) => t.name.split(' ').at(-1) as string)].sort((a, b) => a.localeCompare(b)));
    const maria = l.technicians.find((t) => t.name === 'Maria Santos') as Row;
    expect(maria.since).toBe(2016);
    expect(maria.userStatus).toBe('active');
    expect(maria.skills.length).toBeGreaterThan(0);
    expect(maria.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(maria.workingHours.start).toMatch(/^\d\d:\d\d$/);
    expect(maria.van?.number).toBeTruthy();
    expect(l.vans.length).toBeGreaterThan(11);
    expect(l.skills).toEqual(['heating_cooling', 'plumbing', 'install']);
    expect(l.saturdayHours).toEqual({ start: '08:00', end: '12:00' });
    const doyle = l.technicians.find((t) => t.name === 'Kevin Doyle') as Row;
    expect(doyle.apps.web).toMatchObject({ waitingCount: 2, device: 'Safari on iPhone', version: '1.0.1' });
    expect(doyle.apps.web?.lastSyncAt).toMatch(/^2026-09-15T10:19:00-04:00\[America\/New_York\]$/);
    expect(doyle.apps.native).toBeNull();
  });

  // why: FR-DISP-33 today's load counts the day's live jobs against the day's capacity, and Right now follows the technician's job in status
  it('counts today\'s load and says what each technician is doing right now', async () => {
    const before = await rowOf('Luis Ortega');
    expect(before.todayLoad).toBe(0);
    const j1 = await book('2026-09-15', 'two_hour 08:00', 'Luis Ortega');
    await book('2026-09-15', 'two_hour 14:00', 'Luis Ortega');
    const cancel = await book('2026-09-15', 'two_hour 16:00', 'Luis Ortega');
    await sql(`UPDATE world.job SET status = 'canceled' WHERE job_number = $1`, [cancel]);
    const scheduled = await rowOf('Luis Ortega');
    expect([scheduled.todayLoad, scheduled.capacity]).toEqual([2, 5]);
    expect(scheduled.workingToday).toBe(true);
    expect(scheduled.rightNow).toMatchObject({ status: 'between_jobs', jobNumber: null });
    await sql(`UPDATE world.job SET status = 'on_the_way', on_the_way_at = '2026-09-15T07:00:00-04:00' WHERE job_number = $1`, [j1]);
    const way = await rowOf('Luis Ortega');
    expect(way.rightNow).toMatchObject({ status: 'on_the_way', jobNumber: j1 });
    expect(way.rightNow?.customerName).toBeTruthy();
    // a technician with no job today has no chip
    expect((await rowOf('Marcus Bell')).rightNow).toBeNull();
  });
});

describe('the name in texts (API-32, API-33; FR-TEXT-11)', () => {
  // why: FR-TEXT-11 a name with a character outside the standard text set is named with the character, and a name that fits says so
  it('checks a name as typed: Ramón is refused naming the ó, Ramon fits', async () => {
    const bad = (await json(await api.post('/text-checks', { slot: 'technician', value: 'Ramón' }, keisha))).data;
    expect(bad).toMatchObject({ ok: false, problem: 'not_gsm7_basic', characters: ['ó'], length: 5, maximum: 10 });
    const good = (await json(await api.post('/text-checks', { slot: 'technician', value: 'Ramon' }, keisha))).data;
    expect(good).toMatchObject({ ok: true, problem: 'none', characters: [] });
    const long = (await json(await api.post('/text-checks', { slot: 'technician', value: 'Bartholomew1' }, keisha))).data;
    expect(long).toMatchObject({ ok: false, problem: 'too_long' });
  });

  // why: FR-TEXT-11 a name in texts that breaks 1 message is never saved: API-33 refuses it with the reason and the stored name stays
  it('refuses to save a name that breaks 1 message, with the reason, and saves one that fits', async () => {
    const id = tech('Maria Santos');
    const stored = (await sql<{ name_in_texts: string }>('SELECT name_in_texts FROM world.technician WHERE id = $1', [id]))[0]!.name_in_texts;
    const refused = await api.patch(`/technicians/${id}`, { nameInTexts: 'Mar\u00eda' }, keisha);
    expect(refused.status).toBe(422);
    const body = await json(refused);
    expect(body.code).toBe('text_value_breaks_limit');
    expect(body).toMatchObject({ problem: 'not_gsm7_basic', chars: ['í'], length: 5, limit: 10 });
    expect((await sql<{ name_in_texts: string }>('SELECT name_in_texts FROM world.technician WHERE id = $1', [id]))[0]!.name_in_texts).toBe(stored);
    const ok = await api.patch(`/technicians/${id}`, { nameInTexts: 'Maria S' }, keisha);
    expect(ok.status).toBe(200);
    expect((await json(ok)).data.technician.nameInTexts).toBe('Maria S');
    expect((await sql<{ name_in_texts: string }>('SELECT name_in_texts FROM world.technician WHERE id = $1', [id]))[0]!.name_in_texts).toBe('Maria S');
  });

  // why: FR-DISP-33 API-33 saves the van, the skills and the hours, and a van of another branch is refused
  it('saves a van, skills and hours, and refuses a van that is not the branch\'s', async () => {
    const id = tech('Dave Kowalski');
    const vans = (await list()).vans;
    const had = (await rowOf('Dave Kowalski')).van?.id;
    const other = vans.find((v) => v.id !== had) as { id: string };
    const r = await api.patch(`/technicians/${id}`, { vanId: other.id, skills: ['heating_cooling', 'plumbing'], workingHours: { start: '07:30', end: '18:00', days: [1, 2, 3, 4], saturdays: 'even_weeks' } }, keisha);
    expect(r.status).toBe(200);
    const t = (await json(r)).data.technician as Row;
    expect(t.van?.id).toBe(other.id);
    expect(t.skills).toEqual(['heating_cooling', 'plumbing']);
    expect([t.workingHours, t.workingDays, t.saturdays]).toEqual([{ start: '07:30', end: '18:00' }, [1, 2, 3, 4], 'even_weeks']);
    const dayton = await sql<{ id: string }>(`SELECT id FROM world.van WHERE branch_id <> 'columbus' LIMIT 1`);
    if (dayton[0]) expect((await api.patch(`/technicians/${id}`, { vanId: dayton[0].id }, keisha)).status).toBe(422);
    expect((await api.patch(`/technicians/${id}`, { vanId: null }, keisha)).status).toBe(200);
    expect((await rowOf('Dave Kowalski')).van).toBeNull();
    expect((await api.patch('/technicians/00000000-0000-7000-8000-000000000000', { vanId: null }, keisha)).status).toBe(404);
  });

  // why: F-769 (NFR-01: a board change shows within 5 seconds) a van, a skill, a time off with no jobs and its removal each tell an open board of the branch
  it('tells an open board of the branch after a van, skills, a time off with no jobs, its removal and a new technician', async () => {
    const id = tech('Dave Kowalski');
    const had = (await rowOf('Dave Kowalski')).van?.id;
    const other = (await list()).vans.find((v) => v.id !== had) as { id: string };
    const bus = await listen(db.url());
    const refreshes = () => bus.notices.filter((n) => n.name === 'board.refresh' && n.ids.branch === 'columbus').length;
    try {
      expect((await api.patch(`/technicians/${id}`, { vanId: other.id }, keisha)).status).toBe(200);
      await bus.waitFor(1);
      expect(refreshes()).toBe(1);
      expect((await api.patch(`/technicians/${id}`, { skills: ['heating_cooling'] }, keisha)).status).toBe(200);
      await bus.waitFor(2);
      expect(refreshes()).toBe(2);
      const off = await api.post(`/technicians/${id}/time-off`, { from: '2026-12-14', to: '2026-12-14', note: null }, keisha);
      expect(off.status).toBe(201);
      await bus.waitFor(3);
      expect(refreshes()).toBe(3);
      expect((await api.del(`/technicians/${id}/time-off/${(await json(off)).data.timeOffId}`, keisha)).status).toBe(204);
      await bus.waitFor(4);
      expect(refreshes()).toBe(4);
      const body = { name: 'Nina Event', email: 'nevent@brightwaterair.example', branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' } };
      expect((await api.post('/technicians', body, keisha)).status).toBe(201);
      await bus.waitFor(5);
      expect(refreshes()).toBe(5);
    } finally {
      await bus.end();
    }
  });
});

describe('add a technician (API-147; SD-29)', () => {
  // why: FR-AUTH-12 Add technician creates an Invited technician with the next employee number, 1 invite email and a one-time link, and the board's list holds them
  it('adds an Invited technician with an employee number, an invite and a one-time link, and refuses an address already a user', async () => {
    const body = { name: 'Derek Lindgren', email: 'dlindgren@brightwaterair.example', branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' } };
    const r = await api.post('/technicians', body, keisha);
    expect(r.status).toBe(201);
    const d = (await json(r)).data;
    expect(d.user).toMatchObject({ email: body.email, status: 'invited', role: 'technician' });
    expect(d.emailLink).toMatch(/^\/email\/[A-Za-z0-9_-]+$/);
    expect(d.technician).toMatchObject({ name: 'Derek Lindgren', userStatus: 'invited', skills: ['plumbing'], nameInTexts: 'Derek', since: 2026, van: null });
    expect(d.technician.phone).toMatch(/^\(614\) 555-01(4\d|[5-9]\d)$/);
    const u = (await sql<{ role: string; status: string; employee_number: string | null }>('SELECT role, status, employee_number FROM world."user" WHERE email = $1', [body.email]))[0]!;
    expect(u).toMatchObject({ role: 'technician', status: 'invited' });
    expect(u.employee_number).toMatch(/^\d{5}$/);
    expect(await sql('SELECT 1 FROM world.email_message WHERE to_address = $1 AND kind = \'invite\'', [body.email])).toHaveLength(1);
    expect((await list()).technicians.map((t) => t.name)).toContain('Derek Lindgren');
    const again = await api.post('/technicians', body, keisha);
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe('already_a_user');
  });

  // why: F-767 the writers stored technician.skills without the primary skill (a 1-skill technician stored {}); the seed stores it with
  it('stores the primary skill in technician.skills on add and on edit, as the seed does', async () => {
    const body = { name: 'Ola Stored', email: 'ostored@brightwaterair.example', branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' } };
    const r = await api.post('/technicians', body, keisha);
    expect(r.status).toBe(201);
    const id = (await json(r)).data.technician.id as string;
    const stored = async () => (await sql<{ primary_skill: string; skills: string[] }>('SELECT primary_skill, skills FROM world.technician WHERE id = $1', [id]))[0]!;
    expect(await stored()).toEqual({ primary_skill: 'plumbing', skills: ['plumbing'] });
    expect((await api.patch(`/technicians/${id}`, { skills: ['install', 'plumbing'] }, keisha)).status).toBe(200);
    expect(await stored()).toEqual({ primary_skill: 'plumbing', skills: ['plumbing', 'install'] });
    expect((await api.patch(`/technicians/${id}`, { skills: ['install'] }, keisha)).status).toBe(200);
    expect(await stored()).toEqual({ primary_skill: 'install', skills: ['install'] });
  });

  // why: F-765 2 adds at once took the same phone (5 of 5 rounds), and 2 adds of 1 address answered 500 for the loser
  it('gives 2 simultaneous adds 2 phones, and answers the loser of a same-address race already_a_user', async () => {
    const mk = (name: string, email: string) => ({ name, email, branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' } });
    const two = await Promise.all([api.post('/technicians', mk('Race One', 'race1@brightwaterair.example'), keisha), api.post('/technicians', mk('Race Two', 'race2@brightwaterair.example'), keisha)]);
    expect(two.map((r) => r.status)).toEqual([201, 201]);
    const phones = (await Promise.all(two.map(async (r) => (await json(r)).data.technician.phone as string)));
    expect(new Set(phones).size).toBe(2);
    const same = await Promise.all([api.post('/technicians', mk('Race Three', 'race3@brightwaterair.example'), keisha), api.post('/technicians', mk('Race Three', 'race3@brightwaterair.example'), keisha)]);
    expect(same.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  // why: F-766 an hour past 23, a NUL in the name and a NUL in a time off note answered 500: they are validation_failed
  it('answers validation_failed to 25:00, a NUL in a name and a NUL in a note', async () => {
    const hours = { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' };
    const body = { name: 'Pat Nul', email: 'pnul@brightwaterair.example', branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: hours };
    expect((await api.post('/technicians', { ...body, workingHours: { ...hours, end: '25:00' } }, keisha)).status).toBe(422);
    expect((await api.post('/technicians', { ...body, name: 'Pat\u0000 Nul' }, keisha)).status).toBe(422);
    const id = tech('Dave Kowalski');
    expect((await api.patch(`/technicians/${id}`, { workingHours: { ...hours, end: '25:00' } }, keisha)).status).toBe(422);
    expect((await api.post(`/technicians/${id}/time-off`, { from: '2026-10-05', to: '2026-10-05', note: 'Den\u0000tist' }, keisha)).status).toBe(422);
    expect((await api.post(`/technicians/${id}/time-off`, { from: '2026-02-30', to: '2026-03-01', note: null }, keisha)).status).toBe(422);
  });
});

describe('booking and the suggestions around a time off span (API-148, API-169; FR-DISP-28)', () => {
  const day = '2026-09-17';
  const room = async () => {
    const q = new URLSearchParams({ branch: 'columbus', date: day, windowId: win('two_hour 10:00'), serviceId: 'water_heater', customerId: nextCustomer() });
    const r = await api.get(`/technicians/room?${q}`, keisha);
    expect(r.status).toBe(200);
    return (await json(r)).data.technicians as { name: string; room: boolean; suggested: boolean }[];
  };
  const cell = async () => {
    const r = await api.get('/board/week?branch=columbus&week=2026-09-14', keisha);
    expect(r.status).toBe(200);
    const row = (await json(r)).data.technicians.find((d: { name: string }) => d.name === 'Kevin Doyle');
    return (row.cells as { date: string; state: string }[]).find((c) => c.date === day)?.state;
  };
  const place = () => api.post('/jobs', { customerId: nextCustomer(), serviceId: 'water_heater', equipmentId: null, problem: null, date: day, windowId: win('two_hour 10:00'), technicianId: tech('Kevin Doyle') }, keisha);

  // why: FR-DISP-33 Kevin Doyle's Sep 17 time off through API-148: booking gives him no room, the FR-DISP-28 suggestions leave him out and the week board shows him off
  // why: FR-DISP-33 removing Kevin's Sep 17 time off gives him his room back in booking and the FR-DISP-28 suggestions and the week board no longer shows him off
  it('takes Kevin Doyle off booking, the suggestions and the week for Sep 17, and Remove gives all 3 back', async () => {
    expect((await room()).find((t) => t.name === 'Kevin Doyle')).toMatchObject({ room: true, suggested: true });
    expect(await cell()).toBe('has_room');

    const off = await api.post(`/technicians/${tech('Kevin Doyle')}/time-off`, { from: day, to: day, note: null }, keisha);
    expect(off.status).toBe(201);
    const refused = await place();
    expect(refused.status).toBe(409);
    expect((await json(refused)).code).toBe('rule_refused');
    expect((await room()).find((t) => t.name === 'Kevin Doyle')).toBeUndefined();
    expect(await cell()).toBe('day_off');

    expect((await api.del(`/technicians/${tech('Kevin Doyle')}/time-off/${(await json(off)).data.timeOffId}`, keisha)).status).toBe(204);
    expect((await room()).find((t) => t.name === 'Kevin Doyle')).toMatchObject({ room: true, suggested: true });
    expect(await cell()).toBe('has_room');
    expect((await place()).status).toBe(201);
  });
});

describe('an hours edit settles the technician\'s days (API-33; F-764)', () => {
  const week = (over: Partial<{ start: string; end: string; days: number[]; saturdays: string }> = {}) => ({ start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none', ...over });
  const edit = (name: string, w: ReturnType<typeof week>) => api.patch(`/technicians/${tech(name)}`, { workingHours: w }, keisha);
  /** What the board reads for a job: the planned arrival a person sees, as a local clock time. */
  const shown = async (date: string, job: number): Promise<string | null> => {
    const r = await api.get(`/board?branch=columbus&date=${date}`, keisha);
    expect(r.status).toBe(200);
    const d = (await json(r)).data;
    const j = (d.technicians.flatMap((t: { jobs: unknown[] }) => t.jobs) as { jobNumber: number; plannedArrival: string | null }[]).find((x) => x.jobNumber === job);
    return j?.plannedArrival?.slice(11, 16) ?? null;
  };
  const jobRow = async (job: number) => (await sql<{ technician_id: string | null; version: number; planned_arrival: Date | null }>(
    'SELECT technician_id, version, planned_arrival FROM world.job WHERE job_number = $1', [job]))[0]!;

  // why: F-764 a start moved through API-33 moves the planned arrival the board shows from today on, a derived write: no version, no job_change row, a past day's plan kept, 1 event for an open board, and the same edit again adds nothing
  it('moves the planned arrivals of today and later, keeps a past day, tells an open board, and a replay changes nothing', async () => {
    const name = 'Luis Ortega';
    const future = await book('2026-09-22', 'two_hour 08:00', name);
    const past = await book('2026-09-23', 'two_hour 08:00', name);
    await sql(`UPDATE world.job SET date = '2026-09-14', planned_arrival = '2026-09-14T12:06:00Z' WHERE job_number = $1`, [past]);
    const was = await shown('2026-09-22', future);
    expect(was).toMatch(/^08:/);
    const before = await jobRow(future);
    const changes = await sql('SELECT 1 FROM world.job_change WHERE job_number = $1', [future]);

    const bus = await listen(db.url());
    try {
      const r = await edit(name, week({ start: '09:30' }));
      expect(r.status).toBe(200);
      expect((await json(r)).data.offDayJobs).toEqual([]);
      expect((await shown('2026-09-22', future))! >= '09:30').toBe(true);
      await bus.waitFor(1);
      // why: F-822 1 board.refresh for the branch, no job.changed for any job: a job page answers job.changed with a toast about a change it does not show
      expect(bus.notices.filter((n) => n.name === 'board.refresh')).toHaveLength(1);
      expect(bus.notices.find((n) => n.name === 'board.refresh')?.ids.branch).toBe('columbus');
      expect(bus.notices.filter((n) => n.name === 'job.changed')).toEqual([]);
      expect(bus.notices.filter((n) => n.ids.jobNumber === past)).toEqual([]);
      const after = await jobRow(future);
      expect(after.version).toBe(before.version);
      expect(await sql('SELECT 1 FROM world.job_change WHERE job_number = $1', [future])).toHaveLength(changes.length);
      expect((await jobRow(past)).planned_arrival?.toISOString()).toBe('2026-09-14T12:06:00.000Z');

      // the same edit again: same row, same plan, nothing published
      const heard = bus.notices.length;
      const again = await edit(name, week({ start: '09:30' }));
      expect(again.status).toBe(200);
      await new Promise((r2) => setTimeout(r2, 150));
      expect(bus.notices.length).toBe(heard);
      expect((await jobRow(future)).planned_arrival).toEqual(after.planned_arrival);
    } finally {
      await bus.end();
      await edit(name, week());
    }
  });

  // why: F-794 (owner ruling c9f57035, "Unassign it"): a scheduled job on a weekday just removed comes off the technician as time off does (version + 1, a history row, Unassigned); the answer names it, a job on the way stays, and a replay names nothing
  it('unassigns a scheduled job on a weekday just removed, names it, keeps a job on the way, and names nothing on a replay', async () => {
    const name = 'Ryan Mitchell';
    const monday = await book('2026-09-21', 'two_hour 08:00', name);
    const tuesday = await book('2026-09-22', 'two_hour 08:00', name);
    const going = await book('2026-09-28', 'two_hour 08:00', name);
    await sql(`UPDATE world.job SET status = 'on_the_way' WHERE job_number = $1`, [going]);
    const before = await jobRow(monday);
    const w = week({ days: [2, 3, 4, 5] });
    const r = await edit(name, w);
    expect(r.status).toBe(200);
    const named = (await json(r)).data.offDayJobs as { jobNumber: number; date: string; window: { start: string; end: string } }[];
    expect(named.map((j) => [j.jobNumber, j.date])).toEqual([[monday, '2026-09-21']]);
    expect(named[0]!.window.start).toContain('2026-09-21T10:00:00-04:00'.slice(0, 10));
    expect(await jobRow(monday)).toMatchObject({ technician_id: null, planned_arrival: null, version: before.version + 1 });
    expect(await sql(`SELECT kind, from_version, to_version FROM world.job_change WHERE job_number = $1 AND kind = 'assigned'`, [monday])).toEqual([{ kind: 'assigned', from_version: before.version, to_version: before.version + 1 }]);
    expect((await jobRow(tuesday)).technician_id).toBe(tech(name));
    expect((await jobRow(going)).technician_id).toBe(tech(name));
    const again = await edit(name, w);
    expect((await json(again)).data.offDayJobs).toEqual([]);
    // a Saturday pattern taken away unassigns its job too
    expect((await edit(name, week({ days: [1, 2, 3, 4, 5], saturdays: 'even_weeks' }))).status).toBe(200);
    const saturday = await book('2026-09-19', 'two_hour 08:00', name);
    const none = await edit(name, week());
    expect(((await json(none)).data.offDayJobs as { jobNumber: number }[]).map((j) => j.jobNumber)).toEqual([saturday]);
    expect((await jobRow(saturday)).technician_id).toBeNull();
  });

  // why: F-764 an hours edit holds the technician row without blocking a job write under a day lock: FOR UPDATE here deadlocks, FOR KEY SHARE from the job's technician reference against the edit's wait for the day
  it('finishes beside a write that holds a day and then sets a job\'s technician, with no deadlock', async () => {
    const name = 'Tom Reinhart';
    const made = await api.post('/jobs', { customerId: nextCustomer(), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-09-24', windowId: win('two_hour 08:00'), technicianId: null }, keisha);
    expect(made.status).toBe(201);
    const job = (await json(made)).data.job.jobNumber as number;
    let answered: Promise<Response> | null = null;
    await inTransaction(world.web, async (tx) => {
      await lockTechnicianDays(tx, [{ technicianId: tech(name), date: '2026-09-24' }]);
      answered = edit(name, week({ start: '09:00' }));
      await until('the edit to wait for the day', async () => (await advisoryWaiters()) >= 1);
      await tx.query('UPDATE world.job SET technician_id = $2 WHERE job_number = $1', [job, tech(name)]);
    });
    expect((await answered!).status).toBe(200);
    expect((await shown('2026-09-24', job))! >= '09:00').toBe(true);
    await edit(name, week());
  });

  // why: F-764 a booking running beside the edit read the old shift: the edit waits on a day with no job yet and then settles the job that write placed, so the plan matches the hours saved
  it('waits on a day with no job yet and settles the job another write placed there', async () => {
    const name = 'Brian Schaefer';
    const date = '2026-10-07';
    const made = await api.post('/jobs', { customerId: nextCustomer(), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: win('two_hour 08:00'), technicianId: null }, keisha);
    expect(made.status).toBe(201);
    const job = (await json(made)).data.job.jobNumber as number;
    let answered: Promise<Response> | null = null;
    await inTransaction(world.web, async (tx) => {
      await lockTechnicianDays(tx, [{ technicianId: tech(name), date }]);
      answered = edit(name, week({ start: '09:45' }));
      await until('the edit to wait for the empty day', async () => (await advisoryWaiters()) >= 1);
      await tx.query(`UPDATE world.job SET technician_id = $2, planned_arrival = '2026-10-07T12:06:00Z' WHERE job_number = $1`, [job, tech(name)]);
    });
    expect((await answered!).status).toBe(200);
    expect((await shown(date, job))! >= '09:45').toBe(true);
    await edit(name, week());
  });
});

describe('the employee number on the page (API-31; SD-29, GAP-27)', () => {
  // why: SD-29 a technician's employee number is shown on the Technicians page: API-31 answers the stored number, and a new technician's next number
  it('answers each technician\'s stored number and a new technician\'s', async () => {
    expect((await rowOf('Maria Santos')).employeeNumber).toBe('40712');
    const body = { name: 'Nia Oduya', email: 'noduya@brightwaterair.example', branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' } };
    const r = await api.post('/technicians', body, keisha);
    expect(r.status).toBe(201);
    const stored = (await sql<{ employee_number: string }>('SELECT employee_number FROM world."user" WHERE email = $1', [body.email]))[0]!.employee_number;
    expect(stored).toMatch(/^\d{5}$/);
    expect((await json(r)).data.technician.employeeNumber).toBe(stored);
    expect((await rowOf('Nia Oduya')).employeeNumber).toBe(stored);
  });
});

describe('add a technician to another branch (API-147; FR-DISP-33)', () => {
  // why: FR-DISP-33 a technician an office user adds to Dayton appears on the Dayton board, is listed Invited on the Technicians page and gets 1 invite email
  it('puts an office user\'s Dayton technician on the Dayton board, Invited, with 1 invite email', async () => {
    const body = { name: 'Dee Dayton', email: 'dee.dayton@brightwaterair.example', branch: 'dayton', vanId: null, skills: ['plumbing'], workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' } };
    expect((await api.post('/technicians', body, keisha)).status).toBe(201);
    expect((await list('dayton')).technicians.find((t) => t.name === 'Dee Dayton')).toMatchObject({ userStatus: 'invited', branch: 'dayton' });
    const b = await api.get('/board?branch=dayton&date=2026-09-15', keisha);
    expect(((await json(b)).data.technicians as { name: string }[]).map((t) => t.name)).toContain('Dee Dayton');
    expect(await sql('SELECT 1 FROM world.email_message WHERE to_address = $1 AND kind = \'invite\'', [body.email])).toHaveLength(1);
  });
});

describe('time off (API-148, API-169; SD-28, OI-44)', () => {
  // why: FR-DISP-33 time off over 2 booked jobs takes both off the technician and lists both for reassignment, and Remove gives the days back with no confirm step
  it('lists both booked jobs of the span as Unassigned, refuses a span with a job on the way, and removes a span at once', async () => {
    const id = tech('Ashley Nguyen');
    const a = await book('2026-09-21', 'two_hour 10:00', 'Ashley Nguyen');
    const b = await book('2026-09-21', 'two_hour 14:00', 'Ashley Nguyen');
    const r = await api.post(`/technicians/${id}/time-off`, { from: '2026-09-21', to: '2026-09-21', note: 'Dentist' }, keisha);
    expect(r.status).toBe(201);
    const d = (await json(r)).data;
    expect(d.unassigned.map((j: { jobNumber: number }) => j.jobNumber)).toEqual([a, b]);
    const jobs = await sql<{ job_number: number; technician_id: string | null }>('SELECT job_number, technician_id FROM world.job WHERE job_number = ANY($1)', [[a, b]]);
    expect(jobs.every((j) => j.technician_id === null)).toBe(true);
    expect(await sql(`SELECT 1 FROM world.job_change WHERE kind = 'unassigned_time_off' AND job_number = ANY($1)`, [[a, b]])).toHaveLength(2);
    const t = await rowOf('Ashley Nguyen');
    expect(t.timeOff).toEqual([{ id: d.timeOffId, from: '2026-09-21', to: '2026-09-21', note: 'Dentist' }]);

    // a job on the way in the span refuses the whole write and names the job
    const way = await book('2026-09-22', 'two_hour 08:00', 'Ashley Nguyen');
    await sql(`UPDATE world.job SET status = 'on_the_way' WHERE job_number = $1`, [way]);
    const refused = await api.post(`/technicians/${id}/time-off`, { from: '2026-09-22', to: '2026-09-23', note: null }, keisha);
    expect(refused.status).toBe(409);
    const rb = await json(refused);
    expect(rb.code).toBe('rule_refused');
    expect(rb.jobNumbers).toEqual([way]);
    expect((await rowOf('Ashley Nguyen')).timeOff).toHaveLength(1);

    // Remove: no confirm step, no job changes, a second Remove is not_found
    const gone = await api.del(`/technicians/${id}/time-off/${d.timeOffId}`, keisha);
    expect(gone.status).toBe(204);
    expect((await rowOf('Ashley Nguyen')).timeOff).toEqual([]);
    expect((await sql<{ technician_id: string | null }>('SELECT technician_id FROM world.job WHERE job_number = $1', [a]))[0]!.technician_id).toBeNull();
    const twice = await api.del(`/technicians/${id}/time-off/${d.timeOffId}`, keisha);
    expect(twice.status).toBe(404);
  });

  // why: FR-DISP-33 a span that ends before it starts is refused with a validation error and records nothing
  it('refuses a span whose end is before its start', async () => {
    const r = await api.post(`/technicians/${tech('Tom Reinhart')}/time-off`, { from: '2026-09-25', to: '2026-09-24', note: null }, keisha);
    expect(r.status).toBe(422);
    expect((await rowOf('Tom Reinhart')).timeOff).toEqual([]);
  });
});

describe('a technician is refused at the API (F-771; FR-AUTH-1, FR-AUTH-12)', () => {
  // why: FR-AUTH-1 the 6 Technicians page calls hold no key for a technician: each answers 403 to a real technician session and 401 to none, and the stored rows stay
  it('answers 403 to a technician session and 401 to a signed-out caller on all 6 calls', async () => {
    const [u] = await sql<{ id: string }>(`SELECT id FROM world."user" WHERE role = 'technician' LIMIT 1`);
    const token = await startSession(new SqlSessionStore(world.web), { realNow: () => realNow('session_lifetime') }, { userId: u!.id, role: 'technician' }, { client: 'web', via: 'password', keepSignedIn: false });
    const technician: Staff = { userId: u!.id, name: 'Technician', cookie: sessionCookie(token, false, false).split(';')[0] as string };
    const nobody: Staff = { userId: '', name: 'Nobody', cookie: '' };
    const id = tech('Maria Santos');
    const before = Number((await sql<{ n: string }>('SELECT count(*) AS n FROM world.technician'))[0]?.n);
    const calls: [string, (who: Staff) => Promise<Response>][] = [
      ['API-31', (who) => api.get('/technicians?branch=columbus', who)],
      ['API-32', (who) => api.post('/text-checks', { slot: 'technician', value: 'Ramon' }, who)],
      ['API-33', (who) => api.patch(`/technicians/${id}`, { nameInTexts: 'Maria Refused' }, who)],
      ['API-147', (who) => api.post('/technicians', { name: 'Zed Refused', branch: 'columbus' }, who)],
      ['API-148', (who) => api.post(`/technicians/${id}/time-off`, { from: '2026-09-28', to: '2026-09-28', note: null }, who)],
      ['API-169', (who) => api.del(`/technicians/${id}/time-off/00000000-0000-4000-8000-000000000000`, who)],
    ];
    for (const [key, call] of calls) {
      expect([key, (await call(technician)).status], `${key} as a technician`).toEqual([key, 403]);
      expect([key, (await call(nobody)).status], `${key} signed out`).toEqual([key, 401]);
    }
    expect(Number((await sql<{ n: string }>('SELECT count(*) AS n FROM world.technician'))[0]?.n)).toBe(before);
    expect((await sql<{ name_in_texts: string }>('SELECT name_in_texts FROM world.technician WHERE id = $1', [id]))[0]!.name_in_texts).not.toBe('Maria Refused');
  });
});
