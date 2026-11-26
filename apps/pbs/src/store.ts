// SPDX-License-Identifier: AGPL-3.0-or-later
// The pretend billing service's store (SPECIFICATIONS section 3 `pbs.*`, section 6.6 FR-BILL-4, FR-BILL-5, FR-BILL-8,
// FR-BILL-11; SD-12, SD-44). Runs as role pbs (login bw_pbs), which reaches only schemas pbs and pbs_snapshot.
//
// The epoch rule (SD-12): every store compares the request's world epoch with pbs.mode.epoch inside the transaction
// that stores, under a lock on the 1 pbs.mode row, which reset() also takes. So a request held 60 s by Not answering
// across a reset can never be stored into the fresh pbs, and an old world's invoice never answers already_have to the
// fresh world's job of the same number.
//
// Never twice (FR-BILL-8, invariant 10): pbs.invoice is keyed by job number; a store is INSERT ... ON CONFLICT DO
// NOTHING, and a conflict answers already_have, so a replayed or concurrent request leaves exactly 1 invoice.
import { inTransaction, type Queryable } from '@bw/db';
import {
  validateInvoice, type CallAnswer, type InvoiceLine, type InvoiceRequest, type PbsMode, type PbsModeName,
  PBS_MODES, REJECT_N_MAX, REJECT_N_MIN,
} from '@bw/domain';
import type pg from 'pg';

interface ModeRow {
  mode: PbsModeName;
  n_left: number | null;
  set_by: string | null;
  set_at: Date | null;
  epoch: number;
}

const toMode = (r: ModeRow): PbsMode => ({
  mode: r.mode, nLeft: r.n_left, setBy: r.set_by, setAt: r.set_at ? r.set_at.toISOString() : null, epoch: r.epoch,
});

const MODE_SQL = 'SELECT mode, n_left, set_by, set_at, epoch FROM pbs.mode';

/** The reason a Reject the next N call answers (FR-BILL-5): the data error a person then sees on the billing list. */
const REJECTED_REASON = 'Rejected as a data error by the pretend billing system';

/** The 1 mode row, created at start-up when absent: Up, at epoch 0, so setup's epoch 1 reset applies (SD-12). */
export async function ensureModeRow(db: Queryable): Promise<void> {
  await db.query(`INSERT INTO pbs.mode (mode, n_left, set_by, set_at, epoch) VALUES ('up', NULL, NULL, NULL, 0) ON CONFLICT DO NOTHING`);
}

async function lockMode(tx: Queryable): Promise<ModeRow> {
  const r = await tx.query<ModeRow>(`${MODE_SQL} FOR UPDATE`);
  const row = r.rows[0];
  if (!row) throw new Error('pbs.mode holds no row; pbs creates it at start-up');
  return row;
}

async function recordCall(tx: Queryable, jobNumber: number, at: string, answer: CallAnswer): Promise<void> {
  await tx.query('INSERT INTO pbs."call" (job_number, at, answer) VALUES ($1, $2, $3)', [jobNumber, at, answer]);
}

