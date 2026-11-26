// SPDX-License-Identifier: AGPL-3.0-or-later
// The Messages handlers (UI-SPECIFICATION 12.2 API-38, API-40, API-41, API-42, API-144, API-145, API-146; SPECIFICATIONS section 6.4
// FR-TEXT-12, FR-TEXT-13, FR-TEXT-15, FR-TEXT-24, FR-TEXT-25). The reads (the text log, a text, the call list) are plain queries over
// the outbox and the call list; the writes call the outbox's own services (Try now) or write one row and say so on the bus.
import type { addToCallList, callList, recordCallOutcome, textDetail, textLog, textLogExport, tryTextNow } from '@bw/api';
import { foldStreetName, publishEvent } from '@bw/db';
import { areaSql } from '@bw/domain';
import type { RowT } from '@bw/i18n/src/billing-rows.ts';
import { formatterFor } from '@bw/i18n/src/format.ts';
import {
  clockOfWire, handlingChip, hourWordOfWire, languageText, statusLine, typeText, type StatusFacts, type TimeWords,
} from '@bw/i18n/src/text-rows.ts';
import { MAX_TRIES, parseReminderCallId, plannedTries, publishTextChanged, reminderCallId, tryNow, upsertReminderCall } from '@bw/outbox';
import { addDays, atLocal, formatTime, fromWire, localDateOf, Temporal, toWire, zoneAbbreviation } from '@bw/time';
import type { z } from 'zod';
import { csvCell } from './import.ts';
import type { ApiResult, Handler, Tx } from '../types.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

const refuse = (status: number, code: 'not_found' | 'rule_refused' | 'not_retryable' | 'already_on_call_list'): ApiResult<never> => ({ ok: false, status, code });
const instant = (d: Date): Temporal.Instant => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const wireOf = (d: Date, zone: string): string => toWire(instant(d), zone);

interface BranchRow { zone: string }
async function zoneOf(tx: Tx, branch: string): Promise<string | null> {
  return (await tx.query<BranchRow>('SELECT zone FROM world.branch WHERE id = $1', [branch])).rows[0]?.zone ?? null;
}

const TEXT_STATUS_FILTER: Record<string, string[]> = {
  queued: ['queued', 'sending'], held: ['held'], delivered: ['delivered'], retrying: ['retrying'], gave_up: ['gave_up'], canceled: ['canceled'],
};
const HANDLINGS = new Set(['confirmed', 'reschedule_sent', 'not_understood']);

interface Filters {
  date: string;
  branch: string;
  type?: string | undefined;
  status?: string | undefined;
  language?: string | undefined;
  customerId?: string | undefined;
  customer?: string | undefined;
}

/** The day's bounds in the branch zone, as ISO instants (the log's day is the branch's local day, CTL-OFC-08-03). */
function dayBounds(date: string, zone: string): { from: string; to: string } {
  return { from: atLocal(date, '00:00', zone, 'compatible').toString(), to: atLocal(addDays(date, 1), '00:00', zone, 'compatible').toString() };
}

/** The SQL conditions of the filters for the texts side (alias t, c) and the replies side (alias m, c), after the day and branch. */
function filterSql(f: Filters): { texts: string; replies: string; params: unknown[]; textsOn: boolean; repliesOn: boolean } {
  const params: unknown[] = [];
  const next = (v: unknown) => { params.push(v); return `$${3 + params.length}`; };
  let texts = '';
  let replies = '';
  let textsOn = true;
  let repliesOn = true;
  if (f.type === 'replies') textsOn = false;
  else if (f.type) { repliesOn = false; texts += ` AND t.kind = ${next(f.type)}`; }
  if (f.status) {
    if (HANDLINGS.has(f.status)) { textsOn = false; replies += ` AND m.handling = ${next(f.status)}`; }
    else { repliesOn = false; texts += ` AND t.status = ANY(${next(TEXT_STATUS_FILTER[f.status] ?? [])}::text[])`; }
  }
  if (f.language) { const p = next(f.language); texts += ` AND t.language = ${p}`; replies += ` AND c.text_language = ${p}`; }
  if (f.customerId) { const p = next(f.customerId); texts += ` AND t.customer_id = ${p}::uuid`; replies += ` AND m.customer_id = ${p}::uuid`; }
  const name = f.customer ? foldStreetName(f.customer) : '';
  if (name !== '') { const p = next(name); texts += ` AND strpos(c.name_search, ${p}) > 0`; replies += ` AND strpos(c.name_search, ${p}) > 0`; }
  return { texts, replies, params, textsOn, repliesOn };
}

interface TextDbRow {
  id: string; at: Date; customer_id: string; customer: string; kind: string; language: 'en' | 'es'; body: string; status: string; reason_key: string | null;
  held_until: Date | null; tries: number; next_try_at: Date | null; job_number: number | null; customer_zone: string; area: string;
  technician: string | null; visit_day: string | null; window_start: Date | null; window_end: Date | null; job_zone: string | null;
}
interface ReplyDbRow {
  id: string; at: Date; customer_id: string; customer: string; language: 'en' | 'es'; body: string; handling: string; job_number: number | null; area: string;
  technician: string | null; visit_day: string | null; window_start: Date | null; window_end: Date | null; job_zone: string | null;
}

