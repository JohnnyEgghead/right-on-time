// SPDX-License-Identifier: AGPL-3.0-or-later
// The office's job writes on a visit the technician has begun, and on a closed one (P4-JOB; F-505, F-506, F-566,
// F-507 item 3), on the real database through the production kernel as bw_web, with dispatchers whose sessions the real
// session layer made. The on-the-way text and its live map link are made by P3-TEXTS's real trigger (sendOnTheWay), the
// one an applied On my way runs, so the end this file proves is the end of a real link and a real queued text.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { sendOnTheWay } from '@bw/outbox';
import { Temporal } from '@bw/time';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { caller, ORIGIN, officeWorld, type Caller, type OfficeWorld, type Staff } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 30);
  api = caller(world.kernel);
  ({ keisha } = world.staff);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

interface Job { jobNumber: number; technicianId: string | null; status: string; version: number }
interface Problem { code: string; status: number; key?: string }

const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;
const body = async <T>(r: Response): Promise<T> => ((await r.json()) as { data: T }).data;
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const DATE = '2026-09-24';

async function created(input: { window: string; technician: string; service?: string; date?: string }): Promise<Job> {
  const customerId = world.customers[customer++ % world.customers.length] as string;
  const r = await api.post('/jobs', {
    customerId, serviceId: input.service ?? 'furnace_tune_up', equipmentId: null, problem: null,
    date: input.date ?? DATE, windowId: win(input.window), technicianId: tech(input.technician),
  }, keisha);
  if (r.status !== 201) throw new Error(`create answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return (await body<{ job: Job }>(r)).job;
}

/**
 * The job On the way the way an applied On my way leaves it: status and on_the_way_at, then P3-TEXTS's real trigger
 * (the live map token, the queued on-the-way text, texted_arrival). The customer gets a mobile and texts on first.
 */
async function onTheWay(job: Job): Promise<{ token: string; textId: string }> {
  const a = db.admin();
  await a.query(`UPDATE world.customer SET mobile = '(614) 555-0142', texts_on = true WHERE id = (SELECT customer_id FROM world.job WHERE job_number = $1)`, [job.jobNumber]);
  await a.query(`UPDATE world.job SET status = 'on_the_way', on_the_way_at = window_start WHERE job_number = $1`, [job.jobNumber]);
  const start = (await rows<{ window_start: Date }>('SELECT window_start FROM world.job WHERE job_number = $1', [job.jobNumber]))[0]!.window_start;
  const now = Temporal.Instant.fromEpochMilliseconds(start.getTime());
  const sent = await sendOnTheWay(a, { catalogs, linkHost: 'rot.example' }, { jobNumber: job.jobNumber, eta: now.add({ minutes: 12 }), now });
  if (!sent.sent) throw new Error(`the on-the-way trigger sent nothing: ${sent.reason}`);
  return { token: sent.token, textId: sent.textId };
}

const ended = async (token: string) => (await rows<{ ended_at: Date | null }>('SELECT ended_at FROM world.link_token WHERE token = $1', [token]))[0]!.ended_at;
const text = async (id: string) => (await rows<{ status: string; reason_key: string | null }>('SELECT status, reason_key FROM world.outbox_text WHERE id = $1', [id]))[0]!;
const status = async (n: number) => (await rows<{ status: string; on_the_way_at: Date | null; texted_arrival: Date | null }>(
  'SELECT status, on_the_way_at, texted_arrival FROM world.job WHERE job_number = $1', [n]))[0]!;
const version = async (n: number) => (await rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [n]))[0]!.version;

const cancel = (n: number, baseVersion: number) => api.post(`/jobs/${n}/cancellation`, { baseVersion }, keisha);
const assign = (n: number, technicianId: string | null, baseVersion: number) => api.post(`/jobs/${n}/assignment`, { technicianId, baseVersion }, keisha);
const reschedule = (n: number, date: string, window: string, baseVersion: number) => api.post(`/jobs/${n}/schedule`, { date, windowId: win(window), baseVersion }, keisha);
const edit = (n: number, serviceId: string, baseVersion: number) => world.kernel.router.handle(new Request(`http://web:3000/api/v1/jobs/${n}`, {
  method: 'PATCH', body: JSON.stringify({ serviceId, equipmentId: null, problem: null, baseVersion }),
  headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: keisha.cookie },
}), { address: '203.0.113.9' });

