// SPDX-License-Identifier: AGPL-3.0-or-later
// applyItem (API-102; SPECIFICATIONS section 5.1 steps 3 to 10, SD-16, D14; invariant 1; FR-TECH-2, FR-TECH-3, FR-TECH-6,
// FR-TECH-9, FR-TECH-14, FR-TEXT-19, FR-DEMO-9, FR-BILL-3). 1 send is up to 50 items in the kernel's 1 transaction
// (SD-6); each item runs in its own savepoint, so 1 item's refusal or failure never undoes another's, and every item's
// writes (ledger row included) land together or not at all. A deadlock or serialization failure retries that item;
// a failure that would repeat (a data exception or constraint) refuses that item alone; any other fails the send (5xx), the kernel rolls everything back, and the phone keeps every item waiting.
//
// Re-run semantics: a send whose answer was lost is sent again with the same keys; every key then reads its stored
// answer under its lock and answers `duplicate` with the stored message, applying nothing (shared.ts). A key whose
// first send is still running waits for it. A refused item stores nothing, so its corrected resend applies.
//
// Per item, in order: the key lock and the stored answer (duplicate); the world epoch (world_reset); the job's lock
// and ownership (not_found); the finish lines (parts_required, validation_failed); the placement on the clock; then a
// note applies, a late On my way is history only (step 9), and any other status item takes the table's verdict for
// the change since its base version (apply as a forward move, else duplicate; or flag).
import { publishEvent, type Queryable } from '@bw/db';
import {
  batchOrder, conflictVerdict, entryRealMs, finishLines, isForwardMove, OFFLINE_AFTER_MS, onMyWayIsHistoryOnly, STATUS_ITEM_TARGET,
  type FinishLinesCode, type StatusItemKind,
} from '@bw/domain';
import type { Instant } from '@bw/time';
import { billFinishedJob } from 'bw-worker/billing';
import { changeSince, flagValues, recordFlag, recordUnlistedJobFlag, techFlagKey } from './conflicts.ts';
import { sendOnTheWay, type TextContext } from '@bw/outbox';
import { endOnTheWay, onTheWayEta } from './effects.ts';
import {
  appendTechnicianChange, inSavepoint, isTechniciansJob, jobExists, lockJob, lockKey, placeOnClock, recordItem, storedAnswer, wireAt,
  type Answer, type ItemContext, type ItemFacts, type LockedJob, type Placement,
} from './shared.ts';

export interface FinishInput {
  parts: { partId: string; quantity: number }[];
  noPartsUsed: boolean;
  laborMinutes: number;
  workDone: string[];
}

export type QueuedItem = ItemFacts & (
  | { kind: 'note'; text: string }
  | { kind: 'on_my_way' | 'arrived' | 'no_one_home' }
  | { kind: 'finished'; finish: FinishInput }
);

/** The reasons the phone cannot fix: the item is listed for the dispatcher and answered flagged with the code (owner ruling 546d6f1e; F-867). */
export type FlagCode = 'validation_failed' | 'not_found';

export type ItemOutcome =
  | ({ key: string } & Answer & { code: FlagCode | null })
  | { key: string; result: 'refused'; code: FinishLinesCode | 'not_found'; messageKey: string; values: null };

export const MESSAGE = {
  worldReset: 'tech.item.worldReset',
  historyOnly: 'tech.item.historyOnly',
} as const;

/** Refused items stay on the phone with the reason (section 5.1 step 10); nothing is stored. */
class Refused extends Error {
  readonly code: FinishLinesCode | 'not_found' | 'validation_failed';
  constructor(code: FinishLinesCode | 'not_found' | 'validation_failed') {
    super(code);
    this.code = code;
  }
}

const RETRYABLE = new Set(['40P01', '40001']);
const MAX_ITEM_TRIES = 3;

