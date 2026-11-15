// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI8 inv8-one-message, a held confirmation (F-799, F-729; SPECIFICATIONS SD-45, section 5.2). The office makes and changes visits through
// the real routes (API-28, API-24, API-25), as a dispatcher with a real session, through the production kernel as bw_web. The demo clock
// then moves past the real hold, and the worker as main.ts starts it runs the text.try events: what the customer ends with is read from
// their inbox (world.inbox_message), the row the gateway writes when it delivers. After a cancel: nothing. After a move: exactly 1
// confirmation, the current day and window. Each end leaves its record: the old text canceled with the visit-changed reason, its try event
// skipped, and a second drain changes nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { caller, officeWorld, type Caller, type OfficeWorld } from '../../../packages/api-server/src/office-writes/testing.ts';
import { setDemoClock, setSimulator } from '../../../packages/outbox/src/testing/world.ts';
import { startTestWorker, type TestWorker } from '../../../apps/worker/src/testing/worker.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let worker: TestWorker;
let customer: string;

/** 10:30 PM EDT on Sep 15: quiet hours, so a text made now is held to 8:00 AM on Sep 16. */
const NIGHT = '2026-09-16T02:30:00Z';
/** 8:02 AM EDT on Sep 16, past the hold's end. */
const MORNING = '2026-09-16T12:02:00Z';

beforeAll(async () => {
  world = await officeWorld(db, 4);
  api = caller(world.kernel);
  customer = world.customers[0] as string;
  await db.admin().query(`UPDATE world.customer SET mobile = '(614) 555-0142', texts_on = true, text_language = 'en', zone = 'America/New_York' WHERE id = $1`, [customer]);
  await db.admin().query(`INSERT INTO world.text_simulator (mode) VALUES ('up')`);
  worker = await startTestWorker(db.url());
}, 120_000);
afterAll(async () => {
  await worker?.stop();
  await world?.close();
});

const window = (key: string) => world.windows.get(key) as string;
const at = async (t: string) => {
  await setDemoClock(db.admin(), t);
  await worker.drain();
};
interface Made { jobNumber: number; version: number }
const job = async (r: Response, status: number): Promise<Made> => {
  expect(r.status, await r.clone().text()).toBe(status);
  return ((await r.json()) as { data: { job: Made } }).data.job;
};
const create = async (date: string, key: string) =>
  job(await api.post('/jobs', { customerId: customer, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: window(key), technicianId: null }, world.staff.keisha), 201);
const move = async (j: Made, date: string, key: string) => job(await api.post(`/jobs/${j.jobNumber}/schedule`, { date, windowId: window(key), baseVersion: j.version }, world.staff.keisha), 200);
const cancel = async (j: Made) => job(await api.post(`/jobs/${j.jobNumber}/cancellation`, { baseVersion: j.version }, world.staff.keisha), 200);

interface Row { id: string; status: string; reason_key: string | null; next_try_at: Date | null; body: string }
const confirmations = async (n: number) => (await db.admin().query<Row>(
  `SELECT id, status, reason_key, next_try_at, body FROM world.outbox_text WHERE job_number = $1 AND kind = 'confirmation' ORDER BY created_at, id`, [n])).rows;
/** Every text of the visit that reached the customer: what they read, in order. */
const inbox = async (n: number) => (await db.admin().query<{ body: string }>(
  `SELECT m.body FROM world.inbox_message m JOIN world.outbox_text t ON t.id = m.text_id WHERE t.job_number = $1 AND m.direction = 'out' ORDER BY m.at, m.id`, [n])).rows.map((r) => r.body);
const tryEvents = async (id: string) => (await db.admin().query<{ state: string; result: string | null }>(
  `SELECT state, result FROM world.scheduled_event WHERE kind = 'text.try' AND subject = $1 ORDER BY due_at, id`, [id])).rows;

const VISIT_CHANGED = 'text_reason.visit_changed';

