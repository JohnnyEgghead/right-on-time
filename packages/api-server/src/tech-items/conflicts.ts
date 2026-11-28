// SPDX-License-Identifier: AGPL-3.0-or-later
// Flagged items (SPECIFICATIONS section 5.1 steps 5, 6 and 8; FR-TECH-6, FR-DISP-9, OA-59): the change since the app's
// version read from the job's history, the message that names who moved the job, the offline_conflict row with its
// job_change entry and notice, and Mark handled (API-39), the only way a flagged item leaves the dispatcher's list.
import { publishEvent, type Queryable } from '@bw/db';
import { classifyChange, type ChangeColumn, type HistoryRow } from '@bw/domain';
import type { Instant } from '@bw/time';
import { appendTechnicianChange, wireAt, type ItemContext, type LockedJob, type MessageValues } from './shared.ts';

interface ChangeRow extends HistoryRow {
  at: Date;
  actorName: string | null;
}

/** Section 5.1 step 5 over the job's real history rows (every writer's job_change row; office, customer, time off). */
export async function changeSince(tx: Queryable, jobNumber: number, baseVersion: number): Promise<{ column: ChangeColumn; row: ChangeRow | null }> {
  const r = await tx.query<{ kind: HistoryRow['kind']; actor_kind: HistoryRow['actorKind']; from_version: number; data: Record<string, unknown>; at: Date; actor_name: string | null }>(
    `SELECT c.kind, c.actor_kind, c.from_version, c.data, c.at, u.name AS actor_name
       FROM world.job_change c LEFT JOIN world."user" u ON u.id = c.actor_user_id
      WHERE c.job_number = $1 AND c.from_version >= $2
      ORDER BY c.to_version, c.id`, [jobNumber, baseVersion]);
  const rows: ChangeRow[] = r.rows.map((x) => ({
    kind: x.kind, actorKind: x.actor_kind, fromVersion: x.from_version, data: x.data ?? {}, at: x.at, actorName: x.actor_name,
  }));
  return classifyChange(rows, baseVersion);
}

const side = (data: Record<string, unknown>, k: 'from' | 'to'): Record<string, unknown> => {
  const v = data[k];
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
};

/**
 * The flag's message values (no phone number or address, NFR-05): the technician's name in texts, the item, the job,
 * who moved it (the office person's name, the customer, time off) and when, and for a move where it went.
 */
export async function flagValues(tx: Queryable, input: {
  ctx: ItemContext; job: LockedJob; action: string; column: ChangeColumn; row: ChangeRow | null;
}): Promise<MessageValues> {
  const { row, job } = input;
  const byKind = row === null ? null : row.kind === 'unassigned_time_off' ? 'time_off' : row.actorKind;
  let to: string | null = null;
  let date: string | null = null;
  if (row && input.column === 'assigned') {
    const id = side(row.data, 'to')['technicianId'];
    if (typeof id === 'string') to = (await tx.query<{ name: string }>('SELECT name FROM world.technician WHERE id = $1', [id])).rows[0]?.name ?? null;
  }
  if (row && input.column === 'rescheduled') {
    const d = side(row.data, 'to')['date'];
    date = typeof d === 'string' ? d : null;
  }
  return {
    tech: input.ctx.technician.nameInTexts, action: input.action, job: job.jobNumber, change: input.column,
    by: row?.actorName ?? null, byKind, to, toKind: to === null ? 'nobody' : 'technician', date,
    at: row ? wireAt(row.at, job.zone) : null,
  };
}

/** The catalog keys: the dispatcher's list line and the technician's answer, 1 per flagging column. */
const officeFlagKey = (column: ChangeColumn | RefusedFlag): string => `offline.flag.${column}`;
export const techFlagKey = (column: ChangeColumn | RefusedFlag): string => `tech.item.flagged.${column}`;
/** The 2 refusals the phone cannot fix, flagged beside the table's columns (section 5.1 step 10; F-867). */
export type RefusedFlag = 'validation_failed' | 'not_found';

/**
 * Section 5.1 step 8: the offline_conflict row (offline_at = the item's placed demo time, sent_at = receipt), a
 * job_change row of kind `flagged` that leaves the version alone (the job is not changed), and EVT-01.
 */
