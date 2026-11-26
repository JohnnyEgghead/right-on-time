// SPDX-License-Identifier: AGPL-3.0-or-later
// Reply intake (SPECIFICATIONS section 6.4 Replies, SD-46, OI-16; FR-TEXT-8; API-121's service, in its transaction).
// The body is trimmed and case-folded: `c` confirms the target visit, `r` sends the R-reply with a new reschedule
// token, anything else is stored as not understood for the office, with no outgoing text. Every reply is stored as
// typed, as an `in` inbox row with its handling and the visit it was about.
//
// SD-46: C and R target the customer's earliest live job with status `scheduled` dated today or later (today in the
// job's own zone). With none, a C is not understood; an R still gets the R-reply, with the date and a reschedule link
// of the customer's most recent job, which answers gone (OI-16).
import { randomInt } from 'node:crypto';
import type { Queryable } from '@bw/db';
import { localDateOf, zoned, type Instant } from '@bw/time';
import { enqueueText } from './enqueue.ts';
import { instantOf } from './model.ts';
import { publish } from './notify.ts';
import type { TextCatalog, TextLanguage } from './render.ts';
import { textLink } from './slots.ts';

export type ReplyHandling = 'confirmed' | 'reschedule_sent' | 'not_understood';

/** The weekday and date labels of a visit day in a language (SD-17 maxima); slots.ts visitDayLabels is the real one. */
export type VisitDayLabels = (localDate: string, lang: TextLanguage) => { weekday: string; date: string };

export interface ReplyInput {
  customerId: string;
  /** The reply exactly as typed. */
  body: string;
  now: Instant;
  catalog: TextCatalog;
  dayLabels: VisitDayLabels;
  /** TEXT_LINK_HOST (FR-TEXT-18): links are written with no scheme, e.g. bw.j7l.io/r/7Hk2Ab9Q (SD-17). */
  linkHost: string;
}

export interface ReplyResult {
  replyId: string;
  at: Instant;
  handling: ReplyHandling;
  jobNumber: number | null;
  /** The R-reply's text, when one was enqueued. */
  textId: string | null;
}

interface JobRow {
  job_number: number;
  date: string;
  zone: string;
  branch_id: string;
  version: number;
  confirmed_at: Date | null;
  status: string;
  window_start: Date;
}

const JOB_COLUMNS = 'job_number, date, zone, branch_id, version, confirmed_at, status, window_start';

/** The visit a C or an R reply is about: the customer's earliest scheduled visit dated today or later in the job's own zone, or null (SD-46; an R with none falls back to the most recent job). */
export async function replyTarget(tx: Queryable, customerId: string, now: Instant): Promise<JobRow | null> {
  const { rows } = await tx.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM world.job WHERE customer_id = $1 AND status = 'scheduled' ORDER BY window_start, job_number`,
    [customerId],
  );
  return rows.find((j) => j.date >= localDateOf(now, j.zone)) ?? null;
}

async function mostRecentJob(tx: Queryable, customerId: string): Promise<JobRow | null> {
  const { rows } = await tx.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM world.job WHERE customer_id = $1 ORDER BY window_start DESC, job_number DESC LIMIT 1`,
    [customerId],
  );
  return rows[0] ?? null;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A token of 8 random base62 characters (SD-17, about 47 bits). */
export function newToken(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += BASE62[randomInt(62)];
  return s;
}

export async function handleReply(tx: Queryable, input: ReplyInput): Promise<ReplyResult> {
  const word = input.body.trim().toLowerCase();
  let handling: ReplyHandling = 'not_understood';
  let job: JobRow | null = null;
  let textId: string | null = null;

  if (word === 'c') {
    job = await replyTarget(tx, input.customerId, input.now);
    if (job) {
      handling = 'confirmed';
      if (job.confirmed_at === null) await confirmJob(tx, job, input.now);
    }
  } else if (word === 'r') {
    job = (await replyTarget(tx, input.customerId, input.now)) ?? (await mostRecentJob(tx, input.customerId));
    if (job) {
      textId = await sendRReply(tx, input, job);
      if (textId) handling = 'reschedule_sent';
    }
  }

  const ins = await tx.query<{ id: string; at: Date }>(
    `INSERT INTO world.inbox_message (customer_id, direction, body, at, handling, job_number) VALUES ($1, 'in', $2, $3, $4, $5) RETURNING id, at`,
    [input.customerId, input.body, input.now.toString(), handling, job?.job_number ?? null],
  );
  const reply = ins.rows[0]!;
  return { replyId: reply.id, at: instantOf(reply.at), handling, jobNumber: job?.job_number ?? null, textId };
}

/**
 * C: the visit's confirmed_at and a `confirmed` job_change by the customer (section 3 enums). The version is not
 * bumped: confirmed_at is no field an office write sets, so it can lose no update, and a customer's C must not turn a
 * dispatcher's open edit into a version conflict (section 5.3 step 1 gates office writes).
 */
async function confirmJob(tx: Queryable, job: JobRow, now: Instant): Promise<void> {
  await tx.query(`UPDATE world.job SET confirmed_at = $2 WHERE job_number = $1`, [job.job_number, now.toString()]);
  await tx.query(
    `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
     VALUES ($1, $2, NULL, 'customer', 'confirmed', $3, $3, $4)`,
    [job.job_number, now.toString(), job.version, JSON.stringify({ messageKey: 'job_change.confirmed_by_reply' })],
  );
  await publish(tx, 'job.changed', { jobNumber: job.job_number, branch: job.branch_id });
}

/** R: a new reschedule token for the visit (ends 7 demo days after it was sent, SD-17) and the R-reply carrying it. */
async function sendRReply(tx: Queryable, input: ReplyInput, job: JobRow): Promise<string | null> {
  const lang = await tx.query<{ text_language: TextLanguage }>(`SELECT text_language FROM world.customer WHERE id = $1`, [input.customerId]);
  const phone = await tx.query<{ office_phone: string }>(`SELECT office_phone FROM world.branch WHERE id = $1`, [job.branch_id]);
  const token = newToken();
  await tx.query(
    `INSERT INTO world.link_token (token, kind, job_number, created_at, expires_at) VALUES ($1, 'reschedule', $2, $3, $4)`,
    [token, job.job_number, input.now.toString(), zoned(input.now, job.zone).add({ days: 7 }).toInstant().toString()],
  );
  const labels = input.dayLabels(job.date, lang.rows[0]!.text_language);
  const r = await enqueueText(tx, {
    kind: 'r_reply',
    customerId: input.customerId,
    jobNumber: job.job_number,
    now: input.now,
    linkToken: token,
    catalog: input.catalog,
    values: { weekday: labels.weekday, date: labels.date, rescheduleLink: textLink(input.linkHost, 'reschedule', token), phone: phone.rows[0]!.office_phone },
  });
  return r.ok ? r.textId : null;
}