describe('a confirmation held by quiet hours, then the visit changed', () => {
  // why: F-799, SD-45 (canceling sends no text: the held confirmation of a canceled visit never reaches the customer, and it ends canceled with the reason)
  it('canceled: nothing reaches the customer at 8:00 AM, and the held text ends canceled at once', async () => {
    await at(NIGHT);
    const j = await create('2026-10-13', 'two_hour 08:00');
    const [held] = await confirmations(j.jobNumber);
    expect(held).toMatchObject({ status: 'held' });
    await cancel(j);
    expect(await confirmations(j.jobNumber)).toEqual([expect.objectContaining({ id: held!.id, status: 'canceled', reason_key: VISIT_CHANGED, next_try_at: null })]);
    await at(MORNING);
    expect(await inbox(j.jobNumber)).toEqual([]);
    // The try event ends with a record, and a second drain changes nothing.
    expect(await tryEvents(held!.id)).toEqual([expect.objectContaining({ state: 'skipped', result: 'not_sendable' })]);
    await worker.drain();
    expect(await inbox(j.jobNumber)).toEqual([]);
  });

  // why: F-799, SD-45 (a visit moved overnight: the customer reads exactly 1 confirmation, the new day and window, never the old day)
  it('moved: the customer reads exactly 1 confirmation, the new day and window', async () => {
    await at(NIGHT);
    const j = await create('2026-10-13', 'two_hour 08:00');
    const [old] = await confirmations(j.jobNumber);
    await move(j, '2026-10-14', 'two_hour 12:00');
    const held = await confirmations(j.jobNumber);
    expect(held.map((r) => [r.status, r.reason_key])).toEqual([['canceled', VISIT_CHANGED], ['held', 'text_reason.quiet_hours']]);
    await at(MORNING);
    const read = await inbox(j.jobNumber);
    const confirmed = read.filter((b) => b.includes("You're booked"));
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toContain('Oct 14');
    expect(confirmed[0]).toContain('12-2 PM');
    expect(read.join(' ')).not.toContain('Oct 13');
    expect(await tryEvents(old!.id)).toEqual([expect.objectContaining({ state: 'skipped', result: 'not_sendable' })]);
    expect((await confirmations(j.jobNumber)).map((r) => r.status)).toEqual(['canceled', 'delivered']);
  });

  // why: F-828, SD-45 (the same day and window sent again: no 2nd confirmation, and a delivered one stays the customer's only one)
  it('the same day and window again: the delivered confirmation stays the only one', async () => {
    await at(MORNING);
    const j = await create('2026-10-13', 'two_hour 08:00');
    await worker.drain();
    expect((await confirmations(j.jobNumber)).map((r) => r.status)).toEqual(['delivered']);
    await move(j, '2026-10-13', 'two_hour 08:00');
    await worker.drain();
    expect((await confirmations(j.jobNumber)).map((r) => r.status)).toEqual(['delivered']);
    expect((await inbox(j.jobNumber)).filter((x) => x.includes("You're booked"))).toHaveLength(1);
  });

  // why: F-828 (the same day and window with the confirmation still held: it is not canceled, and it goes out once)
  it('the same day and window while the confirmation is held: that 1 goes out', async () => {
    await at(NIGHT);
    const j = await create('2026-10-14', 'two_hour 10:00');
    await move(j, '2026-10-14', 'two_hour 10:00');
    expect((await confirmations(j.jobNumber)).map((r) => r.status)).toEqual(['held']);
    await at(MORNING);
    expect((await confirmations(j.jobNumber)).map((r) => r.status)).toEqual(['delivered']);
    expect((await inbox(j.jobNumber)).filter((x) => x.includes("You're booked"))).toHaveLength(1);
  });

  // why: F-799, SD-45 (moved twice: the first 2 end canceled and only the last day and window reach the customer)
  it('moved twice: only the last day and window reach the customer', async () => {
    await at(NIGHT);
    const a = await create('2026-10-13', 'two_hour 08:00');
    const b = await move(a, '2026-10-14', 'two_hour 12:00');
    await move(b, '2026-10-15', 'two_hour 14:00');
    await at(MORNING);
    const read = (await inbox(a.jobNumber)).filter((x) => x.includes("You're booked"));
    expect(read).toHaveLength(1);
    expect(read[0]).toContain('Oct 15');
    expect(read[0]).toContain('2-4 PM');
    expect((await confirmations(a.jobNumber)).map((r) => r.status)).toEqual(['canceled', 'canceled', 'delivered']);
  });

  // why: F-799, SD-45 (moved and then canceled: nothing at all reaches the customer)
  it('moved and then canceled: nothing reaches the customer', async () => {
    await at(NIGHT);
    const a = await create('2026-10-13', 'two_hour 10:00');
    const b = await move(a, '2026-10-14', 'two_hour 10:00');
    await cancel(b);
    await at(MORNING);
    expect(await inbox(a.jobNumber)).toEqual([]);
    expect((await confirmations(a.jobNumber)).map((r) => r.status)).toEqual(['canceled', 'canceled']);
  });

  // why: F-799, SD-45 (a job made at night for the next morning is canceled: the held confirmation and the held at-once reminder both stay unsent)
  it('canceled the night before the visit: neither the confirmation nor the at-once reminder reaches the customer', async () => {
    await at(NIGHT);
    const j = await create('2026-09-16', 'four_hour 12:00');
    await worker.drain(); // the reminder event fires at once (F-446) and its text is held too
    await cancel(j);
    await at(MORNING);
    expect(await inbox(j.jobNumber)).toEqual([]);
  });

  // why: F-799 (a refused write changes nothing: the held confirmation is still the one that goes out)
  it('a refused cancel or move leaves the held confirmation to go out', async () => {
    await at(NIGHT);
    const j = await create('2026-10-16', 'two_hour 08:00');
    const stale = { ...j, version: j.version + 7 };
    expect((await api.post(`/jobs/${j.jobNumber}/cancellation`, { baseVersion: stale.version }, world.staff.keisha)).status).toBe(409);
    expect((await api.post(`/jobs/${j.jobNumber}/schedule`, { date: '2026-10-19', windowId: window('two_hour 10:00'), baseVersion: stale.version }, world.staff.keisha)).status).toBe(409);
    expect((await confirmations(j.jobNumber)).map((r) => r.status)).toEqual(['held']);
    await at(MORNING);
    const read = (await inbox(j.jobNumber)).filter((x) => x.includes("You're booked"));
    expect(read).toHaveLength(1);
    expect(read[0]).toContain('Oct 16');
  });

  // why: F-799 (the Messages page's confirmation tile counts what could go out: a canceled confirmation does not read as a late one)
  it('the Messages tile does not count a canceled confirmation against on time', async () => {
    await setDemoClock(db.admin(), '2026-09-20T02:30:00Z'); // 10:30 PM EDT, Sep 19, a day with no other text
    await worker.drain();
    const a = await create('2026-10-20', 'two_hour 08:00');
    const b = await create('2026-10-20', 'two_hour 10:00');
    await cancel(a);
    await at('2026-09-20T12:00:00Z');
    expect((await inbox(b.jobNumber)).filter((x) => x.includes("You're booked"))).toHaveLength(1);
    const r = await api.post('/text-searches', { date: '2026-09-19', branch: 'columbus' }, world.staff.keisha);
    expect(r.status, await r.clone().text()).toBe(200);
    const { counts } = ((await r.json()) as { data: { counts: { confirmations: number; confirmationsOnTime: number; notSent: number } } }).data;
    expect(counts).toMatchObject({ confirmations: 1, confirmationsOnTime: 1, notSent: 1 });
  });
});

