// SPDX-License-Identifier: AGPL-3.0-or-later
// The triggers of the customer texts (SPECIFICATIONS section 6.4, SD-45; REQUIREMENTS FR-TEXT-1 to FR-TEXT-3, FR-TEXT-6,
// FR-TEXT-13, FR-TEXT-17), each an in-transaction service the handler of its cause calls (booking, office create and
// reschedule, the reminder event, On my way). Each fills the template's slots with the slot formatter and hands the
// text to enqueueText, the only way a text is created; a customer with texts off or no mobile gets no text at all (OI-31).
import type { Queryable } from '@bw/db';
import { addDays, atLocal, localDateOf, Temporal, zoned, type Instant, type Zone } from '@bw/time';
import { upsertReminderCall } from './call-list.ts';
import { enqueueText, type EnqueueResult } from './enqueue.ts';
import { instantOf } from './model.ts';
import { releaseTime } from './quiet-hours.ts';
import { newToken } from './reply.ts';
import { renderTemplate, type CountedBody, type TextLanguage } from './render.ts';
import {
  arrivalLabel, dateLabel, serviceLabel, textCatalogOf, textLink, weekdayLabel, windowLabelZoned, type TextCatalogs,
} from './slots.ts';

/** What every trigger needs: the catalogs the templates and labels come from, and TEXT_LINK_HOST (FR-TEXT-18). */
export interface TextContext {
  catalogs: TextCatalogs;
  linkHost: string;
}

/** scheduled_event.kind of the 6:00 PM reminder planner's event (section 6.4); its subject is the job number. */
export const TEXT_REMINDER = 'text.reminder';
/** The reminder goes out at 6:00 PM, the evening before the visit, in the customer's zone (FR-TEXT-2). */
export const REMINDER_TIME = '18:00';

interface JobFacts {
  job_number: number;
  customer_id: string;
  branch_id: string;
  date: string;
  zone: string;
  status: string;
  window_start: Date;
  window_end: Date;
  technician_id: string | null;
  text_label_key: string;
  text_language: TextLanguage;
  customer_zone: string;
  texts_on: boolean;
  mobile: string | null;
}

async function jobFacts(tx: Queryable, jobNumber: number): Promise<JobFacts> {
  const { rows } = await tx.query<JobFacts>(
    `SELECT j.job_number, j.customer_id, j.branch_id, j.date::text AS date, j.zone, j.status, j.window_start, j.window_end,
            j.technician_id, s.text_label_key, c.text_language, c.zone AS customer_zone, c.texts_on, c.mobile
       FROM world.job j
       JOIN world.service_type s ON s.id = j.service_id
       JOIN world.customer c ON c.id = j.customer_id
      WHERE j.job_number = $1`,
    [jobNumber],
  );
  const j = rows[0];
  if (!j) throw new Error(`no job ${jobNumber}`);
  return j;
}

/**
 * FR-TEXT-1 and SD-45: the confirmation of a booking, an office-created job or a reschedule, due at demo now (the try runs
 * at once, within the minute; quiet hours may hold it). Slots: weekday, date, window label, service text label.
 */
export async function sendConfirmation(tx: Queryable, ctx: TextContext, input: { jobNumber: number; now: Instant }): Promise<EnqueueResult> {
  const j = await jobFacts(tx, input.jobNumber);
  const lang = j.text_language;
  const d = Temporal.PlainDate.from(j.date);
  return enqueueText(tx, {
    kind: 'confirmation',
    customerId: j.customer_id,
    jobNumber: j.job_number,
    now: input.now,
    catalog: textCatalogOf(ctx.catalogs),
    values: {
      weekday: weekdayLabel(ctx.catalogs, lang, d.dayOfWeek),
      date: dateLabel(ctx.catalogs, lang, d.month, d.day),
      window: windowLabelZoned(instantOf(j.window_start), instantOf(j.window_end), j.zone, lang),
      service: serviceLabel(ctx.catalogs, lang, j.text_label_key),
    },
  });
}

