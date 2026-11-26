// SPDX-License-Identifier: AGPL-3.0-or-later
// The text.try handler (SPECIFICATIONS section 5.2 step 3; FR-TEXT-12, invariant 2; section 11.6 enforcement matrix).
// 1 run = at most 1 numbered try of 1 text, in the dispatcher's transaction for that event:
//
//   lock the text -> precondition (sendable, tries < 5, this event's number = tries + 1) -> quiet-hours recheck
//   -> the reminder's day word for this send (F-650) -> gateway send -> text_attempt n -> delivered | retrying with the event of try n + 1 | gave_up after try 5
//
// After the 5th failure: status gave_up, 1 call list row (reason text_gave_up) and 1 office alert (text_gave_up), and
// no event, so there is never a 6th try. Re-run safety: the attempt's primary key (text_id, number), the number check
// and the 1-transaction run mean a replayed or concurrent event can neither repeat a try nor make an extra one.
import type { Queryable } from '@bw/db';
import {
  instantOf, MAX_TRIES, plannedTryAt, publishTextChanged, REASON, reminderBodyAt, reminderIsStale, scheduleTry, SENDABLE,
  type GatewayFactory, type TextCatalogs, type TextKind, type TextLanguage, type TextStatus, type TextTryPayload,
} from '@bw/outbox';
import { localDateOf, Temporal, type Clock, type Instant } from '@bw/time';
import { openAlert, textGaveUpLink } from '../alerts/index.ts';
import type { EventHandler, EventOutcome, GiveUp } from '../dispatcher.ts';
import { holdIfQuiet } from './quietHours.ts';

interface TextRow {
  id: string;
  customer_id: string;
  job_number: number | null;
  kind: TextKind;
  language: TextLanguage;
  body: string;
  encoding: 'gsm7' | 'ucs2';
  status: TextStatus;
  tries: number;
  zone: string;
  branch_id: string;
  branch_zone: string;
  /** When the text was written: the text log lists it on this day (F-1298). */
  created_at: Date;
}

const skipped = (result: string): EventOutcome => ({ state: 'skipped', result });

/**
 * The give-up of a text.try event whose handler failed on every run (F-368, invariant 2: every end path needs its end
 * record). The dispatcher calls it after MAX_HANDLER_FAILURES failed runs: the text becomes gave_up exactly as after its
 * 5th failed try, so it reaches the call list and the office as a text_gave_up alert, never retried forever unseen.
 */
export function giveUpTextHandler(deps: { clock: Pick<Clock, 'realNow'> }): GiveUp {
  return async (event, { tx, now }) => {
    const p = event.payload as unknown as TextTryPayload;
    const { rows } = await tx.query<TextRow>(
      `SELECT t.id, t.customer_id, t.job_number, t.kind, t.language, t.body, t.encoding, t.status, t.tries, c.zone, c.branch_id, b.zone AS branch_zone, t.created_at
         FROM world.outbox_text t
         JOIN world.customer c ON c.id = t.customer_id
         JOIN world.branch b ON b.id = c.branch_id
        WHERE t.id = $1
          FOR UPDATE OF t`,
      [p.textId],
    );
    const t = rows[0];
    if (!t || !SENDABLE.includes(t.status)) return skipped('handler_failed');
    await tx.query(`UPDATE world.outbox_text SET status = 'gave_up', next_try_at = NULL, reason_key = $2 WHERE id = $1`, [t.id, REASON.gaveUp]);
    await reportGaveUp(tx, t, now, deps.clock);
    await publishTextChanged(tx, { textId: t.id, customerId: t.customer_id, jobNumber: t.job_number, branch: t.branch_id });
    return skipped('handler_failed');
  };
}

/**
 * The text.try handler with its gateway (composed at start-up), the clock (for the alert's operator real time) and the
 * catalogs (a reminder's body is re-rendered for the moment of its send, F-650).
 */