async function insertLines(tx: Queryable, jobNumber: number, lines: readonly InvoiceLine[]): Promise<void> {
  let seq = 0;
  for (const l of lines) {
    seq += 1;
    await tx.query(
      `INSERT INTO pbs.invoice_line (job_number, seq, kind, label, code, quantity, unit_cents, amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [jobNumber, seq, l.kind, l.label, l.code, l.quantity, l.unitCents, l.amountCents],
    );
  }
}

/** Store 1 received invoice, or answer already_have when the job has its 1 invoice (FR-BILL-8). */
async function storeReceived(tx: Queryable, inv: InvoiceRequest): Promise<'stored' | 'already_have'> {
  const r = await tx.query(
    `INSERT INTO pbs.invoice (job_number, received_at, how, total_cents, customer_name, done_at)
     VALUES ($1, $2, 'received', $3, $4, $5) ON CONFLICT (job_number) DO NOTHING`,
    [inv.jobNumber, inv.sentAt, inv.totalCents, inv.customerName, inv.doneAt],
  );
  if ((r.rowCount ?? 0) === 0) return 'already_have';
  await insertLines(tx, inv.jobNumber, inv.lines);
  return 'stored';
}

/** What a POST /invoices receipt decided. `hold` is Not answering: the caller waits, then calls storeLate. */
export type Receipt =
  | { answer: Exclude<CallAnswer, 'stored_late'>; reason?: string }
  | { answer: 'hold'; invoice: InvoiceRequest };

export interface ReceiveInput {
  jobNumber: number;
  epoch: number;
  sentAt: string;
  body: unknown;
}

/**
 * The receipt of 1 POST /invoices, in 1 transaction under the mode lock (FR-BILL-5, SD-12, SD-44): a different epoch
 * answers wrong_epoch; Down answers down; Reject the next N answers data_error and counts N down (back to Up at 0); an
 * invoice that fails validation answers data_error with its reason; Not answering holds; Up stores. Every answer but
 * a hold writes its pbs.call row here; a hold writes its row when it ends (storeLate).
 */
export async function receive(pool: pg.Pool, input: ReceiveInput): Promise<Receipt> {
  return inTransaction(pool, async (tx) => {
    const mode = await lockMode(tx);
    const answer = async (a: Exclude<CallAnswer, 'stored_late'>, reason?: string): Promise<Receipt> => {
      await recordCall(tx, input.jobNumber, input.sentAt, a);
      return reason === undefined ? { answer: a } : { answer: a, reason };
    };
    if (input.epoch !== mode.epoch) return answer('wrong_epoch');
    if (mode.mode === 'down') return answer('down');
    if (mode.mode === 'reject_next_n') {
      const left = (mode.n_left ?? 1) - 1;
      await tx.query(left > 0 ? 'UPDATE pbs.mode SET n_left = $1' : `UPDATE pbs.mode SET mode = 'up', n_left = NULL`, left > 0 ? [left] : []);
      return answer('data_error', REJECTED_REASON);
    }
    const v = validateInvoice(input.body);
    if (!v.ok) return answer('data_error', v.reason);
    if (mode.mode === 'not_answering') return { answer: 'hold', invoice: v.invoice };
    return answer(await storeReceived(tx, v.invoice));
  });
}

/**
 * The end of a Not answering hold (FR-BILL-5, FR-BILL-8): the epoch is checked again at store, under the mode lock
 * (SD-12), so a hold that spans a reset answers wrong_epoch and stores nothing; otherwise the invoice is stored late,
 * or answers already_have when the job got its invoice meanwhile (a Mark fixed, or an earlier late success).
 */
export async function storeLate(pool: pg.Pool, inv: InvoiceRequest, epoch: number): Promise<CallAnswer> {
  return inTransaction(pool, async (tx) => {
    const mode = await lockMode(tx);
    const a: CallAnswer = epoch !== mode.epoch ? 'wrong_epoch' : (await storeReceived(tx, inv)) === 'stored' ? 'stored_late' : 'already_have';
    await recordCall(tx, inv.jobNumber, inv.sentAt, a);
    return a;
  });
}

export interface EnterByHandInput {
  jobNumber: number;
  epoch: number;
  reason: string;
  by: string;
  /** The demo time of the Mark fixed. */
  at: string;
  customerName: string;
  doneAt: string;
  /** The lines the billing link composed for the job; empty when the job could not be composed. */
  lines: InvoiceLine[];
  totalCents: number;
}

/**
 * Mark fixed's record (FR-BILL-11, invariant 10): the job keeps 1 invoice. A job pbs already holds (a held or late
 * request stored it) gets how = entered_by_hand with the reason, who and when; a job it does not hold is stored with
 * how = entered_by_hand. Repeating it changes nothing more. The epoch is checked under the mode lock (SD-12).
 */
export async function enterByHand(pool: pg.Pool, input: EnterByHandInput): Promise<'entered' | 'wrong_epoch'> {
  return inTransaction(pool, async (tx) => {
    const mode = await lockMode(tx);
    if (input.epoch !== mode.epoch) return 'wrong_epoch';
    const updated = await tx.query(
      `UPDATE pbs.invoice SET how = 'entered_by_hand', entered_by_hand_reason = $2, entered_by = $3, entered_at = $4 WHERE job_number = $1`,
      [input.jobNumber, input.reason, input.by, input.at],
    );
    if ((updated.rowCount ?? 0) === 0) {
      await tx.query(
        `INSERT INTO pbs.invoice (job_number, received_at, how, total_cents, customer_name, done_at, entered_by_hand_reason, entered_by, entered_at)
         VALUES ($1, $2, 'entered_by_hand', $3, $4, $5, $6, $7, $2)`,
        [input.jobNumber, input.at, input.totalCents, input.customerName, input.doneAt, input.reason, input.by],
      );
      await insertLines(tx, input.jobNumber, input.lines);
    }
    return 'entered';
  });
}

export async function getMode(db: Queryable): Promise<PbsMode> {
  const r = await db.query<ModeRow>(MODE_SQL);
  const row = r.rows[0];
  if (!row) throw new Error('pbs.mode holds no row; pbs creates it at start-up');
  return toMode(row);
}

export interface SetModeInput {
  mode: unknown;
  n?: unknown;
  setBy?: unknown;
  setAt?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Set the mode (API-68 through the billing client; FR-BILL-5, SD-44). Answers the stored mode, or why it was refused. */
export async function setMode(pool: pg.Pool, input: SetModeInput): Promise<{ ok: true; mode: PbsMode } | { ok: false; reason: string }> {
  if (!(PBS_MODES as readonly unknown[]).includes(input.mode)) return { ok: false, reason: 'mode must be up, not_answering, down or reject_next_n' };
  const mode = input.mode as PbsModeName;
  let n: number | null = null;
  if (mode === 'reject_next_n') {
    if (!Number.isInteger(input.n) || (input.n as number) < REJECT_N_MIN || (input.n as number) > REJECT_N_MAX) {
      return { ok: false, reason: `n must be a whole number from ${REJECT_N_MIN} to ${REJECT_N_MAX}` };
    }
    n = input.n as number;
  } else if (input.n !== undefined && input.n !== null) {
    return { ok: false, reason: 'n is set only for reject_next_n' };
  }
  const setBy = input.setBy ?? null;
  const setAt = input.setAt ?? null;
  if (setBy !== null && (typeof setBy !== 'string' || !UUID.test(setBy))) return { ok: false, reason: 'setBy must be a user id' };
  if (setAt !== null && (typeof setAt !== 'string' || !RFC3339.test(setAt))) return { ok: false, reason: 'setAt must be an RFC 3339 time' };
  const r = await inTransaction(pool, async (tx) => {
    await lockMode(tx);
    return tx.query<ModeRow>(`UPDATE pbs.mode SET mode = $1, n_left = $2, set_by = $3, set_at = $4 RETURNING mode, n_left, set_by, set_at, epoch`,
      [mode, n, setBy, setAt]);
  });
  return { ok: true, mode: toMode(r.rows[0]!) };
}

/** A reset the snapshot cannot serve: pbs_snapshot's tables exist but role pbs cannot read them (SD-12 grants). */
export class SnapshotUnreadableError extends Error {
  constructor(table: string) {
    super(`pbs cannot read pbs_snapshot.${table}; the reset task must grant SELECT on pbs_snapshot to role pbs`);
    this.name = 'SnapshotUnreadableError';
  }
}

const SNAPSHOT_TABLES = ['invoice', 'invoice_line', 'call'] as const;

/**
 * Apply a world reset (SD-12): once per epoch. An epoch at or below pbs.mode.epoch answers success and changes nothing;
 * a later one applies even when one was skipped. Under the mode lock (which every store takes), pbs's own tables are
 * emptied and refilled from pbs_snapshot (setup's day-start copy) when it exists, the mode returns to the snapshot's
 * (Up when the snapshot holds none), and the epoch is recorded.
 */
export async function reset(pool: pg.Pool, epoch: number): Promise<{ applied: boolean; epoch: number }> {
  return inTransaction(pool, async (tx) => {
    const mode = await lockMode(tx);
    if (epoch <= mode.epoch) return { applied: false, epoch: mode.epoch };
    await tx.query('DELETE FROM pbs.invoice_line');
    await tx.query('DELETE FROM pbs.invoice');
    await tx.query('DELETE FROM pbs."call"');
    let restored: ModeRow | undefined;
    for (const t of [...SNAPSHOT_TABLES, 'mode'] as const) {
      const p = await tx.query<{ present: boolean; readable: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present,
                CASE WHEN to_regclass($1) IS NULL THEN false ELSE has_table_privilege(to_regclass($1), 'SELECT') END AS readable`,
        [`pbs_snapshot."${t}"`]);
      const { present, readable } = p.rows[0]!;
      if (!present) continue;
      if (!readable) throw new SnapshotUnreadableError(t);
      if (t === 'mode') {
        restored = (await tx.query<ModeRow>('SELECT mode, n_left, set_by, set_at, epoch FROM pbs_snapshot.mode LIMIT 1')).rows[0];
      } else {
        await tx.query(`INSERT INTO pbs."${t}" SELECT * FROM pbs_snapshot."${t}"`);
      }
    }
    await tx.query('UPDATE pbs.mode SET mode = $1, n_left = $2, set_by = $3, set_at = $4, epoch = $5',
      [restored?.mode ?? 'up', restored?.n_left ?? null, restored?.set_by ?? null, restored?.set_at ?? null, epoch]);
    return { applied: true, epoch };
  });
}

