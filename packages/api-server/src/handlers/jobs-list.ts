// SPDX-License-Identifier: AGPL-3.0-or-later
// API-133 Jobs list and API-134 Jobs export (UI-SPECIFICATION 12.2, SCR-OFC-30; SPECIFICATIONS section 6.2 "Jobs list", SD-15, SD-31, UD-44,
// UD-52; FR-DISP-24, FR-DISP-14, NFR-05): 1 read for the Jobs page and the same rows as a spreadsheet.
//   rows      the branch's jobs in the Date filter's range, plus every job on the billing list (retrying or waiting for a person)
//             whatever its day (UD-44); the technician, status, service filters are SQL, the search text is matched here
//   timing    SD-15's etaDay over today's jobs of each technician, the same function and drive minutes the board and the ETA sweep use
//   attention UD-52: an open job that is Late, At risk, Unassigned, or Scheduled with an unhandled offline conflict
//   counts    each tab for the same search and filters (the tab itself not applied; Not in billing ignores the day)
//   order     attention first (Late, At risk, Unassigned, flagged), then day, window start, job number; `window` sort: day, window start, number
// The search text arrives in the request body only (a POST), is bound as a parameter or matched in memory, never written into SQL text,
// and is never logged: the kernel logs the contract, the route and the status, never a parameter (NFR-05).
import { PAGE_SIZE, type jobsExport, type jobsList } from '@bw/api';
import { formatterFor } from '@bw/i18n/src/format.ts';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { areaName } from '@bw/domain';
import { addDays, localDateOf, toWire, type Instant } from '@bw/time';
import type { z } from 'zod';
import { branchTechnicians, wire } from '../office-writes/day.ts';
import type { Handler, Tx } from '../types.ts';
import { branchOf, dayJobs, etas } from './board.ts';
import { csvCell } from './import.ts';
import { searchTerms } from './search.ts';

type ListAnswer = z.infer<typeof jobsList.response>;
type ListIn = z.infer<typeof jobsList.request>;
type Row = ListAnswer['rows'][number];
type ExportIn = z.infer<typeof jobsExport.request>;

/** SPECIFICATIONS section 6.2: "Today and upcoming" covers demo today and the next 4 calendar days (CTL-OFC-30-18). */
const UPCOMING_DAYS = 4;

/** The catalog words of a job status and of a timing (the page's chips say the same). */
const STATUS_KEY = {
  scheduled: 'status.job.scheduled', on_the_way: 'status.job.onTheWay', on_site: 'status.job.onSite', done: 'status.job.done',
  no_one_home: 'status.job.noOneHome', canceled: 'status.job.canceled',
} as const satisfies Record<Row['status'], MessageKey>;
const TIMING_KEY = { late: 'status.timing.late', at_risk: 'status.timing.atRisk', on_time: 'jobs.timing.onTime' } as const satisfies Record<'late' | 'at_risk' | 'on_time', MessageKey>;

const OPEN = new Set(['scheduled', 'on_the_way', 'on_site']);
const ON_BILLING_LIST = new Set(['retrying', 'waiting_person']);

interface SqlRow {
  job_number: number; customer: string; city: string; zip: string; problem: string | null; name_search: string; mobile: string | null; home_phone: string | null;
  house_number: number; street_search: string; service_id: string; date: string; zone: string; window_start: Date; window_end: Date;
  technician_id: string | null; technician: string | null; status: Row['status']; arrived_at: Date | null; ended_at: Date | null;
  late_text_sent_at: Date | null; booked_via: Row['bookedVia']; booked_by_name: string | null; billing_state: Row['billingState'];
  tries: number | null; billed_at: Date | null; flagged: boolean;
}

/** The digits of a phone number as stored (any punctuation dropped). */
const digits = (s: string | null): string => (s ?? '').replace(/\D/g, '');

/** Whether a search matches a row: job number, customer, street (with a house number) or phone (NFR-05: matched in memory). */
function matches(query: string, r: SqlRow): boolean {
  if (query === '') return true;
  const t = searchTerms(query);
  if (/^\d+$/.test(query) && String(r.job_number).startsWith(query)) return true;
  if (/^[\d\s()+.-]+$/.test(query)) {
    const d = digits(query);
    if (d.length >= 3 && (digits(r.mobile).includes(d) || digits(r.home_phone).includes(d))) return true;
  }
  if (t.name !== null && r.name_search.includes(t.name)) return true;
  if (t.street !== null && r.street_search.includes(t.street) && (t.house === null || r.house_number === t.house)) return true;
  return false;
}

interface JobsResult {
  answer: ListAnswer;
  /** Every row of the picked tab, in order (the page is a slice of it). */
  all: Row[];
}