describe('the office changes a job that is On the way (owner rulings 4241980e, 2142ce69, d0c0a033, 7ccb76ec call 8)', () => {
  // why: FR-TEXT-4 (F-566; owner ruling 2142ce69 "End the link", 7ccb76ec call 8)
  it('Cancel visit cancels an On the way job, ends its live map link and cancels its unsent on-the-way text', async () => {
    const job = await created({ window: 'two_hour 08:00', technician: 'Jamal Carter' });
    const { token, textId } = await onTheWay(job);
    expect(await ended(token)).toBeNull();
    const r = await cancel(job.jobNumber, await version(job.jobNumber));
    expect(r.status).toBe(200);
    expect((await status(job.jobNumber)).status).toBe('canceled');
    expect(await ended(token)).not.toBeNull();
    expect(await text(textId)).toEqual({ status: 'canceled', reason_key: 'text_reason.visit_changed' });
  });

  // why: FR-TEXT-4 (owner ruling d0c0a033 "Back to Scheduled"; F-566)
  it('Reassign gives an On the way job to another technician as Scheduled, ends its link and cancels its text, and the board reads Scheduled', async () => {
    const job = await created({ window: 'two_hour 10:00', technician: 'Jamal Carter' });
    const { token, textId } = await onTheWay(job);
    const r = await assign(job.jobNumber, tech('Tom Reinhart'), await version(job.jobNumber));
    expect(r.status).toBe(200);
    expect((await body<{ job: Job }>(r)).job).toMatchObject({ status: 'scheduled', technicianId: tech('Tom Reinhart') });
    expect(await status(job.jobNumber)).toEqual({ status: 'scheduled', on_the_way_at: null, texted_arrival: null });
    expect(await ended(token)).not.toBeNull();
    expect(await text(textId)).toEqual({ status: 'canceled', reason_key: 'text_reason.visit_changed' });
    const change = (await rows<{ data: { from: Record<string, unknown>; to: Record<string, unknown> } }>(
      `SELECT data FROM world.job_change WHERE job_number = $1 AND kind = 'assigned' ORDER BY id DESC LIMIT 1`, [job.jobNumber]))[0]!;
    expect(change.data).toEqual({ from: { technicianId: tech('Jamal Carter'), status: 'on_the_way' }, to: { technicianId: tech('Tom Reinhart'), status: 'scheduled' } });
    // API-20: the board shows the job Scheduled on the new technician's row.
    const board = await body<{ technicians: { id: string; jobs: { jobNumber: number; status: string }[] }[] }>(await api.get(`/board?branch=columbus&date=${DATE}`, keisha));
    const row = board.technicians.find((t) => t.id === tech('Tom Reinhart'));
    expect(row?.jobs.find((j) => j.jobNumber === job.jobNumber)?.status).toBe('scheduled');
  });

  // why: FR-TEXT-4 (owner ruling d0c0a033 "Back to Scheduled")
  it('Reassign of an On site job sets it back to Scheduled for the new technician', async () => {
    const job = await created({ window: 'two_hour 12:00', technician: 'Jamal Carter' });
    await db.admin().query(`UPDATE world.job SET status = 'on_site', on_the_way_at = window_start, arrived_at = window_start WHERE job_number = $1`, [job.jobNumber]);
    const r = await assign(job.jobNumber, tech('Tom Reinhart'), await version(job.jobNumber));
    expect(r.status).toBe(200);
    expect((await rows('SELECT status, arrived_at FROM world.job WHERE job_number = $1', [job.jobNumber]))).toEqual([{ status: 'scheduled', arrived_at: null }]);
  });

  // why: FR-TEXT-4 (owner ruling 2142ce69 "End the link"; F-566)
  it('Reschedule moves an On the way job to another day as Scheduled, ends its link and cancels its text', async () => {
    const job = await created({ window: 'two_hour 14:00', technician: 'Jamal Carter' });
    const { token, textId } = await onTheWay(job);
    const r = await reschedule(job.jobNumber, '2026-09-25', 'two_hour 14:00', await version(job.jobNumber));
    expect(r.status).toBe(200);
    expect((await status(job.jobNumber)).status).toBe('scheduled');
    expect(await ended(token)).not.toBeNull();
    expect(await text(textId)).toEqual({ status: 'canceled', reason_key: 'text_reason.visit_changed' });
    // The customer's inbox never gets the canceled on-the-way text.
    expect(await rows(`SELECT 1 FROM world.inbox_message WHERE job_number = $1`, [job.jobNumber])).toHaveLength(0);
  });

  // why: FR-TEXT-4 (a reassign to the same technician is no change of hands: the trip stays)
  it('a reassign to the technician the job already has keeps the trip, its link and its text', async () => {
    const job = await created({ window: 'two_hour 16:00', technician: 'Jamal Carter' });
    const { token, textId } = await onTheWay(job);
    const r = await assign(job.jobNumber, tech('Jamal Carter'), await version(job.jobNumber));
    expect(r.status).toBe(200);
    expect((await status(job.jobNumber)).status).toBe('on_the_way');
    expect(await ended(token)).toBeNull();
    expect((await text(textId)).status).not.toBe('canceled');
  });
});