/**
 * FR-TEXT-2: when the reminder for a visit on `date` goes out: 6:00 PM on the day before, in the CUSTOMER's zone (a wall
 * time there, exact across daylight-saving changes).
 */
export function reminderDueAt(visitDate: string, customerZone: Zone): Instant {
  return atLocal(addDays(visitDate, -1), REMINDER_TIME, customerZone, 'compatible');
}

export type ReminderPlan =
  | { planned: true; dueAt: Instant; moved: boolean; atOnce: boolean }
  | { planned: false; why: 'not_scheduled' | 'already_past' };

/**
 * The reminder planner (section 6.4): writes 1 `text.reminder` event per job, due at 6:00 PM the day before the visit in
 * the customer's zone, and MOVES that event when the job is rescheduled or the zone is edited. A job that is not
 * scheduled gets none; an old due event is skipped.
 *
 * A visit booked or moved after that 6:00 PM, while the customer's evening before the visit is still on, gets its
 * reminder at once (owner ruling 86ecd5ae, "Send it right away"; F-446): the event is due now and carries `atOnce` and
 * the visit's date, so the reminder text (or, with no mobile or texts off, the call list entry of FR-TEXT-13) is made
 * minutes after the confirmation. Once the visit's own day has begun in the customer's zone there is no evening before
 * left, and the job gets none (`already_past`).
 */
export async function planReminder(tx: Queryable, input: { jobNumber: number; now: Instant }): Promise<ReminderPlan> {
  const j = await jobFacts(tx, input.jobNumber);
  const regular = reminderDueAt(j.date, j.customer_zone);
  const passed = Temporal.Instant.compare(regular, input.now) <= 0;
  const eveningLeft = Temporal.Instant.compare(input.now, atLocal(j.date, '00:00', j.customer_zone, 'compatible')) < 0;
  const why = j.status !== 'scheduled' ? 'not_scheduled' : passed && !eveningLeft ? 'already_past' : null;
  if (why !== null) {
    await tx.query(`UPDATE world.scheduled_event SET state = 'skipped', run_at = $2, result = 'reminder_not_planned' WHERE kind = $1 AND subject = $3 AND state = 'due'`, [TEXT_REMINDER, input.now.toString(), String(j.job_number)]);
    return { planned: false, why };
  }
  const dueAt = passed ? input.now : regular;
  const payload = passed ? { jobNumber: j.job_number, atOnce: true, visitDate: j.date } : { jobNumber: j.job_number };
  // F-826: the index of migration 0018 holds 1 due reminder per job, and this write is its 1 writer: a second writer at once waits for
  // the first and then moves the first's row, and a row a run has just ended is out of the index, so the visit gets a new one (F-446).
  const { rows } = await tx.query<{ moved: boolean }>(
    `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ($1, '${TEXT_REMINDER}', $2, $3, 'due')
     ON CONFLICT (subject) WHERE kind = '${TEXT_REMINDER}' AND state = 'due' DO UPDATE SET due_at = EXCLUDED.due_at, payload = EXCLUDED.payload
     RETURNING xmax <> 0 AS moved`,
    [dueAt.toString(), String(j.job_number), JSON.stringify(payload)],
  );
  return { planned: true, dueAt, moved: rows[0]!.moved, atOnce: passed };
}

/**
 * A zone edit (API-36) moves the reminder of every live future visit of the customer (FR-TEXT-17). It moves one still to go and
 * never makes a second one (FR-TEXT-2, F-824): a visit whose reminder has run, with none due, is left alone. The visit did not
 * change, so it is not the moved visit that F-446 and F-653 remind again.
 */