export interface InvoiceSummary {
  jobNumber: number;
  receivedAt: string;
  how: 'received' | 'entered_by_hand';
  totalCents: number;
  customerName: string;
  doneAt: string;
}

interface InvoiceRow {
  job_number: number;
  received_at: Date;
  how: 'received' | 'entered_by_hand';
  total_cents: number;
  customer_name: string;
  done_at: Date;
  entered_by_hand_reason: string | null;
  entered_by: string | null;
  entered_at: Date | null;
}

const summary = (r: InvoiceRow): InvoiceSummary => ({
  jobNumber: r.job_number, receivedAt: r.received_at.toISOString(), how: r.how, totalCents: r.total_cents,
  customerName: r.customer_name, doneAt: r.done_at.toISOString(),
});

export const PAGE_SIZE = 50;

/** The invoices received (API-65), newest job number first, 50 a page; cursor = the last job number of the page before. */
export async function listInvoices(db: Queryable, after: number | null): Promise<{ items: InvoiceSummary[]; next: string | null }> {
  const r = await db.query<InvoiceRow>(
    `SELECT * FROM pbs.invoice WHERE ($1::integer IS NULL OR job_number < $1) ORDER BY job_number DESC LIMIT ${PAGE_SIZE + 1}`, [after]);
  const rows = r.rows.slice(0, PAGE_SIZE);
  return { items: rows.map(summary), next: r.rows.length > PAGE_SIZE ? String(rows.at(-1)!.job_number) : null };
}

