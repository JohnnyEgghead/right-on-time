// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: invariant-3, FR-DISP-6, FR-BOOK-3, FR-DISP-34
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
  return {
    async query<R>(text: string, values?: unknown[]) {
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
      await fill(date, 'two_hour 16:00', 9); // the 4-6 PM window holds 10 (FR-BOOK-6)
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
