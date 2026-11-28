// SPDX-License-Identifier: AGPL-3.0-or-later
// What applyItem (API-102) and applyBlob (API-103) share (SPECIFICATIONS section 5.1 steps 3 and 4; invariant 1): the
// calling technician, the idempotency ledger, the job's lock and ownership, and the re-base on the server's clock.
//
// The ledger (world.tech_item) is append-only for role app (no UPDATE grant), so the answer is written with the row,
// once, in the same (sub)transaction as everything the item changes. Exactly once rests on 3 things:
//   1. a transaction-level advisory lock on the key, taken first, so a second send of a key whose first send is still
//      in flight waits for it and then reads its answer;
//   2. the stored row read under that lock: present means `duplicate` with the stored message, nothing applied;
//   3. the row inserted with the item's writes, in the same savepoint, so the key and the state it names commit together
//      or not at all (a photo's file is renamed into place before its rows are written, F-67); ON CONFLICT DO NOTHING
//      is a second guard: 0 rows means another send won, and the caller rolls this item back.
// A refused item (parts_required) writes no row, so the corrected item can still be sent under its key; a flagged one
// (validation_failed, not_found) writes its row, so its resend answers duplicate and lists nothing twice.
import type { Queryable } from '@bw/db';
import { demoTimeAtRealMs, entryRealMs, placeItem, type ClockMoveRow, type JobChangeKind } from '@bw/domain';
import { Temporal, toWire, type Instant } from '@bw/time';

/** pg_advisory_xact_lock class of the item keys ('ti'); the billing link uses 0x6269. */
const ITEM_LOCK_CLASS = 0x7469;

export type ItemResult = 'applied' | 'duplicate' | 'flagged' | 'history_only' | 'world_reset';
export type MessageValues = Record<string, string | number | null>;

export interface Answer {
  result: ItemResult;
  messageKey: string | null;
  values: MessageValues | null;
}

/** The facts every item and blob carries (section 5.1 step 1), parsed. */
export interface ItemFacts {
  key: string;
  jobNumber: number;
  kind: string;
  /** Null for a photo or signature, which always apply (section 3 tech_item.base_version). */
  baseVersion: number | null;
  worldEpoch: number;
  deviceTime: Instant;
  offsetSavedReal: Instant;
  sinceSaveMs: number;
  demoTime: Instant;
}

/** The calling technician (UI-SPECIFICATION 2.4: technicians only, own jobs only). */
export interface ItemTechnician {
  id: string;
  userId: string;
  name: string;
  nameInTexts: string;
  branchId: string;
}

/** Everything the server knows about the send, besides the items. */
export interface ItemContext {
  technician: ItemTechnician;
  /** Demo now at receipt: every row's sent_at and received_at. */
  receivedAt: Instant;
  /** The server's real time at receipt, read as realNow('offline_entry'): entered_offline is judged on the real clock (FR-DEMO-9, F-866). */
  receivedReal: Instant;
  /** The clock row's world epoch now (SD-12). */
  worldEpoch: number;
  /**
   * SD-21: the item is an autopilot step, not a person's. It is placed at `receivedAt` (the event's own time, which
   * a replay stamps, not the phone's clock) and does not set `touched_by_person` (a person's item does; F-491).
   */
  autopilot?: boolean;
}

export async function readTechnician(tx: Queryable, userId: string): Promise<ItemTechnician | null> {
  const r = await tx.query<{ id: string; name: string; name_in_texts: string; branch_id: string }>(
    'SELECT id, name, name_in_texts, branch_id FROM world.technician WHERE user_id = $1', [userId]);
  const t = r.rows[0];
  return t ? { id: t.id, userId, name: t.name, nameInTexts: t.name_in_texts, branchId: t.branch_id } : null;
}

/** Step 1 of exactly once: serialize every send of 1 key (held to the end of the whole transaction). */
export async function lockKey(tx: Queryable, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [ITEM_LOCK_CLASS, key]);
}

/** Step 2: the stored answer of a key already seen, repeated as `duplicate` (section 5.1 step 3). */
export async function storedAnswer(tx: Queryable, key: string): Promise<Answer | null> {
  const r = await tx.query<{ message_key: string | null; message_values: MessageValues | null }>(
    'SELECT message_key, message_values FROM world.tech_item WHERE key = $1', [key]);
  const s = r.rows[0];
  return s ? { result: 'duplicate', messageKey: s.message_key, values: s.message_values } : null;
}