export interface InvoiceDetail extends InvoiceSummary {
  enteredByHandReason: string | null;
  enteredBy: string | null;
  enteredAt: string | null;
  lines: InvoiceLine[];
  /** Every call received for the job (API-66 callsReceived), oldest first. */
  calls: { at: string; answer: CallAnswer }[];
}

/** 1 invoice with its lines and the calls received for its job (API-66), or null. */
export async function getInvoice(db: Queryable, jobNumber: number): Promise<InvoiceDetail | null> {
  const r = await db.query<InvoiceRow>('SELECT * FROM pbs.invoice WHERE job_number = $1', [jobNumber]);
  const row = r.rows[0];
  if (!row) return null;
  const lines = await db.query<{ kind: InvoiceLine['kind']; label: string; code: string | null; quantity: number | null; unit_cents: number | null; amount_cents: number | null }>(
    'SELECT kind, label, code, quantity, unit_cents, amount_cents FROM pbs.invoice_line WHERE job_number = $1 ORDER BY seq', [jobNumber]);
  const calls = await db.query<{ at: Date; answer: CallAnswer }>('SELECT at, answer FROM pbs."call" WHERE job_number = $1 ORDER BY at, id', [jobNumber]);
  return {
    ...summary(row),
    enteredByHandReason: row.entered_by_hand_reason, enteredBy: row.entered_by, enteredAt: row.entered_at ? row.entered_at.toISOString() : null,
    lines: lines.rows.map((l) => ({ kind: l.kind, label: l.label, code: l.code, quantity: l.quantity, unitCents: l.unit_cents, amountCents: l.amount_cents })),
    calls: calls.rows.map((c) => ({ at: c.at.toISOString(), answer: c.answer })),
  };
}
