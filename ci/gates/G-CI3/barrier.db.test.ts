// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: invariant-3, FR-DISP-6, FR-BOOK-3, FR-DISP-34, K-01
// Gate G-CI3 (inv3-one-technician-capacity; SPECIFICATIONS section 14 item 3, section 5.3, invariant 3, D15): 2
// barrier-released transactions on the same job, the last place in a window, or the same block; exactly 1 commits.
//
// The path is the production one: 2 HTTP requests through the real router (mount over the real policy table and
// handlers, SQL sessions, the database clock), as the web process's login bw_web on PostgreSQL 18. The only difference
// from createWebKernel is the transaction wrapper: it holds each request's transaction at its first lock or write
// statement until both requests have reached theirs, then lets both go at once. So both have started before either
// takes a lock (the first held statement is the first lock or write; a read before it, such as the session check, is
// not held), and the locks and the version gate alone must serialize them.
//
// The harness self-check (last describe) runs the same barrier over a write with no lock: both commit. A barrier that
// let one request finish before the other started would pass the real races vacuously; that case would then fail.
// F-381: the technician-day writes have 3 more races (the technician's last room by 2 assigns, a block create against a job assign, a
// reschedule into the last place). Measured plants (P3-CLOSE, before F-745): lockTechnicianDays a no-op turned the first red;
// rescheduleJob without its booking-day lock turns the third red; the second survived the technician-lock plant, because
// settleDay's write to the technician_day row also serializes a block create and an assign on 1 row.
// F-779: since F-745, assignJob to a technician takes the booking-day row first (service.ts:224), so the first case's 2 same-day
// assigns serialize on that row and it holds the outcome, not the technician-day lock. By reading, no case here is known to turn red on
// lockTechnicianDays alone (not planted, budget 0). Invariant 3 still holds on the live path: every writer that adds to a
// technician's room takes the booking-day row.
// K-01 (P10-BOOKING-KEY): 2 sends of 1 booking key (API-113) both pass the handler's first key lookup, then race. On 1 day the booking-day
// lock serializes them and the second finds the key under it; on 2 days nothing serializes them and the unique constraint does. Each
// request's statements are traced (traces) so a case proves which of the 2 settled it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../packages/config/src/index.ts';
import { inTransaction, type Queryable } from '../../../packages/db/src/client.ts';
import { createLogger } from '../../../packages/log/src/index.ts';
import { DbClock } from '../../../packages/time/src/index.ts';
import { handlers, tokenChecks } from '../../../packages/api-server/src/handlers/index.ts';
import { generatedAccessKey } from '../../../packages/api-server/src/kernel/access-code.ts';
import { mount, type Router } from '../../../packages/api-server/src/kernel/mount.ts';
import { SqlSessionStore } from '../../../packages/api-server/src/kernel/sessions.ts';
import { policyTable } from '../../../packages/api-server/src/policy.ts';
import { loginUrl, officeWorld, ORIGIN, type OfficeWorld, type Staff } from '../../../packages/api-server/src/office-writes/testing.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let router: Router;
const ROUNDS = 5;

/** The first statement of a write's decision: a lock, or (with no lock) its first write. */
const GATE_AT = /pg_advisory_xact_lock|world\.booking_day|^\s*(INSERT|UPDATE|DELETE)\b/i;
const BARRIER_TIMEOUT_MS = 10_000;

interface Barrier { arrive(): Promise<void>; met: boolean }
let barrier: Barrier | null = null;
/** While set, each gated transaction's statements, 1 list per request in the order the transactions began. */
let traces: string[][] | null = null;

function newBarrier(parties: number): Barrier {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((r) => { release = r; });
  const b: Barrier = {
    met: false,
    async arrive() {
      arrived += 1;
      if (arrived === parties) {
        b.met = true;
        release();
      }
      // A party that never arrives (its request failed early) must not hang the gate: the round then fails on b.met.
      await Promise.race([open, new Promise((r) => setTimeout(r, BARRIER_TIMEOUT_MS))]);
    },
  };
  return b;
}

