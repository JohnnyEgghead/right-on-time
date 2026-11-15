// SPDX-License-Identifier: AGPL-3.0-or-later
// API-50 Reports and API-51 Reports export (UI-SPECIFICATION 12.2, SCR-OFC-11; SPECIFICATIONS section 6.5, SD-25, SD-31; FR-REP-1 to FR-REP-8).
// Visits come from the `report_visit` view only (FR-REP-4): the week range, the branch and the technician are its WHERE clause for every
// figure (FR-REP-5). What each figure counts:
//   on time      rows with an arrival, never the live no-one-home-only rows (SD-25: those count for no one home only): on time over arrived
//   no one home  SC-02's population: every view row of the week is a visit, live finished ones included; the no-one-home ones are the pilot visits with that outcome plus the live ones
//   visits       the visits the page lists and the export holds (LISTED): the pilot rows and the live No one home rows, not the live finished ones
//   calls        `pilot_call` rows of the week (the week of the call's time in its branch's zone), tied to the technician of the visit asked about
//   per day      the week's calls over the week's days that had at least 1 visit (a pilot visit; GAP-28), a whole number
//   late texts   `outbox_text` rows of kind `late` with status delivered, by the week of their delivery in the customer's branch zone
//   technician   visits (pilot rows), on-time rate, the mean minutes late over the late visits only (1 decimal), no-one-home visits, calls
//   period       each figure over the range's weeks that fall in the before or the after period (SD-25); calls are the weekly average
// Every rate is made here from whole counts as round(1000 * n / d) / 10, an exact half rounding up, so 37 of 40 is 92.5.
import { AFTER_PERIOD, BEFORE_PERIOD, GOAL_NO_ONE_HOME, GOAL_ON_TIME, PILOT_FIRST_WEEK, PILOT_LAST_WHOLE_WEEK, type reports, type reportsExport } from '@bw/api';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { Temporal } from '@bw/time';
import type { z } from 'zod';
import type { ApiResult, Handler, Tx } from '../types.ts';
import { csvCell } from './import.ts';

type Answer = z.infer<typeof reports.response>;
type In = z.infer<typeof reports.request>;
type ExportIn = z.infer<typeof reportsExport.request>;

/** At most this many weeks in one read (5 years): a range wider than the pilot is a malformed request. */
const MAX_WEEKS = 260;

/** A percent with 1 decimal from whole counts; null with no denominator. */
export const percentOf = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n * 1000) / d) / 10);

const mondayOf = (d: Temporal.PlainDate): Temporal.PlainDate => d.subtract({ days: d.dayOfWeek - 1 });

interface Scope { branch: string | null; technicianId: string | null; from: string; to: string }

/** The filtered rows of the view: every query below reads through this one WHERE clause (FR-REP-5). */
const VIEW_WHERE = `week_start BETWEEN $3::date AND $4::date AND ($1::text IS NULL OR branch_id = $1) AND ($2::uuid IS NULL OR technician_id = $2)`;
const args = (s: Scope): unknown[] => [s.branch, s.technicianId, s.from, s.to];
/** The view rows a person sees listed: a live finished visit (F-736, migration 0017) is in the no-one-home denominator and in nothing else. */
const LISTED = `(NOT no_one_home_only OR outcome = 'no_one_home')`;

