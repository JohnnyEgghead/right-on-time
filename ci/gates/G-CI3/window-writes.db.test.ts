// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: invariant-3, FR-BOOK-17, FR-BOOK-3, FR-BOOK-2, FR-BOOK-8
// Gate G-CI3 case file of P4-ADMIN-WINDOWS (BUILD_PLAN D-15: a later lane that builds part of a gate adds its own case file): a capacity edit (API-155)
// or a day switch (API-91) against the writes that decide on those values, the booking (API-28), the reschedule (API-24) and the assign (API-22).
// SPECIFICATIONS section 5.3 steps 3 and 5: the capacity and the day's mode are read under the booking-day lock, so the lock decides the order.
// F-746: both orders are forced and asserted, never left to timing. A round holds the 1st request at a named statement inside the lock, starts the 2nd,
// waits until PostgreSQL shows the 2nd queued on the booking-day row, and only then lets the 1st go. So the 2nd always runs behind the 1st, and a
// write that read the value before its lock is caught: it decides on the old number. The requests go through the real router as bw_web on PostgreSQL 18.
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
/** GATE-ACCEPTANCE item 11: no step of a forced order waits longer than this; a round that needs longer fails. */
const CAP_MS = 10_000;

/** Where a request stops: just before a statement runs, or just after it returned (its lock is then held). */
interface Stop { before?: RegExp; after?: RegExp }
const BEFORE_THE_CAPACITY_WRITE: Stop = { before: /UPDATE world\.arrival_window/ };
const BEFORE_THE_MODE_WRITE: Stop = { before: /INSERT INTO world\.day_mode/ };
const HOLDING_THE_DAY: Stop = { after: /FROM world\.booking_day .*FOR UPDATE/ };
const AFTER_THE_COUNT: Stop = { before: /INSERT INTO world\.job \(/ };

interface Hold extends Stop { used: boolean; reached(): void; release: Promise<void> }
let hold: Hold | null = null;

/** The transaction as the handler sees it: the 1 request that reaches the armed stop waits there; every other statement goes straight through. */
function holding(tx: Queryable): Queryable {
  return {
    async query<R>(text: string, values?: unknown[]) {
      const h = hold;
      const stop = async (at?: RegExp) => {
        if (h && !h.used && at?.test(text)) {
          h.used = true;
          h.reached();
          await h.release;
        }
      };
      await stop(h?.before);
      const r = await tx.query<R>(text, values);
      await stop(h?.after);
      return r;
    },
  };
}

beforeAll(async () => {
  world = await officeWorld(db, 90);
  const settings = loadConfig({ DATABASE_URL: loginUrl(db.url(), 'bw_web'), ACCESS_CODE_ON: 'off' });
  router = mount(policyTable, handlers, {
    tokens: tokenChecks,
    db: { transaction: (fn) => inTransaction(world.web, (tx) => fn(holding(tx))) },
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
const win = (key: string) => world.windows.get(key) as string;
const tech = (name: string) => world.technicians.get(name) as string;

const capped = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([
  p, new Promise<never>((_, no) => { setTimeout(() => no(new Error(`${what}: not within ${CAP_MS} ms`)), CAP_MS).unref(); }),
]);

/** Done when a session of this database is queued on a booking_day row: the proof the 2nd request runs behind the 1st, with no sleep to guess at. */
async function queuedOnTheDay(): Promise<void> {
  const by = Date.now() + CAP_MS;
  for (;;) {
    const [w] = await rows<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%booking_day%'`);
    if (Number(w!.n) > 0) return;
    if (Date.now() > by) throw new Error(`the 2nd request never queued on the booking-day lock within ${CAP_MS} ms: it does not take the lock the 1st holds`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const answer = async (r: Response) => {
  const body = (await r.json()) as Record<string, unknown>;
  return { status: r.status, code: (body.code as string | undefined) ?? null, key: (body.key as string | undefined) ?? null };
};

/** Force the order: `first` stops at `stop`, `second` starts and queues behind it, then `first` goes on. Their answers, in that order. */
async function inOrder(stop: Stop, first: () => Promise<Response>, second: () => Promise<Response>) {
  let reached!: () => void;
  let release!: () => void;
  const atStop = new Promise<void>((r) => { reached = r; });
  hold = { ...stop, used: false, reached, release: new Promise<void>((r) => { release = r; }) };
  const a = first();
  let b: Promise<Response> | null = null;
  try {
    await capped(Promise.race([atStop, a.then(() => { throw new Error('the 1st request answered without reaching its stop'); })]), 'the 1st request reaching its stop');
    b = second();
    await queuedOnTheDay();
  } finally {
    release();
    hold = null;
  }
  const [x, y] = await capped(Promise.all([a, b as Promise<Response>]), 'both requests answering');
  return [await answer(x), await answer(y)] as const;
}

let customer = 0;
const body = (date: string, windowId: string, technicianId: string | null = null) => ({
  customerId: world.customers[customer++] as string, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId, technicianId,
});
const book = (date: string, windowId: string, technicianId: string | null = null) => send('POST', '/jobs', world.staff.keisha, body(date, windowId, technicianId));
const booked = async (date: string, windowId: string, technicianId: string | null = null): Promise<number> => {
  const r = await book(date, windowId, technicianId);
  expect([date, r.status]).toEqual([date, 201]);
  return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
};
const limit = (windowId: string, n: number) => send('PUT', '/branches/columbus/window-limits', world.staff.dana, { limits: [{ windowId, limit: n }] });
const setMode = (date: string, mode: string) => send('PUT', `/branches/columbus/days/${date}/mode`, world.staff.dana, { mode, ...(mode === 'four_hour' ? { reason: 'Heat advisory' } : {}) });
const reschedule = (job: number, date: string, windowId: string) => send('POST', `/jobs/${job}/schedule`, world.staff.keisha, { date, windowId, baseVersion: 1 });
const held = async (windowId: string, date: string) => Number((await rows<{ n: string }>(
  `SELECT count(*) AS n FROM world.job WHERE window_id = $1 AND date = $2::date AND status <> 'canceled'`, [windowId, date]))[0]!.n);
const capacity = async (windowId: string) => (await rows<{ capacity: number }>('SELECT capacity FROM world.arrival_window WHERE id = $1', [windowId]))[0]!.capacity;
const modeOf = async (date: string) => (await rows<{ mode: string }>(`SELECT mode FROM world.day_mode WHERE branch_id = 'columbus' AND date = $1::date`, [date]))[0]?.mode;
const placeOf = async (job: number) => (await rows<{ date: string; window_id: string; version: number }>(
  'SELECT date::text AS date, window_id, version FROM world.job WHERE job_number = $1', [job]))[0]!;

// A round leaves its window at the capacity it asserts, so each round has a window of its own: API-155 refuses a limit below any day's bookings.
const STARTS = ['08:00', '10:00', '12:00', '14:00', '16:00'] as const;
const WEEKS = {
  editFirst: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'],
  bookingFirst: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'],
  switchFirst: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
  bookingBeforeSwitch: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'],
} as const;

describe('a capacity edit and the last place in that window (FR-BOOK-17, invariant 3): each order forced', () => {
  // why: invariant-3 / FR-BOOK-17: the edit holds its locks and a booking of the last place queues behind it: the edit commits and the booking is refused (window_full), so the window never holds more than its capacity (section 5.3 steps 3 and 5, F-745)
  it(`the edit first: 200 and window_full, the window holds 1 of 1, ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = win(`two_hour ${STARTS[round]}`);
      const day = WEEKS.editFirst[round]!;
      expect((await limit(w, 2)).status).toBe(200);
      await booked(day, w);
      const [edit, place] = await inOrder(BEFORE_THE_CAPACITY_WRITE, () => limit(w, 1), () => book(day, w));
      expect([round, edit.status, place.status, place.code]).toEqual([round, 200, 409, 'window_full']);
      expect([await held(w, day), await capacity(w)]).toEqual([1, 1]);
    }
  });

  // why: invariant-3 / FR-BOOK-17: the booking holds the day and an edit to 1 queues behind it: the booking commits and the edit counts it and is refused (capacity_below_bookings), so exactly 1 commits in this order too
  it(`the booking first: 201 and capacity_below_bookings, the window holds 2 of 2, ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = win(`two_hour ${STARTS[round]}`);
      const day = WEEKS.bookingFirst[round]!;
      expect((await limit(w, 2)).status).toBe(200);
      await booked(day, w);
      const [place, edit] = await inOrder(HOLDING_THE_DAY, () => book(day, w), () => limit(w, 1));
      expect([round, place.status, edit.status, edit.code]).toEqual([round, 201, 409, 'capacity_below_bookings']);
      expect([await held(w, day), await capacity(w)]).toEqual([2, 2]);
    }
  });

  // why: invariant-3 / FR-BOOK-3: a reschedule takes a place as a booking does: behind an edit that took its last place it is refused (window_full) and the job stays where it was
  it('the edit first against a reschedule into the last place: 200 and window_full, the job stays put', async () => {
    const w = win('two_hour 12:00');
    const day = '2026-11-02';
    const job = await booked('2026-11-03', win('two_hour 10:00'));
    expect((await limit(w, 3)).status).toBe(200);
    await booked(day, w);
    await booked(day, w);
    const [edit, move] = await inOrder(BEFORE_THE_CAPACITY_WRITE, () => limit(w, 2), () => reschedule(job, day, w));
    expect([edit.status, move.status, move.code]).toEqual([200, 409, 'window_full']);
    expect([await held(w, day), await capacity(w)]).toEqual([2, 2]);
    expect(await placeOf(job)).toEqual({ date: '2026-11-03', window_id: win('two_hour 10:00'), version: 1 });
  });

  // why: invariant-3 / FR-BOOK-17: the instrument is not vacuous, every run: an edit written as a bare UPDATE, with no booking-day lock and no count, lands after the booking counted, so both commit and the window holds more than its capacity. The lock, not the order of the statements, is what keeps the window
  it('must-fail: a capacity edit with no booking-day lock lands after the booking counted, both commit and the window holds more than its capacity', async () => {
    const w = win('two_hour 14:00');
    const day = '2026-10-29';
    await rows('UPDATE world.arrival_window SET capacity = 2 WHERE id = $1', [w]);
    await booked(day, w);
    let reached!: () => void;
    let release!: () => void;
    const atStop = new Promise<void>((r) => { reached = r; });
    hold = { ...AFTER_THE_COUNT, used: false, reached, release: new Promise<void>((r) => { release = r; }) };
    const place = book(day, w);
    try {
      await capped(atStop, 'the booking reaching its write');
      await rows('UPDATE world.arrival_window SET capacity = 1 WHERE id = $1', [w]);
    } finally {
      release();
      hold = null;
    }
    expect((await capped(place, 'the booking answering')).status).toBe(201);
    expect([await held(w, day), await capacity(w)]).toEqual([2, 1]);
    expect(await held(w, day)).toBeGreaterThan(await capacity(w));
  });
});

describe('a day switch and the writes that read the day (FR-BOOK-2, FR-BOOK-8): each order forced', () => {
  // why: FR-BOOK-2: the switch holds its lock and a booking of a 2-hour window queues behind it: the switch commits and the booking is refused as the same booking sent after it is (rule_refused, section 5.3 step 3, F-745)
  it(`the switch first: 200 and rule_refused, no 2-hour booking lands on the 4-hour day, ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = win(`two_hour ${STARTS[round]}`);
      const day = WEEKS.switchFirst[round]!;
      const [sw, place] = await inOrder(BEFORE_THE_MODE_WRITE, () => setMode(day, 'four_hour'), () => book(day, w));
      expect([round, sw.status, place.status, place.code, place.key]).toEqual([round, 200, 409, 'rule_refused', 'rule.windowNotOffered']);
      expect([await modeOf(day), await held(w, day)]).toEqual(['four_hour', 0]);
      // The answer behind the lock is the answer after it.
      const after = await answer(await book(day, w));
      expect([after.status, after.code, after.key]).toEqual([409, 'rule_refused', 'rule.windowNotOffered']);
    }
  });

  // why: FR-BOOK-8: the booking holds the day and the switch queues behind it: both commit, and the booking keeps its 2-hour window on the day that is now 4-hour
  it(`the booking first: 201 and 200, the job keeps its 2-hour window, ${ROUNDS} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = win(`two_hour ${STARTS[round]}`);
      const day = WEEKS.bookingBeforeSwitch[round]!;
      const [place, sw] = await inOrder(HOLDING_THE_DAY, () => book(day, w), () => setMode(day, 'four_hour'));
      expect([round, place.status, sw.status]).toEqual([round, 201, 200]);
      expect([await modeOf(day), await held(w, day)]).toEqual(['four_hour', 1]);
    }
  });

  // why: FR-BOOK-2: a reschedule reads the day as a booking does: behind a switch it is refused, and the job stays where it was
  it('the switch first against a reschedule into a 2-hour window: 200 and rule_refused, the job stays put', async () => {
    const w = win('two_hour 10:00');
    const day = '2026-10-19';
    const job = await booked('2026-10-20', win('two_hour 08:00'));
    const [sw, move] = await inOrder(BEFORE_THE_MODE_WRITE, () => setMode(day, 'four_hour'), () => reschedule(job, day, w));
    expect([sw.status, move.status, move.code, move.key]).toEqual([200, 409, 'rule_refused', 'rule.windowNotOffered']);
    expect(await placeOf(job)).toEqual({ date: '2026-10-20', window_id: win('two_hour 08:00'), version: 1 });
  });

  // why: FR-BOOK-5 / invariant-3: an assign reads the day's mode for the technician's daily capacity (section 5.3 step 2): behind a switch back to 2-hour windows it counts 5, not 6, so a technician with 5 jobs is refused (technician_no_room)
  it('the switch back first against an assign of the 6th job: 200 and technician_no_room, the technician keeps 5', async () => {
    const day = '2026-10-26';
    const kevin = tech('Kevin Doyle');
    expect((await setMode(day, 'four_hour')).status).toBe(200);
    for (const w of ['08:00', '10:00', '12:00', '14:00', '08:00']) await booked(day, win(`four_hour ${w}`), kevin);
    const sixth = await booked(day, win('four_hour 10:00'));
    const [sw, assign] = await inOrder(BEFORE_THE_MODE_WRITE, () => setMode(day, 'two_hour'),
      () => send('POST', `/jobs/${sixth}/assignment`, world.staff.keisha, { technicianId: kevin, baseVersion: 1 }));
    expect([sw.status, assign.status, assign.code]).toEqual([200, 409, 'technician_no_room']);
    expect(await rows(`SELECT 1 FROM world.job WHERE job_number = $1 AND technician_id IS NOT NULL`, [sixth])).toEqual([]);
  });
});