/** Every item of 1 send, answered in the order sent. */
export async function applyItems(tx: Queryable, ctx: ItemContext, deps: TextContext, items: readonly QueuedItem[]): Promise<ItemOutcome[]> {
  const answers = new Map<string, ItemOutcome>();
  const kindsByJob = new Map<number, string[]>();
  for (const it of items) kindsByJob.set(it.jobNumber, [...(kindsByJob.get(it.jobNumber) ?? []), it.kind]);
  const ordered = batchOrder(items.map((it) => ({ it, jobNumber: it.jobNumber, demoMs: it.demoTime.epochMilliseconds })));
  for (const [i, { it }] of ordered.entries()) {
    // The same key twice in 1 send is applied once; its other copies answer as repeats (below).
    if (answers.has(it.key)) continue;
    answers.set(it.key, await applyItemWithRetry(tx, ctx, deps, it, kindsByJob.get(it.jobNumber) ?? [], i));
  }
  const seen = new Set<string>();
  return items.map((it) => {
    const a = answers.get(it.key) as ItemOutcome;
    if (seen.has(it.key)) return a.result === 'refused' ? a : { ...a, result: 'duplicate' as const };
    seen.add(it.key);
    return a;
  });
}

async function applyItemWithRetry(tx: Queryable, ctx: ItemContext, deps: TextContext, it: QueuedItem, batchKinds: readonly string[], n: number): Promise<ItemOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await applyItem(tx, ctx, deps, it, batchKinds, `item_${n}`);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string' && RETRYABLE.has(code) && attempt < MAX_ITEM_TRIES) continue;
      // An item that fails the same way every time (a data exception, class 22, or a constraint, class 23) is answered
      // flagged with validation_failed and listed for the dispatcher, its savepoint already undone, so the rest of the
      // send commits (SPECIFICATIONS 5.1 steps 8 and 10; F-469, F-867).
      if (typeof code === 'string' && /^2[23]/.test(code)) {
        return inSavepoint(tx, `flag_${n}`, async () => {
          const job = await lockJob(tx, it.jobNumber);
          const out = await flagRefused(tx, ctx, it, 'validation_failed', job);
          return { keep: !out.lostRace, value: out.answer };
        });
      }
      throw e;
    }
  }
}

/** 1 item (section 5.1 steps 3 to 9) in its own savepoint. */
export function applyItem(tx: Queryable, ctx: ItemContext, deps: TextContext, it: QueuedItem, batchKinds: readonly string[], savepoint = 'item'): Promise<ItemOutcome> {
  return inSavepoint(tx, savepoint, async () => {
    try {
      const out = await decideAndWrite(tx, ctx, deps, it, batchKinds);
      if (out.lostRace) return { keep: false, value: out.answer };
      return { keep: true, value: out.answer };
    } catch (e) {
      if (e instanceof Refused) {
        return { keep: false, value: { key: it.key, result: 'refused', code: e.code, messageKey: `error.${e.code}`, values: null } };
      }
      throw e;
    }
  });
}

export interface Decided {
  answer: ItemOutcome;
  /** Undo this item's savepoint and answer `answer`: another send of the key committed between the lock and the insert, or the reset world no longer holds the job. */
  lostRace: boolean;
}

const done = (key: string, a: Answer): ItemOutcome => ({ key, ...a, code: null });