/**
 * Step 3: the ledger row with its answer. False when another send of the key committed first (roll this item back).
 * `unlistedJob`: the job number names no job of the world (F-562, migration 0022), so the row keeps no job reference;
 * only a flagged not_found or validation_failed answer may (the table's CHECK constraint).
 */
export async function recordItem(tx: Queryable, ctx: ItemContext, f: ItemFacts, placed: Placement | null, a: Answer, unlistedJob = false): Promise<boolean> {
  // F-1139 (section 3 tech_item.payload): the ledger is append-only, so a flagged item's entry is written with its row; no other result keeps one.
  const payload = a.result === 'flagged' ? entryOf(f) : null;
  const r = await tx.query(
    `INSERT INTO world.tech_item (key, technician_id, job_number, kind, base_version, world_epoch, device_time_real, offset_saved_real,
                                  demo_time, since_save_ms, demo_time_rebased, received_at, result, message_key, message_values, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [f.key, ctx.technician.id, unlistedJob ? null : f.jobNumber, f.kind, f.baseVersion, f.worldEpoch, f.deviceTime.toString(), f.offsetSavedReal.toString(),
      f.demoTime.toString(), f.sinceSaveMs, placed?.rebased ? placed.at.toString() : null, ctx.receivedAt.toString(), a.result,
      a.messageKey, a.values === null ? null : JSON.stringify(a.values), payload === null ? null : keepable(payload)]);
  return (r.rowCount ?? 0) === 1;
}

/** PostgreSQL jsonb cannot hold a NUL (U+0000): an entry that has one (the reason the item was flagged, F-260) is kept with U+FFFD in its place. */
const keepable = (entry: ItemEntry): string => JSON.stringify(entry, (_k, v) => (typeof v === 'string' ? v.replaceAll('\u0000', '\ufffd') : v));

/** What a technician entered, as API-102 carried it (section 3 tech_item.payload): a finish's lines, or a note's text; a refused photo or signature, the name of its kept file (F-1168); none for a status item. */
type ItemEntry =
  | { parts: { partId: string; quantity: number }[]; noPartsUsed: boolean; laborMinutes: number; workDone: string[] }
  | { text: string }
  | { file: string };

function entryOf(f: ItemFacts): ItemEntry | null {
  const q = f as ItemFacts & { finish?: { parts: { partId: string; quantity: number }[]; noPartsUsed: boolean; laborMinutes: number; workDone: string[] }; text?: string };
  if (f.kind === 'finished' && q.finish) return { parts: q.finish.parts, noPartsUsed: q.finish.noPartsUsed, laborMinutes: q.finish.laborMinutes, workDone: q.finish.workDone };
  if (f.kind === 'note' && typeof q.text === 'string') return { text: q.text };
  // F-1168: a photo or signature the server refused is kept as a file in the photo volume; the row names it (blob.ts, flag with keep).
  const k = (f as ItemFacts & { keptFile?: string }).keptFile;
  if ((f.kind === 'photo' || f.kind === 'signature') && typeof k === 'string') return { file: k };
  return null;
}

/** False when the world no longer holds the job (an SD-12 reset truncated it): tech_item.job_number cannot reference it (F-469). */
export async function jobExists(tx: Queryable, jobNumber: number): Promise<boolean> {
  return ((await tx.query('SELECT 1 FROM world.job WHERE job_number = $1', [jobNumber])).rowCount ?? 0) > 0;
}

export interface LockedJob {
  jobNumber: number;
  branchId: string;
  customerId: string;
  technicianId: string | null;
  status: string;
  version: number;
  date: string;
  zone: string;
}

/** The job row, locked for the item's transaction, so no office write slips between the classification and the write. */
export async function lockJob(tx: Queryable, jobNumber: number): Promise<LockedJob | null> {
  const r = await tx.query<{ job_number: number; branch_id: string; customer_id: string; technician_id: string | null; status: string; version: number; date: string; zone: string }>(
    `SELECT job_number, branch_id, customer_id, technician_id, status, version, date, zone FROM world.job WHERE job_number = $1 FOR UPDATE`,
    [jobNumber]);
  const j = r.rows[0];
  return j ? {
    jobNumber: j.job_number, branchId: j.branch_id, customerId: j.customer_id, technicianId: j.technician_id,
    status: j.status, version: j.version, date: j.date, zone: j.zone,
  } : null;
}

/**
 * Own jobs only (UI-SPECIFICATION 2.4): the job is the technician's now, or its history shows it was (a job moved away
 * while the phone was offline is the Reassigned column, not a stranger's job).
 */
export async function isTechniciansJob(tx: Queryable, job: LockedJob, technicianId: string): Promise<boolean> {
  if (job.technicianId === technicianId) return true;
  const r = await tx.query(
    `SELECT 1 FROM world.job_change WHERE job_number = $1
        AND (data->'from'->>'technicianId' = $2 OR data->'to'->>'technicianId' = $2) LIMIT 1`, [job.jobNumber, technicianId]);
  return (r.rowCount ?? 0) > 0;
}

/** Where an item lands on the demo clock (section 5.1 step 4). */
export interface Placement {
  at: Instant;
  /** True when `at` differs from the phone's demo time (then stored as tech_item.demo_time_rebased). */
  rebased: boolean;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : Temporal.Instant.from(v).epochMilliseconds);

/**
 * Section 5.1 step 4: entryReal = offsetSavedReal + sinceSaveMs, then the demo time at entryReal rebuilt from the
 * current epoch's clock_move rows (the clock row stands in when the epoch has none yet). Never after receipt.
 */
export async function placeOnClock(tx: Queryable, f: ItemFacts, ctx: ItemContext): Promise<Placement> {
  const moves = await tx.query<{ kind: ClockMoveRow['kind']; at_real: Date; to_demo: Date }>(
    'SELECT kind, at_real, to_demo FROM system.clock_move WHERE world_epoch = $1', [ctx.worldEpoch]);
  const clock = (await tx.query<{ demo_anchor: Date; real_anchor: Date; rate: string; paused: boolean }>(
    'SELECT demo_anchor, real_anchor, rate, paused FROM system.demo_clock WHERE id = 1')).rows[0];
  const rows: ClockMoveRow[] = moves.rows.map((m) => ({ kind: m.kind, atRealMs: ms(m.at_real), toDemoMs: ms(m.to_demo) }));
  if (rows.length === 0 && clock) {
    rows.push({ kind: clock.paused ? 'pause' : 'resume', atRealMs: ms(clock.real_anchor), toDemoMs: ms(clock.demo_anchor) });
  }
  const rebuilt = demoTimeAtRealMs(entryRealMs(f.offsetSavedReal.epochMilliseconds, f.sinceSaveMs), rows, Number(clock?.rate ?? 1));
  const p = placeItem({ phoneDemoMs: f.demoTime.epochMilliseconds, rebuiltMs: rebuilt, receivedDemoMs: ctx.receivedAt.epochMilliseconds });
  return { at: Temporal.Instant.fromEpochMilliseconds(p.atMs), rebased: p.rebased };
}

/** A wire time in the job's zone, for message values and history data. */
export const wireAt = (at: Instant | Date, zone: string): string =>
  toWire(at instanceof Date ? Temporal.Instant.fromEpochMilliseconds(at.getTime()) : at, zone);

/** 1 job_change row by the technician's app (section 3; actor_kind technician, with the offline and sent times). */
export async function appendTechnicianChange(tx: Queryable, ctx: ItemContext, row: {
  jobNumber: number; at: Instant; kind: JobChangeKind; fromVersion: number; toVersion: number; data: Record<string, unknown>;
}): Promise<void> {
  await tx.query(
    `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
     VALUES ($1, $2, $3, 'technician', $4, $5, $6, $7::jsonb)`,
    [row.jobNumber, row.at.toString(), ctx.technician.userId, row.kind, row.fromVersion, row.toVersion, JSON.stringify(row.data)]);
}

/** Run fn inside a savepoint: its writes stay when it returns `keep`, and are undone when it returns `undo` or throws. */
export async function inSavepoint<T>(tx: Queryable, name: string, fn: () => Promise<{ keep: boolean; value: T }>): Promise<T> {
  await tx.query(`SAVEPOINT ${name}`);
  let r: { keep: boolean; value: T };
  try {
    r = await fn();
  } catch (e) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await tx.query(`RELEASE SAVEPOINT ${name}`);
    throw e;
  }
  if (!r.keep) await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
  await tx.query(`RELEASE SAVEPOINT ${name}`);
  return r.value;
}
