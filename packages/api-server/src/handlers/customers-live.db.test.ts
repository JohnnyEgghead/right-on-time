// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer page's edits and history against the writes that act on them live (P4-CUSTOMERS; F-668 member 2, F-670), on
// the real database through the production web kernel (createWebKernel as bw_web) and, for the reminder, the worker as
// main.ts starts it (job registry, bw_worker, DbClock on the clock row):
// - API-36 sets Spanish texts, and the technician's On my way (API-102, P3-TEXTS sendOnTheWay) is then sent in Spanish;
// - API-36 turns texts off, and the reminder of his next visit then goes on the call list (fireReminder through the worker);
// - API-35's history carries what a technician's finish wrote (work_done_line) and the old system's work-done cell.
// The visit is made through the office's own write, API-28, which plans its reminder (dispatch-writes.ts planReminder): no test
// calls the planner. Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatTime, Temporal } from '@bw/time';
import { startTestWorker } from '../../../../apps/worker/src/testing/worker.ts';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { ORIGIN } from '../office-writes/testing.ts';
import { answers, demoAt, item, noParts, techWorld, ZONE, type Tech, type TechWorld } from '../tech-items/testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
let maria: Tech;

beforeAll(async () => {
  w = await techWorld(db);
  [maria] = w.techs;
}, 120_000);
afterAll(async () => {
  await w?.close();
});
beforeEach(async () => {
  await w.runningClock(demoAt('11:06'));
});

