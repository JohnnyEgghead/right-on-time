// SPDX-License-Identifier: AGPL-3.0-or-later
// The job page's reads and small writes (P4-JOB: API-23, API-29, API-37, API-107, API-110, API-135, API-140, API-142) on
// the real database through the production kernel as bw_web, as a dispatcher of the reference seed with a real session.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobDetailAnswer, OnTheWayAnswer } from '@bw/api';
import { createClient } from '@bw/db';
import { Temporal } from '@bw/time';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import type { ApiRequest, Tx } from '../types.ts';
import { caller, ORIGIN, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';
import { officeAvailabilityHandler } from './job-reads.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let job = 0;
let customerId = '';

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const data = async <T>(r: Response): Promise<T> => {
  if (r.status >= 300) throw new Error(`answered ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { data: T }).data;
};

beforeAll(async () => {
  world = await officeWorld(db, 8);
  api = caller(world.kernel);
  ({ keisha } = world.staff);
  customerId = world.customers[0] as string;
  const a = db.admin();
  await a.query(`UPDATE world.customer SET mobile = '(614) 555-0142', texts_on = true, customer_since = '2014-10-01' WHERE id = $1`, [customerId]);
  await a.query(`INSERT INTO world.membership (customer_id, since, renews, benefits_key) VALUES ($1, '2024-01-01', '2027-01-01', 'club.benefits')`, [customerId]);
  await a.query(`INSERT INTO world.equipment (customer_id, type, year, location, details) VALUES ($1, 'Gas furnace', 2012, 'basement', '80,000 BTU')`, [customerId]);
  for (const [d, what] of [['2023-10-02', 'Furnace tune-up'], ['2022-10-11', 'Furnace tune-up'], ['2021-01-15', 'No heat']]) {
    await a.query(`INSERT INTO world.past_visit (customer_id, technician_name, date, zone, window_start, window_end, outcome, service_text, source_ref)
                   VALUES ($1, 'Old Tech', $2::date, 'America/New_York', $2::date + time '08:00', $2::date + time '10:00', 'done', $3, 'old-' || $2)`, [customerId, d, what]);
  }
  const r = await api.post('/jobs', {
    customerId, serviceId: 'furnace_tune_up', equipmentId: null, problem: 'Rattles at start', date: '2026-09-24',
    windowId: world.windows.get('two_hour 10:00'), technicianId: world.technicians.get('Jamal Carter'),
  }, keisha);
  job = (await data<{ job: { jobNumber: number } }>(r)).job.jobNumber;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

describe('API-23 Job detail', () => {
  // why: FR-DISP-5 (customer, equipment, history: the old system's past visits with done jobs, the last 3 and the count)
  it('answers the customer, the equipment and the last 3 visits with their count', async () => {
    const d = await data<JobDetailAnswer>(await api.get(`/jobs/${job}`, keisha));
    expect(d.customer).toMatchObject({ id: customerId, mobile: '(614) 555-0142', textsOn: true, plan: 'comfort_club', customerSince: '2014-10-01' });
    expect(d.equipment).toEqual([expect.objectContaining({ type: 'Gas furnace', year: 2012, location: 'basement' })]);
    expect(d.history.count).toBe(3);
    expect(d.history.fromOldSystem).toBe(true);
    expect(d.history.visits.map((v) => v.date)).toEqual(['2023-10-02', '2022-10-11', '2021-01-15']);
  });

  // why: FR-DISP-26 (job type, expected length, Customer since with the past-visit count, and the plan)
  it('answers the job type and length, the booking facts and the past-visit count', async () => {
    const d = await data<JobDetailAnswer>(await api.get(`/jobs/${job}`, keisha));
    expect(d.job).toMatchObject({ jobNumber: job, status: 'scheduled', serviceId: 'furnace_tune_up', bookedVia: 'office', problem: 'Rattles at start' });
    expect(d.job.jobType.length).toBeGreaterThan(0);
    expect(d.job.expectedMinutes).toBeGreaterThan(0);
    expect(d.customer.pastVisitCount).toBe(3);
    expect(d.timeline.map((t) => t.kind)).toEqual(['created']);
    expect(d.billing).toEqual({ state: 'not_sent', reasonKey: null });
  });

  // why: FR-DISP-5 (a done job joins the history of the customer's next job)
  it('counts a done job of the customer in the history of another job', async () => {
    const other = await data<{ job: { jobNumber: number } }>(await api.post('/jobs', {
      customerId, serviceId: 'heating_or_ac_fix', equipmentId: null, problem: null, date: '2026-09-25',
      windowId: world.windows.get('two_hour 12:00'), technicianId: null,
    }, keisha));
    await api.post(`/jobs/${other.job.jobNumber}/finish`, { parts: [], noPartsUsed: true, laborMinutes: 30, baseVersion: 1 }, keisha);
    const d = await data<JobDetailAnswer>(await api.get(`/jobs/${job}`, keisha));
    expect(d.history.count).toBe(4);
    expect(d.history.visits[0]).toMatchObject({ date: '2026-09-25', oldSystem: false, jobNumber: other.job.jobNumber });
  });

  // why: F-708 CTL-OFC-03-12 What was done: a done job's work-done lines in order, an old visit's cell, and none for a blank cell
  it('carries what was done: the lines of a done job, the cell of an old visit, none when nothing was recorded', async () => {
    const a = db.admin();
    await a.query(`UPDATE world.past_visit SET work_done = 'Replaced the igniter.' WHERE customer_id = $1 AND date = DATE '2023-10-02'`, [customerId]);
    await a.query(`UPDATE world.past_visit SET work_done = '  ' WHERE customer_id = $1 AND date = DATE '2022-10-11'`, [customerId]);
    const done = (await rows<{ job_number: number }>(`SELECT job_number FROM world.job WHERE customer_id = $1 AND date = DATE '2026-09-25'`, [customerId]))[0] as { job_number: number };
    await a.query(`INSERT INTO world.work_done_line (job_number, seq, text) VALUES ($1, 2, 'Replaced the filter'), ($1, 1, 'Cleaned the flame sensor')`, [done.job_number]);
    const d = await data<JobDetailAnswer>(await api.get(`/jobs/${job}`, keisha));
    expect(d.history.visits.map((v) => [v.date, v.workDone])).toEqual([
      ['2026-09-25', ['Cleaned the flame sensor', 'Replaced the filter']],
      ['2023-10-02', ['Replaced the igniter.']],
      ['2022-10-11', []],
    ]);
  });

  // why: FR-DISP-5, F-1542, CTL-OFC-03-12 (a history row that is a job carries its job number; an old-system row carries none, so the page links only the job)
  it('answers the job number for a job row and none for an old-system row', async () => {
    const done = (await rows<{ job_number: number }>(`SELECT job_number FROM world.job WHERE customer_id = $1 AND date = DATE '2026-09-25'`, [customerId]))[0] as { job_number: number };
    const d = await data<JobDetailAnswer>(await api.get(`/jobs/${job}`, keisha));
    expect(d.history.visits.map((v) => [v.oldSystem, v.jobNumber])).toEqual([[false, done.job_number], [true, null], [true, null]]);
  });

  // why: FR-DISP-5 (an unknown job number is not_found: SCR-SHR-02)
  it('answers an unknown job with not_found', async () => {
    expect((await api.get('/jobs/99999999', keisha)).status).toBe(404);
  });
});

describe('API-140 Add note and API-142 Edit equipment (FR-DISP-27)', () => {
  // why: FR-DISP-27 (an office note is saved with its author and time and shows in the job's notes and history)
  it('saves an office note on the job, shown in API-23 with its author', async () => {
    const r = await api.post('/notes', { jobNumber: job, body: 'Gate code 4410. Dog in the yard.' }, keisha);
    expect(r.status).toBe(201);
    const d = await data<JobDetailAnswer>(await api.get(`/jobs/${job}`, keisha));
    expect(d.notes[0]).toMatchObject({ kind: 'office', author: 'Keisha Thompson', body: 'Gate code 4410. Dog in the yard.' });
    expect(d.timeline.map((t) => t.kind)).toContain('note_added');
    expect((await api.post('/notes', { jobNumber: job, customerId, body: 'x' }, keisha)).status).toBe(422);
  });

  // why: F-701, FR-DISP-5 (a customer note reaches the customer's job page: API-23 answers it under customer, apart from the job's own notes)
  it('answers the customer\'s notes under customer, newest first, with the job\'s notes kept apart', async () => {
    expect((await api.post('/notes', { customerId, body: 'Older: side door only.' }, keisha)).status).toBe(201);
    expect((await api.post('/notes', { customerId, body: 'Newer: call from the driveway.' }, keisha)).status).toBe(201);
    const d = await data<JobDetailAnswer>(await api.get(`/jobs/${job}`, keisha));
    expect(d.customer.notes.map((n) => n.body)).toEqual(['Newer: call from the driveway.', 'Older: side door only.']);
    expect(d.customer.notes[0]).toMatchObject({ kind: 'office', author: 'Keisha Thompson', enteredOffline: false });
    expect(d.customer.notes[0]?.at).toMatch(/^2026-.*\[America\/New_York\]$/);
    expect(d.notes.map((n) => n.body)).not.toContain('Older: side door only.');
    expect(d.notes.map((n) => n.body)).toContain('Gate code 4410. Dog in the yard.');
  });

  // why: F-851 (customer detail, API-35, and customer edit, API-36, refuse a merged customer; the add office note call's customerId path, API-140, and the add equipment call, API-141, saved on the merged record)
  it('refuses a customer note and a piece of equipment for a merged customer with not_found, and writes nothing', async () => {
    const other = (await rows<{ id: string }>('SELECT id FROM world.customer WHERE id <> $1 LIMIT 1', [customerId]))[0]!.id;
    const notes = async () => Number((await rows<{ n: string }>('SELECT count(*) AS n FROM world.note WHERE customer_id = $1', [customerId]))[0]!.n);
    const equip = async () => Number((await rows<{ n: string }>('SELECT count(*) AS n FROM world.equipment WHERE customer_id = $1', [customerId]))[0]!.n);
    const [n0, e0] = [await notes(), await equip()];
    await db.admin().query(`UPDATE world.customer SET status = 'merged', merged_into = $2 WHERE id = $1`, [customerId, other]);
    try {
      expect((await api.post('/notes', { customerId, body: 'After the merge' }, keisha)).status).toBe(404);
      expect((await api.post(`/customers/${customerId}/equipment`, { type: 'Water heater', year: 2020 }, keisha)).status).toBe(404);
      expect([await notes(), await equip()]).toEqual([n0, e0]);
    } finally {
      await db.admin().query(`UPDATE world.customer SET status = 'active', merged_into = NULL WHERE id = $1`, [customerId]);
    }
  });

  // why: FR-DISP-31 (Add equipment adds a water heater to the customer, and the customer's job page shows it)
  it('API-141 adds a water heater to the customer, shown by API-23, and refuses an empty type and an unknown customer', async () => {
    const post = (path: string, body: unknown) => api.post(path, body, keisha);
    const r = await post(`/customers/${customerId}/equipment`, { type: 'Water heater', year: 2016, location: 'basement', details: '50 gallon' });
    expect(r.status).toBe(201);
    const made = (await data<{ equipment: { id: string } }>(r)).equipment;
    expect(made).toMatchObject({ type: 'Water heater', year: 2016, location: 'basement', details: '50 gallon' });
    const d = await data<JobDetailAnswer>(await api.get(`/jobs/${job}`, keisha));
    expect(d.equipment.find((e) => e.id === made.id)).toMatchObject({ type: 'Water heater', year: 2016, location: 'basement', details: '50 gallon' });
    expect((await post(`/customers/${customerId}/equipment`, { type: '   ' })).status).toBe(422);
    expect((await post('/customers/0192f000-0000-7000-8000-0000000000ff/equipment', { type: 'Boiler' })).status).toBe(404);
  });

  // why: FR-DISP-27 (Edit equipment changes the fields sent and keeps the rest)
  it('edits a piece of equipment', async () => {
    const id = (await rows<{ id: string }>('SELECT id FROM world.equipment WHERE customer_id = $1', [customerId]))[0]!.id;
    const r = await world.kernel.router.handle(new Request(`http://web:3000/api/v1/equipment/${id}`, {
      method: 'PATCH', body: JSON.stringify({ location: 'utility room', details: '96% efficient' }),
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: keisha.cookie },
    }), { address: '203.0.113.9' });
    expect((await data<{ equipment: Record<string, unknown> }>(r)).equipment).toMatchObject({ type: 'Gas furnace', year: 2012, location: 'utility room', details: '96% efficient' });
  });
});

