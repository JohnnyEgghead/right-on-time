// SPDX-License-Identifier: AGPL-3.0-or-later
// The office finish (API-26, SCR-OFC-22 finish mode; P4-JOB, D-17) on the real database through the production kernel as
// bw_web, as a dispatcher of the reference seed with a real session (SPECIFICATIONS section 6.6 FR-BILL-1, FR-BILL-3;
// section 3: finishJobOffice writes done, billing sending and job_change status_set). G-CI10's finish probe drives the
// parts_required case too (ci/gates/G-CI10/finish-probes.ts); this file covers the rest of the route.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let customer = 0;
const parts: string[] = [];

beforeAll(async () => {
  world = await officeWorld(db, 20);
  api = caller(world.kernel);
  ({ keisha } = world.staff);
  parts.push(...(await db.admin().query<{ id: string }>('SELECT id::text AS id FROM world.part ORDER BY code LIMIT 2')).rows.map((r) => r.id));
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const windows = ['two_hour 08:00', 'two_hour 10:00', 'two_hour 12:00', 'two_hour 14:00', 'two_hour 16:00'];

async function onSite(status = 'on_site'): Promise<number> {
  const r = await api.post('/jobs', {
    customerId: world.customers[customer % world.customers.length], serviceId: 'furnace_tune_up', equipmentId: null, problem: null,
    date: '2026-09-24', windowId: world.windows.get(windows[customer++ % windows.length] as string), technicianId: world.technicians.get('Kevin Doyle'),
  }, keisha);
  if (r.status !== 201) throw new Error(`create answered ${r.status}: ${await r.text()}`);
  const n = ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
  await db.admin().query(`UPDATE world.job SET status = $2 WHERE job_number = $1`, [n, status]);
  return n;
}
const finish = (n: number, body: Record<string, unknown>) => api.post(`/jobs/${n}/finish`, { parts: [], noPartsUsed: false, laborMinutes: 50, baseVersion: 1, ...body }, keisha);

describe('the office finish (API-26)', () => {
  // why: FR-BILL-1 (the office finish path: the job is Done and enters billing in the same transaction)
  it('finishes an On site job with 2 parts and labor: Done, billing sending, the lines stored, 1 status_set row, no work-done lines', async () => {
    const n = await onSite();
    const r = await finish(n, { parts: [{ partId: parts[0], quantity: 2 }, { partId: parts[1], quantity: 1 }], laborMinutes: 75 });
    expect(r.status, await r.clone().text()).toBe(200);
    const data = ((await r.json()) as { data: { job: { status: string; version: number }; billing: { state: string } } }).data;
    expect(data).toMatchObject({ job: { status: 'done', version: 2 }, billing: { state: 'sending' } });
    expect(await rows('SELECT status, labor_minutes, no_parts_used, billing_state FROM world.job WHERE job_number = $1', [n]))
      .toEqual([{ status: 'done', labor_minutes: 75, no_parts_used: false, billing_state: 'sending' }]);
    expect(await rows('SELECT part_id::text AS part, quantity FROM world.job_part WHERE job_number = $1 ORDER BY quantity DESC', [n]))
      .toEqual([{ part: parts[0], quantity: 2 }, { part: parts[1], quantity: 1 }]);
    expect(await rows('SELECT state FROM world.billing_item WHERE job_number = $1', [n])).toEqual([{ state: 'sending' }]);
    expect(await rows(`SELECT kind, actor_kind, actor_user_id::text AS by FROM world.job_change WHERE job_number = $1 AND kind = 'status_set'`, [n]))
      .toEqual([{ kind: 'status_set', actor_kind: 'office', by: keisha.userId }]);
    // why: OI-35 (an office finish carries no work-done lines)
    expect(await rows('SELECT 1 FROM world.work_done_line WHERE job_number = $1', [n])).toHaveLength(0);
  });

  // why: FR-BILL-3 (F-358: neither parts nor No parts used is refused, and nothing is written)
  it('refuses a finish with neither parts nor No parts used with parts_required: the job stays On site with no billing item', async () => {
    const n = await onSite();
    const r = await finish(n, {});
    expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([422, 'parts_required']);
    expect(await rows('SELECT status, version FROM world.job WHERE job_number = $1', [n])).toEqual([{ status: 'on_site', version: 1 }]);
    expect(await rows('SELECT 1 FROM world.billing_item WHERE job_number = $1', [n])).toHaveLength(0);
  });

  // why: FR-BILL-3 (OA-54: a part not on the seeded list cannot be billed)
  it('refuses a part not on the list with validation_failed', async () => {
    const n = await onSite();
    const r = await finish(n, { parts: [{ partId: 'typed-by-hand', quantity: 1 }] });
    expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([422, 'validation_failed']);
  });

  // why: FR-BILL-1 (No parts used finishes a Scheduled job the office closes out)
  it('finishes a Scheduled job with No parts used', async () => {
    const n = await onSite('scheduled');
    const r = await finish(n, { noPartsUsed: true, laborMinutes: 30 });
    expect(r.status).toBe(200);
    expect(await rows('SELECT status, no_parts_used FROM world.job WHERE job_number = $1', [n])).toEqual([{ status: 'done', no_parts_used: true }]);
  });

  // why: F-505 (CTL-OFC-03-08's rule: a closed job cannot be finished; the rule's key names it)
  it('refuses a Canceled job with rule_refused rule.jobClosed, and a stale version with version_conflict', async () => {
    const n = await onSite('canceled');
    const r = await finish(n, { noPartsUsed: true });
    const p = (await r.json()) as { code: string; key?: string };
    expect([r.status, p.code, p.key]).toEqual([409, 'rule_refused', 'rule.jobClosed']);
    const m = await onSite();
    const stale = await finish(m, { noPartsUsed: true, baseVersion: 7 });
    expect([stale.status, ((await stale.json()) as { code: string }).code]).toEqual([409, 'version_conflict']);
  });
});