const rankOf = (r: Row): number => (r.timing === 'late' ? 0 : r.timing === 'at_risk' ? 1 : r.technicianId === null && OPEN.has(r.status) ? 2 : 3);

/** The whole read: every row of the picked tab in order, the counts and the range. null when the branch does not exist. */
async function readJobs(tx: Tx, p: ListIn | ExportIn, demoNow: Instant): Promise<JobsResult | null> {
  const branch = await branchOf(tx, p.branch);
  if (!branch) return null;
  const today = localDateOf(demoNow, branch.zone);
  const date = p.date ?? 'upcoming';
  const range = date === 'upcoming' ? { from: today, to: addDays(today, UPCOMING_DAYS) } : date === 'today' ? { from: today, to: today } : { from: date, to: date };
  const now = demoNow.epochMilliseconds;

  const found = await tx.query<SqlRow>(
    `SELECT j.job_number, c.name AS customer, s.city, s.zip, j.problem, c.name_search, c.mobile, c.home_phone, c.house_number, s.name_search AS street_search,
            j.service_id, j.date::text AS date, j.zone, j.window_start, j.window_end, j.technician_id, t.name AS technician, j.status,
            j.arrived_at, j.ended_at, j.late_text_sent_at, j.booked_via, u.name AS booked_by_name, j.billing_state,
            b.tries, CASE WHEN j.billing_state IN ('in_billing', 'marked_fixed') THEN coalesce(b.left_at, b.last_try_at) END AS billed_at,
            EXISTS (SELECT 1 FROM world.offline_conflict oc WHERE oc.job_number = j.job_number AND oc.handled_at IS NULL) AS flagged
       FROM world.job j
       JOIN world.customer c ON c.id = j.customer_id
       JOIN world.street s ON s.id = c.street_id
       LEFT JOIN world.technician t ON t.id = j.technician_id
       LEFT JOIN world."user" u ON u.id = j.booked_by
       LEFT JOIN world.billing_item b ON b.job_number = j.job_number
      WHERE j.branch_id = $1
        AND (j.date BETWEEN $2::date AND $3::date OR j.billing_state IN ('retrying', 'waiting_person'))
        AND ($4::uuid IS NULL OR j.technician_id = $4)
        AND ($5::text IS NULL OR j.status = $5)
        AND ($6::text IS NULL OR j.service_id = $6)`,
    [branch.id, range.from, range.to, p.technicianId ?? null, p.status ?? null, p.serviceId ?? null],
  );
  const query = (p.query ?? '').trim();
  const rows = found.rows.filter((r) => matches(query, r));

  // SD-15: the ETA and timing of today's open jobs, per technician.
  const people = new Map((await branchTechnicians(tx, branch.id)).map((x) => [x.id, x] as const));
  const todays = await dayJobs(tx, branch.id, today);
  const etaOf = new Map<number, { eta: number; timing: 'late' | 'at_risk' | 'on_time' }>();
  for (const id of new Set(todays.map((j) => j.technician_id).filter((x): x is string => x !== null))) {
    const person = people.get(id);
    if (!person) continue;
    const e = await etas(tx, branch, person, today, todays.filter((j) => j.technician_id === id), now);
    for (const [n, v] of e) etaOf.set(n, v);
  }

  const modeDates = [...new Set(rows.map((r) => r.date))];
  const modes = new Map(
    (await tx.query<{ date: string; mode: Row['dayMode'] }>(
      'SELECT date::text AS date, mode FROM world.day_mode WHERE branch_id = $1 AND date = ANY($2::date[])', [branch.id, modeDates])).rows.map((m) => [m.date, m.mode] as const),
  );

  const built: Row[] = rows.map((r) => {
    const open = OPEN.has(r.status);
    const e = open && r.date === today && r.technician_id !== null ? etaOf.get(r.job_number) : undefined;
    const timing = e ? e.timing : null;
    return {
      jobNumber: r.job_number, customer: r.customer, area: areaName(r.city, r.zip), service: r.service_id, problem: r.problem === null || r.problem.trim() === '' ? null : r.problem, day: r.date,
      window: { start: wire(r.window_start, r.zone), end: wire(r.window_end, r.zone) },
      technicianId: r.technician_id, technician: r.technician, status: r.status, timing,
      eta: e ? wire(new Date(e.eta), r.zone) : null,
      arrivedAt: r.arrived_at ? wire(r.arrived_at, r.zone) : null,
      endedAt: r.ended_at ? wire(r.ended_at, r.zone) : null,
      lateTextSentAt: r.late_text_sent_at ? wire(r.late_text_sent_at, r.zone) : null,
      dayMode: modes.get(r.date) ?? 'two_hour',
      bookedVia: r.booked_via, bookedBy: r.booked_via === 'office' ? r.booked_by_name : null,
      billingState: r.billing_state, billingTries: r.tries ?? 0, billedAt: r.billed_at ? wire(r.billed_at, r.zone) : null,
      // UD-52: a closed job never needs attention.
      needsAttention: open && (timing === 'late' || timing === 'at_risk' || r.technician_id === null || (r.status === 'scheduled' && r.flagged)),
    };
  });

  const inRange = (r: Row) => r.day >= range.from && r.day <= range.to;
  const onList = (r: Row) => ON_BILLING_LIST.has(r.billingState);
  const unassigned = (r: Row) => r.technicianId === null && OPEN.has(r.status);
  const counts = {
    all: built.filter(inRange).length,
    unassigned: built.filter((r) => inRange(r) && unassigned(r)).length,
    atRisk: built.filter((r) => inRange(r) && r.timing === 'at_risk').length,
    late: built.filter((r) => inRange(r) && r.timing === 'late').length,
    notInBilling: built.filter(onList).length,
  };

  const tab = p.tab ?? 'all';
  const picked = built.filter((r) =>
    tab === 'not-in-billing' ? onList(r)
      : inRange(r) && (tab === 'all' || (tab === 'unassigned' ? unassigned(r) : tab === 'at-risk' ? r.timing === 'at_risk' : r.timing === 'late')));
  const attentionFirst = (p.sort ?? 'attention') === 'attention';
  picked.sort((a, b) =>
    (attentionFirst ? Number(b.needsAttention) - Number(a.needsAttention) || (a.needsAttention ? rankOf(a) - rankOf(b) : 0) : 0)
    || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)
    || (a.window.start < b.window.start ? -1 : a.window.start > b.window.start ? 1 : 0)
    || a.jobNumber - b.jobNumber);

  const services = await tx.query<{ id: string }>('SELECT id FROM world.service_type ORDER BY id');
  return {
    all: picked,
    answer: {
      branch: branch.id, today, asOf: toWire(demoNow, branch.zone), counts, rows: [], range, total: picked.length, pages: Math.ceil(picked.length / PAGE_SIZE),
      filters: {
        technicians: [...people.values()].map((x) => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name, 'en') || (a.id < b.id ? -1 : 1)),
        services: services.rows.map((x) => x.id),
      },
    },
  };
}