const TEXT_SELECT = `SELECT t.id, t.created_at AS at, t.customer_id, c.name AS customer, t.kind, t.language, t.body, t.status, t.reason_key, t.held_until, t.tries,
         t.next_try_at, t.job_number, c.zone AS customer_zone, ${areaSql('s.city', 's.zip')} AS area, tech.name AS technician, j.date::text AS visit_day, j.window_start, j.window_end, j.zone AS job_zone
    FROM world.outbox_text t
    JOIN world.customer c ON c.id = t.customer_id
    JOIN world.street s ON s.id = c.street_id
    LEFT JOIN world.job j ON j.job_number = t.job_number
    LEFT JOIN world.technician tech ON tech.id = j.technician_id`;
const REPLY_SELECT = `SELECT m.id, m.at, m.customer_id, c.name AS customer, c.text_language AS language, m.body, m.handling, m.job_number, ${areaSql('s.city', 's.zip')} AS area,
         tech.name AS technician, j.date::text AS visit_day, j.window_start, j.window_end, j.zone AS job_zone
    FROM world.inbox_message m
    JOIN world.customer c ON c.id = m.customer_id
    JOIN world.street s ON s.id = c.street_id
    LEFT JOIN world.job j ON j.job_number = m.job_number
    LEFT JOIN world.technician tech ON tech.id = j.technician_id`;

type LogAnswer = Out<typeof textLog>;
type TextOut = LogAnswer['texts'][number];
type ReplyOut = LogAnswer['replies'][number];

const place = (r: TextDbRow | ReplyDbRow, zone: string, bookedAt: Date | null) => ({
  area: r.area,
  technician: r.technician,
  visitDay: r.visit_day,
  window: r.window_start && r.window_end && r.job_zone ? { start: wireOf(r.window_start, r.job_zone), end: wireOf(r.window_end, r.job_zone) } : null,
  bookedAt: bookedAt ? wireOf(bookedAt, zone) : null,
});

const textOut = (r: TextDbRow, zone: string): TextOut => ({
  id: r.id, at: wireOf(r.at, zone), customerId: r.customer_id, customer: r.customer, type: r.kind as TextOut['type'], language: r.language, body: r.body,
  status: r.status as TextOut['status'], reasonKey: r.reason_key, heldUntil: r.held_until ? wireOf(r.held_until, r.customer_zone) : null, tries: r.tries,
  nextTryAt: r.next_try_at ? wireOf(r.next_try_at, zone) : null, jobNumber: r.job_number,
  context: place(r, zone, r.kind === 'confirmation' && r.held_until !== null ? r.at : null),
});

const replyOut = (r: ReplyDbRow, zone: string): ReplyOut => ({
  id: r.id, at: wireOf(r.at, zone), customerId: r.customer_id, customer: r.customer, language: r.language, body: r.body, handling: r.handling as ReplyOut['handling'],
  jobNumber: r.job_number, context: place(r, zone, null),
});

interface Cursor { dir: 'o' | 'n'; at: string; id: string }
function parseCursor(raw: string | undefined): Cursor | null {
  const m = raw ? /^([on]):(\d{1,15}):([0-9a-f-]{36})$/.exec(raw) : null;
  return m ? { dir: m[1] as 'o' | 'n', at: new Date(Number(m[2])).toISOString(), id: m[3]! } : null;
}
const cursorOf = (dir: 'o' | 'n', row: { at: string; id: string }): string => `${dir}:${fromWire(row.at).epochMilliseconds}:${row.id}`;

/** The day's rows for the filters, newest first: the texts and replies merged by time (CTL-OFC-08-11), paged by a keyset cursor. */
async function logRows(tx: Tx, f: Filters, zone: string, page: { cursor: Cursor | null; limit: number | null }) {
  const { from, to } = dayBounds(f.date, zone);
  const fs = filterSql(f);
  const base = [f.branch, from, to, ...fs.params];
  const older = page.cursor?.dir === 'n' ? false : true;
  const after = page.cursor ? (c: string, alias: string) => ` AND (${alias}.${c}, ${alias}.id) ${older ? '<' : '>'} ($${base.length + 1}::timestamptz, $${base.length + 2}::uuid)` : () => '';
  const cur = page.cursor ? [page.cursor.at, page.cursor.id] : [];
  const order = older ? 'DESC' : 'ASC';
  const lim = page.limit === null ? '' : ` LIMIT ${page.limit + 1}`;
  const texts = fs.textsOn
    ? (await tx.query<TextDbRow>(
      `${TEXT_SELECT} WHERE c.branch_id = $1 AND t.created_at >= $2 AND t.created_at < $3${fs.texts}${after('created_at', 't')} ORDER BY t.created_at ${order}, t.id ${order}${lim}`,
      [...base, ...cur])).rows
    : [];
  const replies = fs.repliesOn
    ? (await tx.query<ReplyDbRow>(
      `${REPLY_SELECT} WHERE m.direction = 'in' AND c.branch_id = $1 AND m.at >= $2 AND m.at < $3${fs.replies}${after('at', 'm')} ORDER BY m.at ${order}, m.id ${order}${lim}`,
      [...base, ...cur])).rows
    : [];
  type Merged = { kind: 'text'; at: Date; id: string; row: TextDbRow } | { kind: 'reply'; at: Date; id: string; row: ReplyDbRow };
  const merged: Merged[] = [
    ...texts.map((row): Merged => ({ kind: 'text', at: row.at, id: row.id, row })),
    ...replies.map((row): Merged => ({ kind: 'reply', at: row.at, id: row.id, row })),
  ].sort((a, b) => (a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) * (older ? -1 : 1));
  return { merged, more: page.limit !== null && merged.length > page.limit };
}