export async function recordFlag(tx: Queryable, input: {
  ctx: ItemContext; job: LockedJob; itemKey: string; itemKind: string; column: ChangeColumn | RefusedFlag; at: Instant; values: MessageValues;
}): Promise<string> {
  const { ctx, job } = input;
  const c = await tx.query<{ id: string }>(
    `INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
    [job.jobNumber, input.itemKey, job.branchId, officeFlagKey(input.column), JSON.stringify(input.values), input.at.toString(), ctx.receivedAt.toString()]);
  const conflictId = c.rows[0]!.id;
  await appendTechnicianChange(tx, ctx, {
    jobNumber: job.jobNumber, at: input.at, kind: 'flagged', fromVersion: job.version, toVersion: job.version,
    data: { itemKey: input.itemKey, item: input.itemKind, change: input.column, conflictId, offlineAt: wireAt(input.at, job.zone), sentAt: wireAt(ctx.receivedAt, job.zone) },
  });
  await publishEvent(tx, 'job.changed', { jobNumber: job.jobNumber, branch: job.branchId });
  return conflictId;
}

/**
 * F-562: a refusal the phone cannot fix for a job number the world does not hold (not_found, or validation_failed from a
 * future world epoch). The row is listed for the dispatcher of the technician's branch with no job reference (migration
 * 0022; the number the phone sent stays in `values.job`), so the item leaves the phone and the dispatcher still sees it,
 * with Mark handled (FR-DISP-9). There is no job to hold a history row, so none is written; the board hears board.refresh.
 */
export async function recordUnlistedJobFlag(tx: Queryable, input: {
  ctx: ItemContext; itemKey: string; column: RefusedFlag; at: Instant; values: MessageValues;
}): Promise<string> {
  const { ctx } = input;
  const c = await tx.query<{ id: string }>(
    `INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
     VALUES (NULL, $1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
    [input.itemKey, ctx.technician.branchId, officeFlagKey(input.column), JSON.stringify(input.values), input.at.toString(), ctx.receivedAt.toString()]);
  await publishEvent(tx, 'board.refresh', { branch: ctx.technician.branchId });
  return c.rows[0]!.id;
}

export type MarkHandledResult =
  | { ok: true; conflict: { conflictId: string; jobNumber: number; handledBy: string; handledAt: string } }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'already_handled'; by: string; at: string };

/**
 * Mark handled (API-39; FR-DISP-9, OA-59): sets handled_by and handled_at once (WHERE handled_at IS NULL); 0 rows
 * answers already_handled with the earlier person and time; a job_change row of kind `flag_handled` (who and when,
 * the version left alone) and EVT-01. A replay of a call that committed answers already_handled with its own name.
 * F-562: a row with no job (recordUnlistedJobFlag) has no job history to write to; its handled_by and handled_at are
 * the record of who and when, its times are in the branch's zone, and the board hears board.refresh.
 */
export async function markHandled(tx: Queryable, input: { conflictId: string; userId: string; at: Instant }): Promise<MarkHandledResult> {
  const r = await tx.query<{ job_number: number | null; sent_job: number | null; branch_id: string; zone: string }>(
    `UPDATE world.offline_conflict o SET handled_by = $2, handled_at = $3 FROM world.branch b
      WHERE o.id = $1 AND o.handled_at IS NULL AND b.id = o.branch_id
      RETURNING o.job_number, (o.message_values->>'job')::integer AS sent_job, o.branch_id, b.zone`,
    [input.conflictId, input.userId, input.at.toString()]);
  const zoneOf = async (job: number | null, branchZone: string) => job === null
    ? branchZone
    : (await tx.query<{ zone: string }>('SELECT zone FROM world.job WHERE job_number = $1', [job])).rows[0]?.zone ?? branchZone;
  const done = r.rows[0];
  if (!done) {
    const prior = (await tx.query<{ job_number: number | null; name: string | null; handled_at: Date | null; zone: string }>(
      `SELECT o.job_number, u.name, o.handled_at, b.zone FROM world.offline_conflict o JOIN world.branch b ON b.id = o.branch_id
         LEFT JOIN world."user" u ON u.id = o.handled_by WHERE o.id = $1`,
      [input.conflictId])).rows[0];
    if (!prior || prior.handled_at === null) return { ok: false, code: 'not_found' };
    return { ok: false, code: 'already_handled', by: prior.name ?? '', at: wireAt(prior.handled_at, await zoneOf(prior.job_number, prior.zone)) };
  }
  const zone = await zoneOf(done.job_number, done.zone);
  const who = (await tx.query<{ name: string }>('SELECT name FROM world."user" WHERE id = $1', [input.userId])).rows[0]?.name ?? '';
  if (done.job_number === null) {
    await publishEvent(tx, 'board.refresh', { branch: done.branch_id });
    return { ok: true, conflict: { conflictId: input.conflictId, jobNumber: done.sent_job ?? 0, handledBy: who, handledAt: wireAt(input.at, zone) } };
  }
  const version = (await tx.query<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [done.job_number])).rows[0]?.version ?? 1;
  await tx.query(
    `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
     VALUES ($1, $2, $3, 'office', 'flag_handled', $4, $4, $5::jsonb)`,
    [done.job_number, input.at.toString(), input.userId, version, JSON.stringify({ conflictId: input.conflictId })]);
  await publishEvent(tx, 'job.changed', { jobNumber: done.job_number, branch: done.branch_id });
  return { ok: true, conflict: { conflictId: input.conflictId, jobNumber: done.job_number, handledBy: who, handledAt: wireAt(input.at, zone) } };
}