export const jobsListHandler: Handler<ListAnswer> = async (req, tx) => {
  const p = req.params as ListIn;
  const r = await readJobs(tx, p, req.demoNow);
  if (r === null) return { ok: false, status: 404, code: 'not_found' };
  // K-08.1: a page past the last answers the last page, never an empty one.
  const page = Math.min(p.page ?? 1, Math.max(1, r.answer.pages));
  const start = (page - 1) * PAGE_SIZE;
  return { ok: true, status: 200, data: { ...r.answer, rows: r.all.slice(start, start + PAGE_SIZE) } };
};

/** "2026-09-15 10:28": a time in the sheet's plain form (the job's zone, 24-hour, so a spreadsheet sorts it). */
const sheetTime = (w: string | null): string => (w === null ? '' : `${w.slice(0, 10)} ${w.slice(11, 16)}`);

export const jobsExportHandler: Handler<string> = async (req, tx) => {
  const p = req.params as ExportIn;
  const r = await readJobs(tx, p, req.demoNow);
  if (r === null) return { ok: false, status: 404, code: 'not_found' };
  const t = formatterFor(p.lang ?? 'en');
  const header = (['job', 'customer', 'area', 'service', 'day', 'window', 'technician', 'status', 'timing', 'eta', 'bookedBy', 'billing', 'needsAttention'] as const)
    .map((k) => t(`jobs.csv.${k}`));
  const body = r.all.map((j) => [
    j.jobNumber, j.customer, j.area, j.problem ?? t(`service.${j.service}.screen` as MessageKey), j.day,
    `${j.window.start.slice(11, 16)}-${j.window.end.slice(11, 16)}`, j.technician ?? t('jobs.noTechnician'),
    t(STATUS_KEY[j.status]), j.timing === null ? '' : t(TIMING_KEY[j.timing]), sheetTime(j.eta),
    j.bookedVia === 'online' ? t('jobs.by.online') : j.bookedVia === 'office' ? (j.bookedBy ? t('jobs.by.officePerson', { who: j.bookedBy }) : t('jobs.by.office')) : t('jobs.by.seed'),
    t(`jobs.csv.billing.${j.billingState}` as MessageKey), j.needsAttention ? t('jobs.csv.yes') : t('jobs.csv.no'),
  ]);
  const lines = [header, ...body].map((row) => row.map(csvCell).join(','));
  return { ok: true, status: 200, data: `﻿${lines.join('\r\n')}\r\n`, fileName: `jobs-${r.answer.branch}-${r.answer.today}.csv` };
};