/** The next-day totals for a date D (SPECIFICATIONS section 6.4, FR-TEXT-13): the text log's nextReminders (API-40) and the call list's dayTotals (API-42). */
export async function dayTotals(tx: Tx, branch: string, zone: string, date: string) {
  const visitDay = addDays(date, 1);
  const r = await tx.query<{ visits: number; texts: number }>(
    `SELECT count(*)::int AS visits, count(*) FILTER (WHERE c.mobile IS NOT NULL AND c.texts_on)::int AS texts
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id
      WHERE j.branch_id = $1 AND j.date = $2 AND j.status = 'scheduled'`, [branch, visitDay]);
  const visits = r.rows[0]?.visits ?? 0;
  const reminderTexts = r.rows[0]?.texts ?? 0;
  return { visitDay, visits, reminderTexts, at: toWire(atLocal(date, '18:00', zone, 'compatible'), zone), callListCount: visits - reminderTexts };
}

async function simulatorMode(tx: Tx): Promise<LogAnswer['simulatorMode']> {
  const r = await tx.query<{ mode: LogAnswer['simulatorMode'] }>('SELECT mode FROM world.text_simulator LIMIT 1');
  return r.rows[0]?.mode ?? 'up';
}

async function counts(tx: Tx, branch: string, zone: string, date: string): Promise<LogAnswer['counts']> {
  const { from, to } = dayBounds(date, zone);
  const t = await tx.query<Record<string, number>>(
    `SELECT count(*)::int AS texts,
            count(*) FILTER (WHERE t.status = 'delivered')::int AS delivered,
            count(*) FILTER (WHERE t.status = 'held')::int AS held,
            count(*) FILTER (WHERE t.status = 'retrying')::int AS failed_retrying,
            count(*) FILTER (WHERE t.status IN ('gave_up', 'canceled'))::int AS not_sent,
            count(*) FILTER (WHERE t.kind = 'confirmation' AND t.status <> 'canceled')::int AS confirmations,
            count(*) FILTER (WHERE t.kind = 'confirmation' AND t.delivered_at IS NOT NULL
                               AND t.delivered_at <= coalesce(t.held_until, t.due_at) + interval '1 minute')::int AS on_time
       FROM world.outbox_text t JOIN world.customer c ON c.id = t.customer_id
      WHERE c.branch_id = $1 AND t.created_at >= $2 AND t.created_at < $3`, [branch, from, to]);
  const r = await tx.query<Record<string, number>>(
    `SELECT count(*)::int AS replies,
            count(*) FILTER (WHERE m.handling = 'confirmed')::int AS confirmed,
            count(*) FILTER (WHERE m.handling = 'reschedule_sent')::int AS reschedule
       FROM world.inbox_message m JOIN world.customer c ON c.id = m.customer_id
      WHERE m.direction = 'in' AND c.branch_id = $1 AND m.at >= $2 AND m.at < $3`, [branch, from, to]);
  const g = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM world.outbox_text t JOIN world.customer c ON c.id = t.customer_id
      WHERE c.branch_id = $1 AND t.status = 'gave_up'
        AND (SELECT max(a.at) FROM world.text_attempt a WHERE a.text_id = t.id) >= $2
        AND (SELECT max(a.at) FROM world.text_attempt a WHERE a.text_id = t.id) < $3`, [branch, from, to]);
  const a = t.rows[0]!;
  const b = r.rows[0]!;
  return {
    texts: a.texts!, delivered: a.delivered!, held: a.held!, failedRetrying: a.failed_retrying!, notSent: a.not_sent!, replies: b.replies!,
    confirmations: a.confirmations!, confirmationsOnTime: a.on_time!, repliesConfirmed: b.confirmed!, repliesReschedule: b.reschedule!, gaveUp: g.rows[0]?.n ?? 0,
  };
}

export const textLogHandler: Handler<LogAnswer> = async (req, tx) => {
  const p = req.params as In<typeof textLog>;
  const zone = await zoneOf(tx, p.branch);
  if (zone === null) return refuse(404, 'not_found');
  const limit = p.limit ?? 50;
  const cursor = parseCursor(p.cursor);
  const { merged, more } = await logRows(tx, p, zone, { cursor, limit });
  const olderQuery = cursor?.dir !== 'n';
  let page = merged.slice(0, limit);
  if (!olderQuery) page = page.reverse(); // an ascending read for the newer page: show newest first
  const rows = page.map((m) => ({ at: wireOf(m.at, zone), id: m.id }));
  const first = rows[0];
  const last = rows[rows.length - 1];
  const cursors = !first || !last
    ? { newer: null, older: null }
    : olderQuery
      ? { newer: cursor ? cursorOf('n', first) : null, older: more ? cursorOf('o', last) : null }
      : { newer: more ? cursorOf('n', first) : null, older: cursorOf('o', last) };
  const fs = filterSql(p);
  const { from, to } = dayBounds(p.date, zone);
  const nText = fs.textsOn
    ? (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM world.outbox_text t JOIN world.customer c ON c.id = t.customer_id
        WHERE c.branch_id = $1 AND t.created_at >= $2 AND t.created_at < $3${fs.texts}`, [p.branch, from, to, ...fs.params])).rows[0]!.n
    : 0;
  const nReply = fs.repliesOn
    ? (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM world.inbox_message m JOIN world.customer c ON c.id = m.customer_id
        WHERE m.direction = 'in' AND c.branch_id = $1 AND m.at >= $2 AND m.at < $3${fs.replies}`, [p.branch, from, to, ...fs.params])).rows[0]!.n
    : 0;
  const data: LogAnswer = {
    asOf: toWire(req.demoNow, zone),
    texts: page.flatMap((m) => (m.kind === 'text' ? [textOut(m.row, zone)] : [])),
    replies: page.flatMap((m) => (m.kind === 'reply' ? [replyOut(m.row, zone)] : [])),
    counts: await counts(tx, p.branch, zone, p.date),
    nextReminders: await dayTotals(tx, p.branch, zone, p.date),
    simulatorMode: await simulatorMode(tx),
    total: nText + nReply,
    cursors,
  };
  return { ok: true, status: 200, data };
};

// API-146 ------------------------------------------------------------------------------------------------------------

/** The words a row is written in: the page's own formatter and time helpers (zone words from the catalog, falling back to the city). */
function wordsFor(lang: 'en' | 'es', zone: string): { t: RowT; w: TimeWords } {
  const t = formatterFor(lang);
  const w: TimeWords = {
    clock: clockOfWire,
    hourWord: hourWordOfWire,
    branchClock: (wire) => `${formatTime(fromWire(wire).toInstant(), zone, lang)} ${zoneAbbreviation(fromWire(wire).toInstant(), zone)}`,
    zoneWord: (z) => {
      try { return t(`msg.zone.${z}` as never); } catch { return z.split('/').pop()!.replace(/_/g, ' '); }
    },
  };
  return { t, w };
}

const statusFactsOf = (r: TextOut, zone: string): StatusFacts => ({
  status: r.status, heldUntil: r.heldUntil, tries: r.tries, nextTryAt: r.nextTryAt, customerZone: r.heldUntil ? fromWire(r.heldUntil).timeZoneId : zone,
  otherZone: r.heldUntil ? fromWire(r.heldUntil).timeZoneId !== zone : false,
});

const textLogExportHandler: Handler<string> = async (req, tx) => {
  const p = req.params as In<typeof textLogExport>;
  const zone = await zoneOf(tx, p.branch);
  if (zone === null) return refuse(404, 'not_found');
  const lang = p.lang ?? 'en';
  const { t, w } = wordsFor(lang, zone);
  const { merged } = await logRows(tx, p, zone, { cursor: null, limit: null });
  const header = (['time', 'customer', 'type', 'language', 'text', 'status'] as const).map((k) => t(`msg.csv.${k}` as never));
  const lines = merged.map((m) => {
    if (m.kind === 'reply') {
      const r = replyOut(m.row, zone);
      return [clockOfWire(r.at), r.customer, typeText('replies', t), languageText(r.language, t), r.body, handlingChip(r.handling, t).label];
    }
    const r = textOut(m.row, zone);
    return [clockOfWire(r.at), r.customer, typeText(r.type, t), languageText(r.language, t), r.body, statusLine(statusFactsOf(r, zone), t, w)];
  });
  // A byte order mark first, so a spreadsheet reads the UTF-8 accents; CRLF between rows; the file is named
  // <kind>-<branch>-<yyyy-mm-dd>.csv by demo date in the branch zone, as billing and jobs are (SPECIFICATIONS 7.5, F-599, F-654).
  return {
    ok: true, status: 200, data: `﻿${[header, ...lines].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
    fileName: `text-log-${p.branch}-${localDateOf(req.demoNow, zone)}.csv`,
  };
};

