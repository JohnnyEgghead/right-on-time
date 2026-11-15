// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: invariant-3, FR-DISP-6, FR-TECH-6
// Gate G-CI3 case file of P3-JOB-WRITES (BUILD_PLAN D-15: a second lane that builds part of a gate adds its own case file):
// a cancel (API-25) and a reschedule (API-24) of the same job, released together at their first lock from 1 version; exactly
// 1 commits (invariant 3, D15). The harness is barrier.db.test.ts's, copied: 2 HTTP requests through the real router, as
// bw_web on PostgreSQL 18, each held at its first lock or write until both have reached theirs.
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

/** F-511: holds the next transaction at the first statement that matches `at`, after its lock and before its write, until released. */
interface Hold { at: RegExp; reached: () => void; open: Promise<void> }
let hold: Hold | null = null;

function held(tx: Queryable, h: Hold): Queryable {
  let done = false;
  return {
    async query<R>(text: string, values?: unknown[]) {
      if (!done && h.at.test(text)) {
        done = true;
        h.reached();
        await h.open;
      }
      return tx.query<R>(text, values);
    },
  };
}

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
    db: {
      transaction: (fn) => inTransaction(world.web, (tx) => {
        const h = hold;
        if (h) hold = null; // the first transaction after the hold is armed is the held one
        return fn(h ? held(tx, h) : barrier ? gated(tx, barrier) : tx);
      }),
    },
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

const MOVE_DAYS = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'] as const; // Mon to Fri, 2-hour days

