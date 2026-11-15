// SPDX-License-Identifier: AGPL-3.0-or-later
// Merges, their undo and the office's pair decisions (SPECIFICATIONS section 6.7 "Duplicates" and "Undo a merge";
// FR-IMP-3, FR-IMP-4, FR-IMP-11). 1 merge path for the run's exact merges and for decidePair (API-86), as the spec
// says it holds for both. Each function runs in the caller's transaction and locks the rows it decides on, so 2
// concurrent decisions on 1 pair, or 2 undos of 1 merge, serialize: the second sees the first's result and is refused.
//
// A merge keeps record A (its own name and contact fields stay as they are). Record B gets status merged and
// merged_into = A, and every past visit, piece of equipment and job of B (done, no_one_home and open alike) moves to A.
// merge.undo_payload stores both customer rows as they were and the ids it moved; undo puts B's row back and moves
// exactly those ids back to B, wherever they are now, and returns the pair to the office's queue (status listed).
// Jobs (owner ruling a7cafbb1, F-267): a merge and its undo move B's jobs through the caller's JobMover, which gives
// each moved job version + 1, a job_change row and a job.changed notice (the office write service's
// moveJobsToCustomer, P3-OFFICE-WRITES). This package cannot reach that service (it sits above @bw/import), so every
// caller passes its mover; the import run's own exact merges pass importRunMover, which asserts what is true by
// construction there: both records were inserted in the run's transaction, so record B owns no job.
import type { CustomerRow, Queryable } from '@bw/db';

/** 1 move of jobs between the 2 records of a merge. */
export interface JobMove {
  from: string;
  to: string;
  /** null: every job of `from` (a merge); else exactly these jobs, wherever they are now (an undo). */
  jobNumbers: readonly number[] | null;
  mergeId: string;
  step: 'merge' | 'undo';
  by: string | null;
  at: Date;
  /** The technician-days the caller already holds (from `lockDays`): a day the jobs show beyond these is only try-locked, and an unavailable one throws LockOrderRetry. */
  held?: readonly HeldDay[];
}

/** 1 technician-day lock a caller holds (section 5.3 step 2). */
export interface HeldDay {
  technicianId: string;
  date: string;
}

/** Thrown by a mover that holds `move.held` when the jobs show a day it cannot take without waiting; mergePair rolls back to its savepoint and starts over holding `days` first. */
export class LockOrderRetry extends Error {
  readonly days: readonly HeldDay[];
  constructor(days: readonly HeldDay[]) {
    super('the jobs moved to a technician-day the merge does not hold');
    this.days = days;
    this.name = 'LockOrderRetry';
  }
}

/**
 * Moves the jobs, records each move on the job (version, job_change, notice) and returns the moved job numbers, sorted.
 * `lockDays` (F-379, F-622; section 5.3 step 6: technician-days before any customer or job row): takes the technician-day
 * locks of every job of `from` (plus `seed`, days a previous try found), in 1 sorted batch, and returns the days held.
 */
export type JobMover = ((tx: Queryable, move: JobMove) => Promise<number[]>) & {
  lockDays?: (tx: Queryable, from: string, seed: readonly HeldDay[]) => Promise<readonly HeldDay[]>;
};

/** The import run's mover: an exact merge inside the run finds no job on record B, so it moves none (and says so if it ever did). */
export const importRunMover: JobMover = async (tx, move) => {
  const r = await tx.query<{ n: string }>('SELECT count(*) AS n FROM world.job WHERE customer_id = $1', [move.from]);
  if (Number(r.rows[0]?.n ?? 0) > 0) throw new Error(`an import-run merge found jobs on record ${move.from}; only the office write service may move jobs`);
  return [];
};

export interface UndoPayload {
  recordA: CustomerRow;
  recordB: CustomerRow;
  moved: { pastVisitIds: string[]; equipmentIds: string[]; jobNumbers: number[] };
}

export class MergeRefused extends Error {
  readonly code: 'already_decided' | 'already_undone' | 'not_found';
  constructor(code: 'already_decided' | 'already_undone' | 'not_found', what: string) {
    super(what);
    this.code = code;
    this.name = 'MergeRefused';
  }
}

interface PairRow {
  id: string;
  kind: string;
  record_a: string;
  record_b: string;
  status: string;
}

async function customerRow(tx: Queryable, id: string): Promise<CustomerRow> {
  const r = await tx.query<CustomerRow>('SELECT * FROM world.customer WHERE id = $1 FOR UPDATE', [id]);
  const row = r.rows[0];
  if (!row) throw new MergeRefused('not_found', `customer ${id} does not exist`);
  return row;
}