// API-41 ------------------------------------------------------------------------------------------------------------

interface DetailDbRow {
  id: string; kind: string; customer_id: string; customer: string; language: 'en' | 'es'; encoding: 'gsm7' | 'ucs2'; body: string; status: string;
  reason_key: string | null; held_until: Date | null; tries: number; next_try_at: Date | null; job_number: number | null; sent_by_name: string | null;
  customer_zone: string; mobile: string | null; home_phone: string | null; branch_id: string;
}

async function attemptsOf(tx: Tx, textId: string, zone: string) {
  const r = await tx.query<{ number: number; at: Date; result: 'delivered' | 'failed'; reason: string | null }>(
    'SELECT number, at, result, reason FROM world.text_attempt WHERE text_id = $1 ORDER BY number', [textId]);
  return r.rows.map((a) => ({ number: a.number, at: wireOf(a.at, zone), result: a.result, reasonKey: a.reason === null ? null : `text_attempt.${a.reason}` }));
}

const textDetailHandler: Handler<Out<typeof textDetail>> = async (req, tx) => {
  const { textId } = req.params as In<typeof textDetail>;
  const r = await tx.query<DetailDbRow>(
    `SELECT t.id, t.kind, t.customer_id, c.name AS customer, t.language, t.encoding, t.body, t.status, t.reason_key, t.held_until, t.tries, t.next_try_at,
            t.job_number, u.name AS sent_by_name, c.zone AS customer_zone, c.mobile, c.home_phone, c.branch_id
       FROM world.outbox_text t JOIN world.customer c ON c.id = t.customer_id LEFT JOIN world."user" u ON u.id = t.sent_by
      WHERE t.id = $1`, [textId]);
  const t = r.rows[0];
  if (!t) return refuse(404, 'not_found');
  const zone = (await zoneOf(tx, t.branch_id)) ?? t.customer_zone;
  const attempts = await attemptsOf(tx, t.id, zone);
  const due = t.status === 'retrying'
    ? (await tx.query(`SELECT 1 FROM world.scheduled_event WHERE kind = 'text.try' AND subject = $1 AND state = 'due'`, [t.id])).rows.length > 0
    : false;
  const first = attempts[0] ? fromWire(attempts[0].at).toInstant() : null;
  const planned = t.status === 'retrying' && first ? plannedTries(first, t.tries + 1, t.customer_zone, t.kind) : [];
  const onList = await tx.query<{ by: string | null; at: Date }>(
    `SELECT u.name AS by, e.added_at AS at FROM world.call_list_entry e LEFT JOIN world."user" u ON u.id = e.added_by WHERE e.text_id = $1 ORDER BY e.added_at LIMIT 1`, [t.id]);
  let job: Out<typeof textDetail>['job'] = null;
  if (t.job_number !== null) {
    const j = await tx.query<{ job_number: number; service_id: string; area: string; date: string; window_start: Date; window_end: Date; zone: string;
      technician: string | null; booked_via: 'online' | 'office' | 'seed'; booked_at: Date; booked_by_name: string | null }>(
      `SELECT j.job_number, j.service_id, ${areaSql('s.city', 's.zip')} AS area, j.date::text AS date, j.window_start, j.window_end, j.zone, tech.name AS technician,
              j.booked_via, j.booked_at, bu.name AS booked_by_name
         FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street s ON s.id = c.street_id
         LEFT JOIN world.technician tech ON tech.id = j.technician_id LEFT JOIN world."user" bu ON bu.id = j.booked_by
        WHERE j.job_number = $1`, [t.job_number]);
    const x = j.rows[0];
    if (x) {
      job = {
        jobNumber: x.job_number, service: x.service_id, area: x.area, day: x.date, window: { start: wireOf(x.window_start, x.zone), end: wireOf(x.window_end, x.zone) },
        technician: x.technician, bookedVia: x.booked_via, bookedAt: wireOf(x.booked_at, zone), bookedBy: x.booked_by_name,
      };
    }
  }
  const mobile = t.mobile ?? null;
  return {
    ok: true, status: 200,
    data: {
      id: t.id, type: t.kind as Out<typeof textDetail>['type'], customerId: t.customer_id, customer: t.customer, language: t.language, encoding: t.encoding, body: t.body,
      status: t.status as Out<typeof textDetail>['status'], reasonKey: t.reason_key, heldUntil: t.held_until ? wireOf(t.held_until, t.customer_zone) : null, attempts,
      sentBy: t.sent_by_name, canTryNow: due && t.tries < MAX_TRIES, nextTryAt: t.next_try_at ? wireOf(t.next_try_at, zone) : null,
      plannedTries: planned.map((x) => ({ number: x.number, at: toWire(x.at, zone) })),
      onCallList: onList.rows[0] ? { by: onList.rows[0].by, at: wireOf(onList.rows[0].at, zone) } : null,
      job,
      customerContact: { phone: mobile ?? t.home_phone, mobileEnd: mobile ? mobile.replace(/\D/g, '').slice(-4) : null, zone: t.customer_zone },
    },
  };
};