export function tryTextHandler(deps: { gateway: GatewayFactory; clock: Pick<Clock, 'realNow'>; catalogs: TextCatalogs }): EventHandler {
  return async (event, { tx, now }) => {
    const p = event.payload as unknown as TextTryPayload;
    const { rows } = await tx.query<TextRow>(
      `SELECT t.id, t.customer_id, t.job_number, t.kind, t.language, t.body, t.encoding, t.status, t.tries, c.zone, c.branch_id, b.zone AS branch_zone, t.created_at
         FROM world.outbox_text t
         JOIN world.customer c ON c.id = t.customer_id
         JOIN world.branch b ON b.id = c.branch_id
        WHERE t.id = $1
          FOR UPDATE OF t`,
      [p.textId],
    );
    const t = rows[0];
    if (!t) return skipped('no_text');
    if (!SENDABLE.includes(t.status)) return skipped('not_sendable');
    if (t.tries >= MAX_TRIES || p.number !== t.tries + 1) return skipped('stale_try');

    // F-685: a reminder whose visit was canceled, or moved to a day that is not the day after or the day of this send, says nothing true.
    if (t.kind === 'reminder' && t.job_number !== null && (await reminderIsStale(tx, { jobNumber: t.job_number, at: now }))) {
      await tx.query(`UPDATE world.outbox_text SET status = 'canceled', reason_key = $2, next_try_at = NULL WHERE id = $1`, [t.id, REASON.visitChanged]);
      await publishTextChanged(tx, { textId: t.id, customerId: t.customer_id, jobNumber: t.job_number, branch: t.branch_id });
      return skipped('visit_changed');
    }

    const releasedAt = await holdIfQuiet(tx, t, now, p);
    if (releasedAt) {
      await publishTextChanged(tx, { textId: t.id, customerId: t.customer_id, jobNumber: t.job_number, branch: t.branch_id });
      return { state: 'done', result: 'held' };
    }

    const n = p.number;
    // F-650: a reminder says "tomorrow" or "today" as it is at this send, in the customer's zone and the text's language.
    // The new words are stored in this try's transaction, so the log, the inbox row and what the gateway sent are one body;
    // a replay of the try renders the same words at the same event time.
    let { body, encoding } = t;
    if (t.kind === 'reminder' && t.job_number !== null) {
      const fresh = await reminderBodyAt(tx, deps, { jobNumber: t.job_number, language: t.language, at: now });
      if (fresh && fresh.body !== t.body) {
        await tx.query('UPDATE world.outbox_text SET body = $2, encoding = $3, characters = $4 WHERE id = $1', [t.id, fresh.body, fresh.encoding, fresh.characters]);
        ({ body, encoding } = fresh);
      }
    }
    const sent = await deps.gateway(tx, now).send({ textId: t.id, customerId: t.customer_id, body, encoding });
    await tx.query(`INSERT INTO world.text_attempt (text_id, number, at, result, reason, "by") VALUES ($1, $2, $3, $4, $5, $6)`, [
      t.id, n, now.toString(), sent.result, sent.result === 'failed' ? sent.reason : null, p.by ?? null,
    ]);

    let result: string;
    if (sent.result === 'delivered') {
      await tx.query(
        `UPDATE world.outbox_text SET status = 'delivered', tries = $2, delivered_at = $3, next_try_at = NULL, reason_key = NULL WHERE id = $1`,
        [t.id, n, now.toString()],
      );
      result = 'delivered';
    } else if (n < MAX_TRIES) {
      const next = await nextTryTime(tx, t, n, now);
      await tx.query(`UPDATE world.outbox_text SET status = 'retrying', tries = $2, next_try_at = $3, reason_key = $4 WHERE id = $1`, [
        t.id, n, next.toString(), REASON.sendFailed,
      ]);
      await scheduleTry(tx, next, { textId: t.id, number: n + 1 });
      result = 'failed';
    } else {
      await tx.query(`UPDATE world.outbox_text SET status = 'gave_up', tries = $2, next_try_at = NULL, reason_key = $3 WHERE id = $1`, [
        t.id, n, REASON.gaveUp,
      ]);
      await reportGaveUp(tx, t, now, deps.clock);
      result = 'gave_up';
    }
    await publishTextChanged(tx, { textId: t.id, customerId: t.customer_id, jobNumber: t.job_number, branch: t.branch_id });
    return { state: 'done', result };
  };
}

/**
 * Try n + 1 at the first try's time plus its offset, pushed out of quiet hours (FR-TEXT-12), never before this try:
 * a try that ran late (held at try time, Try now) must not schedule the next one in its own past, where a replay
 * would stamp it earlier than the try before it.
 */
async function nextTryTime(tx: Queryable, t: TextRow, n: number, now: Instant): Promise<Instant> {
  let first = now;
  if (n > 1) {
    const r = await tx.query<{ at: Date }>(`SELECT at FROM world.text_attempt WHERE text_id = $1 AND number = 1`, [t.id]);
    first = instantOf(r.rows[0]!.at);
  }
  const planned = plannedTryAt(first, n + 1, t.zone, t.kind);
  return Temporal.Instant.compare(planned, now) >= 0 ? planned : now;
}

/**
 * The 5th failure is reported, never dropped (invariant 2): 1 call list row for the branch's day and 1 open office
 * alert. The call list row is skipped when the text already has one (the office's Add to call list, API-145) or has
 * no visit (an office text about no visit: call_list_entry.job_number is required; finding filed). The alert is
 * always written: the rule of 1 open alert per type and subject (the text), SD-30, is the index's job.
 */
async function reportGaveUp(tx: Queryable, t: TextRow, now: Instant, clock: Pick<Clock, 'realNow'>): Promise<void> {
  const callDate = localDateOf(now, t.branch_zone);
  if (t.job_number !== null) {
    await tx.query(
      `INSERT INTO world.call_list_entry (branch_id, call_date, customer_id, job_number, text_id, reason, added_at)
       SELECT $1, $2, $3, $4, $5, 'text_gave_up', $6
        WHERE NOT EXISTS (SELECT 1 FROM world.call_list_entry WHERE text_id = $5)`,
      [t.branch_id, callDate, t.customer_id, t.job_number, t.id, now.toString()],
    );
  }
  // F-447: the shared creator publishes alert.created and emails the managers when the type's switch is on.
  await openAlert(tx, 'text_gave_up', {
    // A text about a visit is on the call list; an office text about no visit is not, so its alert opens the text log at the
    // day the text was written, the day the log lists it on (F-1277, F-1298).
    subject: t.id, branchId: t.branch_id,
    link: textGaveUpLink(t.job_number, { callDate, writtenDate: localDateOf(instantOf(t.created_at), t.branch_zone) }),
    values: t.job_number === null ? { textId: t.id } : { textId: t.id, jobNumber: t.job_number },
  }, { now, clock });
}