/** Retries of mergePair's lock phase before it takes the last one without the strict try-lock (a deadlock is then aborted by PostgreSQL, as before). */
const LOCK_TRIES = 4;

/**
 * Merge the pair's record B into record A and write its merge row. The pair must be listed or skipped (an exact pair
 * the run has just written is listed until this call). Returns the merge id.
 *
 * Lock order (F-379, F-622; section 5.3 step 6): technician-days first, then the pair and customer rows, then the
 * visit, equipment and job rows. A booking holds its technician-day and then takes KEY SHARE on its customer through the
 * job's foreign key, so a merge that held the customer rows before it asked for a day would wait on the booking while the
 * booking waited on it. The days are those of record B's jobs, read before any row lock (`jobs.lockDays`). A job that
 * reaches a new day between that read and the customer locks is found by the mover, which then only try-locks the day;
 * if it cannot have it, the whole lock phase rolls back to its savepoint (releasing the customer locks) and starts again
 * holding that day too. The customers are locked in id order, so merges of 2 pairs that share a record cannot cross.
 */
export async function mergePair(
  tx: Queryable, pairId: string, opts: { kind: 'exact' | 'office'; at: Date; by: string | null; jobs: JobMover },
): Promise<string> {
  const peek = await tx.query<{ record_b: string }>('SELECT record_b FROM world.duplicate_pair WHERE id = $1', [pairId]);
  const recordBId = peek.rows[0]?.record_b;
  if (recordBId === undefined) throw new MergeRefused('not_found', `pair ${pairId} does not exist`);
  // F-681: a mover with no lockDays (the import run's) takes no day lock and is never handed `held`, so it cannot throw
  // LockOrderRetry: no savepoint. Otherwise 1 savepoint for the whole lock phase: a retry rolls back to it (which keeps it),
  // and success releases it, so a bulk transaction of many merges holds no subtransaction per merge.
  if (!opts.jobs.lockDays) return mergePairLocked(tx, pairId, opts, recordBId, [], false);
  let seed: readonly HeldDay[] = [];
  await tx.query('SAVEPOINT merge_pair');
  for (let attempt = 0; ; attempt++) {
    try {
      const id = await mergePairLocked(tx, pairId, opts, recordBId, seed, attempt < LOCK_TRIES);
      await tx.query('RELEASE SAVEPOINT merge_pair');
      return id;
    } catch (e) {
      if (!(e instanceof LockOrderRetry)) throw e;
      await tx.query('ROLLBACK TO SAVEPOINT merge_pair');
      seed = e.days;
    }
  }
}

async function mergePairLocked(
  tx: Queryable, pairId: string, opts: { kind: 'exact' | 'office'; at: Date; by: string | null; jobs: JobMover },
  recordBId: string, seed: readonly HeldDay[], strict: boolean,
): Promise<string> {
  const held = opts.jobs.lockDays ? await opts.jobs.lockDays(tx, recordBId, seed) : null;
  const pr = await tx.query<PairRow>('SELECT id, kind, record_a, record_b, status FROM world.duplicate_pair WHERE id = $1 FOR UPDATE', [pairId]);
  const pair = pr.rows[0];
  if (!pair) throw new MergeRefused('not_found', `pair ${pairId} does not exist`);
  if (pair.status !== 'listed' && pair.status !== 'skipped') throw new MergeRefused('already_decided', `pair ${pairId} is ${pair.status}`);
  const rows = new Map<string, CustomerRow>();
  for (const id of [pair.record_a, pair.record_b].sort()) rows.set(id, await customerRow(tx, id));
  const recordA = rows.get(pair.record_a) as CustomerRow;
  const recordB = rows.get(pair.record_b) as CustomerRow;
  if (recordA.status !== 'active' || recordB.status !== 'active') {
    throw new MergeRefused('already_decided', `pair ${pairId}: a record is already merged`);
  }
  const visits = await tx.query<{ id: string }>(
    'UPDATE world.past_visit SET customer_id = $1 WHERE customer_id = $2 RETURNING id', [recordA.id, recordB.id]);
  const equipment = await tx.query<{ id: string }>(
    'UPDATE world.equipment SET customer_id = $1 WHERE customer_id = $2 RETURNING id', [recordA.id, recordB.id]);
  const mergeId = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id as string;
  const jobNumbers = await opts.jobs(tx, {
    from: recordB.id, to: recordA.id, jobNumbers: null, mergeId, step: 'merge', by: opts.by, at: opts.at,
    ...(held !== null && strict ? { held } : {}),
  });
  await tx.query(`UPDATE world.customer SET status = 'merged', merged_into = $1 WHERE id = $2`, [recordA.id, recordB.id]);
  const payload: UndoPayload = {
    recordA, recordB,
    moved: {
      pastVisitIds: visits.rows.map((r) => r.id).sort(),
      equipmentIds: equipment.rows.map((r) => r.id).sort(),
      jobNumbers,
    },
  };
  const m = await tx.query<{ id: string }>(
    `INSERT INTO world."merge" (id, pair_id, kind, status, at, undo_payload) VALUES ($5, $1, $2, 'active', $3, $4::jsonb) RETURNING id`,
    [pairId, opts.kind, opts.at, JSON.stringify(payload), mergeId]);
  await tx.query(
    `UPDATE world.duplicate_pair SET status = 'merged', decided_by = $2, decided_at = $3 WHERE id = $1`,
    [pairId, opts.by, opts.kind === 'office' ? opts.at : null]);
  return (m.rows[0] as { id: string }).id;
}