// API-144 and API-145 -----------------------------------------------------------------------------------------------

const tryTextNowHandler: Handler<Out<typeof tryTextNow>> = async (req, tx) => {
  const { textId } = req.params as In<typeof tryTextNow>;
  if (req.caller.kind !== 'staff') throw new Error('an office write reached its handler without a signed-in caller');
  const exists = await tx.query<{ branch_id: string }>(
    'SELECT c.branch_id FROM world.outbox_text t JOIN world.customer c ON c.id = t.customer_id WHERE t.id = $1', [textId]);
  const branch = exists.rows[0]?.branch_id;
  if (!branch) return refuse(404, 'not_found');
  const out = await tryNow(tx, { textId, by: req.caller.userId, now: req.demoNow });
  if (!out.ok) return refuse(409, 'not_retryable');
  const zone = (await zoneOf(tx, branch)) ?? 'America/New_York';
  const row = (await tx.query<{ status: string; customer_zone: string; next_try_at: Date | null }>(
    'SELECT t.status, c.zone AS customer_zone, t.next_try_at FROM world.outbox_text t JOIN world.customer c ON c.id = t.customer_id WHERE t.id = $1', [textId])).rows[0]!;
  return {
    ok: true, status: 200,
    data: {
      text: {
        id: textId, status: row.status as Out<typeof tryTextNow>['text']['status'], attempts: (await attemptsOf(tx, textId, zone)).map(({ number, at, result }) => ({ number, at, result })),
        heldUntil: out.heldUntil ? toWire(out.heldUntil, row.customer_zone) : null, nextTryAt: row.next_try_at ? wireOf(row.next_try_at, zone) : null,
      },
    },
  };
};

