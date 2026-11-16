// SPDX-License-Identifier: AGPL-3.0-or-later
// The office writes (SPECIFICATIONS section 5.3, SD-14) on the real database (PostgreSQL 18, the migrated schema, P2-SEED's
// reference seed) through the production kernel (createWebKernel: the real policy table, handlers, SQL sessions and the
// clock) as the web process's login bw_web, with dispatchers whose sessions the real session layer created, and the
// notices read by a real LISTEN connection. The demo clock is the seeded Tue, Sep 15, 2026, 7:00 AM.
// The 2-transaction barrier races (invariant 3) are gate G-CI3's: ci/gates/G-CI3/barrier.db.test.ts.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { moveJobsToCustomer } from './service.ts';
import { readBranch, readDayKind, readWindow, officeWindowRoom, branchWindows, windowOffered } from './day.ts';
import { caller, listen, officeWorld, type Caller, type OfficeWorld, type Staff } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let ana: Staff;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 60);
  api = caller(world.kernel);
  ({ keisha, ana } = world.staff);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

interface Job { jobNumber: number; technicianId: string | null; version: number; plannedArrival: string | null; date: string; windowId: string }
interface Problem { code: string; status: number; [k: string]: unknown }

const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;
const nextCustomer = () => world.customers[customer++ % world.customers.length] as string;
const body = async <T>(r: Response): Promise<T> => ((await r.json()) as { data: T }).data;
const problem = async (r: Response): Promise<Problem> => (await r.json()) as Problem;
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0]?.n);

function create(input: { date: string; window: string; technician?: string | null; service?: string }, who: Staff = keisha) {
  return api.post('/jobs', {
    customerId: nextCustomer(), serviceId: input.service ?? 'furnace_tune_up', equipmentId: null, problem: null,
    date: input.date, windowId: win(input.window), technicianId: input.technician ? tech(input.technician) : null,
  }, who);
}
async function created(input: Parameters<typeof create>[0]): Promise<Job> {
  const r = await create(input);
  if (r.status !== 201) throw new Error(`create answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return (await body<{ job: Job }>(r)).job;
}
const assign = (job: number, technician: string | null, baseVersion: number, who: Staff = keisha) =>
  api.post(`/jobs/${job}/assignment`, { technicianId: technician ? tech(technician) : null, baseVersion }, who);

describe('per-window capacity (FR-BOOK-6)', () => {
  // why: FR-BOOK-6, FR-DISP-8
  it("refuses the 13th booking for Columbus's first window on Sep 15 with window_full, and the next window still takes one", async () => {
    for (let i = 1; i <= 12; i++) expect([i, (await create({ date: '2026-09-15', window: 'two_hour 08:00' })).status]).toEqual([i, 201]);
    const thirteenth = await create({ date: '2026-09-15', window: 'two_hour 08:00' });
    expect([thirteenth.status, (await problem(thirteenth)).code]).toEqual([409, 'window_full']);
    expect(await count(`SELECT count(*) AS n FROM world.job WHERE date = '2026-09-15' AND window_id = $1 AND status <> 'canceled'`, [win('two_hour 08:00')])).toBe(12);
    expect((await create({ date: '2026-09-15', window: 'two_hour 10:00' })).status).toBe(201);
  });

  // why: FR-BOOK-6
  it('holds the seeded Columbus limits 12, 12, 11, 11 and 10 in time order', async () => {
    const caps = await rows<{ capacity: number }>(
      `SELECT capacity FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' ORDER BY start_local`);
    expect(caps.map((c) => c.capacity)).toEqual([12, 12, 11, 11, 10]);
  });
});

