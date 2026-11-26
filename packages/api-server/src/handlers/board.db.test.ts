// SPDX-License-Identifier: AGPL-3.0-or-later
// The board's reads (API-20 board day, API-30 suggested technicians, API-131 move preview) on the real database
// (PostgreSQL 18, the migrated schema, P2-SEED's reference seed) through the production kernel as bw_web, with the
// dispatchers' real sessions. The demo clock is the seeded Tue, Sep 15, 2026, 7:00 AM. Run by gate G-CI7 step 3.
import { approximateDriveMinutes, worksOn } from '@bw/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { branchTechnicians } from '../office-writes/day.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';
import { initialsOf } from './board.ts';

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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;
const nextCustomer = () => world.customers[customer++ % world.customers.length] as string;
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const data = async (r: Response): Promise<Json> => ((await r.json()) as { data: Json }).data;
const board = async (date: string) => {
  const r = await api.get(`/board?branch=columbus&date=${date}`, keisha);
  expect(r.status).toBe(200);
  return data(r);
};
const minutes = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));

async function book(date: string, window: string, technician: string | null, service = 'furnace_tune_up'): Promise<{ jobNumber: number; version: number; plannedArrival: string | null }> {
  const r = await api.post('/jobs', {
    customerId: nextCustomer(), serviceId: service, equipmentId: null, problem: null, date, windowId: win(window), technicianId: technician ? tech(technician) : null,
  }, keisha);
  if (r.status !== 201) throw new Error(`create answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return (await data(r)).job;
}

describe('board day (API-20)', () => {
  // why: FR-DISP-1, FR-DISP-15
  it('shows 1 row per Columbus technician working Sep 15, each with van and skill, and each job at its window', async () => {
    const j = await book('2026-09-15', 'two_hour 10:00', 'Kevin Doyle');
    const u = await book('2026-09-15', 'two_hour 12:00', null);
    const b = await board('2026-09-15');
    const working = (await branchTechnicians(db.admin(), 'columbus')).filter((t) => worksOn(t, '2026-09-15')).map((t) => t.id).sort();
    expect(b.technicians.map((t: Json) => t.id).sort()).toEqual(working);
    expect(b.onShift).toBe(working.length);
    const facts = await rows<{ id: string; name: string; primary_skill: string; number: string | null }>(
      `SELECT t.id, t.name, t.primary_skill, v.number FROM world.technician t LEFT JOIN world.van v ON v.id = t.van_id WHERE t.branch_id = 'columbus'`);
    for (const row of b.technicians) {
      const f = facts.find((x) => x.id === row.id)!;
      expect([row.name, row.van, row.skills[0], row.initials]).toEqual([f.name, f.number, f.primary_skill, initialsOf(f.name)]);
    }
    const kevin = b.technicians.find((t: Json) => t.id === tech('Kevin Doyle'));
    const mine = kevin.jobs.find((x: Json) => x.jobNumber === j.jobNumber);
    expect(mine.window).toEqual({ start: '2026-09-15T10:00:00-04:00[America/New_York]', end: '2026-09-15T12:00:00-04:00[America/New_York]' });
    expect(mine).toMatchObject({ status: 'scheduled', plannedArrival: j.plannedArrival, serviceLabelKey: 'service.furnace_tune_up.screen', version: 1 });
    expect(b.unassigned.map((x: Json) => x.jobNumber)).toContain(u.jobNumber);
    expect(b.needsAttention.unassigned.find((x: Json) => x.jobNumber === u.jobNumber)).toMatchObject({ label: 'status.job.unassigned', technician: null });
    expect(b).toMatchObject({ date: '2026-09-15', today: true, dayMode: 'two_hour' });
    expect((await board('today')).date).toBe('2026-09-15');
  });

  // why: FR-DISP-13
  it('gives the 7-day on-time rate of Sep 8 to Sep 14 against the 90% goal, equal to an independent count over the pilot visits', async () => {
    // Pilot visits on Sep 8 to 14 (SD-25 row 2): 3 on time, 1 late, 1 with no arrival (left out).
    const visits: [string, string | null][] = [['2026-09-08', '09:30'], ['2026-09-10', '09:59'], ['2026-09-12', '08:15'], ['2026-09-14', '10:40'], ['2026-09-11', null]];
    for (const [date, arrived] of visits) {
      await rows(`INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version, expected_minutes,
                                         booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot, arrived_at, technician_id)
                  VALUES ($1, 'columbus', 'furnace_tune_up', $2::date, 'America/New_York', $3, ($2 || ' 08:00 America/New_York')::timestamptz,
                          ($2 || ' 10:00 America/New_York')::timestamptz, 'done', 1, 60, 'office', '2026-09-01T12:00:00Z', 'sent', false, false, true,
                          CASE WHEN $4::text IS NULL THEN NULL ELSE ($2 || ' ' || $4 || ' America/New_York')::timestamptz END, $5)`,
        [nextCustomer(), date, win('two_hour 08:00'), arrived, tech('Kevin Doyle')]);
    }
    const independent = await rows<{ rate: number }>(
      `SELECT (count(*) FILTER (WHERE arrived_at <= window_end))::float / count(*) AS rate FROM world.job
        WHERE pilot AND branch_id = 'columbus' AND date BETWEEN '2026-09-08' AND '2026-09-14' AND arrived_at IS NOT NULL`);
    const b = await board('2026-09-15');
    expect(b.onTime7).toEqual({ rate: independent[0]!.rate, goal: 0.9, labelKey: 'board.summary.simulated', from: '2026-09-08', to: '2026-09-14' });
    expect(b.onTime7.rate).toBe(0.75);
  });

  // why: FR-DISP-13 SD-25 and F-736: the rate is the view's pilot rows, so a live finished visit in its 7 days (a report row for the no-one-home denominator only) changes nothing
  it('keeps a late live finished visit out of the 7-day rate', async () => {
    // The pilot visits of the test above that fall on Sep 9 to 15: on time Sep 10 and 12, late Sep 14, none arrived on Sep 11: 2 of 3 by hand.
    const live = await rows<{ job_number: number }>(
      `INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version, expected_minutes,
                              booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot, arrived_at, technician_id)
       VALUES ($1, 'columbus', 'furnace_tune_up', '2026-09-15', 'America/New_York', $2, '2026-09-15 08:00 America/New_York', '2026-09-15 10:00 America/New_York',
               'done', 1, 60, 'office', '2026-09-01T12:00:00Z', 'sent', false, false, false, '2026-09-15 11:00 America/New_York', $3) RETURNING job_number`,
      [nextCustomer(), win('two_hour 08:00'), tech('Kevin Doyle')]);
    try {
      const b = await board('2026-09-16');
      expect(b.onTime7).toMatchObject({ from: '2026-09-09', to: '2026-09-15' });
      expect(b.onTime7.rate).toBeCloseTo(2 / 3, 10); // 2 of 4 (0.5) if the live row counted
    } finally {
      await rows('DELETE FROM world.job WHERE job_number = $1', [live[0]!.job_number]);
    }
  });

  // why: FR-DISP-4, FR-DISP-14
  it('names a late job and an at-risk job by their timing word, counts them and lists them under Needs attention', async () => {
    const date = '2026-09-15';
    const late = await book(date, 'two_hour 08:00', 'Greg Hoffman');
    const risk = await book(date, 'two_hour 08:00', 'Luis Ortega');
    const point = async (n: number) => (await rows<{ lon: number; lat: number }>('SELECT c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = $1', [n]))[0]!;
    const depot = (await rows<{ lon: number; lat: number }>(`SELECT depot_lon AS lon, depot_lat AS lat FROM world.branch WHERE id = 'columbus'`))[0]!;
    // On the way from the depot (the first job of each day): ETA = on the way + the drive. Late: past 10:00. At risk: 5 minutes before.
    const lateDrive = approximateDriveMinutes(depot, await point(late.jobNumber));
    const riskDrive = approximateDriveMinutes(depot, await point(risk.jobNumber));
    await rows(`UPDATE world.job SET status = 'on_the_way', on_the_way_at = '2026-09-15T10:00:00-04:00'::timestamptz - make_interval(mins => $2) + interval '10 minutes' WHERE job_number = $1`, [late.jobNumber, lateDrive]);
    await rows(`UPDATE world.job SET status = 'on_the_way', on_the_way_at = '2026-09-15T10:00:00-04:00'::timestamptz - make_interval(mins => $2) - interval '5 minutes' WHERE job_number = $1`, [risk.jobNumber, riskDrive]);
    const b = await board(date);
    const jobs = b.technicians.flatMap((t: Json) => t.jobs);
    expect(jobs.find((j: Json) => j.jobNumber === late.jobNumber)).toMatchObject({ status: 'on_the_way', timing: 'late' });
    expect(jobs.find((j: Json) => j.jobNumber === risk.jobNumber)).toMatchObject({ status: 'on_the_way', timing: 'atRisk' });
    expect(b.counts.late).toBe(jobs.filter((j: Json) => j.timing === 'late').length);
    expect(b.counts.atRisk).toBe(jobs.filter((j: Json) => j.timing === 'atRisk').length);
    expect(b.needsAttention.late.find((x: Json) => x.jobNumber === late.jobNumber)).toMatchObject({ label: 'status.timing.late', technician: 'Greg Hoffman' });
    expect(b.needsAttention.atRisk.find((x: Json) => x.jobNumber === risk.jobNumber)).toMatchObject({ label: 'status.timing.atRisk', technician: 'Luis Ortega' });
    // An ended job has no timing word: it shows its status (here No one home).
    await rows(`UPDATE world.job SET status = 'no_one_home', arrived_at = on_the_way_at + interval '20 minutes', ended_at = on_the_way_at + interval '30 minutes' WHERE job_number = $1`, [late.jobNumber]);
    const after = (await board(date)).technicians.flatMap((t: Json) => t.jobs).find((j: Json) => j.jobNumber === late.jobNumber);
    expect(after).toMatchObject({ status: 'no_one_home', timing: null });
  });

  // why: FR-DISP-16
  it('shows a block on its technician row with its label, place and times, and never counts it as a job', async () => {
    const date = '2026-09-16';
    const before = await board(date);
    const c = await api.post('/time-blocks', { technicianId: tech('Kevin Doyle'), date, label: 'Pickup', place: 'Supply house', start: '07:10', end: '07:55' }, keisha);
    expect(c.status).toBe(201);
    const b = await board(date);
    const kevin = b.technicians.find((t: Json) => t.id === tech('Kevin Doyle'));
    expect(kevin.blocks).toEqual([expect.objectContaining({ label: 'Pickup', place: 'Supply house', start: '2026-09-16T07:10:00-04:00[America/New_York]', end: '2026-09-16T07:55:00-04:00[America/New_York]', version: 1 })]);
    expect(b.counts.jobs).toBe(before.counts.jobs);
  });

  // why: FR-DISP-9
  it('lists every flagged item of the branch not yet marked handled, whatever the date, until Mark handled', async () => {
    const j = await book('2026-09-17', 'two_hour 08:00', 'Kevin Doyle');
    // The phone's item the server flagged (the item path itself is tested in tech-items/items.db.test.ts).
    const [item] = await rows<{ key: string }>(
      `INSERT INTO world.tech_item (key, technician_id, job_number, kind, base_version, world_epoch, device_time_real, offset_saved_real, demo_time,
                                    since_save_ms, received_at, result)
       VALUES (gen_random_uuid(), $1, $2, 'finished', 1, 1, now(), now(), '2026-09-15T14:40:00Z', 0, now(), 'flagged') RETURNING key`,
      [tech('Kevin Doyle'), j.jobNumber]);
    const [c] = await rows<{ id: string }>(
      `INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
       VALUES ($1, $3, 'columbus', 'offline.flag.canceled', $2::jsonb, '2026-09-15T14:40:00Z', '2026-09-15T14:50:00Z') RETURNING id`,
      [j.jobNumber, JSON.stringify({ tech: 'Maria', action: 'finished', job: j.jobNumber, by: 'Keisha T.', at: '10:40 AM' }), item!.key]);
    const shown = (await board('2026-09-15')).needsAttention.flagged;
    expect(shown).toEqual([expect.objectContaining({ conflictId: c!.id, jobNumber: j.jobNumber, messageKey: 'offline.flag.canceled', offlineAt: '2026-09-15T10:40:00-04:00[America/New_York]' })]);
    expect((await board('2026-09-18')).needsAttention.flagged.map((f: Json) => f.conflictId)).toEqual([c!.id]);
    expect((await board('2026-09-18')).counts.flagged).toBe(1);
    expect((await api.post(`/offline-conflicts/${c!.id}/handled`, {}, keisha)).status).toBe(200);
    expect((await board('2026-09-15')).needsAttention.flagged).toEqual([]);
  });

  // why: FR-DISP-1
  it('answers a Sunday as closed with no technician on shift, and an unknown branch with not_found', async () => {
    const b = await board('2026-09-20');
    expect([b.dayMode, b.onShift, b.technicians.length]).toEqual(['closed', 0, 0]);
    expect((await api.get('/board?branch=nowhere&date=today', keisha)).status).toBe(404);
    expect((await board('2026-09-19')).workingHours).toEqual({ start: '2026-09-19T08:00:00-04:00[America/New_York]', end: '2026-09-19T12:00:00-04:00[America/New_York]' });
  });
});

describe('move preview (API-131)', () => {
  // why: FR-DISP-17
  it('answers the arrival the move would give, equal to the planned arrival the move then writes, and whether it is inside the window', async () => {
    const date = '2026-09-22';
    await book(date, 'two_hour 08:00', 'Kevin Doyle', 'boiler_repair');
    const j = await book(date, 'two_hour 10:00', 'Greg Hoffman');
    const p = await api.post(`/jobs/${j.jobNumber}/assignment-preview`, { technicianId: tech('Kevin Doyle') }, keisha);
    expect(p.status).toBe(200);
    const preview = await data(p);
    expect(preview.window).toEqual({ start: '2026-09-22T10:00:00-04:00[America/New_York]', end: '2026-09-22T12:00:00-04:00[America/New_York]' });
    const moved = await api.post(`/jobs/${j.jobNumber}/assignment`, { technicianId: tech('Kevin Doyle'), baseVersion: j.version }, keisha);
    expect(moved.status).toBe(200);
    const written = (await data(moved)).job;
    expect(preview.arrivesAbout).toBe(written.plannedArrival);
    const a = minutes(preview.arrivesAbout);
    expect(preview.insideWindow).toBe(a >= minutes(preview.window.start) && a <= minutes(preview.window.end));
    // The preview wrote nothing: a second preview of the same move changes no version.
    expect(await rows('SELECT version FROM world.job WHERE job_number = $1', [j.jobNumber])).toEqual([{ version: 2 }]);
    expect(await data(await api.post(`/jobs/${j.jobNumber}/assignment-preview`, { technicianId: null }, keisha))).toMatchObject({ arrivesAbout: null, insideWindow: null });
  });

  // why: FR-DISP-17 a late verdict: a 3-hour job before it pushes the arrival past the window
  it('answers insideWindow false when the target day pushes the arrival past the window end', async () => {
    const date = '2026-09-23';
    await book(date, 'two_hour 08:00', 'Luis Ortega', 'sump_pump_install');
    await book(date, 'two_hour 08:00', 'Luis Ortega', 'boiler_repair');
    const j = await book(date, 'two_hour 08:00', null);
    const preview = await data(await api.post(`/jobs/${j.jobNumber}/assignment-preview`, { technicianId: tech('Luis Ortega') }, keisha));
    expect(preview.insideWindow).toBe(false);
    expect(minutes(preview.arrivesAbout)).toBeGreaterThan(minutes(preview.window.end));
  });
});

describe('suggested technicians (API-30)', () => {
  // why: FR-DISP-2 the reassign dialog lists each technician working that day with van, skill and jobs of capacity
  it('lists the technicians working the day with van, skills and load, the moved job left out of its own count', async () => {
    const date = '2026-09-24';
    const j = await book(date, 'two_hour 10:00', 'Kevin Doyle');
    const q = `/technicians/room?branch=columbus&date=${date}&windowId=${win('two_hour 10:00')}&serviceId=furnace_tune_up&jobNumber=${j.jobNumber}`;
    const r = await api.get(q, keisha);
    expect(r.status).toBe(200);
    const list = (await data(r)).technicians;
    const working = (await branchTechnicians(db.admin(), 'columbus')).filter((t) => worksOn(t, date));
    expect(list.map((t: Json) => t.id).sort()).toEqual(working.map((t) => t.id).sort());
    expect(list.find((t: Json) => t.id === tech('Kevin Doyle')).load).toEqual({ jobs: 0, capacity: expect.any(Number) });
    expect((await api.get(`/technicians/room?branch=columbus&date=${date}&windowId=${win('two_hour 10:00')}&serviceId=furnace_tune_up`, keisha)).status).toBe(422);
  });
});

describe('suggested technicians for a job not yet made (API-30, F-424)', () => {
  const date = '2026-09-29';
  const ask = async (customerId: string, windowKey: string, serviceId: string) => {
    const r = await api.get(`/technicians/room?branch=columbus&date=${date}&windowId=${win(windowKey)}&serviceId=${serviceId}&customerId=${customerId}`, keisha);
    expect(r.status).toBe(200);
    return data(r);
  };

  // why: FR-DISP-28 (the minutes come from the stop before, which the answer names with its planned time and area; the depot is null)
  it('answers each technician\'s stop before: the last job before the window with its planned time and area, or none for the depot', async () => {
    const job = await book(date, 'two_hour 10:00', 'Kevin Doyle');
    const area = (await rows<{ city: string }>(`SELECT s.city FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street s ON s.id = c.street_id WHERE j.job_number = $1`, [job.jobNumber]))[0]!.city;
    const answer = await ask(nextCustomer(), 'two_hour 12:00', 'furnace_tune_up');
    const kevin = answer.technicians.find((t: Json) => t.id === tech('Kevin Doyle'));
    expect(kevin.stopBefore).toMatchObject({ jobNumber: job.jobNumber, area });
    expect(minutes(kevin.stopBefore.plannedArrival)).toBe(minutes(job.plannedArrival as string));
    const idle = answer.technicians.filter((t: Json) => t.id !== tech('Kevin Doyle') && t.stopBefore === null);
    expect(idle.length).toBeGreaterThan(0);
    expect(answer.serviceSkill).toBe('heating_cooling');
  });

  // why: FR-DISP-28 (the order is SD-26's: skill match, then minutes from the stop before, then load ratio, then name; a technician without the skill comes last, not suggested)
  it('orders the technicians as SD-26 sets, checked by an independent function over the answer\'s own facts', async () => {
    await book(date, 'two_hour 08:00', 'Luis Ortega');
    await book(date, 'two_hour 08:00', 'Maria Santos');
    const answer = await ask(nextCustomer(), 'two_hour 12:00', 'plumbing_repair');
    const need: string = answer.serviceSkill;
    const match = (t: Json) => (t.skills[0] === need ? 0 : t.skills.includes(need) ? 1 : 2);
    const ratio = (t: Json) => (t.load.capacity > 0 ? t.load.jobs / t.load.capacity : 1);
    const group = (t: Json) => (match(t) === 2 ? 2 : t.room ? 0 : 1);
    const expected = [...answer.technicians].sort((a: Json, b: Json) => group(a) - group(b) || match(a) - match(b) || a.minutesFromStopBefore - b.minutesFromStopBefore
      || ratio(a) - ratio(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1)).map((t: Json) => t.id);
    expect(answer.technicians.map((t: Json) => t.id)).toEqual(expected);
    expect(answer.technicians.filter((t: Json) => t.room && t.suggested).length).toBeGreaterThanOrEqual(3);
    for (const t of answer.technicians.filter((x: Json) => match(x) === 2)) expect(t).toMatchObject({ suggested: false, reason: 'skill_missing' });
  });
});