/** Resolves the request's filters: the branch (404 for an unknown one), the week range (422 for an inverted or too wide one). */
async function scopeOf(tx: Tx, p: In, demoNow: Temporal.Instant): Promise<{ scope: Scope; branches: string[]; weeks: string[]; choices: string[] } | ApiResult<never>> {
  const branchRows = (await tx.query<{ id: string; zone: string }>('SELECT id, zone FROM world.branch ORDER BY id')).rows;
  const all = p.branch === undefined || p.branch === 'all';
  const picked = all ? undefined : branchRows.find((b) => b.id === p.branch);
  if (!all && !picked) return { ok: false, status: 404, code: 'not_found' };
  const zone = picked?.zone ?? branchRows[0]?.zone ?? 'America/New_York';
  const demoWeek = mondayOf(demoNow.toZonedDateTimeISO(zone).toPlainDate());
  const first = Temporal.PlainDate.from(PILOT_FIRST_WEEK);
  const lastWhole = Temporal.PlainDate.from(PILOT_LAST_WHOLE_WEEK);
  const from = p.fromWeek === undefined ? first : Temporal.PlainDate.from(p.fromWeek);
  const to = p.toWeek === undefined ? (Temporal.PlainDate.compare(lastWhole, from) < 0 ? from : lastWhole) : Temporal.PlainDate.from(p.toWeek);
  if (Temporal.PlainDate.compare(to, from) < 0 || from.until(to, { largestUnit: 'days' }).days / 7 >= MAX_WEEKS || first.until(to, { largestUnit: 'days' }).days / 7 >= MAX_WEEKS) return { ok: false, status: 422, code: 'validation_failed' };
  const mondays = (a: Temporal.PlainDate, b: Temporal.PlainDate): string[] => {
    const out: string[] = [];
    for (let d = a; Temporal.PlainDate.compare(d, b) <= 0; d = d.add({ days: 7 })) out.push(d.toString());
    return out;
  };
  return {
    scope: { branch: all ? null : (picked?.id ?? null), technicianId: p.technicianId ?? null, from: from.toString(), to: to.toString() },
    branches: branchRows.map((b) => b.id),
    weeks: mondays(from, to),
    choices: mondays(first, Temporal.PlainDate.compare(demoWeek, to) > 0 ? demoWeek : to),
  };
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0);