/** The transaction as the handler sees it, held once at GATE_AT while a barrier is armed. */
function gated(tx: Queryable, b: Barrier): Queryable {
  let held = false;
  const trace: string[] = [];
  traces?.push(trace);
  return {
    async query<R>(text: string, values?: unknown[]) {
      trace.push(text);
      if (!held && GATE_AT.test(text)) {
        held = true;
        await b.arrive();
      }
      return tx.query<R>(text, values);
    },
  };
}

beforeAll(async () => {
  world = await officeWorld(db, 60);
  const settings = loadConfig({ DATABASE_URL: loginUrl(db.url(), 'bw_web'), ACCESS_CODE_ON: 'off' });
  router = mount(policyTable, handlers, {
    tokens: tokenChecks,
    db: { transaction: (fn) => inTransaction(world.web, (tx) => fn(barrier ? gated(tx, barrier) : tx)) },
    sessions: new SqlSessionStore(world.web),
    clock: new DbClock(world.web),
    log: createLogger({ process: 'web', write: () => undefined }),
    settings,
    accessKey: generatedAccessKey(),
  });
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const send = (method: string, path: string, who: Staff, body?: unknown) => router.handle(new Request(`http://web:3000/api/v1${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: ORIGIN, cookie: who.cookie },
}), { address: '203.0.113.9' });
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const n = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0]?.n);
const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;

/** Run 2 calls released together at their first lock; their statuses and Problem codes, in call order. */
async function race(calls: [() => Promise<Response>, () => Promise<Response>]): Promise<{ status: number; code: string | null; body: Record<string, unknown> }[]> {
  const b = newBarrier(2);
  barrier = b;
  try {
    const answers = await Promise.all(calls.map((c) => c()));
    expect(b.met, 'both requests reached their first lock before either went on').toBe(true);
    return Promise.all(answers.map(async (r) => {
      const body = (await r.json()) as Record<string, unknown>;
      return { status: r.status, code: (body.code as string | undefined) ?? null, body };
    }));
  } finally {
    barrier = null;
  }
}

/** Book the fixture's jobs straight into the table (not the code under test), leaving `left` places in the window. */
async function fill(date: string, windowKey: string, jobs: number): Promise<void> {
  await db.admin().query(
    `INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version,
                            expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
     SELECT c.id, 'columbus', 'furnace_tune_up', $1::date, 'America/New_York', w.id,
            ($1::date + w.start_local) AT TIME ZONE 'America/New_York', ($1::date + w.end_local) AT TIME ZONE 'America/New_York',
            'scheduled', 1, 60, 'seed', now(), 'not_sent', false, false, false
       FROM generate_series(1, $3::int) AS g
       JOIN LATERAL (SELECT id FROM world.customer ORDER BY id OFFSET g % 40 LIMIT 1) c ON true
       JOIN world.arrival_window w ON w.id = $2`, [date, win(windowKey), jobs]);
}

const createBody = (date: string, windowKey: string, customer: string) => ({
  customerId: customer, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: win(windowKey), technicianId: null,
});

describe('the same job (FR-DISP-6, D15): 2 dispatchers move it at once from 1 version, exactly 1 commits', () => {
  it(`leaves the job with 1 technician, 1 new history row and 1 version step, and names the winner to the loser, ${ROUNDS} rounds`, async () => {
    const { keisha, ana } = world.staff;
    for (let round = 0; round < ROUNDS; round++) {
      const created = await send('POST', '/jobs', keisha, createBody(`2026-10-0${round + 5}`, 'two_hour 12:00', world.customers[round] as string));
      expect(created.status).toBe(201);
      const job = ((await created.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
      const out = await race([
        () => send('POST', `/jobs/${job}/assignment`, keisha, { technicianId: tech('Kevin Doyle'), baseVersion: 1 }),
        () => send('POST', `/jobs/${job}/assignment`, ana, { technicianId: tech('Marcus Bell'), baseVersion: 1 }),
      ]);
      expect(out.map((o) => o.status).sort()).toEqual([200, 409]);
      const winner = out.find((o) => o.status === 200)!;
      const loser = out.find((o) => o.status === 409)!;
      const winnerTech = (winner.body.data as { job: { technicianId: string } }).job.technicianId;
      expect(loser.body).toMatchObject({ code: 'version_conflict', change: 'assigned', currentVersion: 2, byKind: 'office' });
      expect(loser.body.technician).toBe(winnerTech === tech('Kevin Doyle') ? 'Kevin Doyle' : 'Marcus Bell');
      expect(await rows('SELECT technician_id, version FROM world.job WHERE job_number = $1', [job])).toEqual([{ technician_id: winnerTech, version: 2 }]);
      expect(await n(`SELECT count(*) AS n FROM world.job_change WHERE job_number = $1 AND kind = 'assigned'`, [job])).toBe(1);
    }
  });
});

describe('the last place in a window (FR-BOOK-3, FR-BOOK-6): 2 bookings at once, exactly 1 commits', () => {
  it(`fills the window to its capacity and refuses the other with window_full, ${ROUNDS} rounds`, async () => {
    const { keisha, ana } = world.staff;
    for (let round = 0; round < ROUNDS; round++) {
      const date = `2026-10-${12 + round}`; // Mon Oct 12 to Fri Oct 16: 2-hour days
      await fill(date, 'two_hour 16:00', 9); // the 4-6 PM window holds 10 jobs, so 9 leave room for exactly 1 more (FR-BOOK-6)
      const out = await race([
        () => send('POST', '/jobs', keisha, createBody(date, 'two_hour 16:00', world.customers[10 + round] as string)),
        () => send('POST', '/jobs', ana, createBody(date, 'two_hour 16:00', world.customers[20 + round] as string)),
      ]);
      expect(out.map((o) => [o.status, o.code]).sort()).toEqual([[201, null], [409, 'window_full']]);
      expect(await n(`SELECT count(*) AS n FROM world.job WHERE date = $1::date AND window_id = $2 AND status <> 'canceled'`, [date, win('two_hour 16:00')])).toBe(10);
    }
  });
});

describe('the same block (FR-DISP-34): 2 dispatchers move it at once from 1 version, exactly 1 commits', () => {
  it(`leaves the block at 1 place with 1 version step, ${ROUNDS} rounds`, async () => {
    const { keisha, ana } = world.staff;
    for (let round = 0; round < ROUNDS; round++) {
      const date = `2026-10-${19 + round}`;
      const c = await send('POST', '/time-blocks', keisha, { technicianId: tech('Kevin Doyle'), date, label: 'Supply run', place: null, start: '13:00', end: '13:30' });
      expect(c.status).toBe(201);
      const blockId = ((await c.json()) as { data: { block: { blockId: string } } }).data.block.blockId;
      const out = await race([
        () => send('POST', `/time-blocks/${blockId}/move`, keisha, { technicianId: tech('Kevin Doyle'), start: '14:00', end: '14:30', baseVersion: 1 }),
        () => send('POST', `/time-blocks/${blockId}/move`, ana, { technicianId: tech('Marcus Bell'), start: '15:00', end: '15:30', baseVersion: 1 }),
      ]);
      expect(out.map((o) => [o.status, o.code]).sort()).toEqual([[200, null], [409, 'version_conflict']]);
      const winner = (out.find((o) => o.status === 200)!.body.data as { block: { technicianId: string; start: string } }).block;
      expect(await rows<{ technician_id: string; version: number }>('SELECT technician_id, version FROM world.time_block WHERE id = $1', [blockId]))
        .toEqual([{ technician_id: winner.technicianId, version: 2 }]);
    }
  });
});

describe('the technician-day lock (F-381; SD-27, FR-BOOK-5, FR-DISP-34): writes onto 1 technician day at once, exactly 1 commits', () => {
  const ROUNDS_DAY = 3;

  it(`gives the technician's last room to 1 of 2 assigns and refuses the other with technician_no_room, ${ROUNDS_DAY} rounds`, async () => {
    const { keisha, ana } = world.staff;
    for (let round = 0; round < ROUNDS_DAY; round++) {
      const date = `2026-10-${27 + round}`; // Tue Oct 27 to Thu Oct 29
      const book = async (window: string, technician: string | null) => {
        const r = await send('POST', '/jobs', keisha, { ...createBody(date, `two_hour ${window}`, world.customers[40 + round] as string), technicianId: technician });
        expect([date, window, r.status]).toEqual([date, window, 201]);
        return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
      };
      for (const w of ['08:00', '10:00', '12:00', '14:00']) await book(w, tech('Kevin Doyle'));
      // 2 unassigned jobs on the same day, both assigned to the 1 technician: the technician's last place in the day.
      const [u1, u2] = [await book('08:00', null), await book('10:00', null)];
      const out = await race([
        () => send('POST', `/jobs/${u1}/assignment`, keisha, { technicianId: tech('Kevin Doyle'), baseVersion: 1 }),
        () => send('POST', `/jobs/${u2}/assignment`, ana, { technicianId: tech('Kevin Doyle'), baseVersion: 1 }),
      ]);
      expect(out.map((o) => [o.status, o.code]).sort()).toEqual([[200, null], [409, 'technician_no_room']]);
      expect(await n(`SELECT count(*) AS n FROM world.job WHERE date = $1::date AND technician_id = $2 AND status <> 'canceled'`, [date, tech('Kevin Doyle')])).toBe(5);
    }
  });

  it(`lets a block create and a job assign on the same row both start, and exactly 1 commits (the other is time_overlap), ${ROUNDS_DAY} rounds`, async () => {
    const { keisha, ana } = world.staff;
    for (let round = 0; round < ROUNDS_DAY; round++) {
      const date = `2026-11-0${2 + round}`; // Mon Nov 2 to Wed Nov 4
      const created = await send('POST', '/jobs', keisha, createBody(date, 'two_hour 12:00', world.customers[50 + round] as string));
      expect(created.status).toBe(201);
      const job = ((await created.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
      // The job would be planned about 12:15 PM for an hour; the block sits inside that time.
      const out = await race([
        () => send('POST', `/jobs/${job}/assignment`, keisha, { technicianId: tech('Marcus Bell'), baseVersion: 1 }),
        () => send('POST', '/time-blocks', ana, { technicianId: tech('Marcus Bell'), date, label: 'Supply run', place: null, start: '12:20', end: '12:30' }),
      ]);
      expect(out.map((o) => o.code === 'time_overlap').sort()).toEqual([false, true]);
      expect(out.filter((o) => o.status === 200 || o.status === 201)).toHaveLength(1);
      const assigned = await n('SELECT count(*) AS n FROM world.job WHERE job_number = $1 AND technician_id IS NOT NULL', [job]);
      const blocks = await n('SELECT count(*) AS n FROM world.time_block WHERE technician_id = $1 AND date = $2::date', [tech('Marcus Bell'), date]);
      expect(assigned + blocks, 'the job is assigned or the block exists, never both').toBe(1);
    }
  });

  it(`gives the last place in a window to 1 of a reschedule into it and a booking, and refuses the other with window_full, ${ROUNDS_DAY} rounds`, async () => {
    const { keisha, ana } = world.staff;
    for (let round = 0; round < ROUNDS_DAY; round++) {
      const date = ['2026-11-05', '2026-11-06', '2026-11-09'][round] as string; // Thu, Fri, Mon (a Saturday does not offer the 4-6 PM window)
      await fill(date, 'two_hour 16:00', 9);
      const moving = await send('POST', '/jobs', keisha, createBody(`2026-11-1${round}`, 'two_hour 08:00', world.customers[54 + round] as string));
      expect(moving.status).toBe(201);
      const job = ((await moving.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
      const out = await race([
        () => send('POST', `/jobs/${job}/schedule`, keisha, { date, windowId: win('two_hour 16:00'), baseVersion: 1 }),
        () => send('POST', '/jobs', ana, createBody(date, 'two_hour 16:00', world.customers[57 + round] as string)),
      ]);
      expect(out.map((o) => o.code === 'window_full').sort()).toEqual([false, true]);
      expect(await n(`SELECT count(*) AS n FROM world.job WHERE date = $1::date AND window_id = $2 AND status <> 'canceled'`, [date, win('two_hour 16:00')])).toBe(10);
    }
  });
});

describe('1 booking key sent twice at once (API-113; SPECIFICATIONS 6.1 Booking write, K-01): 1 job, both answers the same', () => {
  const ROUNDS_KEY = 3;
  let clock: Record<string, unknown>;
  beforeAll(async () => {
    clock = (await rows<Record<string, unknown>>('SELECT paused, demo_anchor, last_reset_real FROM system.demo_clock WHERE id = 1'))[0]!;
    await db.admin().query(`UPDATE system.demo_clock SET paused = true, demo_anchor = '2026-09-15T11:00:00Z', last_reset_real = now() - interval '1 hour' WHERE id = 1`);
  });
  afterAll(async () => {
    await db.admin().query('UPDATE system.demo_clock SET paused = $1, demo_anchor = $2, last_reset_real = $3 WHERE id = 1', [clock.paused, clock.demo_anchor, clock.last_reset_real]);
  });
  const visitor = (body: unknown) => router.handle(new Request('http://web:3000/api/v1/public/bookings', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN },
  }), { address: '203.0.113.9' });
  const street = async () => (await rows<{ id: string }>(`SELECT id FROM world.street WHERE branch_id = 'columbus' ORDER BY name, id LIMIT 1`))[0]!.id;
  const draft = (streetId: string, bookingKey: string, name: string, date: string, windowKey = 'two_hour 10:00') => ({
    serviceId: 'furnace_tune_up', streetId, houseNumber: 2310, date, windowId: win(windowKey), name, mobile: null, textsOn: false,
    textLanguage: 'en', timeZone: 'America/New_York', bookingKey,
  });
  /** 2 sends of 1 key released together; the traces of the 2 requests. */
  async function raceKey(first: unknown, second: unknown) {
    traces = [];
    try {
      const out = await race([() => visitor(first), () => visitor(second)]);
      return { out, traced: traces };
    } finally {
      traces = null;
    }
  }
  const lookedUpUnderLock = (t: string[]) => t.some((q) => /SELECT 1 FROM world\.job WHERE booking_key/.test(q));
  const insertedJob = (t: string[]) => t.some((q) => /INSERT INTO world\.job \(/.test(q));
  const rolledBack = (t: string[]) => t.includes('ROLLBACK TO SAVEPOINT booking_key');

  // why: K-01 a double Confirm sends 1 key twice onto 1 day: the booking-day lock serializes them, the second finds the key under it and answers the first's booking
  it(`books 1 job for 2 sends of 1 key onto 1 day, the second found under the booking-day lock, ${ROUNDS_KEY} rounds`, async () => {
    const id = await street();
    for (let round = 0; round < ROUNDS_KEY; round++) {
      const key = randomUUID();
      const name = `Key Sameday ${round}`;
      const { out, traced } = await raceKey(draft(id, key, name, '2026-09-17'), draft(id, key, name, '2026-09-17'));
      expect(out.map((o) => [o.status, o.code]), JSON.stringify(out.map((o) => o.body))).toEqual([[201, null], [201, null]]);
      expect(out[0]!.body).toEqual(out[1]!.body);
      expect(await n('SELECT count(*) AS n FROM world.job WHERE booking_key = $1', [key])).toBe(1);
      // The loser's customer insert went with its savepoint: 1 customer by that name.
      expect(await n('SELECT count(*) AS n FROM world.customer WHERE name = $1', [name])).toBe(1);
      expect(traced.length).toBe(2);
      const loser = traced.filter(rolledBack);
      expect(loser.length).toBe(1);
      expect([lookedUpUnderLock(loser[0]!), insertedJob(loser[0]!)]).toEqual([true, false]);
    }
  });

  // why: F-2061 the key lookup comes before the room check (SPECIFICATIONS 6.1); with room for 1 only, a lookup moved after the room check answers the second send window_full
  it(`books 1 job for 2 sends of 1 key onto the last place of a window, the second answering the first's booking, ${ROUNDS_KEY} rounds`, async () => {
    const id = await street();
    for (let round = 0; round < ROUNDS_KEY; round++) {
      const date = ['2026-09-22', '2026-09-23', '2026-09-24'][round] as string; // Tue, Wed, Thu
      await fill(date, 'two_hour 16:00', 9); // the 4-6 PM window holds 10 jobs: room for 1
      const key = randomUUID();
      const name = `Key Lastplace ${round}`;
      const { out } = await raceKey(draft(id, key, name, date, 'two_hour 16:00'), draft(id, key, name, date, 'two_hour 16:00'));
      expect(out.map((o) => [o.status, o.code]), JSON.stringify(out.map((o) => o.body))).toEqual([[201, null], [201, null]]);
      expect(out[0]!.body).toEqual(out[1]!.body);
      expect(await n('SELECT count(*) AS n FROM world.job WHERE booking_key = $1', [key])).toBe(1);
      expect(await n(`SELECT count(*) AS n FROM world.job WHERE date = $1::date AND window_id = $2 AND status <> 'canceled'`, [date, win('two_hour 16:00')])).toBe(10);
    }
  });

  // why: K-01 2 sends of 1 key onto 2 days take 2 booking-day locks, so the unique constraint settles them: the loser's insert fails and it answers as a repeat
  it(`books 1 job for 2 sends of 1 key onto 2 days, the second refused by the unique constraint, ${ROUNDS_KEY} rounds`, async () => {
    const id = await street();
    for (let round = 0; round < ROUNDS_KEY; round++) {
      const key = randomUUID();
      const name = `Key Twoday ${round}`;
      const { out, traced } = await raceKey(draft(id, key, name, '2026-09-17'), draft(id, key, name, '2026-09-21')); // Thu and Mon: Sep 16 and 18 are 4-hour peak days
      expect(out.map((o) => [o.status, o.code]), JSON.stringify(out.map((o) => o.body))).toEqual([[201, null], [201, null]]);
      expect(out[0]!.body).toEqual(out[1]!.body);
      expect(await n('SELECT count(*) AS n FROM world.job WHERE booking_key = $1', [key])).toBe(1);
      expect(await n('SELECT count(*) AS n FROM world.customer WHERE name = $1', [name])).toBe(1);
      const loser = traced.filter(rolledBack);
      expect(loser.length).toBe(1);
      expect(insertedJob(loser[0]!)).toBe(true);
      expect(await n('SELECT count(*) AS n FROM world.job_change c JOIN world.job j ON j.job_number = c.job_number WHERE j.booking_key = $1', [key])).toBe(1);
    }
  });
});

describe('the harness bites (a must-fail case, every run)', () => {
  it('lets 2 unlocked count-then-insert writes both commit past the same barrier, so the races above are not vacuous', async () => {
    const date = '2026-10-26';
    await fill(date, 'two_hour 16:00', 9);
    // The planted write: the window's count and insert with no booking-day lock (what section 5.3 step 3 forbids).
    const unlocked = (customer: string) => inTransaction(world.web, async (raw) => {
      const tx = barrier ? gated(raw, barrier) : raw;
      const left = await tx.query<{ n: string }>(`SELECT 10 - count(*) AS n FROM world.job WHERE date = $1::date AND window_id = $2`, [date, win('two_hour 16:00')]);
      if (Number(left.rows[0]?.n) <= 0) throw new Error('window_full');
      await tx.query(
        `INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status, version,
                                expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
         SELECT $1, 'columbus', 'furnace_tune_up', $2::date, 'America/New_York', $3, now(), now() + interval '2 hours',
                'scheduled', 1, 60, 'office', now(), 'not_sent', false, true, false`, [customer, date, win('two_hour 16:00')]);
    });
    const b = newBarrier(2);
    barrier = b;
    try {
      const out = await Promise.allSettled([unlocked(world.customers[30] as string), unlocked(world.customers[31] as string)]);
      expect(b.met).toBe(true);
      expect(out.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    } finally {
      barrier = null;
    }
    expect(await n(`SELECT count(*) AS n FROM world.job WHERE date = $1::date AND window_id = $2`, [date, win('two_hour 16:00')])).toBe(11);
  });
});
