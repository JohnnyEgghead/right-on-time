// SPDX-License-Identifier: AGPL-3.0-or-later
// The write stage (SPECIFICATIONS section 6.7, SD-24): customers, past visits, equipment, problem rows, pairs and the
// exact merges, in the caller's 1 transaction. Rows go in set-based (unnest of 1 array per column, CHUNK rows per
// statement): row-at-a-time repositories would make the 1,240-pair, 96,412-visit run thousands of round trips (C13).
// Customer ids are PostgreSQL 18's uuidv7() (section 3 Identifiers), minted up front so visits, equipment, problem
// rows and pairs can point at them.
import { randomBytes } from 'node:crypto';
import type { Queryable } from '@bw/db';
import { importRunMover, mergePair } from './merge.ts';
import type { ImportModel, ImportProblem, ProblemReason } from './model.ts';

const CHUNK = 5000;

/** 22 random URL-safe characters (16 bytes, 128 bits): customer.inbox_token, never derived from row data (NFR-05). */
export function newLinkToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * n distinct inbox tokens none of which is already in world.customer. Unique by construction: each token is 128
 * random bits, a repeat inside the batch is drawn again, and any token already stored is drawn again, so the batch
 * never depends on the unique constraint to catch a collision.
 */
export async function newInboxTokens(tx: Queryable, n: number): Promise<string[]> {
  const out = new Set<string>();
  while (out.size < n) {
    const want = n - out.size;
    const fresh = new Set<string>();
    while (fresh.size < want) {
      const t = newLinkToken();
      if (!out.has(t)) fresh.add(t);
    }
    const taken = await tx.query<{ inbox_token: string }>(
      'SELECT inbox_token FROM world.customer WHERE inbox_token = ANY($1::text[])', [[...fresh]]);
    const stored = new Set(taken.rows.map((r) => r.inbox_token));
    for (const t of fresh) if (!stored.has(t)) out.add(t);
  }
  return [...out];
}

async function insertColumns(tx: Queryable, table: string, columns: readonly [string, string][], rows: readonly unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const arrays = columns.map((_, c) => part.map((r) => r[c]));
    const sel = columns.map(([, type], c) => `$${c + 1}::${type}[]`).join(', ');
    await tx.query(`INSERT INTO ${table} (${columns.map(([n]) => n).join(', ')}) SELECT * FROM unnest(${sel})`, arrays);
  }
}

/** n new row ids from PostgreSQL 18's uuidv7() (section 3 Identifiers). */
async function mintIds(tx: Queryable, n: number): Promise<string[]> {
  const r = await tx.query<{ id: string }>('SELECT uuidv7()::text AS id FROM generate_series(1, $1::integer)', [n]);
  if (r.rows.length !== n) throw new Error(`write: minted ${r.rows.length} ids for ${n} rows`);
  return r.rows.map((x) => x.id);
}

export interface WriteResult {
  customerIds: string[];
  pairIds: string[];
  mergeIds: string[];
}

/** Write every row of the model; the run's exact pairs are merged here, its likely pairs listed. */
export async function writeModel(
  tx: Queryable, model: ImportModel, opts: { runId: string; at: Date; onProgress?: (fraction: number) => Promise<void> },
): Promise<WriteResult> {
  const progress = opts.onProgress ?? (async () => undefined);
  const customerIds = await mintIds(tx, model.customers.length);
  const tokens = await newInboxTokens(tx, model.customers.length);
  await insertColumns(tx, 'world.customer', [
    ['id', 'uuid'], ['branch_id', 'text'], ['name', 'text'], ['name_search', 'text'], ['mobile', 'text'],
    ['home_phone', 'text'], ['email', 'text'], ['getting_in', 'text'], ['home_type', 'text'], ['texts_on', 'boolean'],
    ['text_language', 'text'], ['zone', 'text'], ['street_id', 'uuid'], ['house_number', 'integer'],
    ['lon', 'double precision'], ['lat', 'double precision'], ['customer_since', 'date'], ['source', 'text'],
    ['status', 'text'], ['inbox_token', 'text'], ['old_customer_number', 'text'],
  ], model.customers.map((c, i) => [
    customerIds[i], c.branchId, c.name, c.nameSearch, c.mobile, c.homePhone, c.email, c.gettingIn, c.homeType, c.textsOn,
    c.textLanguage, c.zone, c.streetId, c.houseNumber, c.lon, c.lat, c.customerSince, 'import', 'active', tokens[i],
    // SPECIFICATIONS v0.11 section 3 customer.old_customer_number: the row's customer_ref, copied as written (owner ruling d9901466).
    c.ref,
  ]));
  await progress(0.2);

  await insertColumns(tx, 'world.past_visit', [
    ['customer_id', 'uuid'], ['technician_name', 'text'], ['technician_id', 'uuid'], ['date', 'date'], ['zone', 'text'],
    ['window_start', 'timestamptz'], ['window_end', 'timestamptz'], ['arrived_at', 'timestamptz'], ['outcome', 'text'],
    ['service_text', 'text'], ['work_done', 'text'], ['source_ref', 'text'],
  ], model.visits.map((v) => [
    customerIds[v.customerIndex], v.technicianName, v.technicianId, v.date, v.zone, v.windowStart.toString(),
    v.windowEnd.toString(), v.arrivedAt?.toString() ?? null, v.outcome, v.serviceText, v.workDone, v.sourceRef,
  ]));
  await progress(0.6);

  await insertColumns(tx, 'world.equipment', [
    ['customer_id', 'uuid'], ['type', 'text'], ['year', 'integer'], ['location', 'text'], ['details', 'text'],
  ], model.equipment.map((e) => [customerIds[e.customerIndex], e.type, e.year, e.location, e.details]));
  await progress(0.75);

  await writeProblems(tx, opts.runId, model.problems, customerIds);

  const pairIds = await mintIds(tx, model.pairs.length);
  await insertColumns(tx, 'world.duplicate_pair', [
    ['id', 'uuid'], ['run_id', 'uuid'], ['kind', 'text'], ['why', 'text'], ['record_a', 'uuid'], ['record_b', 'uuid'], ['status', 'text'],
  ], model.pairs.map((p, i) => [pairIds[i], opts.runId, p.kind, p.why, customerIds[p.a], customerIds[p.b], 'listed']));
  await progress(0.8);

  const mergeIds: string[] = [];
  const exact = model.pairs.map((p, i) => ({ p, id: pairIds[i] as string })).filter((x) => x.p.kind === 'exact');
  for (let i = 0; i < exact.length; i++) {
    mergeIds.push(await mergePair(tx, (exact[i] as { id: string }).id, { kind: 'exact', at: opts.at, by: null, jobs: importRunMover }));
    if (i % 200 === 199) await progress(0.8 + (0.2 * i) / exact.length);
  }
  return { customerIds, pairIds, mergeIds };
}

/**
 * The problem rows of 1 run. customerIds is null for a dry run: its customers were rolled back, so a flagged row
 * points at no entity (flagged_entity_id null) rather than at an id that does not exist.
 */
export async function writeProblems(tx: Queryable, runId: string, problems: readonly ImportProblem[], customerIds: readonly string[] | null): Promise<void> {
  await insertColumns(tx, 'world.import_problem_row', [
    ['run_id', 'uuid'], ['file', 'text'], ['row_number', 'integer'], ['reason', 'text'], ['flagged_entity_id', 'uuid'],
    ['example', 'text'],
  ], problems.map((p) => [
    runId, p.file, p.rowNumber, p.reason satisfies ProblemReason,
    p.customerIndex !== null && customerIds ? customerIds[p.customerIndex] : null, p.example,
  ]));
}