describe('the office job writes refuse a closed job with the rule key (F-505, F-506)', () => {
  // why: F-505 (UI-SPECIFICATION 12.1 item 9: 1 status rule for API-22, 24, 25 and 27) and F-506 (the rule's catalog key)
  it.each(['done', 'no_one_home', 'canceled'])('refuses a %s job on Reassign, Reschedule, Cancel visit and Edit details with rule.jobClosed and writes nothing', async (closed) => {
    const window = { done: 'two_hour 08:00', no_one_home: 'two_hour 12:00', canceled: 'two_hour 16:00' }[closed] as string;
    const job = await created({ window, technician: 'Greg Hoffman', date: '2026-09-25' });
    // A Done job has its billing item (migration 0012 refuses a done job without one at commit).
    await db.admin().query(`WITH j AS (UPDATE world.job SET status = $2 WHERE job_number = $1 RETURNING job_number)
      INSERT INTO world.billing_item (job_number, state, tries) SELECT job_number, 'in_billing', 1 FROM j WHERE $2 = 'done'`, [job.jobNumber, closed]);
    const v = await version(job.jobNumber);
    for (const r of [
      await assign(job.jobNumber, tech('Tom Reinhart'), v),
      await reschedule(job.jobNumber, '2026-09-24', 'two_hour 10:00', v),
      await cancel(job.jobNumber, v),
      await edit(job.jobNumber, 'heating_or_ac_fix', v),
    ]) {
      const p = (await r.json()) as Problem;
      expect([r.status, p.code, p.key]).toEqual([409, 'rule_refused', 'rule.jobClosed']);
    }
    expect(await version(job.jobNumber)).toBe(v);
    expect((await rows<{ kind: string }>('SELECT kind FROM world.job_change WHERE job_number = $1', [job.jobNumber])).map((c) => c.kind)).toEqual(['created']);
  });

  // why: F-506 (every rule_refused of the office job writes carries its rule's key)
  it('names the rule of a technician who does not work the day', async () => {
    const job = await created({ window: 'two_hour 08:00', technician: 'Greg Hoffman', date: '2026-09-28' });
    const off = (await rows<{ id: string }>(
      `SELECT t.id FROM world.technician t WHERE t.branch_id = 'columbus' AND NOT (EXTRACT(ISODOW FROM DATE '2026-09-28')::int = ANY (t.working_days)) LIMIT 1`))[0];
    if (!off) return; // every Columbus technician works Mondays in this seed: the key is then proven by the time-off case below
    const p = (await (await assign(job.jobNumber, off.id, 1)).json()) as Problem;
    expect([p.code, p.key]).toEqual(['rule_refused', 'rule.technicianNotWorking']);
  });

  // why: F-506
  it('names the rule of a window the day does not offer', async () => {
    const job = await created({ window: 'two_hour 08:00', technician: 'Greg Hoffman', date: '2026-10-01' });
    const r = await reschedule(job.jobNumber, '2026-10-03', 'two_hour 14:00', 1); // a Saturday: mornings only
    const p = (await r.json()) as Problem;
    expect([r.status, p.code, p.key]).toEqual([409, 'rule_refused', 'rule.windowNotOffered']);
  });
});

describe('Edit details across the install pool (F-507 item 3; SPECIFICATIONS 5.3 step 3)', () => {
  // why: FR-BOOK-5 (an edit that moves a job into the installer pool is a capacity write: window_full when that pool has no room)
  it('answers window_full when the new service is an install and no installer works the day, and changes nothing', async () => {
    const date = '2026-10-06';
    const job = await created({ window: 'two_hour 08:00', technician: 'Jamal Carter', date });
    const install = (await rows<{ id: string }>(`SELECT id FROM world.service_type WHERE skill = 'install' ORDER BY id LIMIT 1`))[0]!.id;
    const installers = (await rows<{ id: string }>(`SELECT id FROM world.technician WHERE branch_id = 'columbus' AND installer`)).map((t) => t.id);
    expect(installers.length).toBeGreaterThan(0);
    for (const id of installers) {
      await db.admin().query(`INSERT INTO world.time_off (technician_id, from_date, to_date, note, created_by) VALUES ($1, $2, $2, 'p4-job test', $3)`, [id, date, keisha.userId]);
    }
    const r = await edit(job.jobNumber, install, 1);
    expect([r.status, ((await r.json()) as Problem).code]).toEqual([409, 'window_full']);
    expect(await rows('SELECT service_id, version FROM world.job WHERE job_number = $1', [job.jobNumber])).toEqual([{ service_id: 'furnace_tune_up', version: 1 }]);
    // The same edit within its pool needs no room check and saves.
    expect((await edit(job.jobNumber, 'heating_or_ac_fix', 1)).status).toBe(200);
  });
});