describe('technician capacity (FR-BOOK-5)', () => {
  // why: FR-BOOK-5, FR-BOOK-3
  it('with every Columbus technician capacity used on the 4-hour day Wed Sep 16, offers no window that day and refuses each', async () => {
    const date = '2026-09-16';
    // 6 a technician on a 4-hour day; installers count only for installs (FR-BOOK-5). No time off is seeded.
    const working = await count(`SELECT count(*) AS n FROM world.technician WHERE branch_id = 'columbus' AND NOT installer AND 3 = ANY(working_days)`);
    expect(working).toBe(11);
    const capacity = working * 6;
    const fourHour = ['four_hour 08:00', 'four_hour 10:00', 'four_hour 12:00', 'four_hour 14:00'];
    // The fixture books all but 1 place directly; the last place goes through the office write.
    await db.admin().query(
      `INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version,
                              expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
       SELECT c.id, 'columbus', 'furnace_tune_up', $1::date, 'America/New_York', w.id,
              ($1::date + w.start_local) AT TIME ZONE 'America/New_York', ($1::date + w.end_local) AT TIME ZONE 'America/New_York',
              'scheduled', 1, 60, 'seed', now(), 'not_sent', false, false, false
         FROM generate_series(1, $2::int) AS g
         JOIN LATERAL (SELECT id FROM world.customer ORDER BY id OFFSET g % 40 LIMIT 1) c ON true
         JOIN LATERAL (SELECT id, start_local, end_local FROM world.arrival_window
                        WHERE branch_id = 'columbus' AND mode = 'four_hour' ORDER BY start_local OFFSET g % 4 LIMIT 1) w ON true`,
      [date, capacity - 1]);
    expect((await create({ date, window: 'four_hour 08:00' })).status).toBe(201);
    for (const w of fourHour) {
      const r = await create({ date, window: w });
      expect([w, r.status, (await problem(r)).code]).toEqual([w, 409, 'window_full']);
    }
    // What availability will read (the same windowRoom, under no lock): every offered window of the day has 0 room.
    const rooms = await inTransaction(world.web, async (tx) => {
      const kind = await readDayKind(tx, 'columbus', date);
      const offered = (await branchWindows(tx, 'columbus')).filter((w) => windowOffered(w, kind));
      return Promise.all(offered.map(async (w) => officeWindowRoom(tx, { branch: 'columbus', date, window: w, kind, install: false })));
    });
    expect(rooms).toEqual([0, 0, 0, 0]);
  });
});

describe('the version gate and Move it anyway (FR-DISP-2, FR-DISP-6; D15)', () => {
  // why: FR-DISP-6, FR-DISP-2
  it('answers a stale baseVersion with version_conflict naming the other change, and Move it anyway resends with currentVersion', async () => {
    const job = await created({ date: '2026-09-17', window: 'two_hour 10:00' });
    expect(job).toMatchObject({ technicianId: null, version: 1, plannedArrival: null });
    const first = await assign(job.jobNumber, 'Kevin Doyle', 1, keisha);
    expect(first.status).toBe(200);
    const moved = (await body<{ job: Job }>(first)).job;
    expect(moved).toMatchObject({ technicianId: tech('Kevin Doyle'), version: 2 });
    expect(moved.plannedArrival).toMatch(/^2026-09-17T10:00:00-04:00\[America\/New_York\]$/);

    const second = await assign(job.jobNumber, 'Marcus Bell', 1, ana);
    expect(second.status).toBe(409);
    const p = await problem(second);
    expect(p).toMatchObject({
      code: 'version_conflict', by: 'Keisha Thompson', byKind: 'office', change: 'assigned', technician: 'Kevin Doyle', currentVersion: 2,
    });
    expect(p.at).toMatch(/^2026-09-15T\d\d:\d\d.*\[America\/New_York\]$/);
    // The refused write changed nothing: 1 technician, version 2, 2 history rows.
    expect(await rows(`SELECT technician_id, version FROM world.job WHERE job_number = $1`, [job.jobNumber])).toEqual([{ technician_id: tech('Kevin Doyle'), version: 2 }]);
    expect(await count('SELECT count(*) AS n FROM world.job_change WHERE job_number = $1', [job.jobNumber])).toBe(2);

    const anyway = await assign(job.jobNumber, 'Marcus Bell', p.currentVersion as number, ana);
    expect(anyway.status).toBe(200);
    expect((await body<{ job: Job }>(anyway)).job).toMatchObject({ technicianId: tech('Marcus Bell'), version: 3 });
  });

  // why: FR-DISP-2, GAP-12
  it('refuses a technician with no room (technician_no_room) and one who does not work the day (rule_refused)', async () => {
    const a = await created({ date: '2026-09-21', window: 'two_hour 08:00', technician: 'Greg Hoffman' });
    const b = await created({ date: '2026-09-21', window: 'two_hour 08:00', technician: 'Greg Hoffman' });
    expect([a.technicianId, b.technicianId]).toEqual([tech('Greg Hoffman'), tech('Greg Hoffman')]);
    const third = await created({ date: '2026-09-21', window: 'two_hour 08:00' });
    const full = await assign(third.jobNumber, 'Greg Hoffman', 1);
    const fullProblem = await problem(full); // a Response body is read once (F-1803)
    expect([full.status, fullProblem.code]).toEqual([409, 'technician_no_room']); // 2 in a 2-hour window (SD-27)
    expect(fullProblem).toMatchObject({ limit: 'window', max: 2 }); // F-1701: the refusal names the window's limit
    // Chris Yoder works Monday to Thursday; Fri Sep 25 is not his day.
    const friday = await created({ date: '2026-09-25', window: 'two_hour 08:00' });
    const off = await assign(friday.jobNumber, 'Chris Yoder', 1);
    expect([off.status, (await problem(off)).code]).toEqual([409, 'rule_refused']);
  });
});