export async function replanCustomerReminders(tx: Queryable, input: { customerId: string; now: Instant }): Promise<number> {
  const { rows } = await tx.query<{ job_number: number }>(
    `SELECT j.job_number FROM world.job j
      WHERE j.customer_id = $1 AND j.status = 'scheduled'
        AND (EXISTS (SELECT 1 FROM world.scheduled_event e WHERE e.kind = $2 AND e.subject = j.job_number::text AND e.state = 'due')
             OR NOT EXISTS (SELECT 1 FROM world.scheduled_event e WHERE e.kind = $2 AND e.subject = j.job_number::text AND e.state = 'done'))
      ORDER BY j.job_number`,
    [input.customerId, TEXT_REMINDER],
  );
  let n = 0;
  for (const j of rows) {
    if ((await planReminder(tx, { jobNumber: j.job_number, now: input.now })).planned) n += 1;
  }
  return n;
}

export type ReminderFired =
  | { result: 'sent'; textId: string }
  | { result: 'call_list'; reason: 'no_mobile' | 'texts_off' }
  | { result: 'skipped'; why: 'not_scheduled' | 'moved' };

/**
 * The reminder event at fire time (section 6.4): the reminder text, or, with no mobile or texts off, a call list entry
 * dated the day before the visit (FR-TEXT-13). `eventDueAt` is the event's own time; a job moved or canceled since
 * leaves the event stale and it does nothing. The text is stamped at the event's time (`now` = max(due, demo now)).
 */
export async function fireReminder(
  tx: Queryable, ctx: TextContext, input: { jobNumber: number; eventDueAt: Instant; now: Instant; atOnce?: { visitDate: string } },
): Promise<ReminderFired> {
  const j = await jobFacts(tx, input.jobNumber);
  if (j.status !== 'scheduled') return { result: 'skipped', why: 'not_scheduled' };
  // An at-once reminder (F-446) is stale when its visit has moved to another day since it was planned; a regular one when its 6:00 PM has moved.
  const stale = input.atOnce ? input.atOnce.visitDate !== j.date : Temporal.Instant.compare(reminderDueAt(j.date, j.customer_zone), input.eventDueAt) !== 0;
  if (stale) return { result: 'skipped', why: 'moved' };
  if (!j.texts_on || !j.mobile) {
    const reason = !j.texts_on ? 'texts_off' : 'no_mobile';
    // Once per visit and call date (F-653): a 2nd fire after a same-evening re-plan, or a row API-38 already wrote that morning, is kept as it is.
    await upsertReminderCall(tx, { branchId: j.branch_id, callDate: addDays(j.date, -1), customerId: j.customer_id, jobNumber: j.job_number, reason, addedAt: input.now });
    return { result: 'call_list', reason };
  }
  // The day word is the one true when try 1 goes out (F-650): an at-once reminder that quiet hours hold past midnight says "today".
  const r = await enqueueText(tx, {
    kind: 'reminder',
    template: reminderTemplateAt(j.date, releaseTime(input.now, j.customer_zone), j.customer_zone),
    customerId: j.customer_id,
    jobNumber: j.job_number,
    now: input.now,
    catalog: textCatalogOf(ctx.catalogs),
    values: reminderValues(j, j.text_language),
  });
  if (!r.ok) throw new Error(`reminder for job ${j.job_number} was not enqueued: ${r.reason}`);
  return { result: 'sent', textId: r.textId };
}

const reminderValues = (j: JobFacts, lang: TextLanguage) => ({ window: windowLabelZoned(instantOf(j.window_start), instantOf(j.window_end), j.zone, lang) });

/**
 * The reminder's template for a send at `at` (F-650, owner ruling 86ecd5ae kept): the reminder says "tomorrow" while the
 * send is on an earlier day than the visit in the customer's zone, and "today" once the visit's own day has begun there
 * (quiet hours held an at-once reminder, or a retry, past midnight to 8:00 AM).
 */
export function reminderTemplateAt(visitDate: string, at: Instant, customerZone: Zone): 'reminder' | 'reminder_today' {
  return Temporal.PlainDate.compare(Temporal.PlainDate.from(localDateOf(at, customerZone)), Temporal.PlainDate.from(visitDate)) >= 0 ? 'reminder_today' : 'reminder';
}