async function decideAndWrite(tx: Queryable, ctx: ItemContext, deps: TextContext, it: QueuedItem, batchKinds: readonly string[]): Promise<Decided> {
  await lockKey(tx, it.key);
  const stored = await storedAnswer(tx, it.key);
  if (stored) return { answer: done(it.key, stored), lostRace: false };

  // The ledger row goes first among the item's writes (note.item_key and offline_conflict.item_key reference it); all of
  // them share the item's savepoint, so none is visible before the send commits, and none survives a failure.
  const finish = async (a: Answer, placed: Placement | null, write?: () => Promise<void>): Promise<Decided> => {
    if (!(await recordItem(tx, ctx, it, placed, a))) {
      const again = await storedAnswer(tx, it.key);
      return { answer: done(it.key, again ?? { result: 'duplicate', messageKey: null, values: null }), lostRace: true };
    }
    if (write) await write();
    return { answer: done(it.key, a), lostRace: false };
  };

  // Section 5.1 step 3: an item from an erased world is answered, never applied (SD-12).
  if (it.worldEpoch !== ctx.worldEpoch) {
    if (it.worldEpoch > ctx.worldEpoch) return flagRefused(tx, ctx, it, 'validation_failed', await lockJob(tx, it.jobNumber));
    const reset: Answer = { result: 'world_reset', messageKey: MESSAGE.worldReset, values: null };
    // The reset world may no longer hold the job (the ledger's job_number is a key to it): answer with no ledger row (F-469).
    if (!(await jobExists(tx, it.jobNumber))) return { answer: done(it.key, reset), lostRace: true };
    return finish(reset, null);
  }

  const job = await lockJob(tx, it.jobNumber);
  if (!job || !(await isTechniciansJob(tx, job, ctx.technician.id))) return flagRefused(tx, ctx, it, 'not_found', job);

  // FR-BILL-3: the finish lines are decided before anything else, so a refused finish stays on the phone whole.
  let lines: ReturnType<typeof finishLines> | null = null;
  if (it.kind === 'finished') {
    const seeded = new Set((await tx.query<{ id: string }>('SELECT id::text FROM world.part')).rows.map((p) => p.id));
    lines = finishLines({ parts: it.finish.parts, noPartsUsed: it.finish.noPartsUsed, laborMinutes: it.finish.laborMinutes }, (id) => seeded.has(id));
    if (!lines.ok) {
      if (lines.code === 'validation_failed') return flagRefused(tx, ctx, it, 'validation_failed', job);
      throw new Refused(lines.code);
    }
  }

  // SD-21 (F-491): a person's technician item marks the job touched, so the autopilot leaves it alone; an autopilot step does not.
  // It sits after the ownership and finish-line refusals (a refused item stores nothing) inside the item's savepoint.
  if (!ctx.autopilot) await tx.query('UPDATE world.job SET touched_by_person = true WHERE job_number = $1 AND NOT touched_by_person', [job.jobNumber]);

  const placed = ctx.autopilot ? { at: ctx.receivedAt, rebased: false } : await placeOnClock(tx, it, ctx);
  const times = { offlineAt: wireAt(placed.at, job.zone), sentAt: wireAt(ctx.receivedAt, job.zone), rebased: placed.rebased };

  if (it.kind === 'note') {
    const note = it;
    return finish({ result: 'applied', messageKey: null, values: null }, placed, () => applyNote(tx, ctx, job, note, placed));
  }

  // Steps 5 and 6: the change since the version the app last read, and the table's verdict.
  const change = await changeSince(tx, job.jobNumber, it.baseVersion as number);

  // Section 5.1 step 9 (FR-TEXT-19): a late On my way goes in the history only, in every column (but the office's own
  // status set with no arrival of this technician behind it, which the table flags: @bw/domain onMyWayIsHistoryOnly).
  // F-472: the exception reads the job too: an arrival or ending of this technician applied earlier (a technician status row to on site, done or no one home) is entered first.
  const arrivalApplied = it.kind === 'on_my_way' && change.column === 'status_set' && (await tx.query(
    `SELECT 1 FROM world.job_change WHERE job_number = $1 AND actor_kind = 'technician' AND kind = 'status'
        AND data->'to'->>'status' IN ('on_site', 'done', 'no_one_home') LIMIT 1`, [job.jobNumber])).rows.length > 0;
  if (it.kind === 'on_my_way' && onMyWayIsHistoryOnly(job.status, batchKinds, change.column, arrivalApplied)) {
    return finish({ result: 'history_only', messageKey: MESSAGE.historyOnly, values: null }, placed, async () => {
      await appendTechnicianChange(tx, ctx, {
        jobNumber: job.jobNumber, at: placed.at, kind: 'history_only', fromVersion: job.version, toVersion: job.version,
        data: { itemKey: it.key, item: it.kind, ...times },
      });
      await publishEvent(tx, 'job.changed', { jobNumber: job.jobNumber, branch: job.branchId });
    });
  }

  if (conflictVerdict(it.kind, change.column) === 'flag') {
    const values = await flagValues(tx, { ctx, job, action: it.kind, column: change.column, row: change.row });
    return finish({ result: 'flagged', messageKey: techFlagKey(change.column), values }, placed, async () => {
      await recordFlag(tx, { ctx, job, itemKey: it.key, itemKind: it.kind, column: change.column, at: placed.at, values });
    });
  }

  // Step 7: a forward move only; a repeat or backward move (the other app's copy) is a duplicate.
  const target = STATUS_ITEM_TARGET[it.kind as StatusItemKind];
  if (!isForwardMove(job.status, target)) return finish({ result: 'duplicate', messageKey: null, values: null }, placed);
  return finish({ result: 'applied', messageKey: null, values: null }, placed,
    () => applyStatus(tx, ctx, deps, { job, item: it, target, placed, times, finish: lines?.ok ? lines.lines : null }));
}

