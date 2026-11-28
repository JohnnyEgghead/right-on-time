// SPDX-License-Identifier: AGPL-3.0-or-later
// The autopilot of the sample day (SPECIFICATIONS SD-21, OA-78) and the touched-by-person rule (F-491), on the real database
// (PostgreSQL 18, the migrated schema, P2-SEED's reference seed) through the production kernel as bw_web. A step is run by
// runAutopilotStep, the function the worker's autopilot.step handler calls; the technician's own items go through the app's send-items call (API-102).
// The sample day's own run (the seeded events through the real dispatcher) is in packages/setup/src/setup.db.test.ts.
// Run by G-CI1 and by G-CI7 step 3.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, inTransaction, type Queryable } from '@bw/db';
import { Temporal } from '@bw/time';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { catalogs } from '../../../i18n/src/catalog.ts';
import { moveJobsToCustomer } from '../office-writes/service.ts';
import { runAutopilotStep, type AutopilotStepName } from './autopilot.ts';
import { answers, demoAt, item, noteOf, techWorld, type Tech, type TechWorld } from './testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
let maria: Tech;
let pool: ReturnType<typeof createPool>;
const deps = { catalogs, linkHost: 'bw.j7l.io' };

beforeAll(async () => {
  w = await techWorld(db);
  maria = w.techs[0];
  pool = createPool({ connectionString: db.url(), max: 2 });
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await w?.close();
});

const job = async (n: number) => (await w.rows<{ status: string; version: number; touched: boolean; on_the_way_at: Date | null; arrived_at: Date | null; ended_at: Date | null; labor_minutes: number | null }>(
  'SELECT status, version, touched_by_person AS touched, on_the_way_at, arrived_at, ended_at, labor_minutes FROM world.job WHERE job_number = $1', [n]))[0]!;
const iso = (d: Date | null) => (d ? Temporal.Instant.fromEpochMilliseconds(d.getTime()).toString() : null);

/** One autopilot.step event run at `now`. */
const step = (n: number, name: AutopilotStepName, now: string, extra: Record<string, unknown> = {}, who: Tech = maria) =>
  inTransaction(pool, (tx) => runAutopilotStep(tx, deps, { id: crypto.randomUUID(), payload: { jobNumber: n, technicianId: who.technicianId, step: name, ...extra } }, demoAt(now)));

describe('the autopilot steps (SD-21)', () => {
  // why: SD-21
  it('moves a job through On my way, Arrived and Finished through the item path as its technician, at the event time, touching nothing as a person', async () => {
    const n = await w.newJob({ customerId: w.texting[0] as string });
    const parts = (await w.rows<{ code: string }>('SELECT code FROM world.part ORDER BY code LIMIT 2')).map((p) => p.code);
    expect(await step(n, 'on_my_way', '09:05')).toEqual({ state: 'done', result: 'applied' });
    expect(await job(n)).toMatchObject({ status: 'on_the_way', version: 2, touched: false });
    expect(iso((await job(n)).on_the_way_at)).toBe(demoAt('09:05').toString());
    expect(await step(n, 'arrived', '09:20')).toEqual({ state: 'done', result: 'applied' });
    expect(await step(n, 'finished', '10:10', { laborMinutes: 50, partCodes: parts })).toEqual({ state: 'done', result: 'applied' });
    const done = await job(n);
    expect(done).toMatchObject({ status: 'done', version: 4, touched: false, labor_minutes: 50 });
    expect([iso(done.arrived_at), iso(done.ended_at)]).toEqual([demoAt('09:20').toString(), demoAt('10:10').toString()]);
    expect(await w.rows('SELECT 1 FROM world.job_part WHERE job_number = $1', [n])).toHaveLength(2);
    // As that technician, through the ledger: 3 tech_item rows of the technician, 3 status changes by a technician.
    expect(await w.rows<{ kind: string; technician_id: string }>('SELECT kind, technician_id FROM world.tech_item WHERE job_number = $1 ORDER BY received_at, kind', [n]))
      .toHaveLength(3);
    expect(await w.rows<{ actor_kind: string; actor_user_id: string }>(`SELECT DISTINCT actor_kind, actor_user_id FROM world.job_change WHERE job_number = $1 AND kind = 'status'`, [n]))
      .toEqual([{ actor_kind: 'technician', actor_user_id: maria.userId }]);
    // The visit's texts follow the item path: the on-the-way text was written by the same trigger a technician's item uses.
    expect((await w.rows<{ kind: string }>('SELECT kind FROM world.outbox_text WHERE job_number = $1', [n])).map((t) => t.kind)).toContain('on_the_way');
  });

  // why: SD-21
  it('finishes with no parts used when the step lists none, and records No one home', async () => {
    const a = await w.newJob({ status: 'on_site' });
    expect(await step(a, 'finished', '10:00', { laborMinutes: 20, partCodes: [] })).toEqual({ state: 'done', result: 'applied' });
    expect(await w.rows<{ no_parts_used: boolean }>('SELECT no_parts_used FROM world.job WHERE job_number = $1', [a])).toEqual([{ no_parts_used: true }]);
    const b = await w.newJob({ status: 'on_site' });
    expect(await step(b, 'no_one_home', '10:00')).toEqual({ state: 'done', result: 'applied' });
    expect((await job(b)).status).toBe('no_one_home');
  });

  // why: SD-21
  it('skips a job a person touched and a job not in the step expected prior status, and changes nothing', async () => {
    const touched = await w.newJob();
    await w.admin().query('UPDATE world.job SET touched_by_person = true WHERE job_number = $1', [touched]);
    const before = await job(touched);
    expect(await step(touched, 'on_my_way', '09:05')).toEqual({ state: 'skipped', result: 'touched_by_person' });
    expect(await job(touched)).toEqual(before);
    expect(await w.rows('SELECT 1 FROM world.tech_item WHERE job_number = $1', [touched])).toHaveLength(0);

    const fresh = await w.newJob();
    for (const name of ['arrived', 'finished', 'no_one_home'] as const) {
      expect(await step(fresh, name, '09:05')).toEqual({ state: 'skipped', result: 'not_in_prior_status' });
    }
    expect((await job(fresh)).status).toBe('scheduled');
    const onWay = await w.newJob({ status: 'on_the_way' });
    expect(await step(onWay, 'on_my_way', '09:05')).toEqual({ state: 'skipped', result: 'not_in_prior_status' });
  });

  // why: SD-21
  it('skips a step of another technician job, a missing job and a payload it cannot read', async () => {
    const n = await w.newJob();
    expect((await step(n, 'on_my_way', '09:05', {}, w.techs[1])).state).toBe('skipped');
    expect((await job(n)).status).toBe('scheduled');
    expect(await step(999999999, 'on_my_way', '09:05')).toEqual({ state: 'skipped', result: 'no_job' });
    expect(await inTransaction(pool, (tx) => runAutopilotStep(tx, deps, { id: crypto.randomUUID(), payload: { jobNumber: n } }, demoAt('09:05')))).toEqual({ state: 'skipped', result: 'bad_payload' });
  });
});