const addToCallListHandler: Handler<Out<typeof addToCallList>> = async (req, tx) => {
  const { textId } = req.params as In<typeof addToCallList>;
  if (req.caller.kind !== 'staff') throw new Error('an office write reached its handler without a signed-in caller');
  const r = await tx.query<{ status: string; customer_id: string; job_number: number | null; branch_id: string; zone: string }>(
    `SELECT t.status, t.customer_id, t.job_number, c.branch_id, b.zone
       FROM world.outbox_text t JOIN world.customer c ON c.id = t.customer_id JOIN world.branch b ON b.id = c.branch_id
      WHERE t.id = $1 FOR UPDATE OF t`, [textId]);
  const t = r.rows[0];
  if (!t) return refuse(404, 'not_found');
  // CTL-OFC-08-19: a Failed (retrying) or Not sent (gave up) text, about a visit (a call list row needs one).
  if ((t.status !== 'retrying' && t.status !== 'gave_up') || t.job_number === null) return refuse(409, 'rule_refused');
  if ((await tx.query('SELECT 1 FROM world.call_list_entry WHERE text_id = $1', [textId])).rows.length > 0) return refuse(409, 'already_on_call_list');
  const callDate = localDateOf(req.demoNow, t.zone);
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO world.call_list_entry (branch_id, call_date, customer_id, job_number, text_id, reason, added_by, added_at)
     VALUES ($1, $2, $3, $4, $5, 'added_by_office', $6, $7) RETURNING id`,
    [t.branch_id, callDate, t.customer_id, t.job_number, textId, req.caller.userId, req.demoNow.toString()]);
  await publishTextChanged(tx, { textId, customerId: t.customer_id, jobNumber: t.job_number, branch: t.branch_id });
  const who = await tx.query<{ name: string }>('SELECT name FROM world."user" WHERE id = $1', [req.caller.userId]);
  return { ok: true, status: 201, data: { entry: { id: ins.rows[0]!.id, by: who.rows[0]?.name ?? null, at: toWire(req.demoNow, t.zone) } } };
};

// API-42 and API-38 -------------------------------------------------------------------------------------------------

interface EntryDbRow {
  /** Null for a listed visit whose row is not written yet (its entryId is reminderCallId). */
  id: string | null; reason: string; customer_id: string; customer: string; area: string; phone: string | null; language: 'en' | 'es';
  job_number: number; job_date: string; window_start: Date; window_end: Date; job_zone: string; service_id: string; job_status: string;
  technician: string | null; name_in_texts: string | null; outcome: string | null; outcome_by_name: string | null; outcome_at: Date | null;
  text_id: string | null; text_kind: string | null; added_by_name: string | null; added_at: Date | null; failed_at: Date | null;
}

const callListHandler: Handler<Out<typeof callList>> = async (req, tx) => {
  const p = req.params as In<typeof callList>;
  const zone = await zoneOf(tx, p.branch);
  if (zone === null) return refuse(404, 'not_found');
  // FR-TEXT-13 (F-651): the reminder calls for date D are the next day's live visits whose customer has no mobile or texts
  // off, all day: before the 6:00 PM reminder event has written their rows too. Each visit is joined to its row for D when
  // there is one (the outcome, with who and when); a row whose visit has since left D + 1 stays listed only with an outcome
  // (a call made: CTL-OFC-09-05's Reschedule moves the visit away). A visit with no row yet has the id its row will get.
  const r = await tx.query<EntryDbRow>(
    `WITH listed AS (
       SELECT e.id, e.reason, e.customer_id, e.job_number, e.text_id, e.added_by, e.added_at, e.outcome, e.outcome_by, e.outcome_at
         FROM world.call_list_entry e JOIN world.job j ON j.job_number = e.job_number
        WHERE e.branch_id = $1 AND e.call_date = $2
          AND (e.reason NOT IN ('no_mobile', 'texts_off') OR e.outcome IS NOT NULL OR (j.status = 'scheduled' AND j.date = $3))
     ), due AS (
       SELECT NULL::uuid AS id, CASE WHEN c.texts_on THEN 'no_mobile' ELSE 'texts_off' END AS reason, j.customer_id, j.job_number,
              NULL::uuid AS text_id, NULL::uuid AS added_by, NULL::timestamptz AS added_at, NULL::text AS outcome, NULL::uuid AS outcome_by,
              NULL::timestamptz AS outcome_at
         FROM world.job j JOIN world.customer c ON c.id = j.customer_id
        WHERE j.branch_id = $1 AND j.date = $3 AND j.status = 'scheduled' AND (c.mobile IS NULL OR NOT c.texts_on)
          AND NOT EXISTS (SELECT 1 FROM world.call_list_entry x
                           WHERE x.job_number = j.job_number AND x.call_date = $2 AND x.reason IN ('no_mobile', 'texts_off'))
     )
     SELECT e.id, e.reason, e.customer_id, c.name AS customer, ${areaSql('s.city', 's.zip')} AS area, coalesce(c.mobile, c.home_phone) AS phone,
            c.text_language AS language, e.job_number, j.date::text AS job_date, j.window_start, j.window_end, j.zone AS job_zone, j.service_id, j.status AS job_status,
            tech.name AS technician, tech.name_in_texts, e.outcome, ou.name AS outcome_by_name, e.outcome_at, e.text_id, ot.kind AS text_kind,
            au.name AS added_by_name, e.added_at,
            (SELECT max(a.at) FROM world.text_attempt a WHERE a.text_id = e.text_id AND a.result = 'failed') AS failed_at
       FROM (SELECT * FROM listed UNION ALL SELECT * FROM due) e
       JOIN world.customer c ON c.id = e.customer_id
       JOIN world.street s ON s.id = c.street_id
       JOIN world.job j ON j.job_number = e.job_number
       LEFT JOIN world.technician tech ON tech.id = j.technician_id
       LEFT JOIN world."user" ou ON ou.id = e.outcome_by
       LEFT JOIN world."user" au ON au.id = e.added_by
       LEFT JOIN world.outbox_text ot ON ot.id = e.text_id
      ORDER BY j.window_start, c.name, e.job_number, e.id`, [p.branch, p.date, addDays(p.date, 1)]);
  const person = (e: EntryDbRow) => ({
    entryId: e.id ?? reminderCallId(e.job_number, p.date), customerId: e.customer_id, customer: e.customer, area: e.area, phone: e.phone, language: e.language,
    visit: {
      jobNumber: e.job_number, day: e.job_date, window: { start: wireOf(e.window_start, e.job_zone), end: wireOf(e.window_end, e.job_zone) },
      service: e.service_id, technician: e.technician, technicianInTexts: e.name_in_texts, jobStatus: e.job_status,
    },
    outcome: e.outcome ? { kind: e.outcome as 'confirmed' | 'no_answer' | 'reschedule', by: e.outcome_by_name, at: wireOf(e.outcome_at!, zone) } : null,
  });
  const reminderRows = r.rows.filter((e) => e.reason === 'no_mobile' || e.reason === 'texts_off');
  const failedRows = r.rows.filter((e) => e.reason === 'text_gave_up' || e.reason === 'added_by_office');
  const reminderCalls = reminderRows.map((e) => ({ ...person(e), reason: e.reason as 'no_mobile' | 'texts_off' }));
  const failedTexts = failedRows.map((e) => ({
    ...person(e), reason: e.reason as 'text_gave_up' | 'added_by_office', textId: e.text_id, textType: e.text_kind as Out<typeof callList>['failedTexts'][number]['textType'],
    failedAt: e.reason === 'text_gave_up' && e.failed_at ? wireOf(e.failed_at, zone) : null,
    addedBy: e.reason === 'added_by_office' ? e.added_by_name : null, addedAt: e.reason === 'added_by_office' && e.added_at ? wireOf(e.added_at, zone) : null,
  }));
  const rows = r.rows;
  const kind = (k: string) => rows.filter((e) => e.outcome === k).length;
  return {
    ok: true, status: 200,
    data: {
      asOf: toWire(req.demoNow, zone), reminderCalls, failedTexts,
      progress: { total: rows.length, called: rows.filter((e) => e.outcome !== null).length, confirmed: kind('confirmed'), reschedule: kind('reschedule'), noAnswer: kind('no_answer') },
      count: rows.filter((e) => e.outcome === null).length,
      dayTotals: await dayTotals(tx, p.branch, zone, p.date),
    },
  };
};

const recordCallOutcomeHandler: Handler<Out<typeof recordCallOutcome>> = async (req, tx) => {
  const p = req.params as In<typeof recordCallOutcome>;
  if (req.caller.kind !== 'staff') throw new Error('an office write reached its handler without a signed-in caller');
  let e = (await tx.query<{ id: string; outcome: string | null; added_at: Date; branch_id: string }>(
    `SELECT id, outcome, added_at, branch_id FROM world.call_list_entry
      WHERE job_number = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY added_at DESC, id DESC LIMIT 1 FOR UPDATE`, [p.jobNumber, p.entryId ?? null])).rows[0];
  // A listed visit with no row yet (F-651: API-42 lists the next day's no-mobile and texts-off visits before the 6:00 PM
  // event writes their rows): its first outcome writes the row, under the id the list gave it.
  const made = e ? null : await writeListedReminderCall(tx, p, req.demoNow);
  if (made) {
    e = (await tx.query<{ id: string; outcome: string | null; added_at: Date; branch_id: string }>(
      'SELECT id, outcome, added_at, branch_id FROM world.call_list_entry WHERE id = $1 FOR UPDATE', [made])).rows[0];
  }
  if (!e) return refuse(404, 'not_found');
  const job = (await tx.query<{ status: string; version: number; confirmed_at: Date | null; branch_id: string; zone: string }>(
    `SELECT j.status, j.version, j.confirmed_at, j.branch_id, b.zone FROM world.job j JOIN world.branch b ON b.id = j.branch_id WHERE j.job_number = $1 FOR UPDATE OF j`, [p.jobNumber])).rows[0];
  if (!job) return refuse(404, 'not_found');
  // UD-53: a Confirmed or Reschedule outcome is never turned into No answer; the others replace the recorded one.
  if (p.outcome === 'no_answer' && (e.outcome === 'confirmed' || e.outcome === 'reschedule')) return refuse(409, 'rule_refused');
  if (p.outcome === 'confirmed' && job.status !== 'scheduled') return refuse(409, 'rule_refused');
  if (p.outcome === 'reschedule') {
    // Recorded only after API-24 has moved the visit (SPECIFICATIONS 6.4): a rescheduled change at or after the row was put on the list.
    const moved = await tx.query(`SELECT 1 FROM world.job_change WHERE job_number = $1 AND kind = 'rescheduled' AND at >= $2 LIMIT 1`, [p.jobNumber, e.added_at]);
    if (moved.rows.length === 0 || job.status !== 'scheduled') return refuse(409, 'rule_refused');
  }
  const at = req.demoNow;
  await tx.query('UPDATE world.call_list_entry SET outcome = $2, outcome_by = $3, outcome_at = $4 WHERE id = $1', [e.id, p.outcome, req.caller.userId, at.toString()]);
  let confirmedAt: string | null = job.confirmed_at ? wireOf(job.confirmed_at, job.zone) : null;
  if (p.outcome === 'confirmed' && job.confirmed_at === null) {
    await tx.query('UPDATE world.job SET confirmed_at = $2 WHERE job_number = $1', [p.jobNumber, at.toString()]);
    confirmedAt = toWire(at, job.zone);
  }
  await tx.query(
    `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
     VALUES ($1, $2, $3, 'office', 'call_outcome', $4, $4, $5::jsonb)`,
    [p.jobNumber, at.toString(), req.caller.userId, job.version, JSON.stringify({ outcome: p.outcome, entryId: e.id })]);
  await publishEvent(tx, 'job.changed', { jobNumber: p.jobNumber, branch: job.branch_id });
  const who = await tx.query<{ name: string }>('SELECT name FROM world."user" WHERE id = $1', [req.caller.userId]);
  return { ok: true, status: 200, data: { outcome: { kind: p.outcome, by: who.rows[0]?.name ?? null, at: toWire(at, job.zone) }, confirmedAt } };
};

/**
 * The row of a reminder call API-42 listed before it was written: `entryId` is its reminderCallId (required, and its call
 * date must be today in the branch zone: F-686). Written only for a customer with no mobile or texts off whose visit is the live visit of
 * the day after the call date, or, for Reschedule (CTL-OFC-20-03: recorded after API-24 moved the visit), was; the outcome's
 * own rules then run on the row as on any other. Its added_at is the start of the call date in the branch zone (the visit
 * was on that day's list from its start), or now when that is earlier. A refused outcome rolls the row back with it.
 */
async function writeListedReminderCall(tx: Tx, p: In<typeof recordCallOutcome>, now: Temporal.Instant): Promise<string | null> {
  // F-686: a row with no entry is written only under the id API-42 gave (no id: nothing to write), and only for the call date that is today.
  const key = p.entryId === undefined ? null : parseReminderCallId(p.entryId);
  if (key === null || key.jobNumber !== p.jobNumber) return null;
  const j = (await tx.query<{ date: string; status: string; branch_id: string; customer_id: string; texts_on: boolean; mobile: string | null; zone: string }>(
    `SELECT j.date::text AS date, j.status, j.branch_id, j.customer_id, c.texts_on, c.mobile, b.zone
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.branch b ON b.id = j.branch_id WHERE j.job_number = $1`,
    [p.jobNumber])).rows[0];
  if (!j || (j.texts_on && j.mobile !== null)) return null;
  const callDate = key.callDate;
  if (callDate !== localDateOf(now, j.zone)) return null;
  const listed = j.status === 'scheduled' && j.date === addDays(callDate, 1);
  if (!listed && p.outcome !== 'reschedule') return null;
  const dayStart = atLocal(callDate, '00:00', j.zone, 'compatible');
  return upsertReminderCall(tx, {
    branchId: j.branch_id, callDate, customerId: j.customer_id, jobNumber: p.jobNumber, reason: j.texts_on ? 'no_mobile' : 'texts_off',
    addedAt: Temporal.Instant.compare(now, dayStart) < 0 ? now : dayStart,
  });
}

export function messagesHandlers() {
  return {
    'API-38': recordCallOutcomeHandler as Handler<unknown>,
    'API-40': textLogHandler as Handler<unknown>,
    'API-41': textDetailHandler as Handler<unknown>,
    'API-42': callListHandler as Handler<unknown>,
    'API-144': tryTextNowHandler as Handler<unknown>,
    'API-145': addToCallListHandler as Handler<unknown>,
    'API-146': textLogExportHandler as Handler<unknown>,
  };
}
