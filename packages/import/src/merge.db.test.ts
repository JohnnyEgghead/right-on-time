// SPDX-License-Identifier: AGPL-3.0-or-later
// Merges and their undo on PostgreSQL 18 after a real import of the real generator output, as bw_web (role app):
// undo of 1 of the run's exact merges restores record B with its past visits and equipment (FR-IMP-4); an office
// merge of a likely pair moves B's jobs too, and its undo returns them; each decision and each undo happens once.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '@bw/db';
import { insertJob, useMigratedDatabase } from '../../db/src/testing/fixture.ts';
import { decidePair, importRunMover, mergePair, MergeRefused, undoMerge } from './merge.ts';
import { moveJobsToCustomer } from '../../api-server/src/office-writes/service.ts';
import { runImport, type RunOutcome } from './runner.ts';
import { generatedWorld, seedReference, stampClock, webPool } from './testing/world.ts';

const db = useMigratedDatabase();
let pool: ReturnType<typeof webPool>;
let real: RunOutcome;
let manager: string;
let windowId: string;
const AT = new Date('2026-09-15T14:00:00Z');

async function asWeb<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** What a customer owns: its status and the ids of its past visits, equipment and jobs. */
async function holdings(id: string) {
  const q = db.admin();
  const c = await q.query<{ status: string; merged_into: string | null }>('SELECT status, merged_into FROM world.customer WHERE id = $1', [id]);
  const v = await q.query<{ id: string }>('SELECT id FROM world.past_visit WHERE customer_id = $1 ORDER BY id', [id]);
  const e = await q.query<{ id: string }>('SELECT id FROM world.equipment WHERE customer_id = $1 ORDER BY id', [id]);
  const j = await q.query<{ job_number: number }>('SELECT job_number FROM world.job WHERE customer_id = $1 ORDER BY job_number', [id]);
  return { ...c.rows[0], visits: v.rows.map((r) => r.id), equipment: e.rows.map((r) => r.id), jobs: j.rows.map((r) => r.job_number) };
}

beforeAll(async () => {
  const a = db.admin();
  await seedReference(a);
  // The reference seed's own manager and Columbus 8-10 window (P2-SEED); the fixture's insertJob names service tune_up.
  const u = await a.query<{ id: string }>(`SELECT id FROM world."user" WHERE role = 'manager' ORDER BY email LIMIT 1`);
  manager = u.rows[0]?.id ?? '';
  await a.query(`INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key,
      invoice_price_cents, job_type, expected_minutes, skill, bookable_online)
    VALUES ('tune_up', 's.k', 't.k', 'p.k', 'l.k', 8900, 'maintenance', 60, 'heating_cooling', true)`);
  const w = await a.query<{ id: string }>(`SELECT id FROM world.arrival_window
    WHERE branch_id = 'columbus' AND mode = 'two_hour' AND start_local = '08:00' LIMIT 1`);
  windowId = w.rows[0]?.id ?? '';
  if (!manager || !windowId) throw new Error('the reference seed wrote no manager or no Columbus 8-10 window');
  pool = webPool(db.url());
  real = await runImport(pool, { kind: 'real', files: generatedWorld().files, bySetup: true, byUser: null, clock: stampClock('real') });
});
afterAll(async () => {
  await pool?.end();
});