/** Undo a merge (API-88): restore record B and move back every id the merge moved. Returns both customer ids. */
export async function undoMerge(
  tx: Queryable, mergeId: string, opts: { by: string | null; at: Date; jobs: JobMover },
): Promise<{ recordA: string; recordB: string }> {
  const mr = await tx.query<{ id: string; pair_id: string; status: string; undo_payload: UndoPayload }>(
    'SELECT id, pair_id, status, undo_payload FROM world."merge" WHERE id = $1 FOR UPDATE', [mergeId]);
  const merge = mr.rows[0];
  if (!merge) throw new MergeRefused('not_found', `merge ${mergeId} does not exist`);
  if (merge.status === 'undone') throw new MergeRefused('already_undone', `merge ${mergeId} is already undone`);
  const { recordA, recordB, moved } = merge.undo_payload;
  await tx.query('UPDATE world.past_visit SET customer_id = $1 WHERE id = ANY($2::uuid[])', [recordB.id, moved.pastVisitIds]);
  await tx.query('UPDATE world.equipment SET customer_id = $1 WHERE id = ANY($2::uuid[])', [recordB.id, moved.equipmentIds]);
  await opts.jobs(tx, { from: recordA.id, to: recordB.id, jobNumbers: moved.jobNumbers, mergeId, step: 'undo', by: opts.by, at: opts.at });
  await tx.query(`UPDATE world.customer SET status = $2, merged_into = $3 WHERE id = $1`, [recordB.id, recordB.status, recordB.merged_into]);
  await tx.query(`UPDATE world."merge" SET status = 'undone' WHERE id = $1`, [mergeId]);
  await tx.query(`UPDATE world.duplicate_pair SET status = 'listed', decided_by = NULL, decided_at = NULL WHERE id = $1`, [merge.pair_id]);
  return { recordA: recordA.id, recordB: recordB.id };
}

export type PairDecision = 'merge' | 'keep_separate' | 'skip';

/**
 * decidePair (API-86; FR-IMP-11): Merge and Keep separate act on a listed or skipped pair, Skip for later on a listed
 * one; any other state answers already_decided. Returns the pair's new status and the merge id when merged.
 */
export async function decidePair(
  tx: Queryable, pairId: string, decision: PairDecision, by: string, at: Date, jobs: JobMover,
): Promise<{ status: 'merged' | 'kept_separate' | 'skipped'; mergeId: string | null }> {
  if (decision === 'merge') return { status: 'merged', mergeId: await mergePair(tx, pairId, { kind: 'office', at, by, jobs }) };
  const pr = await tx.query<PairRow>('SELECT id, kind, record_a, record_b, status FROM world.duplicate_pair WHERE id = $1 FOR UPDATE', [pairId]);
  const pair = pr.rows[0];
  if (!pair) throw new MergeRefused('not_found', `pair ${pairId} does not exist`);
  const open = decision === 'skip' ? pair.status === 'listed' : pair.status === 'listed' || pair.status === 'skipped';
  if (!open) throw new MergeRefused('already_decided', `pair ${pairId} is ${pair.status}`);
  const status = decision === 'skip' ? 'skipped' : 'kept_separate';
  await tx.query('UPDATE world.duplicate_pair SET status = $2, decided_by = $3, decided_at = $4 WHERE id = $1', [pairId, status, by, at]);
  return { status, mergeId: null };
}