async function readReport(tx: Tx, p: In, demoNow: Temporal.Instant): Promise<Answer | ApiResult<never>> {
  const resolved = await scopeOf(tx, p, demoNow);
  if ('ok' in resolved) return resolved;
  const { scope, branches, weeks, choices } = resolved;
  const a = args(scope);

  const perWeekBranch = (await tx.query<{ week: string; branch_id: string; arrived: string; on_time: string; visits: string; listed: string; noh: string }>(
    `SELECT week_start::text AS week, branch_id,
            count(*) FILTER (WHERE NOT no_one_home_only AND on_time IS NOT NULL) AS arrived,
            count(*) FILTER (WHERE NOT no_one_home_only AND on_time) AS on_time,
            count(*) AS visits,
            count(*) FILTER (WHERE ${LISTED}) AS listed,
            count(*) FILTER (WHERE outcome = 'no_one_home') AS noh
       FROM world.report_visit WHERE ${VIEW_WHERE} GROUP BY week_start, branch_id`, a)).rows;
  const days = new Map((await tx.query<{ week: string; days: string }>(
    `SELECT week_start::text AS week, count(DISTINCT date) FILTER (WHERE NOT no_one_home_only) AS days
       FROM world.report_visit WHERE ${VIEW_WHERE} GROUP BY week_start`, a)).rows.map((r) => [r.week, num(r.days)]));
  const callsRows = (await tx.query<{ week: string; n: string }>(
    `SELECT (date_trunc('week', c.at AT TIME ZONE b.zone))::date::text AS week, count(*) AS n
       FROM world.pilot_call c JOIN world.branch b ON b.id = c.branch_id
      WHERE ($1::text IS NULL OR c.branch_id = $1) AND ($2::uuid IS NULL OR c.technician_id = $2)
        AND (date_trunc('week', c.at AT TIME ZONE b.zone))::date BETWEEN $3::date AND $4::date
      GROUP BY 1`, a)).rows;
  const lateRows = (await tx.query<{ week: string; n: string }>(
    `SELECT (date_trunc('week', o.delivered_at AT TIME ZONE b.zone))::date::text AS week, count(*) AS n
       FROM world.outbox_text o
       JOIN world.customer cu ON cu.id = o.customer_id
       JOIN world.branch b ON b.id = cu.branch_id
       LEFT JOIN world.job j ON j.job_number = o.job_number
      WHERE o.kind = 'late' AND o.status = 'delivered' AND o.delivered_at IS NOT NULL
        AND ($1::text IS NULL OR cu.branch_id = $1) AND ($2::uuid IS NULL OR j.technician_id = $2)
        AND (date_trunc('week', o.delivered_at AT TIME ZONE b.zone))::date BETWEEN $3::date AND $4::date
      GROUP BY 1`, a)).rows;
  const techRows = (await tx.query<{
    technician_id: string | null; name: string; visits: string; arrived: string; on_time: string; avg_late: string | null; noh: string;
  }>(
    `SELECT technician_id, technician_name AS name,
            count(*) FILTER (WHERE NOT no_one_home_only) AS visits,
            count(*) FILTER (WHERE NOT no_one_home_only AND on_time IS NOT NULL) AS arrived,
            count(*) FILTER (WHERE NOT no_one_home_only AND on_time) AS on_time,
            round(avg(minutes_late) FILTER (WHERE NOT no_one_home_only), 1) AS avg_late,
            count(*) FILTER (WHERE outcome = 'no_one_home') AS noh
       FROM world.report_visit WHERE ${VIEW_WHERE} AND ${LISTED} AND technician_name IS NOT NULL
      GROUP BY technician_id, technician_name`, a)).rows;
  const techCalls = new Map((await tx.query<{ technician_id: string; n: string }>(
    `SELECT c.technician_id, count(*) AS n
       FROM world.pilot_call c JOIN world.branch b ON b.id = c.branch_id
      WHERE ($1::text IS NULL OR c.branch_id = $1) AND ($2::uuid IS NULL OR c.technician_id = $2)
        AND (date_trunc('week', c.at AT TIME ZONE b.zone))::date BETWEEN $3::date AND $4::date
      GROUP BY c.technician_id`, a)).rows.map((r) => [r.technician_id, num(r.n)]));
  const techChoices = scope.branch === null ? [] : (await tx.query<{ id: string; name: string }>(
    'SELECT id, name FROM world.technician WHERE branch_id = $1 ORDER BY name, id', [scope.branch])).rows;

  // Series, one point per week of the range.
  const weekRows = (w: string) => perWeekBranch.filter((r) => r.week === w);
  const sum = (rows: typeof perWeekBranch, k: 'arrived' | 'on_time' | 'visits' | 'listed' | 'noh') => rows.reduce((s, r) => s + num(r[k]), 0);
  const shown = scope.branch === null ? branches : [scope.branch];
  const onTime = shown.map((branch) => ({
    branch,
    points: weeks.map((week) => {
      const r = weekRows(week).filter((x) => x.branch_id === branch);
      return { week, rate: percentOf(sum(r, 'on_time'), sum(r, 'arrived')), onTime: sum(r, 'on_time'), visits: sum(r, 'arrived') };
    }),
  }));
  const callsBy = new Map(callsRows.map((r) => [r.week, num(r.n)]));
  const calls = weeks.map((week) => {
    const n = callsBy.get(week) ?? 0;
    const d = days.get(week) ?? 0;
    return { week, calls: n, perDay: d === 0 ? null : Math.round(n / d) };
  });
  const noOneHome = weeks.map((week) => {
    const r = weekRows(week);
    return { week, rate: percentOf(sum(r, 'noh'), sum(r, 'visits')), count: sum(r, 'noh'), visits: sum(r, 'visits') };
  });
  const lateBy = new Map(lateRows.map((r) => [r.week, num(r.n)]));
  const lateTexts = weeks.map((week) => ({ week, count: lateBy.get(week) ?? 0 }));

  // The cards: the last week, and the figures over the before and the after period within the range.
  const last = weeks[weeks.length - 1] as string;
  const inPeriod = (p: { from: string; to: string }) => weeks.filter((w) => w >= p.from && w <= p.to);
  // F-742 (owner ruling c6d05e04, "Whole weeks only"): a period's calls average counts whole weeks only. The pilot's data ends on
  // AFTER_PERIOD.to (a Monday), so the week that holds only that Monday is a part week and is left out of the average and of its divisor.
  const wholeWeeks = (ws: string[]) => ws.filter((w) => Temporal.PlainDate.compare(Temporal.PlainDate.from(w).add({ days: 6 }), Temporal.PlainDate.from(AFTER_PERIOD.to)) <= 0);
  const overWeeks = (ws: string[]) => {
    const r = perWeekBranch.filter((x) => ws.includes(x.week));
    return { onTime: percentOf(sum(r, 'on_time'), sum(r, 'arrived')), noh: percentOf(sum(r, 'noh'), sum(r, 'visits')), calls: wholeWeeks(ws).length === 0 ? null : Math.round(wholeWeeks(ws).reduce((s, w) => s + (callsBy.get(w) ?? 0), 0) / wholeWeeks(ws).length) };
  };
  const before = overWeeks(inPeriod(BEFORE_PERIOD));
  const after = overWeeks(inPeriod(AFTER_PERIOD));
  const lastCalls = calls[calls.length - 1] as Answer['calls'][number];
  const lastNoh = noOneHome[noOneHome.length - 1] as Answer['noOneHome'][number];
  const lastOnTime = percentOf(sum(weekRows(last), 'on_time'), sum(weekRows(last), 'arrived'));

  const technicians = techRows.map((r) => ({
    technicianId: r.technician_id, name: r.name, visits: num(r.visits), onTimeRate: percentOf(num(r.on_time), num(r.arrived)),
    averageMinutesLate: r.avg_late === null ? null : Number(r.avg_late), noOneHome: num(r.noh), calls: r.technician_id === null ? 0 : (techCalls.get(r.technician_id) ?? 0),
  })).sort((x, y) => (y.onTimeRate ?? -1) - (x.onTimeRate ?? -1) || x.name.localeCompare(y.name));

  return {
    labelKey: 'simulated_pilot_data',
    branch: scope.branch ?? 'all',
    technicianId: scope.technicianId,
    fromWeek: scope.from,
    toWeek: scope.to,
    weeks,
    choices: { weeks: choices, branches, technicians: techChoices },
    periods: { before: { ...BEFORE_PERIOD }, after: { ...AFTER_PERIOD } },
    goals: {
      onTime: { rate: GOAL_ON_TIME, labelKey: 'reports.goal.onTime' },
      noOneHome: { rate: GOAL_NO_ONE_HOME, labelKey: 'reports.goal.noOneHome' },
    },
    totals: { visits: sum(perWeekBranch, 'listed') },
    onTime,
    calls,
    noOneHome,
    lateTexts,
    headline: {
      week: last,
      onTime: { rate: lastOnTime, before: before.onTime, after: after.onTime },
      calls: { count: lastCalls.calls, perDay: lastCalls.perDay, before: before.calls, after: after.calls },
      noOneHome: { rate: lastNoh.rate, count: lastNoh.count, visits: lastNoh.visits, before: before.noh, after: after.noh },
      lateTexts: lateBy.get(last) ?? 0,
    },
    technicians,
  };
}