/**
 * A refusal the phone cannot fix (validation_failed, not_found): answered flagged with the code and, when the job is in the
 * world, listed for the dispatcher like a flagged item (offline_conflict, a flagged history row, EVT-01), so the item leaves
 * the phone (SPECIFICATIONS 5.1 step 10; UI-SPECIFICATION 4.5 rule 10; owner ruling 546d6f1e). F-562: a job number the
 * world does not hold is listed the same way on the technician's branch, its rows with no job reference (migration 0022),
 * so the dispatcher sees it with Mark handled. Either way the ledger row is written first, so a resend answers duplicate.
 */
export async function flagRefused(tx: Queryable, ctx: ItemContext, it: ItemFacts, code: FlagCode, job: LockedJob | null): Promise<Decided> {
  const values = {
    tech: ctx.technician.nameInTexts, action: it.kind, job: it.jobNumber, change: code,
    by: null, byKind: null, to: null, toKind: 'nobody', date: null, at: null,
  };
  const answer: ItemOutcome = { key: it.key, result: 'flagged', code, messageKey: techFlagKey(code), values };
  const placed = ctx.autopilot ? { at: ctx.receivedAt, rebased: false } : await placeOnClock(tx, it, ctx);
  if (!(await recordItem(tx, ctx, it, placed, answer, job === null))) {
    const again = await storedAnswer(tx, it.key);
    return { answer: done(it.key, again ?? { result: 'duplicate', messageKey: null, values: null }), lostRace: true };
  }
  if (job) await recordFlag(tx, { ctx, job, itemKey: it.key, itemKind: it.kind, column: code, at: placed.at, values });
  else await recordUnlistedJobFlag(tx, { ctx, itemKey: it.key, column: code, at: placed.at, values });
  return { answer, lostRace: false };
}

