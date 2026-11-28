// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing read handlers (UI-SPECIFICATION 12.2 API-60, API-65, API-66, API-67, API-159; SPECIFICATIONS section 6.6 FR-BILL-2,
// FR-BILL-4, FR-BILL-5, FR-BILL-12). API-60 and API-159 read the world (the queue, through bw-worker's billingList, and the names
// around it); API-65 to API-67 read the pretend billing service over HTTP (FR-BILL-4: never a direct database call), and add the
// names the world holds (the technician, who entered or set).
import type { billingExport as exportRow, billingQueue as queueRow, pbsInvoice as invoiceRow, pbsInvoices as invoicesRow, pbsMode as modeRow } from '@bw/api';
import { areaSql, BILLING_EVENT_KINDS, lineWordsOf } from '@bw/domain';
import { leftChipText, leftHowText, leftReasonText, waitingReasonText } from '@bw/i18n/src/billing-rows.ts';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { fromWire, Temporal, toWire } from '@bw/time';
import { BillingUnavailableError, billingList, type BillingClient } from 'bw-worker/billing';
import type { z } from 'zod';
import type { ApiResult, Handler, HandlerContext, Tx } from '../types.ts';
import { pbsClientFor } from './billing.ts';
import { csvCell } from './import.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;
type Queue = Out<typeof queueRow>;

const refuse = (code: 'not_found'): ApiResult<never> => ({ ok: false, status: 404, code });

/** The most invoices counted for "Showing 7 of 41": pbs keeps a demo's few dozen, never thousands. */
const COUNT_PAGES_MAX = 40;

interface BranchRow { zone: string }

async function zoneOf(tx: Tx, branch: string): Promise<string | null> {
  return (await tx.query<BranchRow>('SELECT zone FROM world.branch WHERE id = $1', [branch])).rows[0]?.zone ?? null;
}

interface JobRow {
  job_number: number;
  customer: string;
  area: string;
  service_id: string;
  technician: string | null;
  ended_at: Date | null;
  zone: string;
}

export async function jobRows(tx: Tx, numbers: number[]): Promise<Map<number, JobRow>> {
  if (numbers.length === 0) return new Map();
  const r = await tx.query<JobRow>(
    `SELECT j.job_number, c.name AS customer, ${areaSql('s.city', 's.zip')} AS area, j.service_id, t.name AS technician, j.ended_at, j.zone
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street s ON s.id = c.street_id
       LEFT JOIN world.technician t ON t.id = j.technician_id
      WHERE j.job_number = ANY($1::int[])`, [numbers]);
  return new Map(r.rows.map((x) => [x.job_number, x]));
}

interface AttemptRow { job_number: number; result: string; reason: string | null; at: Date }

/** The latest failed try of each job: why it was listed (billing_attempt.result: timeout, down or data_error). */
export async function lastFailures(tx: Tx, numbers: number[]): Promise<Map<number, AttemptRow>> {
  if (numbers.length === 0) return new Map();
  const r = await tx.query<AttemptRow>(
    `SELECT DISTINCT ON (job_number) job_number, result, reason, at FROM world.billing_attempt
      WHERE job_number = ANY($1::int[]) AND result <> 'success' ORDER BY job_number, number DESC`, [numbers]);
  return new Map(r.rows.map((x) => [x.job_number, x]));
}

/** Who sent again or corrected a job: the latest such change's actor (job_change kinds sent_again and finish_corrected). */
async function lastActors(tx: Tx, numbers: number[]): Promise<Map<number, string>> {
  if (numbers.length === 0) return new Map();
  const r = await tx.query<{ job_number: number; name: string | null }>(
    `SELECT DISTINCT ON (c.job_number) c.job_number, u.name FROM world.job_change c LEFT JOIN world."user" u ON u.id = c.actor_user_id
      WHERE c.job_number = ANY($1::int[]) AND c.kind IN ('sent_again', 'finish_corrected') ORDER BY c.job_number, c.at DESC`, [numbers]);
  return new Map(r.rows.flatMap((x) => (x.name === null ? [] : [[x.job_number, x.name] as const])));
}