export const reportsHandler: Handler<Answer> = async (req, tx) => {
  const r = await readReport(tx, req.params as In, req.demoNow);
  if ('ok' in r) return r;
  return { ok: true, status: 200, data: r };
};

const titleCase = (id: string): string => `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;

const formatters = new Map<string, Intl.DateTimeFormat>();
/** An instant as the visit's local clock, "2026-06-01 08:00" (24-hour, so a spreadsheet sorts it as text). One formatter per zone: a visit row each is 15,000 of them. */
function clock(d: Date | null, zone: string): string {
  if (d === null) return '';
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export const reportsExportHandler: Handler<string> = async (req, tx) => {
  const p = req.params as ExportIn;
  const resolved = await scopeOf(tx, p, req.demoNow);
  if ('ok' in resolved) return resolved;
  const { scope } = resolved;
  const t = formatterFor(p.language ?? 'en');
  // The same rows as the page: the view through the same WHERE clause (FR-REP-3), one per listed visit, live no-one-home visits included.
  const rows = (await tx.query<{ branch_id: string; technician_name: string | null; week: string; zone: string; window_start: Date; window_end: Date; arrived_at: Date | null }>(
    `SELECT branch_id, technician_name, week_start::text AS week, zone, window_start, window_end, arrived_at
       FROM world.report_visit WHERE ${VIEW_WHERE} AND ${LISTED}
      ORDER BY week_start, date, window_start, branch_id, technician_name NULLS LAST, source, past_visit_id NULLS LAST, job_number NULLS LAST`, args(scope))).rows;
  const header = (['dataSource', 'branch', 'technician', 'week', 'window', 'arrival'] as const).map((k) => t(`reports.csv.${k}`));
  const source = t('reports.label.simulated');
  const body = rows.map((r) => [
    source, titleCase(r.branch_id), r.technician_name ?? '', r.week,
    `${clock(r.window_start, r.zone)} - ${clock(r.window_end, r.zone).slice(11)}`, clock(r.arrived_at, r.zone),
  ]);
  const lines = [header, ...body].map((row) => row.map(csvCell).join(','));
  const today = req.demoNow.toZonedDateTimeISO('America/New_York').toPlainDate().toString();
  return { ok: true, status: 200, data: `﻿${lines.join('\r\n')}\r\n`, fileName: `reports-${scope.branch ?? 'all'}-${today}.csv` };
};