describe('planned arrivals for both days (SD-15)', () => {
  // why: SD-15, FR-DISP-2
  it('recomputes the old and the new technician day on a reassign, without bumping any other job version', async () => {
    const a = await created({ date: '2026-09-22', window: 'two_hour 08:00', technician: 'Jamal Carter', service: 'heating_or_ac_fix' });
    const b = await created({ date: '2026-09-22', window: 'two_hour 08:00', technician: 'Jamal Carter' });
    const planned = async (n: number) => (await rows<{ planned_arrival: Date | null; version: number }>(
      'SELECT planned_arrival, version FROM world.job WHERE job_number = $1', [n]))[0]!;
    const bBefore = await planned(b.jobNumber);
    // b follows a: a's 90 minutes and the drive put b well after 9:30 AM.
    expect(bBefore.planned_arrival!.getTime()).toBeGreaterThan(Date.parse('2026-09-22T13:30:00Z'));
    const r = await assign(a.jobNumber, 'Dave Kowalski', a.version);
    expect(r.status).toBe(200);
    const bAfter = await planned(b.jobNumber);
    expect(bAfter.planned_arrival!.getTime()).toBeLessThan(Date.parse('2026-09-22T12:30:00Z')); // first stop now: about 8:0x AM
    expect(bAfter.version).toBe(bBefore.version);
    expect((await planned(a.jobNumber)).planned_arrival).not.toBeNull();
    // Unassigned: no planned arrival (section 3).
    const u = await assign(a.jobNumber, null, a.version + 1);
    expect((await body<{ job: Job }>(u)).job).toMatchObject({ technicianId: null, plannedArrival: null });
  });
});