describe('a retrying confirmation, then the visit changed', () => {
  // why: F-799, SD-45 (a confirmation between tries is unsent too: the move cancels it, its next try is skipped, and the customer reads only the new day)
  it('moved between tries: the next try is skipped and only the new day reaches the customer', async () => {
    await at('2026-09-21T14:00:00Z'); // 10:00 AM EDT: no quiet hours
    await setSimulator(db.admin(), 'fail_customer', { customerId: customer });
    const j = await create('2026-10-21', 'two_hour 08:00');
    await worker.drain();
    const [old] = await confirmations(j.jobNumber);
    expect(old).toMatchObject({ status: 'retrying' });
    await move(j, '2026-10-22', 'two_hour 10:00');
    await setSimulator(db.admin(), 'up');
    await at('2026-09-21T14:03:00Z');
    expect((await confirmations(j.jobNumber)).map((r) => r.status)).toEqual(['canceled', 'delivered']);
    const read = (await inbox(j.jobNumber)).filter((x) => x.includes("You're booked"));
    expect(read).toHaveLength(1);
    expect(read[0]).toContain('Oct 22');
  });
});

describe('a confirmation already delivered, then the visit changed', () => {
  // why: F-799, SD-45 (a delivered confirmation stays delivered: canceling sends nothing, and a move sends the new one)
  it('stays delivered: a cancel adds nothing, and a move adds 1 for the new day', async () => {
    await at('2026-09-22T14:00:00Z');
    const a = await create('2026-10-23', 'two_hour 08:00');
    await worker.drain();
    expect((await confirmations(a.jobNumber)).map((r) => r.status)).toEqual(['delivered']);
    await cancel(a);
    await worker.drain();
    expect((await confirmations(a.jobNumber)).map((r) => r.status)).toEqual(['delivered']);

    const b = await create('2026-10-23', 'two_hour 10:00');
    await worker.drain();
    await move(b, '2026-10-26', 'two_hour 10:00');
    await worker.drain();
    expect((await confirmations(b.jobNumber)).map((r) => r.status)).toEqual(['delivered', 'delivered']);
    expect((await inbox(b.jobNumber)).filter((x) => x.includes("You're booked"))).toHaveLength(2);
  });
});