describe('undo a merge (FR-IMP-4)', () => {
  // why: FR-IMP-4
  it("restores record B of 1 of the run's exact merges with its past visits and equipment, and leaves A with its own", async () => {
    // an exact pair whose B brought both visits and equipment
    const m = await db.admin().query<{ id: string; a: string; b: string; payload: { moved: { pastVisitIds: string[]; equipmentIds: string[] } } }>(
      `SELECT m.id, p.record_a AS a, p.record_b AS b, m.undo_payload AS payload FROM world."merge" m JOIN world.duplicate_pair p ON p.id = m.pair_id
        WHERE m.kind = 'exact' AND jsonb_array_length(m.undo_payload->'moved'->'pastVisitIds') > 0
          AND jsonb_array_length(m.undo_payload->'moved'->'equipmentIds') > 0 ORDER BY m.id LIMIT 1`);
    const merge = m.rows[0];
    if (!merge) throw new Error('the run has no exact merge that moved both visits and equipment');
    const { pastVisitIds, equipmentIds } = merge.payload.moved;
    // B's own rows as the export holds them: its customers.csv row's visits and equipment
    const bIndex = real.customerIds?.indexOf(merge.b) ?? -1;
    const fromFile = { visits: real.model.visits.filter((v) => v.customerIndex === bIndex).length, equipment: real.model.equipment.filter((e) => e.customerIndex === bIndex).length };
    expect({ visits: pastVisitIds.length, equipment: equipmentIds.length }).toEqual(fromFile);

    const a0 = await holdings(merge.a);
    expect(await holdings(merge.b)).toMatchObject({ status: 'merged', merged_into: merge.a, visits: [], equipment: [] });

    expect(await asWeb((tx) => undoMerge(tx, merge.id, { by: manager, at: AT, jobs: moveJobsToCustomer }))).toEqual({ recordA: merge.a, recordB: merge.b });

    const b1 = await holdings(merge.b);
    expect(b1).toMatchObject({ status: 'active', merged_into: null });
    expect(b1.visits).toEqual([...pastVisitIds].sort());
    expect(b1.equipment).toEqual([...equipmentIds].sort());
    const a1 = await holdings(merge.a);
    expect(a1.visits).toEqual(a0.visits.filter((id) => !pastVisitIds.includes(id)));
    expect(a1.equipment).toEqual(a0.equipment.filter((id) => !equipmentIds.includes(id)));
    const after = await db.admin().query<{ status: string; pair_status: string }>(
      `SELECT m.status, p.status AS pair_status FROM world."merge" m JOIN world.duplicate_pair p ON p.id = m.pair_id WHERE m.id = $1`, [merge.id]);
    expect(after.rows[0]).toEqual({ status: 'undone', pair_status: 'listed' });

    const again = await asWeb((tx) => undoMerge(tx, merge.id, { by: manager, at: AT, jobs: moveJobsToCustomer })).catch((e: unknown) => e);
    expect((again as MergeRefused).code).toBe('already_undone');
  });

  // why: FR-IMP-4
  it("an office merge of a likely pair moves B's jobs, visits and equipment to A, and its undo returns every one to B", async () => {
    const p = await db.admin().query<{ id: string; a: string; b: string }>(
      `SELECT p.id, p.record_a AS a, p.record_b AS b FROM world.duplicate_pair p
        WHERE p.kind = 'likely' AND p.status = 'listed' AND EXISTS (SELECT 1 FROM world.past_visit v WHERE v.customer_id = p.record_b)
        ORDER BY p.id LIMIT 1`);
    const pair = p.rows[0];
    if (!pair) throw new Error('no listed likely pair with past visits');
    const open = await insertJob(db.admin(), { customerId: pair.b, windowId });
    const done = await insertJob(db.admin(), { customerId: pair.b, windowId }, { status: 'done', date: '2026-09-01', window_start: '2026-09-01T08:00:00-04:00', window_end: '2026-09-01T10:00:00-04:00' });
    const b0 = await holdings(pair.b);
    const a0 = await holdings(pair.a);
    expect(b0.jobs).toEqual([open, done].sort((x, y) => x - y));

    // The import run's mover never moves a job: it refuses a record B that owns one (F-267).
    await expect(asWeb((tx) => importRunMover(tx, { from: pair.b, to: pair.a, jobNumbers: null, mergeId: pair.id, step: 'merge', by: null, at: AT })))
      .rejects.toThrow(/only the office write service may move jobs/);
    // Jobs move through the office write service's mover (F-267), the one API-86 and API-88 pass.
    const decided = await asWeb((tx) => decidePair(tx, pair.id, 'merge', manager, AT, moveJobsToCustomer));
    expect(decided.status).toBe('merged');
    expect(await holdings(pair.b)).toMatchObject({ status: 'merged', merged_into: pair.a, visits: [], equipment: [], jobs: [] });
    const a1 = await holdings(pair.a);
    expect(a1.jobs).toEqual([...a0.jobs, ...b0.jobs].sort((x, y) => x - y));
    expect(a1.visits).toEqual([...a0.visits, ...b0.visits].sort());
    const row = await db.admin().query<{ kind: string; decided_by: string; status: string }>(
      `SELECT m.kind, p.decided_by, p.status FROM world."merge" m JOIN world.duplicate_pair p ON p.id = m.pair_id WHERE m.id = $1`, [decided.mergeId]);
    expect(row.rows[0]).toEqual({ kind: 'office', decided_by: manager, status: 'merged' });

    const twice = await asWeb((tx) => decidePair(tx, pair.id, 'keep_separate', manager, AT, moveJobsToCustomer)).catch((e: unknown) => e);
    expect((twice as MergeRefused).code).toBe('already_decided');

    await asWeb((tx) => undoMerge(tx, decided.mergeId as string, { by: manager, at: AT, jobs: moveJobsToCustomer }));
    expect(await holdings(pair.b)).toEqual(b0);
    expect(await holdings(pair.a)).toEqual(a0);
  });

  // why: FR-IMP-4
  it('2 concurrent undos of 1 merge: exactly 1 restores, the other answers already_undone', async () => {
    const m = await db.admin().query<{ id: string; b: string }>(
      `SELECT m.id, p.record_b AS b FROM world."merge" m JOIN world.duplicate_pair p ON p.id = m.pair_id
        WHERE m.kind = 'exact' AND m.status = 'active' ORDER BY m.id DESC LIMIT 1`);
    const merge = m.rows[0] as { id: string; b: string };
    const results = await Promise.allSettled([asWeb((tx) => undoMerge(tx, merge.id, { by: manager, at: AT, jobs: moveJobsToCustomer })), asWeb((tx) => undoMerge(tx, merge.id, { by: manager, at: AT, jobs: moveJobsToCustomer }))]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as MergeRefused).code).toBe('already_undone');
    expect((await holdings(merge.b)).status).toBe('active');
  });
});