/** A note (FR-TECH-3, D14): appended with its placed time; the job's version is left alone (a note changes no job field). */
async function applyNote(tx: Queryable, ctx: ItemContext, job: LockedJob, it: ItemFacts & { text: string }, placed: Placement): Promise<void> {
  const key = it.key;
  // FR-DEMO-9: the real clock, never the demo clock: the server's real time at receipt minus the item's entryReal.
  const offline = ctx.receivedReal.epochMilliseconds - entryRealMs(it.offsetSavedReal.epochMilliseconds, it.sinceSaveMs) > OFFLINE_AFTER_MS;
  const n = await tx.query<{ id: string }>(
    `INSERT INTO world.note (job_number, author_user_id, author_kind, body, entered_at, sent_at, entered_offline, device_time_real, item_key)
     VALUES ($1, $2, 'technician', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [job.jobNumber, ctx.technician.userId, it.text, placed.at.toString(), ctx.receivedAt.toString(), offline, it.deviceTime.toString(), key]);
  await appendTechnicianChange(tx, ctx, {
    jobNumber: job.jobNumber, at: placed.at, kind: 'note_added', fromVersion: job.version, toVersion: job.version,
    data: { noteId: n.rows[0]!.id, itemKey: key, enteredOffline: offline, offlineAt: wireAt(placed.at, job.zone), sentAt: wireAt(ctx.receivedAt, job.zone), rebased: placed.rebased },
  });
  await publishEvent(tx, 'job.changed', { jobNumber: job.jobNumber, branch: job.branchId });
}

const STATUS_TIME: Record<string, string> = { on_the_way: 'on_the_way_at', on_site: 'arrived_at', done: 'ended_at', no_one_home: 'ended_at' };

/** An applied status item (section 5.1 step 7): the job at version + 1, its job_change row, the derived effects, EVT-01. */
async function applyStatus(tx: Queryable, ctx: ItemContext, deps: TextContext, input: {
  job: LockedJob; item: QueuedItem; target: string; placed: Placement; times: Record<string, unknown>;
  finish: { parts: { partId: string; quantity: number }[]; noPartsUsed: boolean; laborMinutes: number } | null;
}): Promise<void> {
  const { job, target, placed } = input;
  const at = placed.at;
  if (input.finish) {
    for (const p of input.finish.parts) {
      await tx.query('INSERT INTO world.job_part (job_number, part_id, quantity) VALUES ($1, $2, $3)', [job.jobNumber, p.partId, p.quantity]);
    }
    const workDone = input.item.kind === 'finished' ? input.item.finish.workDone : [];
    for (const [i, text] of workDone.entries()) {
      await tx.query('INSERT INTO world.work_done_line (job_number, seq, text) VALUES ($1, $2, $3)', [job.jobNumber, i + 1, text]);
    }
    await tx.query('UPDATE world.job SET labor_minutes = $2, no_parts_used = $3 WHERE job_number = $1',
      [job.jobNumber, input.finish.laborMinutes, input.finish.noPartsUsed]);
  }
  await tx.query(`UPDATE world.job SET status = $2, ${STATUS_TIME[target]} = $3, version = version + 1 WHERE job_number = $1`,
    [job.jobNumber, target, at.toString()]);
  await appendTechnicianChange(tx, ctx, {
    jobNumber: job.jobNumber, at, kind: 'status', fromVersion: job.version, toVersion: job.version + 1,
    data: { from: { status: job.status }, to: { status: target }, itemKey: input.item.key, item: input.item.kind, ...input.times },
  });
  // FR-TECH-15: the technician's day starts at its first sign-in or applied status item.
  await tx.query(
    `INSERT INTO world.technician_day (technician_id, date, started_at) VALUES ($1, $2, $3)
     ON CONFLICT (technician_id, date) DO UPDATE SET started_at = LEAST(world.technician_day.started_at, EXCLUDED.started_at)`,
    [ctx.technician.id, job.date, at.toString()]);
  if (target === 'on_the_way') {
    // FR-TEXT-3 (F-470): P3-TEXTS's 1 on-the-way trigger: the live map token, the text and texted_arrival, due at
    // receipt (the server learned of the cause then; quiet hours may hold it). Texts off or no mobile: no text, no token.
    await sendOnTheWay(tx, deps, { jobNumber: job.jobNumber, eta: await onTheWayEta(tx, job, at), now: ctx.receivedAt });
  } else {
    await endOnTheWay(tx, { jobNumber: job.jobNumber, at });
  }
  // Section 6.6: a finish enters billing in its own transaction (the billing link sends it); No one home makes no item.
  if (target === 'done') await billFinishedJob(tx, { jobNumber: job.jobNumber, at: ctx.receivedAt as Instant });
  await publishEvent(tx, 'job.changed', { jobNumber: job.jobNumber, branch: job.branchId });
}