/**
 * The reminder text's body for a send at `at`, in the text's language, from the visit's facts now: the try handler
 * calls it right before the gateway, so the words a customer reads are true at the moment they are sent (F-650), whatever
 * held or retried the text. Null when the job is gone.
 */
export async function reminderBodyAt(
  tx: Queryable, ctx: Pick<TextContext, 'catalogs'>, input: { jobNumber: number; language: TextLanguage; at: Instant },
): Promise<CountedBody | null> {
  const { rows } = await tx.query<{ n: number }>('SELECT 1 AS n FROM world.job WHERE job_number = $1', [input.jobNumber]);
  if (rows.length === 0) return null;
  const j = await jobFacts(tx, input.jobNumber);
  return renderTemplate(textCatalogOf(ctx.catalogs), reminderTemplateAt(j.date, input.at, j.customer_zone), input.language, reminderValues(j, input.language));
}

/**
 * Whether a reminder at its send `at` has gone stale (F-685): its visit is no longer scheduled, or its date is no longer the day
 * after or the day of the send in the customer's zone (the visit was moved at night, after a quiet-hours hold or a retry was made).
 * The try handler cancels such a text instead of sending words that are no longer true. False when the job is gone.
 */
export async function reminderIsStale(tx: Queryable, input: { jobNumber: number; at: Instant }): Promise<boolean> {
  const { rows } = await tx.query<{ n: number }>('SELECT 1 AS n FROM world.job WHERE job_number = $1', [input.jobNumber]);
  if (rows.length === 0) return false;
  const j = await jobFacts(tx, input.jobNumber);
  if (j.status !== 'scheduled') return true;
  const today = Temporal.PlainDate.from(localDateOf(input.at, j.customer_zone));
  const ahead = Temporal.PlainDate.from(j.date).since(today, { largestUnit: 'days' }).days;
  return ahead < 0 || ahead > 1;
}

/** The customer's zone at online booking, for an imported customer and for an office-created one (FR-TEXT-17). */
export function customerZoneFor(input: { browserZone?: string | null; branchZone: Zone }): Zone {
  const z = input.browserZone;
  if (z) {
    try {
      zoned(Temporal.Instant.fromEpochMilliseconds(0), z); // throws on a name that is no IANA zone
      return z;
    } catch {
      // not an IANA zone: fall through to the branch's zone
    }
  }
  return input.branchZone;
}

export type OnTheWaySent = { sent: true; textId: string; token: string; arrival: Instant } | { sent: false; reason: 'texts_off' | 'no_mobile' };

/**
 * FR-TEXT-3: the on-the-way text. Its arrival is the job's ETA at enqueue rounded to 5 minutes, its link is the live map
 * on the text link host with a new random token (kind live_map, ends at arrival), and `texted_arrival` is set to that
 * time (section 6.4). The technician's name in texts is used, never the screen name (FR-TEXT-11).
 */
export async function sendOnTheWay(tx: Queryable, ctx: TextContext, input: { jobNumber: number; eta: Instant; now: Instant }): Promise<OnTheWaySent> {
  const j = await jobFacts(tx, input.jobNumber);
  if (!j.technician_id) throw new Error(`job ${j.job_number} has no technician to name in the on-the-way text`);
  const tech = await tx.query<{ name_in_texts: string }>(`SELECT name_in_texts FROM world.technician WHERE id = $1`, [j.technician_id]);
  const arrival = arrivalLabel(input.eta, j.zone, j.text_language);
  const token = newToken();
  await tx.query(`INSERT INTO world.link_token (token, kind, job_number, created_at) VALUES ($1, 'live_map', $2, $3)`, [token, j.job_number, input.now.toString()]);
  const r = await enqueueText(tx, {
    kind: 'on_the_way',
    customerId: j.customer_id,
    jobNumber: j.job_number,
    now: input.now,
    linkToken: token,
    catalog: textCatalogOf(ctx.catalogs),
    values: { tech: tech.rows[0]!.name_in_texts, arrival: arrival.label, mapLink: textLink(ctx.linkHost, 'map', token) },
  });
  if (!r.ok) {
    await tx.query(`DELETE FROM world.link_token WHERE token = $1`, [token]);
    return { sent: false, reason: r.reason === 'texts_off' ? 'texts_off' : 'no_mobile' };
  }
  await tx.query(`UPDATE world.job SET texted_arrival = $2 WHERE job_number = $1`, [j.job_number, arrival.rounded.toString()]);
  return { sent: true, textId: r.textId, token, arrival: arrival.rounded };
}