describe('a write that marks the job touched (SD-21, F-491)', () => {
  // why: F-491
  it("a person's technician status item sets touched_by_person, and the autopilot then leaves the job alone", async () => {
    const n = await w.newJob();
    expect((await job(n)).touched).toBe(false);
    const [r] = await answers(await w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:00') })], maria));
    expect(r).toMatchObject({ result: 'applied' });
    expect((await job(n)).touched).toBe(true);
    expect(await step(n, 'arrived', '10:20')).toEqual({ state: 'skipped', result: 'touched_by_person' });
  });

  // why: F-491
  it("a person's note item sets touched_by_person without bumping the job version", async () => {
    const n = await w.newJob();
    const [r] = await answers(await w.send([item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:00'), payload: noteOf() })], maria));
    expect(r).toMatchObject({ result: 'applied' });
    expect(await job(n)).toMatchObject({ touched: true, version: 1 });
  });

  // why: F-491
  it('a refused item marks nothing touched', async () => {
    const n = await w.newJob({ status: 'on_site' });
    const [r] = await answers(await w.send([item({ kind: 'finished', jobNumber: n, baseVersion: 1, entered: demoAt('10:00'), payload: { parts: [], noPartsUsed: false, laborMinutes: 30, workDone: [] } })], maria));
    expect(r).toMatchObject({ result: 'refused', code: 'parts_required' });
    expect((await job(n)).touched).toBe(false);
  });

  // why: F-491
  it('the office customer merge moves the jobs, bumps the version and sets touched_by_person', async () => {
    const n = await w.newJob({ customerId: w.quiet[0] as string });
    expect((await job(n)).touched).toBe(false);
    const moved = await inTransaction(pool, (tx) => moveJobsToCustomer(tx, {
      from: w.quiet[0] as string, to: w.quiet[1] as string, jobNumbers: [n], mergeId: crypto.randomUUID(), step: 'merge', by: w.keisha.userId, at: new Date('2026-09-15T14:00:00Z'),
    }));
    expect(moved).toEqual([n]);
    expect(await job(n)).toMatchObject({ touched: true, version: 2 });
  });
});

describe('a finish reads only its own parts (K-09.10; F-2009)', () => {
  // why: F-2009 the finish's part check reads the part table by the finish's own ids (WHERE id = ANY), not every row of it (K-09.10)
  it('names the finish\'s part ids in the part query and still finishes with them', async () => {
    const n = await w.newJob({ status: 'on_site' });
    const part = (await w.rows<{ id: string; code: string }>('SELECT id::text, code FROM world.part ORDER BY code LIMIT 1'))[0]!;
    const seen: { text: string; values: unknown[] | undefined }[] = [];
    const out = await inTransaction(pool, (tx) => {
      const spy = { query: (text: string, values?: unknown[]) => { seen.push({ text, values }); return tx.query(text, values); } } as unknown as Queryable;
      return runAutopilotStep(spy, deps, { id: crypto.randomUUID(), payload: { jobNumber: n, technicianId: maria.technicianId, step: 'finished', laborMinutes: 30, partCodes: [part.code] } }, demoAt('10:10'));
    });
    expect(out).toEqual({ state: 'done', result: 'applied' });
    // The autopilot looks its parts up by code; the finish's own check is the other read of world.part.
    const checks = seen.filter((q) => /FROM world\.part\b/.test(q.text) && !/code\s*=\s*ANY/.test(q.text));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.text).toMatch(/WHERE id = ANY\(\$1/);
    expect(checks[0]?.values).toEqual([[part.id]]);
  });
});