async function namesOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const uuids = ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (uuids.length === 0) return new Map();
  const r = await tx.query<{ id: string; name: string }>('SELECT id, name FROM world."user" WHERE id = ANY($1::uuid[])', [uuids]);
  return new Map(r.rows.map((x) => [x.id, x.name]));
}

/**
 * The jobs billing's give-up ended (F-2119): the billing lane ends a billing event that failed MAX_HANDLER_FAILURES runs as skipped with
 * the result handler_failed (apps/worker/src/billing/link.ts billingGiveUp), and no other billing writer ends one that way. That event row is
 * history: a later Mark fixed, Send again or Correct the finish retires only the events still due, and a success clears reason_key, so
 * the row says "billing gave up on this job" long after the item's own columns do. Read from it, so no column or migration is needed.
 */
export async function givenUpJobs(tx: Tx, numbers: number[]): Promise<Map<number, Date>> {
  if (numbers.length === 0) return new Map();
  const r = await tx.query<{ subject: string; at: Date }>(
    `SELECT subject, max(run_at) AS at FROM world.scheduled_event
      WHERE kind = ANY($1::text[]) AND state = 'skipped' AND result = 'handler_failed' AND subject = ANY($2::text[]) GROUP BY subject`,
    [BILLING_EVENT_KINDS, numbers.map(String)]);
  return new Map(r.rows.map((x) => [Number(x.subject), x.at]));
}

const REASON_KINDS = new Set(['timeout', 'down', 'data_error']);
/**
 * The reason kind of a listed job (API-60, read by the page, the export API-159 and the health card API-70): the latest event wins. A give-up
 * (its event's run_at) at or after the latest failed try's time is gave_up, even when earlier tries timed out (F-2122: nothing retries after
 * it); a failed try after the give-up (a Send again that failed again) is that try's kind; a give-up with no try written reads gave_up (24790);
 * a job still on its first try is none.
 */
export function reasonKindOf(a: AttemptRow | undefined, gaveUpAt: Date | undefined): Queue['items'][number]['reasonKind'] {
  const tried = a && REASON_KINDS.has(a.result) ? (a.result as 'timeout' | 'down' | 'data_error') : null;
  if (gaveUpAt === undefined) return tried;
  return a === undefined || tried === null || gaveUpAt.getTime() >= a.at.getTime() ? 'gave_up' : tried;
}

/** Today's local date bounds in the branch zone, as instants. */
function dayBounds(now: Temporal.Instant, zone: string): { from: string; to: string } {
  const day = now.toZonedDateTimeISO(zone).startOfDay();
  return { from: day.toInstant().toString(), to: day.add({ days: 1 }).toInstant().toString() };
}

/**
 * The billing link card's counts (CTL-OFC-10-12; UI-SPECIFICATION 12.4 "API-60 and API-70 finishedToday, inBillingToday"; SPECIFICATIONS
 * section 6.6): the branch's jobs with status done whose ended_at falls on the demo clock's today in the branch zone, and of them those
 * whose job.billing_state is in_billing or marked_fixed. A No one home visit is not done; a job finished yesterday and sent today is not
 * one of today's; a job marked fixed today is in billing. API-70 states the same computation, so it is exported for it.
 */
export async function billingToday(tx: Tx, input: { branch: string; zone: string; now: Temporal.Instant }): Promise<{ finishedToday: number; inBillingToday: number }> {
  const { from, to } = dayBounds(input.now, input.zone);
  const r = await tx.query<{ finished: number; in_billing: number }>(
    `SELECT count(*)::int AS finished, count(*) FILTER (WHERE billing_state IN ('in_billing', 'marked_fixed'))::int AS in_billing
       FROM world.job WHERE branch_id = $1 AND status = 'done' AND ended_at >= $2 AND ended_at < $3`, [input.branch, from, to]);
  return { finishedToday: r.rows[0]?.finished ?? 0, inBillingToday: r.rows[0]?.in_billing ?? 0 };
}