describe('a cancel and a move of the same job (FR-TECH-6, FR-DISP-6, D15): released together, exactly 1 commits', () => {
  it(`leaves the job either canceled at its day or moved and scheduled, with 1 new history row and 1 version step, ${ROUNDS} rounds`, async () => {
    const { keisha, ana } = world.staff;
    for (let round = 0; round < ROUNDS; round++) {
      const created = await send('POST', '/jobs', keisha, {
        customerId: world.customers[round] as string, serviceId: 'furnace_tune_up', equipmentId: null, problem: null,
        date: `2026-11-0${round + 2}`, windowId: win('two_hour 12:00'), technicianId: tech('Kevin Doyle'),
      });
      expect(created.status).toBe(201);
      const job = ((await created.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
      const out = await race([
        () => send('POST', `/jobs/${job}/cancellation`, keisha, { baseVersion: 1 }),
        () => send('POST', `/jobs/${job}/schedule`, ana, { date: MOVE_DAYS[round], windowId: win('two_hour 14:00'), baseVersion: 1 }),
      ]);
      expect(out.map((o) => [o.status, o.code]).sort()).toEqual([[200, null], [409, 'version_conflict']]);
      const loser = out.find((o) => o.status === 409)!;
      const cancelWon = out[0]!.status === 200;
      expect(loser.body).toMatchObject({ currentVersion: 2, byKind: 'office', change: cancelWon ? 'canceled' : 'rescheduled' });
      const row = (await rows<{ status: string; version: number; date: string }>('SELECT status, version, date::text AS date FROM world.job WHERE job_number = $1', [job]))[0]!;
      expect(row).toMatchObject({ status: cancelWon ? 'canceled' : 'scheduled', version: 2 });
      expect(row.date).toBe(cancelWon ? `2026-11-0${round + 2}` : MOVE_DAYS[round]);
      expect(await n(`SELECT count(*) AS n FROM world.job_change WHERE job_number = $1 AND kind <> 'created'`, [job])).toBe(1);
    }
  });

  // The barrier above lets the cancel reach its lock first, so the cancel always commits and the move always loses on its own
  // gate. This case orders the commits both ways: the second write starts only after the first has answered, so the second
  // write's own day lock and version gate alone must refuse it (F-503).
  // why: invariant-3 / D15: whichever of a cancel and a move commits second is refused by its own gate, in both orders.
  it.each([
    { first: 'move', second: 'cancel', change: 'rescheduled', status: 'scheduled', date: '2026-11-12', who: 'Greg Hoffman', day: '2026-11-03' },
    { first: 'cancel', second: 'move', change: 'canceled', status: 'canceled', date: '2026-11-04', who: 'Marcus Bell', day: '2026-11-04' },
  ] as const)('$first commits, then the $second is refused 409 naming $change: 1 history row, 1 version step', async ({ first, change, status, date, who, day }) => {
    const { keisha, ana } = world.staff;
    const idx = first === 'move' ? ROUNDS : ROUNDS + 1; // customers the rounds above did not use
    const created = await send('POST', '/jobs', keisha, {
      customerId: world.customers[idx] as string, serviceId: 'furnace_tune_up', equipmentId: null, problem: null,
      date: day, windowId: win('two_hour 12:00'), technicianId: tech(who),
    });
    expect(created.status).toBe(201);
    const job = ((await created.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
    const cancel = () => send('POST', `/jobs/${job}/cancellation`, keisha, { baseVersion: 1 });
    const move = () => send('POST', `/jobs/${job}/schedule`, ana, { date: '2026-11-12', windowId: win('two_hour 14:00'), baseVersion: 1 });
    const winner = await (first === 'move' ? move : cancel)();
    expect(winner.status).toBe(200);
    const loser = await (first === 'move' ? cancel : move)();
    const body = (await loser.json()) as Record<string, unknown>;
    expect([loser.status, body.code]).toEqual([409, 'version_conflict']);
    expect(body).toMatchObject({ currentVersion: 2, byKind: 'office', change });
    const row = (await rows<{ status: string; version: number; date: string }>('SELECT status, version, date::text AS date FROM world.job WHERE job_number = $1', [job]))[0]!;
    expect(row).toMatchObject({ status, version: 2 });
    expect(row.date).toBe(date);
    expect(await n(`SELECT count(*) AS n FROM world.job_change WHERE job_number = $1 AND kind <> 'created'`, [job])).toBe(1);
  });
});

describe('the cancel holds the technician day (F-511, F-503): the lock decides, not the version gate', () => {
  // The barrier cases above stay green with cancelJob's day lock removed (measured, F-511): the version gate and the day rows settle those
  // races without it. This case holds a cancel after its lock and before its write, and starts an assign onto the same technician day: the
  // assign must wait on the cancel's advisory lock (it is seen waiting, and has not answered), then both commit once the cancel goes on.
  // why: invariant-3 / FR-DISP-34: a cancel is a technician-day write; a second write onto that day waits for it
  it('makes an assign onto the same technician day wait while the cancel is held, and lets both commit after', async () => {
    const { keisha, ana } = world.staff;
    const day = '2026-11-05'; // Thu
    const book = async (customer: string, technician: string | null, window: string) => {
      const r = await send('POST', '/jobs', keisha, {
        customerId: customer, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: day, windowId: win(window), technicianId: technician,
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
    };
    const x = await book(world.customers[20] as string, tech('Marcus Bell'), 'two_hour 12:00');
    const y = await book(world.customers[21] as string, null, 'two_hour 14:00');
    let reached!: () => void;
    let release!: () => void;
    const cancelAtWrite = new Promise<void>((r) => { reached = r; });
    hold = { at: /status = 'canceled'/, reached, open: new Promise<void>((r) => { release = r; }) };
    const cancel = send('POST', `/jobs/${x}/cancellation`, keisha, { baseVersion: 1 });
    await cancelAtWrite; // the cancel holds the day lock and has not written
    let assignAnswered = false;
    const assign = send('POST', `/jobs/${y}/assignment`, ana, { technicianId: tech('Marcus Bell'), baseVersion: 1 }).then((r) => { assignAnswered = true; return r; });
    let waiting = false;
    for (let i = 0; i < 400 && !waiting && !assignAnswered; i++) {
      waiting = (await n(`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`)) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 25));
    }
    const answeredWhileHeld = assignAnswered;
    release();
    const [c, a] = await Promise.all([cancel, assign]);
    expect({ waiting, answeredWhileHeld }, 'the assign waits on the cancel\'s technician-day lock').toEqual({ waiting: true, answeredWhileHeld: false });
    expect([c.status, a.status]).toEqual([200, 200]);
    expect(await n(`SELECT count(*) AS n FROM world.job WHERE job_number = $1 AND status = 'canceled'`, [x])).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM world.job WHERE job_number = $1 AND technician_id = $2`, [y, tech('Marcus Bell')])).toBe(1);
  });
});