/** The office user's call through the mounted router, as the customer page makes it. */
const office = (method: 'GET' | 'PATCH', path: string, body?: unknown) => w.kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), origin: ORIGIN, cookie: w.keisha.cookie },
}), { address: '203.0.113.9' });
/** A visit on `date` in the day's first window (its mode: the seed makes some days 4-hour), made through API-28 as the dispatcher does (no technician yet): the write plans the reminder. */
const made = async (customerId: string, date: string): Promise<number> => {
  const mode = (await w.rows<{ mode: string }>(`SELECT mode FROM world.day_mode WHERE branch_id = 'columbus' AND date = $1::date`, [date]))[0]?.mode ?? 'two_hour';
  const windowId = (await w.rows<{ id: string }>(`SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = $1 ORDER BY start_local LIMIT 1`, [mode]))[0]!.id;
  const r = await w.post('/jobs', { customerId, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId, technicianId: null }, w.keisha);
  if (r.status !== 201) throw new Error(`API-28 answered ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
};
const settings = async (id: string) => (await w.rows<{ text_language: string; texts_on: boolean }>(
  'SELECT text_language, texts_on FROM world.customer WHERE id = $1', [id]))[0];

describe("the customer's text settings, as the next text and the next reminder read them (FR-DISP-31)", () => {
  // why: FR-DISP-31 Edit changes his text language to Spanish and his next text is in Spanish (the technician's On my way, the live text producer)
  it('API-36 sets Spanish texts, and his next text, the On my way, is the Spanish template', async () => {
    const id = w.texting[1] as string;
    expect(await settings(id)).toEqual({ text_language: 'en', texts_on: true });
    expect((await office('PATCH', `/customers/${id}`, { textLanguage: 'es' })).status).toBe(200);
    const n = await w.newJob({ customerId: id });
    expect((await answers(await w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:28') })], maria)))[0]?.result).toBe('applied');
    const j = (await w.rows<{ texted_arrival: Date }>('SELECT texted_arrival FROM world.job WHERE job_number = $1', [n]))[0] as { texted_arrival: Date };
    const arrival = Temporal.Instant.fromEpochMilliseconds(j.texted_arrival.getTime());
    const tok = (await w.rows<{ token: string }>(`SELECT token FROM world.link_token WHERE job_number = $1 AND kind = 'live_map'`, [n]))[0]?.token;
    const t = await w.rows<{ kind: string; body: string }>('SELECT kind, body FROM world.outbox_text WHERE job_number = $1', [n]);
    const name = maria.nameInTexts;
    expect(t).toEqual([{
      kind: 'on_the_way',
      body: `Brightwater: ¡${name} va en camino! Llega a eso de las ${formatTime(arrival, ZONE, 'es')}. Siga la camioneta: bw.j7l.io/m/${tok} (este enlace caduca cuando ${name} llegue).`,
    }]);
  });

  // why: FR-DISP-31, FR-TEXT-13 turning his texts off puts his next reminder on the call list, not a text
  it('API-36 turns texts off, and the 6:00 PM reminder of his next visit goes on the call list through the worker, with no reminder text', async () => {
    const id = w.texting[2] as string;
    expect(await settings(id)).toEqual({ text_language: 'en', texts_on: true });
    expect((await office('PATCH', `/customers/${id}`, { textsOn: false })).status).toBe(200);
    expect((await settings(id))?.texts_on).toBe(false);
    const n = await made(id, '2026-09-16');
    // API-42 lists the next day's visit of a texts-off customer before any reminder event (F-651).
    const list = await office('GET', '/call-list?branch=columbus&date=2026-09-15');
    expect(list.status).toBe(200);
    const calls = ((await list.json()) as { data: { reminderCalls: { customerId: string; reason: string; visit: { jobNumber: number } }[] } }).data.reminderCalls;
    expect(calls.find((c) => c.customerId === id)).toMatchObject({ reason: 'texts_off', visit: { jobNumber: n } });
    const worker = await startTestWorker(db.url());
    try {
      await w.runningClock(demoAt('18:01'));
      await worker.drain();
    } finally {
      await worker.stop();
    }
    expect(await w.rows('SELECT call_date::text AS call_date, reason FROM world.call_list_entry WHERE job_number = $1', [n]))
      .toEqual([{ call_date: '2026-09-15', reason: 'texts_off' }]);
    expect(await w.rows(`SELECT 1 FROM world.outbox_text WHERE job_number = $1 AND kind = 'reminder'`, [n])).toEqual([]);
    expect(await w.rows(`SELECT state, result FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject = $1`, [String(n)]))
      .toEqual([{ state: 'done', result: 'call_list' }]);
  });

  // why: F-672, FR-TEXT-17 a zone edit moves the reminder of a live future visit; without the replan the reminder stays at 6:00 PM in the old zone
  it('API-36 moves the due reminder of a future visit when the zone changes, and leaves it when the zone is unchanged', async () => {
    const id = w.texting[0] as string;
    const n = await made(id, '2026-09-16');
    const due = async () => (await w.rows<{ due_at: Date }>(`SELECT due_at FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject = $1 AND state = 'due'`, [String(n)])).map((r) => r.due_at.toISOString());
    expect(await due()).toEqual(['2026-09-15T22:00:00.000Z']);
    expect((await office('PATCH', `/customers/${id}`, { timeZone: 'America/Chicago' })).status).toBe(200);
    expect(await due()).toEqual(['2026-09-15T23:00:00.000Z']);
  });
});

describe("the service history's What was done (API-35; F-670)", () => {
  // why: F-670 What was done shows the work-done lines a technician's finish wrote, in order, and the old system's cell; a visit with none says Not recorded (an empty list)
  it("reads a done job's work-done lines from the technician's finish, an old visit's cell, and none for a visit without one", async () => {
    const id = w.quiet[20] as string;
    await w.rows(
      `INSERT INTO world.past_visit (customer_id, technician_name, date, zone, window_start, window_end, outcome, service_text, source_ref, work_done)
       VALUES ($1, 'Tom Reinhart', DATE '2024-01-22', $2, TIMESTAMPTZ '2024-01-22 10:00-05', TIMESTAMPTZ '2024-01-22 12:00-05', 'done', 'No heat (repair)', 'f670-1', 'Replaced the igniter.'),
              ($1, 'Kevin Doyle', DATE '2020-10-12', $2, TIMESTAMPTZ '2020-10-12 10:00-04', TIMESTAMPTZ '2020-10-12 12:00-04', 'done', 'Furnace tune-up', 'f670-2', NULL)`, [id, ZONE]);
    const n = await w.newJob({ customerId: id, status: 'on_site' });
    const finish = item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:50'), payload: { ...noParts, workDone: ['Cleaned the flame sensor', 'Replaced the filter'] } });
    expect((await answers(await w.send([finish], maria)))[0]?.result).toBe('applied');
    const r = await office('GET', `/customers/${id}`);
    expect(r.status).toBe(200);
    const history = ((await r.json()) as { data: { history: { date: string; jobNumber: number | null; old: boolean; workDone: string[] }[] } }).data.history;
    expect(history.map((h) => [h.date, h.jobNumber, h.old, h.workDone])).toEqual([
      ['2026-09-15', n, false, ['Cleaned the flame sensor', 'Replaced the filter']],
      ['2024-01-22', null, true, ['Replaced the igniter.']],
      ['2020-10-12', null, true, []],
    ]);
  });
});