async function queueOf(tx: Tx, ctx: HandlerContext, pbs: BillingClient, branch: string, now: Temporal.Instant): Promise<Queue | null> {
  const zone = await zoneOf(tx, branch);
  if (zone === null) return null;
  const { waiting, leftLast7Days } = await billingList(tx, { branchId: branch, now });
  const numbers = [...waiting.map((w) => w.jobNumber), ...leftLast7Days.map((l) => l.jobNumber)];
  // F-886: 1 query at a time on the call's client.
  const jobs = await jobRows(tx, numbers);
  const failures = await lastFailures(tx, numbers);
  const gaveUp = await givenUpJobs(tx, numbers);
  const actors = await lastActors(tx, numbers);
  const fixers = await namesOf(tx, leftLast7Days.flatMap((l) => (l.leftBy === null ? [] : [l.leftBy])));
  const wire = (iso: string) => toWire(Temporal.Instant.from(iso), zone);

  const counts = await billingToday(tx, { branch, zone, now });
  const lastSent = (await tx.query<{ last_sent: Date | null }>(
    `SELECT max(a.at) AS last_sent FROM world.billing_attempt a JOIN world.job j USING (job_number)
      WHERE j.branch_id = $1 AND a.result = 'success' AND a.at <= $2`, [branch, now.toString()])).rows[0]?.last_sent ?? null;

  // The mode read is the card's Up / Down chip; pbs not answering is "cannot tell" (null), never an error page.
  const mode = await pbs.getMode().then((m) => m.mode, () => null);

  return {
    asOf: toWire(now, zone),
    link: {
      mode, lastSentAt: lastSent ? wire(lastSent.toISOString()) : null, ...counts,
    },
    items: waiting.map((w) => {
      const j = jobs.get(w.jobNumber);
      const f = failures.get(w.jobNumber);
      const kind = reasonKindOf(f, w.state === 'waiting_person' ? gaveUp.get(w.jobNumber) : undefined);
      return {
        jobNumber: w.jobNumber, customer: j?.customer ?? '', area: j?.area ?? '', service: j?.service_id ?? '', technician: j?.technician ?? null,
        doneAt: j?.ended_at ? toWire(Temporal.Instant.from(j.ended_at.toISOString()), j.zone) : '', state: w.state,
        reasonKind: kind, reason: kind === 'data_error' ? f?.reason ?? null : null, tries: w.tries,
        lastTry: w.lastTryAt ? wire(w.lastTryAt) : null, nextTry: w.nextTryAt ? wire(w.nextTryAt) : null,
      };
    }),
    leftLast7Days: leftLast7Days.map((l) => {
      const f = failures.get(l.jobNumber);
      const kind = reasonKindOf(f, gaveUp.get(l.jobNumber));
      const by = l.leftHow === 'marked_fixed' ? (l.leftBy === null ? null : fixers.get(l.leftBy) ?? null) : actors.get(l.jobNumber) ?? null;
      return {
        jobNumber: l.jobNumber, reasonKind: kind, reason: kind === 'data_error' ? f?.reason ?? null : null, how: l.leftHow, tries: l.tries,
        by: l.leftHow === 'automatic_retry' ? null : by, markedReason: l.leftHow === 'marked_fixed' ? l.leftReason : null, at: wire(l.leftAt),
      };
    }),
  };
}