describe('pair decisions (FR-IMP-3)', () => {
  // why: FR-IMP-3
  it('Skip for later keeps a pair in the queue as skipped; Keep separate then decides it; no record changes', async () => {
    const p = await db.admin().query<{ id: string; a: string; b: string }>(
      `SELECT id, record_a AS a, record_b AS b FROM world.duplicate_pair WHERE kind = 'likely' AND status = 'listed' ORDER BY id DESC LIMIT 1`);
    const pair = p.rows[0] as { id: string; a: string; b: string };
    const b0 = await holdings(pair.b);
    expect(await asWeb((tx) => decidePair(tx, pair.id, 'skip', manager, AT, moveJobsToCustomer))).toEqual({ status: 'skipped', mergeId: null });
    const skipAgain = await asWeb((tx) => decidePair(tx, pair.id, 'skip', manager, AT, moveJobsToCustomer)).catch((e: unknown) => e);
    expect((skipAgain as MergeRefused).code).toBe('already_decided');
    expect(await asWeb((tx) => decidePair(tx, pair.id, 'keep_separate', manager, AT, moveJobsToCustomer))).toEqual({ status: 'kept_separate', mergeId: null });
    expect(await holdings(pair.b)).toEqual(b0);
  });
});

describe('imported equipment is told from a visitor\'s (F-391)', () => {
  // why: F-391 equipment and visits the import wrote are the ids world_snapshot holds, so the restore test's import counts (infra/backup/import-check.sql) do not move when a visitor adds equipment
  it('counts only the day-start copy\'s equipment in import-check.sql, whatever a visitor adds', async () => {
    const q = db.admin();
    await q.query('CREATE SCHEMA IF NOT EXISTS world_snapshot');
    await q.query('DROP TABLE IF EXISTS world_snapshot.equipment, world_snapshot.past_visit');
    await q.query('CREATE TABLE world_snapshot.equipment AS TABLE world.equipment');
    await q.query('CREATE TABLE world_snapshot.past_visit AS TABLE world.past_visit');
    const sql = readFileSync(new URL('../../../infra/backup/import-check.sql', import.meta.url), 'utf8');
    const counts = async () => Object.fromEntries((await q.query<Record<string, string>>(sql)).rows.flatMap((r) => {
      const [item, , n] = String(Object.values(r)[0]).split('|');
      return item === 'equipment imported' || item === 'service visits imported' ? [[item, Number(n)]] : [];
    }));
    const before = await counts();
    expect(before['equipment imported']).toBeGreaterThan(0);
    expect(before['equipment imported']).toBe(Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM world.equipment')).rows[0]?.n));
    const c = await q.query<{ id: string }>(`SELECT id FROM world.customer WHERE status = 'active' LIMIT 1`);
    await asWeb((tx) => tx.query(`INSERT INTO world.equipment (customer_id, type) VALUES ($1, 'furnace')`, [c.rows[0]?.id]));
    expect(await counts()).toEqual(before);
    expect(Number((await q.query<{ n: string }>('SELECT count(*) AS n FROM world.equipment')).rows[0]?.n)).toBe((before['equipment imported'] as number) + 1);
  });
});

describe('the merge savepoint (F-681)', () => {
  /** Listed likely pairs with disjoint, active records and no jobs, as many as `n`. */
  async function freePairs(n: number): Promise<{ id: string }[]> {
    const p = await db.admin().query<{ id: string; a: string; b: string }>(
      `SELECT p.id, p.record_a AS a, p.record_b AS b FROM world.duplicate_pair p
         JOIN world.customer ca ON ca.id = p.record_a AND ca.status = 'active' JOIN world.customer cb ON cb.id = p.record_b AND cb.status = 'active'
        WHERE p.kind = 'likely' AND p.status = 'listed' AND NOT EXISTS (SELECT 1 FROM world.job j WHERE j.customer_id IN (p.record_a, p.record_b))
        ORDER BY p.id`);
    const seen = new Set<string>();
    return p.rows.filter((r) => !seen.has(r.a) && !seen.has(r.b) && (seen.add(r.a), seen.add(r.b), true)).slice(0, n);
  }
  /** Runs `fn` in 1 transaction as bw_web and rolls it back, so no merge here outlives the test. */
  async function rolledBack<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  // why: F-681 the import run's mover takes no savepoint: 70 merges in the run's 1 transaction leave 0 open subtransactions, not 1 per merge (past 64 the backend's cache overflows)
  it("70 merges with the import run's mover in 1 transaction leave 0 open subtransactions", async () => {
    const pairs = await freePairs(70);
    expect(pairs).toHaveLength(70);
    const s = await rolledBack(async (tx) => {
      for (const pair of pairs) await mergePair(tx, pair.id, { kind: 'exact', at: AT, by: null, jobs: importRunMover });
      // The backend status snapshot is taken at its first read in a transaction, so this is the only read.
      return (await tx.query<{ subxact_count: number; subxact_overflowed: boolean }>(
        `SELECT s.subxact_count, s.subxact_overflowed FROM pg_stat_get_backend_idset() AS b(id), LATERAL pg_stat_get_backend_subxact(b.id) s
          WHERE pg_stat_get_backend_pid(b.id) = pg_backend_pid()`)).rows[0];
    });
    expect(s).toEqual({ subxact_count: 0, subxact_overflowed: false });
  });

  // why: F-681 the office mover's lock-phase savepoint is released once the merge succeeds: none is left behind for the rest of the transaction
  it("an office merge releases its savepoint on success, so the caller's transaction holds none afterwards", async () => {
    const [pair] = await freePairs(1);
    if (!pair) throw new Error('no free listed likely pair');
    const code = await rolledBack(async (tx) => {
      await mergePair(tx, pair.id, { kind: 'office', at: AT, by: manager, jobs: moveJobsToCustomer });
      return tx.query('ROLLBACK TO SAVEPOINT merge_pair').then(() => 'savepoint still open', (e: { code?: string }) => e.code);
    });
    expect(code).toBe('3B001'); // invalid_savepoint_specification: no savepoint of that name is open
  });
});