describe('a reminder held by quiet hours, then the visit moved (F-831)', () => {
  const reminders = async (n: number) => (await db.admin().query<{ status: string; reason_key: string | null }>(
    `SELECT status, reason_key FROM world.outbox_text WHERE job_number = $1 AND kind = 'reminder' ORDER BY created_at, id`, [n])).rows;
  const read = async (n: number) => (await inbox(n)).filter((b) => b.includes('Brightwater reminder'));

  // why: F-831, FR-TEXT-2 (the moved visit is the day after the 8:00 AM send, so the try's own check lets the held text go: the move must end it, or the customer gets 2)
  it('moved 1 day: the held reminder ends canceled and the customer reads exactly 1 reminder, at 6:00 PM before the new day', async () => {
    await at('2026-09-24T02:30:00Z'); // 10:30 PM EDT, Sep 23
    const j = await create('2026-09-24', 'two_hour 12:00');
    await worker.drain(); // the at-once reminder (F-446) fires and quiet hours hold its text
    expect((await reminders(j.jobNumber)).map((r) => r.status)).toEqual(['held']);
    await move(j, '2026-09-25', 'two_hour 12:00');
    await at('2026-09-24T12:02:00Z');
    expect(await read(j.jobNumber)).toEqual([]);
    await at('2026-09-24T22:02:00Z'); // 6:02 PM EDT, the evening before the new day
    expect(await read(j.jobNumber)).toHaveLength(1);
    expect((await reminders(j.jobNumber)).map((r) => [r.status, r.reason_key])).toEqual([['canceled', VISIT_CHANGED], ['delivered', null]]);
  });

  // why: F-831, FR-TEXT-2 (moved inside its day the same night: the fired reminder plus a new at-once one would both go at 8:00 AM)
  it('moved to another window of the same day: the customer reads exactly 1 reminder at 8:00 AM, naming the new window', async () => {
    await at('2026-09-28T02:30:00Z'); // 10:30 PM EDT, Sep 27
    const j = await create('2026-09-28', 'two_hour 12:00');
    await worker.drain();
    await move(j, '2026-09-28', 'two_hour 08:00');
    await worker.drain();
    await at('2026-09-28T12:02:00Z');
    const got = await read(j.jobNumber);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('8-10 AM');
  });

  // why: F-831, FR-TEXT-2 (a move on the visit's own day plans no new reminder, so the held one is the customer's only one and stays)
  it('moved after the visit day began: no new reminder is planned, so the held one still goes, with the new window', async () => {
    await at('2026-09-29T02:30:00Z'); // 10:30 PM EDT, Sep 28
    const j = await create('2026-09-29', 'two_hour 12:00');
    await worker.drain();
    await at('2026-09-29T10:30:00Z'); // 6:30 AM EDT on the visit's day, still quiet hours
    await move(j, '2026-09-29', 'two_hour 10:00');
    await at('2026-09-29T12:02:00Z');
    const got = await read(j.jobNumber);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('10 AM-12 PM');
  });
});