export type LateSent =
  | { sent: true; textId: string; arrival: Instant; wasArrival: Instant }
  | { sent: false; reason: 'not_open' | 'already_sent' | 'no_baseline' | 'not_late' | 'texts_off' | 'no_mobile' | 'message_too_long' };

/**
 * FR-TEXT-5, OA-53 (SPECIFICATIONS section 6.4 late text): the ETA sweep's 1 late text per visit. Under the job's row lock,
 * while the job is scheduled or on the way and `late_text_sent_at` is null, the baseline is `texted_arrival`, else
 * `planned_arrival`; when `isLate(baseline)` holds (the caller's 20-minute rule over the new ETA) the text names the
 * ETA rounded to 5 minutes, and in that same transaction `late_text_was_arrival` takes the baseline, then
 * `late_text_sent_at` is set and `texted_arrival` becomes the new time. A customer with texts off or no mobile gets no
 * text and nothing is stamped. The technician's name in texts is used (FR-TEXT-11).
 */
export async function sendLate(
  tx: Queryable, ctx: TextContext, input: { jobNumber: number; eta: Instant; now: Instant; isLate: (baseline: Instant) => boolean },
): Promise<LateSent> {
  const r = await tx.query<{ status: string; texted_arrival: Date | null; planned_arrival: Date | null; late_text_sent_at: Date | null }>(
    `SELECT status, texted_arrival, planned_arrival, late_text_sent_at FROM world.job WHERE job_number = $1 FOR UPDATE`, [input.jobNumber]);
  const row = r.rows[0];
  if (!row || (row.status !== 'scheduled' && row.status !== 'on_the_way')) return { sent: false, reason: 'not_open' };
  if (row.late_text_sent_at !== null) return { sent: false, reason: 'already_sent' };
  const base = row.texted_arrival ?? row.planned_arrival;
  if (base === null) return { sent: false, reason: 'no_baseline' };
  const baseline = instantOf(base);
  if (!input.isLate(baseline)) return { sent: false, reason: 'not_late' };
  const j = await jobFacts(tx, input.jobNumber);
  if (!j.technician_id) return { sent: false, reason: 'not_open' };
  const tech = await tx.query<{ name_in_texts: string }>(`SELECT name_in_texts FROM world.technician WHERE id = $1`, [j.technician_id]);
  const arrival = arrivalLabel(input.eta, j.zone, j.text_language);
  const e = await enqueueText(tx, {
    kind: 'late', customerId: j.customer_id, jobNumber: j.job_number, now: input.now, catalog: textCatalogOf(ctx.catalogs),
    values: { tech: tech.rows[0]!.name_in_texts, arrival: arrival.label },
  });
  if (!e.ok) return { sent: false, reason: e.reason }; // F-514: message_too_long is its own reason, not no_mobile
  await tx.query(
    `UPDATE world.job SET late_text_was_arrival = $2, late_text_sent_at = $3, texted_arrival = $4 WHERE job_number = $1`,
    [j.job_number, baseline.toString(), input.now.toString(), arrival.rounded.toString()]);
  return { sent: true, textId: e.textId, arrival: arrival.rounded, wasArrival: baseline };
}