describe('blocks (FR-DISP-34; OA-72, OA-74, OA-75)', () => {
  interface Block { blockId: string; technicianId: string; start: string; end: string; version: number }
  const kevin = () => tech('Kevin Doyle');
  const moveBlock = (b: string, start: string, end: string, baseVersion: number, who: Staff = keisha, technician = kevin()) =>
    api.post(`/time-blocks/${b}/move`, { technicianId: technician, start, end, baseVersion }, who);

  // why: FR-DISP-34
  it('creates Supply run for Kevin Doyle on Sep 15 at 1:00 PM, moves it to 2:00 PM, refuses overlaps both ways, and delete frees the time', async () => {
    const c = await api.post('/time-blocks', { technicianId: kevin(), date: '2026-09-15', label: 'Supply run', place: 'Supply house', start: '13:00', end: '13:30' }, keisha);
    expect(c.status).toBe(201);
    const block = (await body<{ block: Block }>(c)).block;
    expect(block).toMatchObject({ technicianId: kevin(), version: 1, start: '2026-09-15T13:00:00-04:00[America/New_York]', end: '2026-09-15T13:30:00-04:00[America/New_York]' });
    const m = await moveBlock(block.blockId, '14:00', '14:30', 1);
    expect(m.status).toBe(200);
    expect((await body<{ block: Block }>(m)).block).toMatchObject({ version: 2, start: '2026-09-15T14:00:00-04:00[America/New_York]', end: '2026-09-15T14:30:00-04:00[America/New_York]' });

    // A new job whose planned time (2:00 to 3:00 PM) would overlap the block is refused, naming the block; nothing is written.
    const before = await count('SELECT count(*) AS n FROM world.job');
    const over = await create({ date: '2026-09-15', window: 'two_hour 14:00', technician: 'Kevin Doyle' });
    const p = await problem(over);
    expect([over.status, p.code]).toEqual([409, 'time_overlap']);
    expect(p.block).toMatchObject({ blockId: block.blockId, label: 'Supply run', place: 'Supply house' });
    expect(p.job).toMatchObject({ plannedArrival: '2026-09-15T14:00:00-04:00[America/New_York]' });
    expect(await count('SELECT count(*) AS n FROM world.job')).toBe(before);

    // Moving the block over a job's planned time (12:00 to 1:00 PM) is refused too, naming the job.
    const noon = await created({ date: '2026-09-15', window: 'two_hour 12:00', technician: 'Kevin Doyle' });
    const onJob = await moveBlock(block.blockId, '12:30', '13:00', 2);
    const q = await problem(onJob);
    expect([onJob.status, q.code, (q.job as { jobNumber: number }).jobNumber]).toEqual([409, 'time_overlap', noon.jobNumber]);

    // 2 dispatchers move it at once from version 2: the second sees the named message and the block is at 1 place.
    expect((await moveBlock(block.blockId, '15:00', '15:30', 2, keisha)).status).toBe(200);
    const late = await moveBlock(block.blockId, '16:00', '16:30', 2, ana);
    expect([late.status, await problem(late)]).toEqual([409, expect.objectContaining({ code: 'version_conflict', technician: 'Kevin Doyle', currentVersion: 3 })]);
    expect(await rows(`SELECT to_char(start AT TIME ZONE 'America/New_York', 'HH24:MI') AS at FROM world.time_block WHERE id = $1`, [block.blockId])).toEqual([{ at: '15:00' }]);

    // Delete frees the time: the 2:00 PM job the block refused goes in now that it is at 3:00, and again once it is gone.
    const blocked = await create({ date: '2026-09-15', window: 'two_hour 14:00', technician: 'Kevin Doyle', service: 'heating_or_ac_fix' });
    expect([blocked.status, (await problem(blocked)).code]).toEqual([409, 'time_overlap']);
    const d = await api.del(`/time-blocks/${block.blockId}`, keisha);
    expect(d.status).toBe(204);
    expect(await count('SELECT count(*) AS n FROM world.time_block WHERE id = $1', [block.blockId])).toBe(0);
    expect((await create({ date: '2026-09-15', window: 'two_hour 14:00', technician: 'Kevin Doyle', service: 'heating_or_ac_fix' })).status).toBe(201);
    const again = await api.del(`/time-blocks/${block.blockId}`, keisha);
    expect([again.status, (await problem(again)).code]).toEqual([404, 'not_found']);
  });

  // why: FR-DISP-34 (owner ruling 8ef38e83, F-354) the block change log names who moved the block and when
  it('writes 1 block change log row per move, and answers a conflicting move with that row, not with nulls', async () => {
    const c = await api.post('/time-blocks', { technicianId: kevin(), date: '2026-10-28', label: 'Supply run', place: 'Supply house', start: '13:00', end: '13:30' }, keisha);
    const block = (await body<{ block: Block }>(c)).block;
    expect(await count('SELECT count(*) AS n FROM world.time_block_change WHERE block_id = $1', [block.blockId])).toBe(0);
    expect((await moveBlock(block.blockId, '14:00', '14:30', 1, keisha)).status).toBe(200);
    // A refused move (an overlap) is rolled back with its log row: still 1 row.
    await created({ date: '2026-10-28', window: 'two_hour 10:00', technician: 'Kevin Doyle' });
    const refused = await moveBlock(block.blockId, '10:00', '10:30', 2, keisha);
    expect((await problem(refused)).code).toBe('time_overlap');
    const log = await rows<{ actor_user_id: string; actor_kind: string; kind: string; from_version: number; to_version: number; at: Date; data: { to: { start: string } } }>(
      'SELECT actor_user_id, actor_kind, kind, from_version, to_version, at, data FROM world.time_block_change WHERE block_id = $1', [block.blockId]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_user_id: keisha.userId, actor_kind: 'office', kind: 'moved', from_version: 1, to_version: 2 });
    expect(log[0]?.data.to.start).toBe('2026-10-28T14:00:00-04:00[America/New_York]');

    const late = await moveBlock(block.blockId, '16:00', '16:30', 1, ana);
    const p = await problem(late);
    expect([late.status, p.code]).toEqual([409, 'version_conflict']);
    expect(p).toMatchObject({ by: keisha.name, byKind: 'office', change: 'moved', technician: 'Kevin Doyle', currentVersion: 2 });
    expect(Date.parse(String(p.at).replace(/\[.*\]$/, ''))).toBe(log[0]?.at.getTime());
    // The app role may append to the log and read it, never change or remove a row.
    for (const sql of ["UPDATE world.time_block_change SET kind = 'x'", 'DELETE FROM world.time_block_change']) {
      await expect(db.asRole('app', (q) => q.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });

  // why: F-378
  it('deletes a block on a day where another block already overlaps a job, answering 204 and keeping the other block', async () => {
    const date = '2026-10-27';
    await created({ date, window: 'two_hour 10:00', technician: 'Kevin Doyle', service: 'heating_or_ac_fix' });
    const mine = (await body<{ block: Block }>(await api.post('/time-blocks', { technicianId: kevin(), date, label: 'Mine', place: null, start: '15:00', end: '15:30' }, keisha))).block;
    // The overlap a merge writes by design: a block over the job's planned time, put in by the database.
    await rows(`INSERT INTO world.time_block (technician_id, date, zone, start, "end", label, place, version, seeded)
                SELECT technician_id, date, zone, start - interval '5 hours', start - interval '4 hours 30 minutes', 'Over the job', place, 1, false FROM world.time_block WHERE id = $1`, [mine.blockId]);
    await rows(`UPDATE world.time_block SET start = (SELECT planned_arrival FROM world.job WHERE technician_id = $1 AND date = $2 ORDER BY job_number DESC LIMIT 1),
                "end" = (SELECT planned_arrival + interval '30 minutes' FROM world.job WHERE technician_id = $1 AND date = $2 ORDER BY job_number DESC LIMIT 1) WHERE label = 'Over the job' AND date = $2`, [kevin(), date]);
    const d = await api.del(`/time-blocks/${mine.blockId}`, keisha);
    expect(d.status).toBe(204);
    expect(await count(`SELECT count(*) AS n FROM world.time_block WHERE label = 'Over the job' AND date = $1`, [date])).toBe(1);
  });

  // why: FR-DISP-34, FR-BOOK-5
  it("does not count a block in the technician's daily capacity: 5 jobs and a block fit, the 6th job does not", async () => {
    const date = '2026-09-23';
    const c = await api.post('/time-blocks', { technicianId: kevin(), date, label: 'Pickup', place: null, start: '17:00', end: '17:30' }, keisha);
    expect(c.status).toBe(201);
    for (const w of ['08:00', '10:00', '12:00', '14:00', '16:00']) {
      expect([w, (await create({ date, window: `two_hour ${w}`, technician: 'Kevin Doyle' })).status]).toEqual([w, 201]);
    }
    const sixth = await create({ date, window: 'two_hour 10:00', technician: 'Kevin Doyle' });
    const sixthProblem = await problem(sixth); // a Response body is read once (F-1803)
    expect([sixth.status, sixthProblem.code]).toEqual([409, 'technician_no_room']);
    expect(sixthProblem).toMatchObject({ limit: 'day', max: 5 }); // F-1701: the day's limit, with its number
  });

  // why: F-1701 the owner moved a job to the installer and the refusal did not say why; an installer's day full is named installer_day with max 1, on a move and on a create
  it('names the installer day as the limit that refused a move to the installer (F-1701)', async () => {
    const date = '2026-09-22';
    await created({ date, window: 'two_hour 08:00', technician: 'Chris Yoder' });
    const other = await created({ date, window: 'two_hour 12:00' });
    const move = await assign(other.jobNumber, 'Chris Yoder', 1);
    const moveProblem = await problem(move); // a Response body is read once (F-1803)
    expect([move.status, moveProblem.code]).toEqual([409, 'technician_no_room']);
    expect(moveProblem).toMatchObject({ limit: 'installer_day', max: 1 });
    const again = await create({ date, window: 'two_hour 14:00', technician: 'Chris Yoder' });
    expect(await problem(again)).toMatchObject({ code: 'technician_no_room', limit: 'installer_day', max: 1 });
  });
});

describe('an office write marks the job touched by a person (SD-21; F-423)', () => {
  const touched = async (n: number) => (await rows<{ touched_by_person: boolean }>('SELECT touched_by_person FROM world.job WHERE job_number = $1', [n]))[0]!.touched_by_person;
  const untouch = (n: number) => rows('UPDATE world.job SET touched_by_person = false WHERE job_number = $1', [n]);

  // why: F-423
  it('sets touched_by_person on an assign and on a reschedule', async () => {
    const job = await created({ date: '2026-10-06', window: 'two_hour 08:00' });
    await untouch(job.jobNumber);
    expect((await assign(job.jobNumber, 'Kevin Doyle', 1)).status).toBe(200);
    expect(await touched(job.jobNumber)).toBe(true);
    await untouch(job.jobNumber);
    const moved = await api.post(`/jobs/${job.jobNumber}/schedule`, { date: '2026-10-07', windowId: win('two_hour 10:00'), baseVersion: 2 }, keisha);
    expect(moved.status).toBe(200);
    expect(await touched(job.jobNumber)).toBe(true);
  });
});

describe('reschedule (SD-45; FR-BOOK-3)', () => {
  const reschedule = (job: number, date: string, window: string, baseVersion: number) =>
    api.post(`/jobs/${job}/schedule`, { date, windowId: win(window), baseVersion }, keisha);

  // why: SD-45, FR-DISP-34
  it('keeps the technician who works the new day with room, and makes the job Unassigned when they have time off', async () => {
    const job = await created({ date: '2026-09-28', window: 'two_hour 08:00', technician: 'Ryan Mitchell' });
    const kept = await reschedule(job.jobNumber, '2026-09-29', 'two_hour 10:00', 1);
    expect(kept.status).toBe(200);
    const k = await body<{ job: Job; outcome: { technicianKept: boolean; textSent: boolean } }>(kept);
    expect(k).toMatchObject({ job: { date: '2026-09-29', technicianId: tech('Ryan Mitchell'), version: 2 }, outcome: { technicianKept: true, textSent: false } });
    expect(k.job.plannedArrival).toMatch(/^2026-09-29T10:00/);
    const off = await rows<{ id: string }>(`SELECT id FROM world."user" WHERE email = 'keisha.t@brightwater.example'`);
    await db.admin().query(`INSERT INTO world.time_off (technician_id, from_date, to_date, created_by) VALUES ($1, '2026-09-30', '2026-09-30', $2)`, [tech('Ryan Mitchell'), off[0]!.id]);
    const moved = await reschedule(job.jobNumber, '2026-09-30', 'two_hour 10:00', 2);
    expect(await body(moved)).toMatchObject({ job: { date: '2026-09-30', technicianId: null, plannedArrival: null, version: 3 }, outcome: { technicianKept: false } });
    const history = await rows<{ kind: string; from_version: number; to_version: number; data: unknown }>(
      'SELECT kind, from_version, to_version, data FROM world.job_change WHERE job_number = $1 ORDER BY to_version', [job.jobNumber]);
    expect(history.map((h) => [h.kind, h.from_version, h.to_version])).toEqual([['created', 0, 1], ['rescheduled', 1, 2], ['rescheduled', 2, 3]]);
    expect(history[2]!.data).toEqual({
      from: { date: '2026-09-29', windowId: win('two_hour 10:00'), technicianId: tech('Ryan Mitchell') },
      to: { date: '2026-09-30', windowId: win('two_hour 10:00'), technicianId: null },
    });
  });

  // why: FR-BOOK-3, FR-BOOK-10, FR-DISP-6
  it('refuses a full window, a past day, a Sunday, a window the day does not offer, and a stale version', async () => {
    const job = await created({ date: '2026-09-28', window: 'two_hour 12:00' });
    const code = async (r: Promise<Response>) => { const x = await r; return [x.status, (await problem(x)).code]; };
    expect(await code(reschedule(job.jobNumber, '2026-09-15', 'two_hour 08:00', 1))).toEqual([409, 'window_full']); // filled above (FR-BOOK-6)
    expect(await code(reschedule(job.jobNumber, '2026-09-14', 'two_hour 08:00', 1))).toEqual([409, 'day_past']);
    expect(await code(reschedule(job.jobNumber, '2026-09-20', 'two_hour 08:00', 1))).toEqual([409, 'day_closed']);
    expect(await code(reschedule(job.jobNumber, '2026-09-28', 'four_hour 08:00', 1))).toEqual([409, 'rule_refused']);
    expect(await code(reschedule(job.jobNumber, '2026-09-26', 'two_hour 12:00', 1))).toEqual([409, 'rule_refused']); // Saturday: mornings only
    expect(await code(reschedule(job.jobNumber, '2026-09-29', 'two_hour 12:00', 7))).toEqual([409, 'version_conflict']);
    expect(await count('SELECT count(*) AS n FROM world.job_change WHERE job_number = $1', [job.jobNumber])).toBe(1);
  });
});

describe('every write appends exactly 1 job_change row and sends exactly 1 notice, ids only (section 4.3)', () => {
  // why: FR-DISP-5, NFR-01, SD-14
  it('counts 1 history row and 1 notice per job write, 1 notice and no history per block write, and nothing for a refusal', async () => {
    const bus = await listen(db.url());
    try {
      const changes = () => count('SELECT count(*) AS n FROM world.job_change');
      const c0 = await changes();
      const job = await created({ date: '2026-10-05', window: 'two_hour 08:00' });
      expect((await assign(job.jobNumber, 'Tom Reinhart', 1)).status).toBe(200);
      expect((await api.post(`/jobs/${job.jobNumber}/schedule`, { date: '2026-10-06', windowId: win('two_hour 08:00'), baseVersion: 2 }, keisha)).status).toBe(200);
      expect((await assign(job.jobNumber, 'Tom Reinhart', 1)).status).toBe(409); // refused: no row, no notice
      expect(await changes()).toBe(c0 + 3);
      const blk = await api.post('/time-blocks', { technicianId: tech('Tom Reinhart'), date: '2026-10-06', label: 'Pickup', place: null, start: '16:30', end: '17:00' }, keisha);
      const blockId = (await body<{ block: { blockId: string } }>(blk)).block.blockId;
      expect((await api.post(`/time-blocks/${blockId}/move`, { technicianId: tech('Tom Reinhart'), start: '16:45', end: '17:15', baseVersion: 1 }, keisha)).status).toBe(200);
      expect((await api.del(`/time-blocks/${blockId}`, keisha)).status).toBe(204);
      expect(await changes()).toBe(c0 + 3);
      expect(await bus.waitFor(6)).toBe(6);
      await new Promise((r) => setTimeout(r, 100));
      const job1 = { name: 'job.changed', ids: { jobNumber: job.jobNumber, branch: 'columbus' } };
      const blk1 = { name: 'block.changed', ids: { blockId, branch: 'columbus', date: '2026-10-06' } };
      expect(bus.notices).toEqual([job1, job1, job1, blk1, blk1, blk1]);
    } finally {
      await bus.end();
    }
  });
});

describe('the reads the writes use', () => {
  // why: FR-BOOK-7, FR-BOOK-10
  it('reads the branch zone and depot, the day kind and the window settings from the seed', async () => {
    const out = await inTransaction(world.web, async (tx) => ({
      branch: await readBranch(tx, 'columbus'),
      peak: await readDayKind(tx, 'columbus', '2026-09-16'),
      saturday: await readDayKind(tx, 'columbus', '2026-09-19'),
      first: await readWindow(tx, win('two_hour 08:00')),
    }));
    expect(out).toMatchObject({ branch: { zone: 'America/New_York' }, peak: 'four_hour', saturday: 'saturday', first: { mode: 'two_hour', capacity: 12, startLocal: '08:00:00' } });
  });
});

describe('what a moved or rescheduled job leaves behind (F-510)', () => {
  const trackFor = (job: number) => count(`SELECT count(*) AS n FROM world.van_track WHERE to_ref = $1`, [String(job)]);

  async function withTrack(date: string): Promise<{ job: Job; from: string }> {
    const job = await created({ date, window: 'two_hour 08:00', technician: 'Kevin Doyle' });
    const from = (await rows<{ customer_id: string; branch_id: string }>('SELECT customer_id, branch_id FROM world.job WHERE job_number = $1', [job.jobNumber]))[0]!;
    await rows(`INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id) VALUES ($1, 'depot', $2, '', '{0,60}', 100, 'test')`, [from.branch_id, String(job.jobNumber)]);
    return { job, from: from.customer_id };
  }
  const move = (job: number, from: string, to: string) =>
    // In a transaction, as every caller is: the day locks and their savepoint (F-379, F-622) need one.
    inTransaction(world.web, (tx) => moveJobsToCustomer(tx, { from, to, jobNumbers: [job], mergeId: '00000000-0000-4000-8000-000000000000', step: 'merge', by: null, at: new Date('2026-09-15T12:00:00Z') }));

  // why: F-510 a job moved to a customer at another point has no baked track, since the track ends at the old point; one moved to the same point keeps it
  it('drops the baked track of a job moved to a customer at another point and keeps it for the same point', async () => {
    const [a, b] = [nextCustomer(), nextCustomer()];
    await rows('UPDATE world.customer SET lon = -83.0, lat = 40.0 WHERE id = $1', [a]);
    await rows('UPDATE world.customer SET lon = -83.1, lat = 40.1 WHERE id = $1', [b]);
    const t1 = await withTrack('2026-10-13');
    await rows('UPDATE world.job SET customer_id = $2 WHERE job_number = $1', [t1.job.jobNumber, a]);
    await move(t1.job.jobNumber, a, b);
    expect(await trackFor(t1.job.jobNumber)).toBe(0);
    const t2 = await withTrack('2026-10-14');
    await rows('UPDATE world.job SET customer_id = $2 WHERE job_number = $1', [t2.job.jobNumber, a]);
    await rows('UPDATE world.customer SET lon = -83.0, lat = 40.0 WHERE id = $1', [b]);
    await move(t2.job.jobNumber, a, b);
    expect(await trackFor(t2.job.jobNumber)).toBe(1);
  });

  // why: F-510 late_text_sent_at is cleared by a reschedule that changes the visit, so the rescheduled job can get a second late text
  it('clears late_text_sent_at when a reschedule changes the day or the window', async () => {
    const job = await created({ date: '2026-10-15', window: 'two_hour 08:00', technician: 'Kevin Doyle' });
    await rows(`UPDATE world.job SET late_text_sent_at = '2026-09-15T12:00:00Z' WHERE job_number = $1`, [job.jobNumber]);
    const moved = await api.post(`/jobs/${job.jobNumber}/schedule`, { date: '2026-10-16', windowId: win('two_hour 10:00'), baseVersion: job.version }, keisha);
    expect(moved.status).toBe(200);
    expect((await rows<{ late_text_sent_at: Date | null }>('SELECT late_text_sent_at FROM world.job WHERE job_number = $1', [job.jobNumber]))[0]!.late_text_sent_at).toBeNull();
  });
});
