// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1933, FR-TEXT-5, SD-15 (an address edit that moves the customer's point plans the technician-days of their open jobs again)
// The customer edit (API-36) on the real database (PostgreSQL 18, the migrated schema, the reference seed), through the production kernel as bw_web. With no
// routing service and no track between these points, a leg's minutes are SD-22's approximate minutes, planDay's own default, so the fresh
// plan of a day is planDay over the rows as they stand. Interleavings are forced by a lock the test holds: a step waits until the other
// transaction is seen waiting for it (or is done, which is what code that takes no such lock does).
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { inTransaction, type Queryable } from '@bw/db';
import { planDay } from '@bw/domain';
import { mergePair } from '@bw/import';
import { Temporal } from '@bw/time';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { lockTechnicianDays } from './locks.ts';
import { moveJobsToCustomer } from './service.ts';
import { caller, listen, officeWorld, type OfficeWorld } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let runId: string;
/** A Columbus street whose first point lies farthest from the depot: an address there moves the drive minutes of a day. */
let far: string;

beforeAll(async () => {
  world = await officeWorld(db, 60);
  runId = (await rows<{ id: string }>(
    `INSERT INTO world.import_run (kind, status, stage, percent, started_at, finished_at, by_setup) VALUES ('real', 'done', 'done', 100, now(), now(), true) RETURNING id`))[0]!.id;
  far = (await rows<{ id: string }>(
    `SELECT s.id FROM world.street s JOIN world.branch b ON b.id = s.branch_id WHERE b.id = 'columbus'
      ORDER BY abs((s.points -> 0 ->> 0)::float8 - b.depot_lon) + abs((s.points -> 0 ->> 1)::float8 - b.depot_lat) DESC, s.id LIMIT 1`))[0]!.id;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
async function until(what: string, cond: () => Promise<boolean>): Promise<void> {
  const stop = performance.now() + 20_000;
  while (!(await cond())) if (performance.now() > stop) throw new Error(`timed out waiting for ${what}`);
}
/** Backends of this database waiting for a lock right now. */
const waiting = async () => Number((await rows<{ n: string }>(
  `SELECT count(DISTINCT l.pid) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database() AND NOT l.granted`))[0]!.n);

/** A call under way: whether it is done, and its answer ('ok', an HTTP status, or the error code a transaction got). */
function started(p: Promise<unknown>): { done: () => boolean; answer: Promise<string> } {
  let done = false;
  const answer = p.then(
    (v) => (v instanceof Response ? String(v.status) : 'ok'),
    (e: unknown) => String((e as { code?: string }).code ?? e),
  ).finally(() => { done = true; });
  return { done: () => done, answer };
}

/** A transaction as bw_web that has run `first` and then holds its locks until released. */
async function holding(first: (tx: Queryable) => Promise<unknown>): Promise<{ release: () => Promise<string> }> {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  let ready!: () => void;
  const held = new Promise<void>((r) => { ready = r; });
  const t = started(inTransaction(world.web, async (tx) => {
    await first(tx);
    ready();
    await opened;
  }));
  await Promise.race([held, t.answer.then((a) => { throw new Error(`the holding transaction ended early: ${a}`); })]);
  return { release: () => (open(), t.answer) };
}

const ZONE = 'America/New_York';
const TODAY = '2026-09-15'; // the reference seed's demo day
let days = 0;
/** A weekday of its own per use, so no case sees another's jobs. */
const newDay = () => Temporal.PlainDate.from('2026-10-05').add({ days: Math.floor(days / 4) * 7 + (days++ % 4) }).toString();
let customers = 0;
const newCustomer = () => world.customers[customers++]!;
const tech = (name: string) => world.technicians.get(name)!;

const INSERT_JOB = `INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, technician_id, status, version,
                                           expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
  VALUES ($1, 'columbus', 'furnace_tune_up', $2, '${ZONE}', $3, $4, $5, $6, $7, 1, 60, 'office', $8, 'not_sent', false, false, false) RETURNING job_number`;
type NewJob = { customer: string; technician: string; date: string; bookedAt?: string; status?: string };
const jobValues = (o: NewJob) => [o.customer, o.date, world.windows.get('two_hour 08:00'), `${o.date}T08:00:00-04:00`, `${o.date}T10:00:00-04:00`, o.technician,
  o.status ?? 'scheduled', o.bookedAt ?? '2026-09-14T12:00:00Z'];
const newJob = async (o: NewJob) => (await rows<{ job_number: number }>(INSERT_JOB, jobValues(o)))[0]!.job_number;

/** The plan of a technician-day as its rows stand now (SD-15): job number to planned arrival. */
async function freshPlan(technician: string, date: string): Promise<Map<number, number>> {
  const b = (await rows<{ lon: number; lat: number }>(`SELECT depot_lon AS lon, depot_lat AS lat FROM world.branch WHERE id = 'columbus'`))[0]!;
  const t = (await rows<{ s: string }>(`SELECT to_char(shift_start, 'HH24:MI') AS s FROM world.technician WHERE id = $1`, [technician]))[0]!;
  const jobs = await rows<{ job_number: number; window_start: Date; booked_at: Date; expected_minutes: number; lon: number; lat: number }>(
    `SELECT j.job_number, j.window_start, j.booked_at, j.expected_minutes, c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id
      WHERE j.technician_id = $1 AND j.date = $2 AND j.status <> 'canceled'`, [technician, date]);
  return new Map(planDay({
    shiftStart: Temporal.PlainDateTime.from(`${date}T${t.s}`).toZonedDateTime(ZONE).epochMilliseconds,
    depot: b,
    stops: jobs.map((j) => ({
      jobNumber: j.job_number, windowStart: j.window_start.getTime(), bookedAt: j.booked_at.getTime(), expectedMinutes: j.expected_minutes, point: { lon: j.lon, lat: j.lat },
    })),
  }).map((p) => [p.jobNumber, p.plannedArrival] as [number, number]));
}
const stored = async (technician: string, date: string) => new Map((await rows<{ n: number; at: Date | null }>(
  `SELECT job_number AS n, planned_arrival AS at FROM world.job WHERE technician_id = $1 AND date = $2 AND status <> 'canceled'`, [technician, date]))
  .map((j) => [j.n, j.at?.getTime() ?? null] as [number, number | null]));
/** Write the fresh plan of a day, as the write that placed its jobs would have. */
async function settle(technician: string, date: string): Promise<void> {
  for (const [n, at] of await freshPlan(technician, date)) await rows('UPDATE world.job SET planned_arrival = $2 WHERE job_number = $1', [n, new Date(at)]);
}
const sorted = <T>(m: Map<number, T>) => [...m].sort((x, y) => x[0] - y[0]);
async function expectPlanned(technician: string, date: string): Promise<void> {
  expect(sorted(await stored(technician, date))).toEqual(sorted(await freshPlan(technician, date)));
}

const edit = (customer: string, body: unknown = { streetId: far, houseNumber: 1 }) => caller(world.kernel).patch(`/customers/${customer}`, body, world.staff.keisha);

/** A settled day of 2 jobs: the mover's first, then another customer's, whose arrival hangs on the drive from the mover's. */
async function dayOfTwo(technician: string, date: string, mover = newCustomer(), status = 'scheduled'): Promise<{ mover: string; job: number; second: number }> {
  const job = await newJob({ customer: mover, technician, date, status });
  const second = await newJob({ customer: newCustomer(), technician, date, bookedAt: '2026-09-14T13:00:00Z' });
  await settle(technician, date);
  return { mover, job, second };
}

describe('API-36: an address edit that moves the point (F-1933)', () => {
  // why: F-1933, SD-15 the day's planned arrivals follow the new point at once, and an open board hears 1 board.refresh, with no job version, history row or job.changed
  it('plans the technician-day of the customer\'s open job again from the new point', async () => {
    const [t, date] = [tech('Kevin Doyle'), newDay()];
    const { mover, job, second } = await dayOfTwo(t, date);
    const before = await stored(t, date);
    const bus = await listen(db.url());
    try {
      const r = await edit(mover);
      expect(r.status, await r.clone().text()).toBe(200);
      expect((await freshPlan(t, date)).get(second), 'the edit must move the 2nd arrival, or this case proves nothing').not.toBe(before.get(second));
      await expectPlanned(t, date);
      await bus.waitFor(1);
      expect(bus.notices.map((n) => [n.name, n.ids])).toEqual([['board.refresh', { branch: 'columbus' }]]);
    } finally {
      await bus.end();
    }
    expect((await rows('SELECT version, touched_by_person FROM world.job WHERE job_number = $1', [job]))[0]).toEqual({ version: 1, touched_by_person: false });
    expect(await rows('SELECT 1 FROM world.job_change WHERE job_number = ANY($1)', [[job, second]])).toEqual([]);
  });

  // why: F-1933, SD-15 today is a day the edit plans again, and so is every later day that holds an open job of the customer
  it('plans every day from today on that holds an open job of the customer', async () => {
    const [t1, t2, date] = [tech('Kevin Doyle'), tech('Greg Hoffman'), newDay()];
    const { mover } = await dayOfTwo(t1, date);
    await dayOfTwo(t2, TODAY, mover, 'on_the_way');
    const before = sorted(await stored(t2, TODAY));
    expect((await edit(mover)).status).toBe(200);
    expect(sorted(await stored(t2, TODAY))).not.toEqual(before);
    await expectPlanned(t2, TODAY);
    await expectPlanned(t1, date);
  });

  // why: F-1933 an edit that keeps the point (the same address, another house number on the same point, or another field) writes no planned arrival
  it('writes no planned arrival when the point stays', async () => {
    const [t, date] = [tech('Kevin Doyle'), newDay()];
    const { mover } = await dayOfTwo(t, date);
    expect((await edit(mover)).status).toBe(200);
    const mark = new Date(`${date}T15:00:00Z`);
    await rows('UPDATE world.job SET planned_arrival = $3 WHERE technician_id = $1 AND date = $2', [t, date, mark]);
    const n = (await rows<{ n: number }>('SELECT jsonb_array_length(points) AS n FROM world.street WHERE id = $1', [far]))[0]!.n;
    for (const body of [{ streetId: far, houseNumber: 1 }, { houseNumber: 1 + n }, { name: 'Another Name' }]) {
      expect((await edit(mover, body)).status).toBe(200);
      expect([...(await stored(t, date)).values()]).toEqual([mark.getTime(), mark.getTime()]);
    }
  });

  // why: F-1933 a day already past, and a day the customer has only an ended or a canceled job on, keep the plan they ran on
  it('leaves a past day, an ended job and a canceled job as they were', async () => {
    const t = tech('Kevin Doyle');
    const mover = newCustomer();
    const cases: [string, string][] = [['2026-09-14', 'scheduled'], ['2026-09-11', 'done'], [newDay(), 'done'], [newDay(), 'no_one_home'], [newDay(), 'canceled']];
    for (const [date, status] of cases) await dayOfTwo(t, date, mover, status);
    const all = async () => {
      const out = [];
      for (const [date] of cases) out.push(sorted(await stored(t, date)));
      return out;
    };
    const before = await all();
    expect((await edit(mover)).status).toBe(200);
    expect(await all()).toEqual(before);
  });

  // why: F-1933 an overlap the new plan makes with a block is no refusal (API-36 answers no time_overlap): the plan is written and the board shows it
  it('is not refused by a block the new plan runs into', async () => {
    const [t, date] = [tech('Kevin Doyle'), newDay()];
    const { mover } = await dayOfTwo(t, date);
    await rows(`INSERT INTO world.time_block (technician_id, date, zone, label, place, start, "end", version, seeded) VALUES ($1, $2, 'America/New_York', 'Truck service', NULL, $3, $4, 1, false)`,
      [t, date, `${date}T08:00:00-04:00`, `${date}T17:00:00-04:00`]);
    expect((await edit(mover)).status).toBe(200);
    await expectPlanned(t, date);
  });
});

const pair = async (a: string, b: string) => (await rows<{ id: string }>(
  `INSERT INTO world.duplicate_pair (run_id, kind, why, record_a, record_b, status) VALUES ($1, 'likely', 'name', $2, $3, 'listed') RETURNING id`, [runId, a, b]))[0]!.id;
const merge = (pairId: string) => inTransaction(world.web, (tx) => mergePair(tx, pairId, { kind: 'office', at: new Date('2026-09-15T12:00:00Z'), by: null, jobs: moveJobsToCustomer }));
const assign = (job: number, technicianId: string) => caller(world.kernel).post(`/jobs/${job}/assignment`, { technicianId, baseVersion: 1 }, world.staff.ana);
const dayLock = (technicianId: string, date: string) => (tx: Queryable) => lockTechnicianDays(tx, [{ technicianId, date }]);
const customerLock = (id: string) => (tx: Queryable) => tx.query('SELECT 1 FROM world.customer WHERE id = $1 FOR UPDATE', [id]);

/** Start the edit and another call, in the order asked, each until it waits or is done, while the test holds a lock; then let go: [edit, other]. */
async function race(hold: (tx: Queryable) => Promise<unknown>, editFirst: boolean, doEdit: () => Promise<unknown>, other: () => Promise<unknown>): Promise<[string, string]> {
  const h = await holding(hold);
  const going: ReturnType<typeof started>[] = [];
  for (const c of editFirst ? [doEdit, other] : [other, doEdit]) {
    going.push(started(c()));
    await until('the call to wait for a lock or be done', async () => (await waiting()) >= going.filter((g) => !g.done()).length);
  }
  expect(await h.release()).toBe('ok');
  const got = await Promise.all(going.map((g) => g.answer));
  return (editFirst ? got : got.reverse()) as [string, string];
}

describe('API-36 against a merge and an office move of the same job (F-1933; section 5.3 steps 2 and 6)', () => {
  // why: F-1933, F-379, F-622 an edit of the customer a merge takes away never deadlocks with the merge, whichever is first and whichever lock they meet at, and the day ends on the plan of the point that stands
  it.each([
    ['the day', true], ['the day', false], ['the customer row', true], ['the customer row', false],
  ])('ends with no deadlock against a merge of the customer: meeting at %s, edit first %s', async (at, editFirst) => {
    const [t, date] = [tech('Kevin Doyle'), newDay()];
    const { mover, job } = await dayOfTwo(t, date);
    const pairId = await pair(newCustomer(), mover);
    const [e, m] = await race(at === 'the day' ? dayLock(t, date) : customerLock(mover), editFirst, () => edit(mover), () => merge(pairId));
    expect(m).toBe('ok');
    expect(['200', '404'], 'the edit is done, or finds its customer merged away').toContain(e);
    expect((await rows<{ customer_id: string }>('SELECT customer_id FROM world.job WHERE job_number = $1', [job]))[0]!.customer_id).not.toBe(mover);
    await expectPlanned(t, date);
  });

  // why: F-1933, F-379, F-622 an edit of the record a merge keeps plans the job the merge brings as well as its own, whichever is first
  it.each([true, false])('ends with no deadlock against a merge into the customer: edit first %s', async (editFirst) => {
    const [t, t2, date] = [tech('Kevin Doyle'), tech('Greg Hoffman'), newDay()];
    const { mover } = await dayOfTwo(t, date);
    const { mover: other } = await dayOfTwo(t2, date);
    const pairId = await pair(mover, other);
    expect(await race(customerLock(mover), editFirst, () => edit(mover), () => merge(pairId))).toEqual(['200', 'ok']);
    await expectPlanned(t, date);
    await expectPlanned(t2, date);
  });

  // why: F-1933 an office move of the edited customer's job never deadlocks with the edit, and both days end on their plan
  it.each([
    ['the day', true], ['the day', false], ['the other day', true], ['the other day', false], ['the customer row', true], ['the customer row', false],
  ])('ends with no deadlock against an office move: meeting at %s, edit first %s', async (at, editFirst) => {
    const [t, t2, date] = [tech('Kevin Doyle'), tech('Greg Hoffman'), newDay()];
    const { mover, job } = await dayOfTwo(t, date);
    await newJob({ customer: newCustomer(), technician: t2, date, bookedAt: '2026-09-14T13:00:00Z' });
    await settle(t2, date);
    const hold = at === 'the day' ? dayLock(t, date) : at === 'the other day' ? dayLock(t2, date) : customerLock(mover);
    expect(await race(hold, editFirst, () => edit(mover), () => assign(job, t2))).toEqual(['200', '200']);
    await expectPlanned(t, date);
    await expectPlanned(t2, date);
  });

  // why: F-1933 a write that holds the customer's job row and then refers to the customer (a technician's item that texts) is not deadlocked by the edit, which waits for the row before it takes the customer
  it('ends with no deadlock against a write that holds the job and then refers to the customer', async () => {
    const [t, date] = [tech('Kevin Doyle'), newDay()];
    const { mover, job } = await dayOfTwo(t, date);
    let item!: Queryable;
    const h = await holding(async (tx) => {
      item = tx;
      await tx.query('SELECT 1 FROM world.job WHERE job_number = $1 FOR UPDATE', [job]);
    });
    const e = started(edit(mover));
    await until('the edit to wait for a lock or be done', async () => e.done() || (await waiting()) === 1);
    await item.query('SELECT 1 FROM world.customer WHERE id = $1 FOR KEY SHARE', [mover]);
    expect(await h.release()).toBe('ok');
    expect(await e.answer).toBe('200');
    await expectPlanned(t, date);
  });

  // why: F-1933, F-622 a job booked for the customer on another day while the edit waits for the customer row makes the edit start its locks again: it gives the customer back, waits for that day, and plans it as the day's other write left it
  it('starts its locks again for the day of a job that is being booked while it waits', async () => {
    const [t, t2, date] = [tech('Kevin Doyle'), tech('Greg Hoffman'), newDay()];
    const { mover } = await dayOfTwo(t, date);
    let made = 0;
    const booking = await holding(async (tx) => {
      made = (await tx.query<{ job_number: number }>(INSERT_JOB, jobValues({ customer: mover, technician: t2, date }))).rows[0]!.job_number;
    });
    const e = started(edit(mover));
    await until('the edit to wait for the customer row or be done', async () => e.done() || (await waiting()) === 1);
    let write!: Queryable;
    const y = await holding(async (tx) => {
      write = tx;
      await lockTechnicianDays(tx, [{ technicianId: t2, date }]);
    });
    expect(await booking.release()).toBe('ok');
    await until('the edit to wait for the new day or be done', async () => e.done() || Number((await rows<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`))[0]!.n) === 1);
    // The write that holds the day refers to the customer, so an edit that kept the customer row while it waits would be a deadlock.
    await write.query('SELECT 1 FROM world.customer WHERE id = $1 FOR KEY SHARE', [mover]);
    await write.query(INSERT_JOB, jobValues({ customer: newCustomer(), technician: t2, date, bookedAt: '2026-09-14T13:00:00Z' }));
    expect(await y.release()).toBe('ok');
    expect(await e.answer).toBe('200');
    expect((await stored(t2, date)).has(made)).toBe(true);
    await expectPlanned(t, date);
    await expectPlanned(t2, date);
  });
});