/** A wire time as a spreadsheet reads it: the local date and 24-hour time, "2026-09-15 11:40". */
function sheetTime(wire: string): string {
  const z = fromWire(wire);
  return `${z.toPlainDate().toString()} ${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

/**
 * The export, in the page's language (SPECIFICATIONS section 7.5). Each row says what its row on the page says (FR-BILL-12: the export
 * equals the on-screen rows; F-591): the reason, the chip and the "How it reached billing, and who" text come from the words the page
 * draws them with (@bw/i18n billing-rows), and the columns the page has no room for (the full name, the typed reason) follow.
 */
function csvOf(q: Queue, lang: 'en' | 'es'): string {
  const t = formatterFor(lang);
  const header = (['job', 'customer', 'technician', 'doneAt', 'status', 'reason', 'tries', 'lastTry', 'nextTry', 'how', 'by', 'when', 'markedReason'] as const)
    .map((k) => t(`billing.csv.${k}`));
  const waiting = q.items.map((i) => [
    i.jobNumber, i.customer, i.technician ?? '', sheetTime(i.doneAt), t(`billing.status.${i.state}`), waitingReasonText(i, t), i.tries, i.lastTry ? sheetTime(i.lastTry) : '', i.nextTry ? sheetTime(i.nextTry) : '',
    '', '', '', '',
  ]);
  const left = q.leftLast7Days.map((l) => [
    l.jobNumber, '', '', '', leftChipText(l, t), leftReasonText(l, t), l.tries, '', '', leftHowText(l, t), l.by ?? '', sheetTime(l.at), l.markedReason ?? '',
  ]);
  const lines = [header, ...waiting, ...left].map((row) => row.map(csvCell).join(','));
  // A byte order mark first, so a spreadsheet reads the UTF-8 accents; CRLF between rows (RFC 4180).
  return `﻿${lines.join('\r\n')}\r\n`;
}

interface PbsLine { kind: string; label: string; code: string | null; quantity: number | null; unitCents: number | null; amountCents: number | null }
interface PbsSummary { jobNumber: number; receivedAt: string; how: 'received' | 'entered_by_hand'; totalCents: number; customerName: string; doneAt: string }
interface PbsDetail extends PbsSummary {
  enteredByHandReason: string | null;
  enteredBy: string | null;
  enteredAt: string | null;
  lines: PbsLine[];
  calls: unknown[];
}

/** The wire time of an instant text pbs holds, in the job's zone (the zone is the branch's, found from the job). */
async function zoneOfJob(tx: Tx, jobNumber: number): Promise<string> {
  return (await tx.query<{ zone: string }>('SELECT zone FROM world.job WHERE job_number = $1', [jobNumber])).rows[0]?.zone ?? 'America/New_York';
}

export function billingReadHandlers(client?: (ctx: HandlerContext) => BillingClient): Record<'API-60' | 'API-65' | 'API-66' | 'API-67' | 'API-159', Handler<unknown>> {
  const pbs = client ?? pbsClientFor();

  const queue: Handler<Queue> = async (req, tx, ctx) => {
    const p = req.params as In<typeof queueRow>;
    const q = await queueOf(tx, ctx, pbs(ctx), p.branch, req.demoNow);
    return q === null ? refuse('not_found') : { ok: true, status: 200, data: q };
  };

  const exportList: Handler<string> = async (req, tx, ctx) => {
    const p = req.params as In<typeof exportRow>;
    const q = await queueOf(tx, ctx, pbs(ctx), p.branch, req.demoNow);
    // SPECIFICATIONS 7.5: <kind>-<branch>-<yyyy-mm-dd>.csv by demo date (F-599); the page saves the file under the name the server gives.
    return q === null ? refuse('not_found') : { ok: true, status: 200, data: csvOf(q, p.lang ?? 'en'), fileName: `billing-${p.branch}-${q.asOf.slice(0, 10)}.csv` };
  };

  const invoices: Handler<Out<typeof invoicesRow>> = async (req, tx, ctx) => {
    const p = req.params as In<typeof invoicesRow>;
    const client = pbs(ctx);
    const page = await client.listInvoices(p.cursor);
    const items = page.items as PbsSummary[];
    // The count for "Showing 7 of 41 invoices": the pages from the first, up to a cap.
    let total = 0;
    let cursor: string | undefined;
    for (let i = 0; i < COUNT_PAGES_MAX; i += 1) {
      const all = i === 0 && p.cursor === undefined ? page : await client.listInvoices(cursor);
      total += all.items.length;
      if (all.next === null) break;
      cursor = all.next;
    }
    const zones = new Map<number, string>();
    for (const it of items) zones.set(it.jobNumber, await zoneOfJob(tx, it.jobNumber));
    const wire = (n: number, iso: string) => toWire(Temporal.Instant.from(iso), zones.get(n) ?? 'America/New_York');
    return {
      ok: true, status: 200,
      data: {
        invoices: items.map((it) => ({
          jobNumber: it.jobNumber, customer: it.customerName, doneAt: wire(it.jobNumber, it.doneAt), receivedAt: wire(it.jobNumber, it.receivedAt),
          how: it.how, totalCents: it.totalCents,
        })),
        next: page.next, total,
      },
    };
  };

  const invoice: Handler<Out<typeof invoiceRow>> = async (req, tx, ctx) => {
    const p = req.params as In<typeof invoiceRow>;
    let d: PbsDetail;
    try {
      d = (await pbs(ctx).getInvoice(p.jobNumber)) as PbsDetail;
    } catch (e) {
      if (e instanceof BillingUnavailableError && e.httpStatus === 404) return refuse('not_found');
      throw e;
    }
    const zone = await zoneOfJob(tx, d.jobNumber);
    const tech = (await tx.query<{ name: string | null }>(
      `SELECT t.name FROM world.job j LEFT JOIN world.technician t ON t.id = j.technician_id WHERE j.job_number = $1`, [d.jobNumber])).rows[0]?.name ?? null;
    const noParts = (await tx.query<{ no_parts_used: boolean }>('SELECT no_parts_used FROM world.job WHERE job_number = $1', [d.jobNumber])).rows[0]?.no_parts_used ?? false;
    const by = d.enteredBy ? (await namesOf(tx, [d.enteredBy])).get(d.enteredBy) ?? null : null;
    const wire = (iso: string) => toWire(Temporal.Instant.from(iso), zone);
    return {
      ok: true, status: 200,
      data: {
        jobNumber: d.jobNumber, customer: d.customerName, technician: tech, doneAt: wire(d.doneAt), receivedAt: wire(d.receivedAt), how: d.how,
        lines: d.lines.map((l) => ({
          kind: l.kind as 'service', label: l.label, code: l.code ?? null, quantity: l.quantity ?? null, unitCents: l.unitCents ?? null,
          amountCents: l.amountCents ?? null, words: lineWordsOf(l),
        })),
        totalCents: d.totalCents, noPartsUsed: noParts && !d.lines.some((l) => l.kind === 'part'), callsReceived: d.calls.length,
        enteredByHand: d.how === 'entered_by_hand' ? { reason: d.enteredByHandReason ?? '', by, at: wire(d.enteredAt ?? d.receivedAt) } : null,
      },
    };
  };

  const mode: Handler<Out<typeof modeRow>> = async (_req, tx, ctx) => {
    const m = (await pbs(ctx).getMode()) as { mode: Out<typeof modeRow>['mode']; nLeft: number | null; setBy: string | null };
    const setBy = m.setBy ? (await namesOf(tx, [m.setBy])).get(m.setBy) ?? null : null;
    return { ok: true, status: 200, data: { mode: m.mode, nLeft: m.nLeft ?? null, setBy } };
  };

  return {
    'API-60': queue as Handler<unknown>, 'API-65': invoices as Handler<unknown>, 'API-66': invoice as Handler<unknown>,
    'API-67': mode as Handler<unknown>, 'API-159': exportList as Handler<unknown>,
  };
}