describe('API-135 Job on the way (FR-DISP-25)', () => {
  // why: FR-DISP-25 (the panel's van, destination, minutes away and arrival while On the way; NFR-04: nothing otherwise)
  it('answers the van and the arrival only while the job is On the way', async () => {
    const before = await data<OnTheWayAnswer>(await api.get(`/jobs/${job}/on-the-way`, keisha));
    expect(before).toMatchObject({ onTheWay: false, van: null, technician: null });
    const now = (await rows<{ demo_anchor: Date }>('SELECT demo_anchor FROM system.demo_clock WHERE id = 1'))[0]!.demo_anchor;
    await db.admin().query(`UPDATE world.job SET status = 'on_the_way', on_the_way_at = $2, texted_arrival = $3 WHERE job_number = $1`,
      [job, now, new Date(now.getTime() + 12 * 60_000)]);
    const d = await data<OnTheWayAnswer>(await api.get(`/jobs/${job}/on-the-way`, keisha));
    expect(d.onTheWay).toBe(true);
    expect(d.van).not.toBeNull();
    expect(d.destination).not.toBeNull();
    expect(d.minutesAway).toBe(12);
    expect(d.technician).toMatchObject({ name: 'Jamal Carter', initials: 'JC' });
    // why: F-868 (UI-SPECIFICATION 12.2 API-135: after arrival, 410 with no coordinates)
    for (const after of ['on_site', 'no_one_home']) {
      await db.admin().query(`UPDATE world.job SET status = $2 WHERE job_number = $1`, [job, after]);
      const r = await api.get(`/jobs/${job}/on-the-way`, keisha);
      expect(r.status, after).toBe(410);
      expect(JSON.stringify(await r.json()), after).not.toMatch(/"lon"|"lat"/);
    }
    await db.admin().query(`UPDATE world.job SET status = 'scheduled', on_the_way_at = NULL, texted_arrival = NULL WHERE job_number = $1`, [job]);
  });
});

describe('the dialogs\' reads', () => {
  // why: FR-BILL-3 (OA-54: the finish form picks parts only from the fixed seeded list)
  it('API-107 answers the seeded parts list', async () => {
    const d = await data<{ parts: { partId: string; code: string }[] }>(await api.get('/parts', keisha));
    expect(d.parts.length).toBe(Number((await rows<{ n: string }>('SELECT count(*) AS n FROM world.part'))[0]!.n));
  });

  // why: FR-DISP-5 (Edit job details picks the service from the service list)
  it('API-110 answers the services by catalog key', async () => {
    const d = await data<{ services: { serviceId: string; screenLabelKey: string }[] }>(await api.get('/public/services', keisha));
    expect(d.services.map((s) => s.serviceId)).toContain('furnace_tune_up');
  });

  // why: FR-TECH-6 (Reschedule lists the days and windows with room, the job being moved left out of the counts)
  it('API-29 answers the office days and windows with their room', async () => {
    const d = await data<{ days: { date: string; state: string; windows: { state: string }[] }[] }>(
      await api.get(`/availability?branch=columbus&serviceId=furnace_tune_up&from=2026-09-24&to=2026-09-27&channel=office&jobNumber=${job}`, keisha));
    expect(d.days.map((x) => x.date)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
    expect(d.days[3]).toMatchObject({ state: 'closed' }); // a Sunday
    expect(d.days[0]!.windows.length).toBeGreaterThan(0);
  });

  interface Avail { date: string; state: string; left: number; windows: { windowId: string; state: string; left: number }[] }
  const availability = async (serviceId: string, date: string, jobNumber?: number) => (await data<{ days: Avail[] }>(
    await api.get(`/availability?branch=columbus&serviceId=${serviceId}&from=${date}&to=${date}&channel=office${jobNumber ? `&jobNumber=${jobNumber}` : ''}`, keisha))).days[0]!;
  interface Room { id: string; room: boolean; suggested: boolean; load: { capacity: number } }
  const skilledWithRoom = async (serviceId: string, date: string, windowId: string) => (await data<{ technicians: Room[] }>(
    await api.get(`/technicians/room?branch=columbus&date=${date}&windowId=${windowId}&serviceId=${serviceId}&customerId=${customerId}`, keisha))).technicians.filter((t) => t.room && t.suggested);
  const windowCapacity = async (id: string) => (await rows<{ capacity: number }>('SELECT capacity FROM world.arrival_window WHERE id = $1', [id]))[0]!.capacity;

  // why: F-801 (a window's left is the technicians with the service's skill and room in it, at most its windowRoom: the same count API-30 lists; UI-SPECIFICATION 12.4)
  it('API-29 counts a window\'s left from the technicians with the skill and room, not its capacity', async () => {
    const date = '2026-09-29';
    const d = await availability('water_heater', date);
    expect(d.windows.length).toBeGreaterThan(0);
    for (const w of d.windows) {
      const capacity = await windowCapacity(w.windowId);
      const skilled = (await skilledWithRoom('water_heater', date, w.windowId)).length;
      expect(w.left).toBe(Math.min(skilled, capacity));
      expect(w.left).toBeLessThan(capacity); // the rule shows: fewer plumbers than the window takes
    }
  });

  // why: F-801 (a day's left is dayRoom for the service: the pool's capacity minus the day's live jobs in that pool; and a job on a skilled technician takes 1 from nothing until that technician is out of room)
  it('API-29 answers a day\'s left as dayRoom for the service', async () => {
    const date = '2026-09-30';
    const [w] = (await availability('water_heater', date)).windows;
    const techs = (await data<{ technicians: Room[] }>(
      await api.get(`/technicians/room?branch=columbus&date=${date}&windowId=${w!.windowId}&serviceId=water_heater&customerId=${customerId}`, keisha))).technicians;
    const installers = new Set((await rows<{ id: string }>('SELECT id FROM world.technician WHERE installer')).map((t) => t.id));
    const capacity = techs.filter((t) => !installers.has(t.id)).reduce((s, t) => s + t.load.capacity, 0);
    expect((await availability('water_heater', date)).left).toBe(capacity);
    const r = await api.post('/jobs', { customerId, serviceId: 'water_heater', equipmentId: null, problem: null, date, windowId: w!.windowId, technicianId: null }, keisha);
    expect(r.status, await r.clone().text()).toBe(201);
    expect((await availability('water_heater', date)).left).toBe(capacity - 1);
  });

  // why: F-801, FR-DISP-8 (no skilled technician has room: the window answers 0 left and stays open, because the office can still save it with no technician yet; the job being moved is left out of the count)
  it('API-29 answers an open window with 0 left when no skilled technician has room, and API-28 still takes the job', async () => {
    const date = '2026-10-01';
    const [w] = (await availability('water_heater', date)).windows;
    const id = w!.windowId;
    const skilled = await skilledWithRoom('water_heater', date, id);
    const jobs: number[] = [];
    for (const t of skilled) {
      for (let i = 0; i < 2; i++) {
        const r = await api.post('/jobs', { customerId, serviceId: 'water_heater', equipmentId: null, problem: null, date, windowId: id, technicianId: t.id }, keisha);
        expect(r.status, await r.clone().text()).toBe(201);
        jobs.push((await data<{ job: { jobNumber: number } }>(r)).job.jobNumber);
      }
    }
    const after = (await availability('water_heater', date)).windows.find((x) => x.windowId === id)!;
    expect(after).toMatchObject({ state: 'open', left: 0 });
    // Moving 1 of those jobs: API-24 counts the day without it, and so does the dialog's read.
    const moving = (await availability('water_heater', date, jobs[0])).windows.find((x) => x.windowId === id)!;
    expect(moving).toMatchObject({ state: 'open', left: 1 });
    const r = await api.post('/jobs', { customerId, serviceId: 'water_heater', equipmentId: null, problem: null, date, windowId: id, technicianId: null }, keisha);
    expect(r.status, await r.clone().text()).toBe(201);
  });

  // why: FR-TEXT-14 (the job page links the customer's text inbox)
  it('API-37 answers the inbox link', async () => {
    const d = await data<{ url: string }>(await api.get(`/customers/${customerId}/inbox-link`, keisha));
    expect(d.url).toMatch(/^\/inbox\//);
  });
});

describe('the job reads on the real database (F-2008)', () => {
  // why: F-2008 K-09.4 (an offline-entered note's read carried no entered_offline label: no handler set it and no row required it)
  it('API-23 carries the entered_offline label on an answer that holds an offline-entered note', async () => {
    expect((await api.post('/notes', { jobNumber: job, body: 'Typed on the roof, no signal.' }, keisha)).status).toBe(201);
    await db.admin().query(`UPDATE world.note SET entered_offline = true WHERE body = 'Typed on the roof, no signal.'`);
    const r = await api.get(`/jobs/${job}`, keisha);
    const body = (await r.json()) as { data: JobDetailAnswer; meta: { labels: string[] } };
    expect(body.data.notes.find((n) => n.body === 'Typed on the roof, no signal.')).toMatchObject({ enteredOffline: true });
    expect(body.meta.labels).toContain('entered_offline');
  });

  // why: F-2008 K-09.5 (the note's read of the job took no lock, so a job write committing between the read and the note's history row left the row at the old version)
  it('API-140 waits for a job write in flight and records its history row at the version that write left', async () => {
    const other = createClient({ connectionString: db.url() });
    await other.connect();
    try {
      const before = (await rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [job]))[0]!.version;
      await other.query('BEGIN');
      await other.query('UPDATE world.job SET version = version + 1 WHERE job_number = $1', [job]);
      const pending = api.post('/notes', { jobNumber: job, body: 'Written beside a job write.' }, keisha);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await other.query('COMMIT');
      expect((await pending).status).toBe(201);
      const change = (await rows<{ from_version: number; to_version: number }>(
        `SELECT from_version, to_version FROM world.job_change WHERE job_number = $1 AND kind = 'note_added' ORDER BY at DESC, id DESC LIMIT 1`, [job]))[0]!;
      expect(change).toEqual({ from_version: before + 1, to_version: before + 1 });
    } finally {
      await other.end();
    }
  });

  // why: F-2008 K-09.6 (API-29 read each day's kind and plan with its own queries, about 3 per day: 183 for 61 days)
  it('API-29 reads a 61-day range with 1 day-mode query and 1 job query', async () => {
    const seen: string[] = [];
    const counting = { query: (text: string, values?: unknown[]) => { seen.push(text); return db.admin().query(text, values); } } as unknown as Tx;
    const req = {
      params: { branch: 'columbus', serviceId: 'furnace_tune_up', from: '2026-09-15', to: '2026-11-14', channel: 'office' },
      demoNow: Temporal.Instant.from('2026-09-15T14:28:00Z'),
    } as unknown as ApiRequest;
    const out = await officeAvailabilityHandler(req, counting, undefined as never);
    expect(out.ok && out.data.days.length).toBe(61);
    // the span counter's own 1 query (a GROUP BY over the technicians' jobs) is the same for 1 day or 61; the 2 day reads are the ones that grew
    const touching = seen.filter((q) => /world\.day_mode/.test(q) || /FROM world\.job\b/.test(q));
    const perDay = touching.filter((q) => !/GROUP BY technician_id/.test(q));
    expect(perDay.length).toBeLessThanOrEqual(2);
    expect(touching.length).toBeLessThanOrEqual(3);
  });
});

