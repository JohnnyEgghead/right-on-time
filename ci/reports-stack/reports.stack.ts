// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-REP-1, FR-REP-2, FR-REP-3, FR-REP-4, FR-REP-5, FR-REP-6, FR-REP-7, FR-REP-8, FR-DISP-10, FR-AUTH-1, SC-01, SC-02, SC-03, UC-09, NFR-06 (P4-REPORTS Acceptance: Playwright on the Compose stack)
// The Reports page (SCR-OFC-11) against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running), set up by the
// setup service (the seeded world with its generated pilot rows, the clock at Tue, Sep 15, 7:00 AM), through its proxy, every page opened through
// the outside-origin guard. The people are ci/reports-stack/fixture.sql's sessions. Run by ci/reports-stack.sh.
//   The numbers: every figure API-50 answers for the generated rows equals an independent SQL query written here on the raw tables (past_visit,
//   job, pilot_call, outbox_text: not the report_visit view, not the report code's week arithmetic), and every number the page prints is the one
//   the real API answered (and so the SQL's): the cards, the by-technician table, the chart tips, the data tables and the export.
//   The planted pilot (SD-25): the before period near 74% on time and 6% no one home with about twice the after period's call rate, the after
//   period at least 90% on time and under 3% no one home.
//   The live week (SC-02): the last describe jumps the clock through the demo week and the autopilot finishes its jobs. A clock move cannot be undone,
//   so it runs last and every test before it hands the world back as it found it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Browser, Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_REPORTS_STACK_URL;
const db = process.env.BW_REPORTS_DB_CONTAINER;
const techSeed = process.env.BW_REPORTS_TECHSEED;
const people = { keisha: process.env.BW_REPORTS_KEISHA, dana: process.env.BW_REPORTS_DANA };
if (!base || !db || !techSeed || Object.values(people).some((v) => !v)) {
  throw new Error('BW_REPORTS_STACK_URL, _DB_CONTAINER, _TECHSEED and the session tokens are not set: run ci/reports-stack.sh');
}
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): a write carries it, as a browser on the default stack's own origin would.
const APP_ORIGIN = 'http://localhost:8080';
const SCREEN = '.r1-screen[data-screen="SCR-OFC-11"]';
const CATALOG = {
  en: JSON.parse(readFileSync('packages/i18n/catalog/en.json', 'utf8')) as Record<string, string>,
  es: JSON.parse(readFileSync('packages/i18n/catalog/es.json', 'utf8')) as Record<string, string>,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
// The browser's globals, read inside page.evaluate / waitForFunction callbacks (this config has no DOM lib).
declare const document: any;
declare const location: any;

/** SQL in the stack's database as its owner. */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
/** Rows of a query as objects, through the database's own json_agg. */
const rows = <T = Json>(sql: string): T[] => JSON.parse(psql(`SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t`)) as T[];

async function call(token: string, path: string): Promise<{ status: number; body: Json; text: string }> {
  const r = await fetch(`${origin}/api/v1${path}`, { headers: { cookie: `bw_session=${token}` } });
  const text = await r.text();
  let body: Json = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: r.status, body, text };
}
const report = async (query = ''): Promise<Json> => {
  const r = await call(people.dana!, `/reports${query}`);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.body;
};

/** A technician's session token as ci/reports-stack/fixture.sql made it: base64url of sha256(techseed + user id). */
const techToken = (userId: string) => createHash('sha256').update(`${techSeed}${userId}`).digest('base64url');

// The numbers a person reads, written the way the page writes them in English (up to 1 decimal; a count with its grouping).
const decimal = (n: number) => new Intl.NumberFormat('en', { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n);
const pct = (n: number | null) => (n === null ? 'n/a' : `${decimal(n)}%`);
const count = (n: number | null) => (n === null ? 'n/a' : new Intl.NumberFormat('en').format(n));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const msg = (key: string, values: Record<string, string | number> = {}, lang: 'en' | 'es' = 'en') => (CATALOG[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

// ---- the independent query: the raw tables, a week is date_trunc('week', date) ----
const PILOT = `SELECT c.branch_id, pv.date, pv.technician_id, pv.technician_name, pv.zone, pv.window_start, pv.window_end, pv.arrived_at, pv.outcome, false AS live
                 FROM world.past_visit pv JOIN world.customer c ON c.id = pv.customer_id WHERE pv.date BETWEEN '2026-06-01' AND '2026-08-30'
               UNION ALL
               SELECT j.branch_id, j.date, j.technician_id, t.name, j.zone, j.window_start, j.window_end, j.arrived_at, j.status, false
                 FROM world.job j LEFT JOIN world.technician t ON t.id = j.technician_id WHERE j.pilot AND j.status IN ('done', 'no_one_home')`;
const liveJobs = (status: string) => `SELECT j.branch_id, j.date, j.technician_id, t.name, j.zone, j.window_start, j.window_end, j.arrived_at, j.status, true
                 FROM world.job j LEFT JOIN world.technician t ON t.id = j.technician_id WHERE NOT j.pilot AND j.status = '${status}' AND j.date >= '2026-09-15'`;
/** The visits the page lists and the export holds. */
const VISITS = `(${PILOT} UNION ALL ${liveJobs('no_one_home')}) v`;
/** SC-02's Population, from its own words: the completed visits of the pilot data, together with the live visits that were finished or recorded as No one home. */
const SC02 = `(${PILOT} UNION ALL ${liveJobs('done')} UNION ALL ${liveJobs('no_one_home')}) v`;
const WEEK = `to_char(date_trunc('week', date::timestamp), 'YYYY-MM-DD')`;
const CALL_WEEK = `date_trunc('week', (at AT TIME ZONE 'America/New_York'))`;
const PCT = (n: string, d: string) => `round(100.0 * ${n} / nullif(${d}, 0), 1)::float8`;

/** A range of weeks, each named by its Monday, ends included. */
interface Weeks { from: string; to: string }
/** The range the reports answer with no toWeek (FR-REP-5, F-1157): the first pilot week to the last whole week, 15 weeks. The week of Sep 14 holds 1 day of the data and is left out. */
const DEFAULT_RANGE: Weeks = { from: '2026-06-01', to: '2026-09-07' };
/** The pilot through the live demo week of Sep 14: a range that includes it must be asked for (toWeek on the API, the To week on the page). */
const WHOLE: Weeks = { from: '2026-06-01', to: '2026-09-14' };
/** The query that asks for the live week, and the week the page's To select picks. */
const LIVE_WEEK = '2026-09-14';
const LIVE_QUERY = `?toWeek=${LIVE_WEEK}`;
/** The week range picked in the Reports filter (FR-REP-5): Jul 6 to Aug 30 is the 8 weeks of Jul 6 to Aug 24. */
const JUL_AUG: Weeks = { from: '2026-07-06', to: '2026-08-24' };
const inWeeks = (w: Weeks, col = 'date::timestamp') => `date_trunc('week', ${col}) BETWEEN DATE '${w.from}' AND DATE '${w.to}'`;
const weeksIn = (w: Weeks) => Math.round((Date.parse(w.to) - Date.parse(w.from)) / (7 * 86_400_000)) + 1;

interface PeriodTruth { onTime: number | null; noh: number | null; calls: number | null }
interface Truth {
  onTime: { wk: string; branch_id: string; arrived: number; ontime: number; rate: number | null }[];
  /** All branches together: the first card. */
  onTimeWeek: { wk: string; rate: number | null }[];
  noh: { wk: string; visits: number; noh: number; rate: number | null }[];
  calls: { wk: string; n: number; per_day: number | null }[];
  late: { wk: string; n: number }[];
  tech: { name: string; visits: number; rate: number | null; late_avg: number | null; noh: number; calls: number }[];
  /** Before and after (SD-25), each clipped to the range; calls are the mean of the range's weeks in the period. */
  before: PeriodTruth;
  after: PeriodTruth;
}
/** F-742 (owner ruling c6d05e04, "Whole weeks only"): the calls average counts whole weeks only. The data ends on Mon Sep 14, so the week of Sep 14 holds 1 day and is left out of the sum and of the divisor. */
const LAST_WHOLE_WEEK = '2026-09-07';
function wholeWeekCalls(w: Weeks): number | null {
  const whole = { from: w.from, to: w.to < LAST_WHOLE_WEEK ? w.to : LAST_WHOLE_WEEK };
  if (whole.from > whole.to) return null;
  return rows<{ r: number }>(`SELECT round(count(*)::numeric / ${weeksIn(whole)})::int AS r FROM world.pilot_call WHERE ${inWeeks(whole, CALL_WEEK)}`)[0]!.r;
}
function periodTruth(p: Weeks, range: Weeks): PeriodTruth {
  const w = { from: p.from > range.from ? p.from : range.from, to: p.to < range.to ? p.to : range.to };
  if (w.from > w.to) return { onTime: null, noh: null, calls: null };
  return {
    onTime: rows<{ r: number | null }>(`SELECT ${PCT('count(*) FILTER (WHERE arrived_at <= window_end)', 'count(*)')} AS r FROM ${VISITS} WHERE arrived_at IS NOT NULL AND NOT live AND ${inWeeks(w)}`)[0]!.r,
    noh: rows<{ r: number | null }>(`SELECT ${PCT("count(*) FILTER (WHERE outcome = 'no_one_home')", 'count(*)')} AS r FROM ${SC02} WHERE ${inWeeks(w)}`)[0]!.r,
    calls: wholeWeekCalls(w),
  };
}
function truth(range: Weeks = DEFAULT_RANGE): Truth {
  const inRange = inWeeks(range);
  const callsInRange = inWeeks(range, CALL_WEEK);
  return {
    onTime: rows(`SELECT ${WEEK} AS wk, branch_id, count(*)::int AS arrived, count(*) FILTER (WHERE arrived_at <= window_end)::int AS ontime,
                         ${PCT('count(*) FILTER (WHERE arrived_at <= window_end)', 'count(*)')} AS rate
                    FROM ${VISITS} WHERE arrived_at IS NOT NULL AND NOT live AND ${inRange} GROUP BY 1, 2`),
    onTimeWeek: rows(`SELECT ${WEEK} AS wk, ${PCT('count(*) FILTER (WHERE arrived_at <= window_end)', 'count(*)')} AS rate
                        FROM ${VISITS} WHERE arrived_at IS NOT NULL AND NOT live AND ${inRange} GROUP BY 1`),
    noh: rows(`SELECT ${WEEK} AS wk, count(*)::int AS visits, count(*) FILTER (WHERE outcome = 'no_one_home')::int AS noh,
                      ${PCT("count(*) FILTER (WHERE outcome = 'no_one_home')", 'count(*)')} AS rate FROM ${SC02} WHERE ${inRange} GROUP BY 1`),
    // The per-day figure (GAP-28): the week's calls over its days with a pilot visit, a whole number.
    calls: rows(`SELECT c.wk, c.n, CASE WHEN d.days IS NULL THEN NULL ELSE round(c.n::numeric / d.days)::int END AS per_day
                   FROM (SELECT to_char(${CALL_WEEK}, 'YYYY-MM-DD') AS wk, count(*)::int AS n FROM world.pilot_call WHERE ${callsInRange} GROUP BY 1) c
                   LEFT JOIN (SELECT ${WEEK} AS wk, count(DISTINCT date) AS days FROM (${PILOT}) p GROUP BY 1) d USING (wk)`),
    late: rows(`SELECT to_char(date_trunc('week', (delivered_at AT TIME ZONE 'America/New_York')), 'YYYY-MM-DD') AS wk, count(*)::int AS n
                  FROM world.outbox_text WHERE kind = 'late' AND status = 'delivered' AND ${inWeeks(range, "(delivered_at AT TIME ZONE 'America/New_York')")} GROUP BY 1`),
    tech: rows(`SELECT v.technician_name AS name, count(*) FILTER (WHERE NOT live)::int AS visits,
                       ${PCT('count(*) FILTER (WHERE arrived_at <= window_end AND NOT live)', 'count(*) FILTER (WHERE arrived_at IS NOT NULL AND NOT live)')} AS rate,
                       round(avg(extract(epoch FROM arrived_at - window_end) / 60) FILTER (WHERE arrived_at > window_end AND NOT live), 1)::float8 AS late_avg,
                       count(*) FILTER (WHERE outcome = 'no_one_home')::int AS noh,
                       (SELECT count(*) FROM world.pilot_call pc JOIN world.technician t ON t.id = pc.technician_id WHERE t.name = v.technician_name AND ${callsInRange})::int AS calls
                  FROM ${VISITS} WHERE technician_name IS NOT NULL AND ${inRange} GROUP BY technician_name`),
    before: periodTruth({ from: '2026-06-01', to: '2026-07-13' }, range),
    after: periodTruth({ from: '2026-07-20', to: '2026-09-14' }, range),
  };
}

/** The export's lines as an independent query writes them, sorted (FR-REP-3, SD-31): a time is the visit's local clock. */
const exportLines = (range: Weeks, branch?: string): string[] =>
  rows<{ line: string }>(`SELECT 'Simulated pilot data,' || initcap(branch_id) || ',' || coalesce(technician_name, '') || ',' || ${WEEK} || ','
                                 || to_char(window_start AT TIME ZONE zone, 'YYYY-MM-DD HH24:MI') || ' - ' || to_char(window_end AT TIME ZONE zone, 'HH24:MI') || ','
                                 || coalesce(to_char(arrived_at AT TIME ZONE zone, 'YYYY-MM-DD HH24:MI'), '') AS line
                            FROM ${VISITS} WHERE ${inWeeks(range)} ${branch ? `AND branch_id = '${branch}'` : ''}`).map((r) => r.line).sort();
/** The rows of an API-51 answer, sorted. */
const fileLines = (text: string): string[] => {
  const lines = text.replace(/^\uFEFF/, '').split('\r\n');
  expect(lines.pop()).toBe('');
  expect(lines[0]).toBe('Data source,Branch,Technician,Week,Booked window,Actual arrival');
  return lines.slice(1).sort();
};

/** Every figure of an API-50 answer over the whole pilot against the independent query, whatever the clock has done. */
function expectEveryNumberToEqualTheQuery(r: Json, t: Truth): void {
  for (const line of r.onTime) {
    for (const p of line.points) {
      const e = t.onTime.find((x) => x.wk === p.week && x.branch_id === line.branch);
      expect([p.visits, p.onTime, p.rate], `${line.branch} ${p.week}`).toEqual([e?.arrived ?? 0, e?.ontime ?? 0, e?.rate ?? null]);
    }
  }
  for (const w of r.noOneHome) {
    const e = t.noh.find((x) => x.wk === w.week);
    expect([w.visits, w.count, w.rate], w.week).toEqual([e?.visits ?? 0, e?.noh ?? 0, e?.rate ?? null]);
  }
  for (const c of r.calls) {
    const e = t.calls.find((x) => x.wk === c.week);
    expect([c.calls, c.perDay], c.week).toEqual([e?.n ?? 0, e?.per_day ?? null]);
  }
  for (const l of r.lateTexts) expect(l.count, l.week).toBe(t.late.find((x) => x.wk === l.week)?.n ?? 0);
  expect(r.technicians).toHaveLength(t.tech.length);
  for (const x of r.technicians) {
    const e = t.tech.find((y) => y.name === x.name);
    expect([x.visits, x.onTimeRate, x.averageMinutesLate, x.noOneHome, x.calls], x.name).toEqual([e?.visits, e?.rate, e?.late_avg, e?.noh, e?.calls]);
  }
  const lastCalls = t.calls.find((x) => x.wk === r.headline.week);
  expect([r.headline.calls.count, r.headline.calls.perDay], 'the calls card').toEqual([lastCalls?.n ?? 0, lastCalls?.per_day ?? null]);
  expect([r.headline.calls.before, r.headline.calls.after], 'the calls card, before and after').toEqual([t.before.calls, t.after.calls]);
  expect([r.headline.noOneHome.before, r.headline.noOneHome.after], 'the no-one-home card, before and after').toEqual([t.before.noh, t.after.noh]);
  expect([r.headline.onTime.before, r.headline.onTime.after], 'the on-time card, before and after').toEqual([t.before.onTime, t.after.onTime]);
}

describe('API-50 on the seeded world: every number equals the independent query (SC-01, SC-02, SC-03)', () => {
  // why: SC-01 SC-02 SC-03 FR-REP-1 FR-REP-2 FR-REP-7 FR-REP-8 each figure of the whole pilot, as the real handlers answer it, equals the SQL on the generated rows: the per-day figure of every week and the before and after calls included
  it('on time, no one home, calls, late texts and the technician table equal the SQL', async () => {
    const r = (await report()).data;
    const t = truth();
    expect(t.onTime.length).toBeGreaterThan(30);
    expect(t.calls).toHaveLength(15);
    expect(r.weeks).toHaveLength(15);
    expectEveryNumberToEqualTheQuery(r, t);
    expect(r.technicians.map((x: Json) => x.onTimeRate)).toEqual([...r.technicians.map((x: Json) => x.onTimeRate)].sort((a: number, b: number) => b - a));
  });

  // why: SC-01 SC-02 SC-03 the planted pilot of SD-25: before near 74% on time and 6% no one home with about twice the calls per visit, after at least 90% and under 3%
  it('shows the planted before and after periods', async () => {
    const r = (await report()).data;
    const t = truth();
    const sum = (rowsOf: { wk: string }[], from: string, to: string, f: (x: any) => number) => rowsOf.filter((x) => x.wk >= from && x.wk <= to).reduce((s, x) => s + f(x), 0);
    const period = (from: string, to: string) => ({
      onTime: (100 * sum(t.onTime, from, to, (x) => x.ontime)) / sum(t.onTime, from, to, (x) => x.arrived),
      noh: (100 * sum(t.noh, from, to, (x) => x.noh)) / sum(t.noh, from, to, (x) => x.visits),
      callsPerVisit: sum(t.calls as any, from, to, (x) => x.n) / sum(t.noh, from, to, (x) => x.visits),
    });
    const before = period('2026-06-01', '2026-07-13');
    const after = period('2026-07-20', '2026-09-14');
    expect(before.onTime).toBeGreaterThan(70);
    expect(before.onTime).toBeLessThan(78);
    expect(before.noh).toBeGreaterThan(5);
    expect(before.noh).toBeLessThan(7);
    expect(after.onTime).toBeGreaterThanOrEqual(90);
    expect(after.noh).toBeLessThan(3);
    expect(before.callsPerVisit / after.callsPerVisit).toBeGreaterThan(1.6);
    expect(before.callsPerVisit / after.callsPerVisit).toBeLessThan(2.4);
    // the headline's period figures are the same numbers (all branches, whole range)
    expect(Math.abs(r.headline.onTime.before - before.onTime)).toBeLessThan(0.06);
    expect(Math.abs(r.headline.onTime.after - after.onTime)).toBeLessThan(0.06);
    expect(Math.abs(r.headline.noOneHome.before - before.noh)).toBeLessThan(0.06);
    expect(Math.abs(r.headline.noOneHome.after - after.noh)).toBeLessThan(0.06);
  });

  // why: FR-REP-4 FR-REP-6 the answer carries the Simulated pilot data label and the goals 90% and 3% with their label keys
  it('carries the label and the goals', async () => {
    const body = await report();
    expect(body.meta.labels).toContain('simulated_pilot_data');
    expect(body.data.goals).toEqual({ onTime: { rate: 90, labelKey: 'reports.goal.onTime' }, noOneHome: { rate: 3, labelKey: 'reports.goal.noOneHome' } });
  });

  // why: FR-REP-3 every value of the export equals an independent query on the rows and the screen's visits: line by line for the whole pilot, Jul 6 to Aug 30 and 1 branch
  it('holds the values of the independent query in the export', async () => {
    for (const [q, weeks, branch] of [['', DEFAULT_RANGE, undefined], [LIVE_QUERY, WHOLE, undefined], ['?fromWeek=2026-07-06&toWeek=2026-08-24', JUL_AUG, undefined], ['?branch=dayton&fromWeek=2026-07-06&toWeek=2026-08-24', JUL_AUG, 'dayton']] as const) {
      const r = await call(people.dana!, `/reports/export${q}`);
      expect(r.status).toBe(200);
      const got = fileLines(r.text);
      const want = exportLines(weeks, branch);
      expect(want.length).toBeGreaterThan(100);
      expect(got).toEqual(want);
      // and the screen's: each technician's rows are the visits the table shows
      const page = (await report(q)).data;
      const perTechnician = new Map<string, number>();
      for (const l of got) perTechnician.set(l.split(',')[2]!, (perTechnician.get(l.split(',')[2]!) ?? 0) + 1);
      for (const x of page.technicians) expect(perTechnician.get(x.name), x.name).toBe(x.visits);
    }
  });

  // why: FR-REP-3 FR-REP-4 the export holds one row per visit of the page's filters, the label in its first column and the 6 columns of SD-31
  it('streams the export from the same rows as the page', async () => {
    for (const q of ['', '?branch=dayton&fromWeek=2026-07-06&toWeek=2026-08-17']) {
      const page = (await report(q)).data;
      const r = await call(people.dana!, `/reports/export${q}`);
      expect(r.status).toBe(200);
      const lines = r.text.replace(/^﻿/, '').split('\r\n');
      expect(lines.pop()).toBe('');
      expect(lines[0]).toBe('Data source,Branch,Technician,Week,Booked window,Actual arrival');
      expect(lines.length - 1).toBe(page.totals.visits);
      expect(lines.slice(1).every((l) => l.startsWith('Simulated pilot data,'))).toBe(true);
      expect(lines.slice(1).filter((l) => l.endsWith(',')).length).toBe(page.noOneHome.reduce((s: number, w: Json) => s + w.count, 0) - (q === '' ? Number(psql("SELECT count(*) FROM world.job WHERE NOT pilot AND status = 'no_one_home' AND date >= '2026-09-15' AND arrived_at IS NOT NULL")) : 0));
    }
  });
});

interface Open { page: Page; g: GuardedContext }
async function open(browser: Browser, path: string, { who = 'dana', lang = 'en', viewport = { width: 1440, height: 1100 } }: { who?: keyof typeof people | { token: string }; lang?: 'en' | 'es'; viewport?: { width: number; height: number } } = {}): Promise<Open & { status: number }> {
  const g = await guardedContext(browser, [origin], { viewport });
  const token = typeof who === 'string' ? people[who]! : who.token;
  await g.context.addCookies([{ name: 'bw_session', value: token, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  const page = await g.context.newPage();
  const res = await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return { page, g, status: res?.status() ?? 0 };
}
const ready = (p: Page) => p.waitForSelector(`${SCREEN} .kpis`, { timeout: 60_000 });
/** A manager reaches the live week as the page offers it: the To week select, then the page's own re-read (the page asks for toWeek and the headline names that week). */
async function pickLiveWeek(p: Page): Promise<void> {
  await p.locator(`${SCREEN} .rh select[aria-label="To"]`).selectOption(LIVE_WEEK);
  await p.waitForFunction((w) => location.search.includes(`to=${w}`), LIVE_WEEK);
  await p.waitForFunction((t) => document.querySelector('.kpi:nth-child(1) .l')?.textContent === t, `On-time arrivals, week of ${day(LIVE_WEEK)}`);
}
/** The index of the last mark of a line, whether or not another line's mark is drawn over it (F-1597: the chart hands the pointer to the nearest mark). */
async function lastPoint(p: Page, label: string): Promise<number> {
  return p.evaluate(({ screen, label: want }) => {
    const marks = Array.from(document.querySelectorAll(`${screen} svg.chart[data-ctl="CTL-OFC-11-06"] circle`) as ArrayLike<any>);
    let found = -1;
    marks.forEach((c, i) => { if ((c.getAttribute('aria-label') ?? '').startsWith(`${want},`)) found = i; });
    return found;
  }, { screen: SCREEN, label });
}
/** The pointer over the middle of a mark, as a user's mouse is (not an element click, which a covering mark would intercept). */
async function pointerOver(p: Page, mark: Locator): Promise<void> {
  await mark.scrollIntoViewIfNeeded();
  const box = (await mark.boundingBox())!;
  await p.mouse.move(1, 1);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
}
const texts = (p: Page, sel: string) => p.locator(sel).evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));

describe.each(engines)('the Reports page on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-REP-4 FR-REP-1 FR-REP-2 FR-REP-8 SC-01 SC-02 SC-03 the page carries the Simulated pilot data label and prints the cards the real API answered (and the SQL holds)
  it('carries the label and prints the cards the API answered', async () => {
    const r = (await report()).data;
    const h = r.headline;
    const o = await open(browser, '/office/reports');
    try {
      expect(o.status).toBe(200);
      await ready(o.page);
      expect(await texts(o.page, `${SCREEN} .rh .sim .chip`)).toEqual(['Simulated pilot data']);
      expect(await texts(o.page, `${SCREEN} .rh h1`)).toEqual(['Arrivals and calls']);
      const kpi = (n: number, part: string) => texts(o.page, `${SCREEN} .kpi:nth-child(${n}) ${part}`).then((a) => a[0]);
      expect(await kpi(1, '.l')).toBe(`On-time arrivals, week of ${day(h.week)}`);
      expect(await kpi(1, '.v')).toBe(pct(h.onTime.rate));
      expect(await kpi(1, '.s')).toBe(`Goal: 90% inside the 2-hour window. Before ${pct(h.onTime.before)}, after ${pct(h.onTime.after)}`);
      expect(await kpi(2, '.v')).toBe(count(h.calls.count));
      expect(await kpi(2, '.s')).toBe(`This week, about ${count(h.calls.perDay)} a day. Before ${count(h.calls.before)}, after ${count(h.calls.after)}`);
      expect(await kpi(3, '.v')).toBe(pct(h.noOneHome.rate));
      expect(await kpi(3, '.s')).toBe(`${count(h.noOneHome.count)} of ${count(h.noOneHome.visits)} visits - goal under 3%. Before ${pct(h.noOneHome.before)}, after ${pct(h.noOneHome.after)}`);
      expect(await kpi(4, '.v')).toBe(count(h.lateTexts));
      // the last week's cards equal the SQL, not only the API
      const t = truth();
      const last = t.noh.find((x) => x.wk === h.week)!;
      expect([h.noOneHome.count, h.noOneHome.visits]).toEqual([last.noh, last.visits]);
    } finally {
      await o.g.context.close();
    }
  }, 120_000);

  // why: FR-REP-7 FR-REP-5 the by-technician table lists what the API answered, highest on-time rate first, under a heading that names the branch and the week range
  it('prints the by-technician table and its heading', async () => {
    const r = (await report()).data;
    const o = await open(browser, '/office/reports');
    try {
      await ready(o.page);
      expect(await texts(o.page, `${SCREEN} h3[data-ctl="CTL-OFC-11-16"]`)).toEqual([`By technician - All branches, ${day(r.fromWeek)} to ${day(new Date(Date.parse(`${r.toWeek}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10))}`]);
      const cells = await o.page.$$eval(`${SCREEN} table[data-ctl="CTL-OFC-11-10"] tbody tr`, (trs: any[]) => trs.map((tr) => Array.from(tr.querySelectorAll('td') as ArrayLike<{ textContent: string | null }>, (td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())));
      expect(cells).toHaveLength(r.technicians.length);
      r.technicians.forEach((x: Json, i: number) => {
        expect(cells[i], x.name).toEqual([expect.stringContaining(x.name), count(x.visits), pct(x.onTimeRate), x.averageMinutesLate === null ? 'n/a' : decimal(x.averageMinutesLate), count(x.noOneHome), count(x.calls)]);
      });
    } finally {
      await o.g.context.close();
    }
  }, 120_000);

  // why: FR-REP-5 the branch, technician and week range filters change every card, chart and table, and are kept in the address
  it('filters by branch, technician and weeks', async () => {
    const o = await open(browser, '/office/reports');
    try {
      await ready(o.page);
      const select = (label: string) => o.page.locator(`${SCREEN} .rh select[aria-label="${label}"]`);
      // Technician is disabled for All branches.
      await expect(select('Technician').isDisabled()).resolves.toBe(true);
      await select('Branch').selectOption('dayton');
      await o.page.waitForFunction(() => location.search.includes('branch=dayton'));
      const dayton = (await report('?branch=dayton')).data;
      await o.page.waitForFunction((t) => document.querySelector('.kpi:nth-child(3) .v')?.textContent === t, pct(dayton.headline.noOneHome.rate));
      expect(await texts(o.page, `${SCREEN} h3[data-ctl="CTL-OFC-11-16"]`)).toEqual([expect.stringContaining('By technician - Dayton,')]);
      expect(await texts(o.page, `${SCREEN} .kpi:nth-child(1) .v`)).toEqual([pct(dayton.headline.onTime.rate)]);
      // the legend and the lines show 1 branch
      expect(await texts(o.page, `${SCREEN} .panel .lg span:not(.tbt)`)).toEqual(expect.arrayContaining(['Dayton']));
      // a technician of the branch
      const tech = dayton.choices.technicians[0];
      await expect(select('Technician').isDisabled()).resolves.toBe(false);
      await select('Technician').selectOption(tech.id);
      await o.page.waitForFunction((n) => document.querySelectorAll('table[data-ctl="CTL-OFC-11-10"] tbody tr').length === n, 1);
      expect(await texts(o.page, `${SCREEN} table[data-ctl="CTL-OFC-11-10"] tbody tr .who`)).toEqual([expect.stringContaining(tech.name)]);
      const one = (await report(`?branch=dayton&technicianId=${tech.id}`)).data;
      expect(await texts(o.page, `${SCREEN} .kpi:nth-child(2) .v`)).toEqual([count(one.headline.calls.count)]);
      expect(o.page.url()).toContain(`technician=${tech.id}`);
      // a week range: the page asks for it and prints its table heading
      await select('Branch').selectOption('all');
      const weeks = (await report()).data.choices.weeks as string[];
      await select('From').selectOption(weeks[6]!);
      await select('To').selectOption(weeks[11]!);
      await o.page.waitForFunction((w) => location.search.includes(`from=${w}`), weeks[6]!);
      const ranged = (await report(`?fromWeek=${weeks[6]}&toWeek=${weeks[11]}`)).data;
      await o.page.waitForFunction((t) => document.querySelector('.kpi:nth-child(1) .l')?.textContent === t, `On-time arrivals, week of ${day(ranged.headline.week)}`);
      expect(await texts(o.page, `${SCREEN} .kpi:nth-child(3) .v`)).toEqual([pct(ranged.headline.noOneHome.rate)]);
      expect(await o.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-08"] path[data-ctl="CTL-OFC-11-13"]`).count()).toBe(ranged.weeks.length);
      // a last week before the first week is held on the page with its message
      await select('To').selectOption(weeks[2]!);
      expect(await texts(o.page, `${SCREEN} .r1-fmsg`)).toEqual([msg('reports.filter.weekOrder')]);
    } finally {
      await o.g.context.close();
    }
  }, 180_000);

  // why: F-741 Export is off on an inverted range (it called API-51, got 422 and added a second message), the week selects stay on Error (an address with a bad week
  // left a Try again that could never work), and a top-bar branch change takes the old technician out of the address
  it('holds Export off on an inverted range, keeps the week selects on Error, and drops the technician from the address with a branch change', async () => {
    const o = await open(browser, '/office/reports');
    try {
      await ready(o.page);
      const select = (label: string) => o.page.locator(`${SCREEN} .rh select[aria-label="${label}"]`);
      const weeks = (await report()).data.choices.weeks as string[];
      await select('To').selectOption(weeks[2]!);
      await select('From').selectOption(weeks[6]!);
      expect(await texts(o.page, `${SCREEN} .r1-fmsg`)).toEqual([msg('reports.filter.weekOrder')]);
      await expect(o.page.locator(`${SCREEN} button[data-ctl="CTL-OFC-11-04"]`).isDisabled()).resolves.toBe(true);
    } finally {
      await o.g.context.close();
    }
    const bad = await open(browser, '/office/reports?from=2026-02-30');
    try {
      await bad.page.waitForSelector(`${SCREEN} .rh select[aria-label="From"]`, { timeout: 60_000 });
      expect(await bad.page.locator(`${SCREEN} .kpis`).count()).toBe(0);
      const weeks = (await report()).data.choices.weeks as string[];
      await bad.page.locator(`${SCREEN} .rh select[aria-label="From"]`).selectOption(weeks[0]!);
      await ready(bad.page);
    } finally {
      await bad.g.context.close();
    }
    const dayton = (await report('?branch=dayton')).data;
    const tech = dayton.choices.technicians[0];
    const t = await open(browser, `/office/reports?branch=dayton&technician=${tech.id}`);
    try {
      await ready(t.page);
      await t.page.locator(`${SCREEN} .topbar select`).selectOption('columbus');
      await t.page.waitForFunction(() => location.search.includes('branch=columbus'));
      await t.page.waitForFunction(() => !location.search.includes('technician='));
      await ready(t.page);
    } finally {
      await t.g.context.close();
    }
  }, 180_000);

  // why: FR-REP-1 FR-REP-2 FR-REP-6 NFR-06 the chart tips name the branch, week and value the API answered, open on hover and on keyboard focus and close with Escape; Show as table swaps in the data table with the goal
  it('tips the points and bars, and shows each chart as a table', async () => {
    const r = (await report()).data;
    const o = await open(browser, '/office/reports');
    try {
      await ready(o.page);
      const col = r.onTime.find((l: Json) => l.branch === 'columbus');
      // F-1597: at the last whole week Columbus and Dayton end 4 px apart and Dayton's mark covers Columbus's; the pointer over Columbus's own mark reaches it
      const at = await lastPoint(o.page, 'Columbus');
      expect(at).toBe(col.points.length - 1);
      const lastPt = col.points[at];
      const circle = o.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-06"] circle`).nth(at);
      const expected = `Columbus, week of ${day(lastPt.week)}: ${pct(lastPt.rate)}`;
      await pointerOver(o.page, circle);
      await expect(o.page.locator(`${SCREEN} .r1-pop[role="tooltip"]`).innerText()).resolves.toBe(expected);
      await o.page.keyboard.press('Escape');
      await expect(o.page.locator(`${SCREEN} .r1-pop[role="tooltip"]`).count()).resolves.toBe(0);
      await circle.focus();
      await expect(o.page.locator(`${SCREEN} .r1-pop[role="tooltip"]`).innerText()).resolves.toBe(expected);
      const bar = o.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-08"] path[data-ctl="CTL-OFC-11-13"]`).last();
      const lastCalls = r.calls[r.calls.length - 1];
      await bar.focus();
      await expect(o.page.locator(`${SCREEN} .r1-pop[role="tooltip"]`).innerText()).resolves.toBe(`Week of ${day(lastCalls.week)}: ${count(lastCalls.calls)}`);
      // the goal lines are labeled
      expect(await texts(o.page, `${SCREEN} svg.chart[data-ctl="CTL-OFC-11-06"] text`)).toContain('Goal 90%');
      expect(await texts(o.page, `${SCREEN} .panel .lg span`)).toContain('Goal: under 3%');
      // Show as table: the data table of the calls chart, one row per week
      await o.page.locator(`${SCREEN} .tbt`).nth(1).click();
      const table = o.page.locator(`${SCREEN} .bw-rp-dt.on table`);
      expect(await table.locator('tbody tr').count()).toBe(r.calls.length);
      expect(await texts(o.page, `${SCREEN} .bw-rp-dt.on tbody tr:last-child td`)).toEqual([day(lastCalls.week), count(lastCalls.calls), count(lastCalls.perDay)]);
      // the on-time chart's table repeats the goal
      await o.page.locator(`${SCREEN} .tbt`).nth(0).click();
      expect(await texts(o.page, `${SCREEN} .bw-rp-dt.on caption`)).toEqual(['Goal 90%']);
    } finally {
      await o.g.context.close();
    }
  }, 120_000);

  // why: FR-REP-3 Export to spreadsheet downloads the file API-51 answers for the page's filters, with the label, and the file's rows equal the screen's visits
  it('downloads the export of the shown filters', async () => {
    const o = await open(browser, '/office/reports?branch=dayton');
    try {
      await ready(o.page);
      const [download] = await Promise.all([o.page.waitForEvent('download'), o.page.locator(`${SCREEN} .rh .btn.primary`).click()]);
      expect(download.suggestedFilename()).toMatch(/^reports-dayton-2026-09-15\.csv$/);
      const text = readFileSync((await download.path()) as string, 'utf8');
      const api = await call(people.dana!, '/reports/export?branch=dayton&language=en');
      expect(text.replace(/^﻿/, '')).toBe(api.text.replace(/^﻿/, ''));
      expect(text.startsWith('﻿Data source,Branch,Technician,Week,Booked window,Actual arrival\r\n')).toBe(true);
      expect(text.split('\r\n').length - 2).toBe((await report('?branch=dayton')).data.totals.visits);
    } finally {
      await o.g.context.close();
    }
  }, 120_000);

  // why: FR-LANG-3 FR-REP-4 the Spanish page carries the label, the heading and the numbers in Spanish, and the Spanish export its header
  it('says it all in Spanish', async () => {
    const r = (await report()).data;
    const o = await open(browser, '/office/reports', { lang: 'es' });
    try {
      await ready(o.page);
      expect(await texts(o.page, `${SCREEN} .rh .sim .chip`)).toEqual([CATALOG.es['reports.label.simulated']]);
      expect(await texts(o.page, `${SCREEN} .rh h1`)).toEqual([CATALOG.es['reports.title']]);
      expect(await texts(o.page, `${SCREEN} .kpi:nth-child(3) .v`)).toEqual([`${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(r.headline.noOneHome.rate)}%`]);
      expect(await texts(o.page, `${SCREEN} .kpi:nth-child(4) .l`)).toEqual([CATALOG.es['reports.kpi.lateTexts']]);
      const es = await call(people.dana!, '/reports/export?language=es');
      expect(es.text.replace(/^﻿/, '').split('\r\n')[0]).toBe('Origen de los datos,Sucursal,Técnico,Semana,Ventana reservada,Llegada real');
    } finally {
      await o.g.context.close();
    }
  }, 120_000);

  // why: FR-REP-2 SC-02 a live No one home visit of Sep 15 raises the count of its week by 1 and its visits by 1 (the page's card, the API and the SQL agree)
  it('counts a live No one home visit in its week', async () => {
    const before = (await report(LIVE_QUERY)).data;
    const beforeLast = before.noOneHome[before.noOneHome.length - 1];
    const n = psql(`SELECT job_number FROM world.job WHERE NOT pilot AND status = 'scheduled' AND date = '2026-09-15' AND technician_id IS NOT NULL ORDER BY job_number LIMIT 1`);
    expect(n).not.toBe('');
    psql(`UPDATE world.job SET status = 'no_one_home', arrived_at = window_start + interval '20 minutes', ended_at = window_start + interval '25 minutes' WHERE job_number = ${n}`);
    try {
      const after = (await report(LIVE_QUERY)).data;
      const afterLast = after.noOneHome[after.noOneHome.length - 1];
      expect(afterLast).toMatchObject({ week: LIVE_WEEK, count: beforeLast.count + 1, visits: beforeLast.visits + 1 });
      expect(beforeLast.week).toBe(LIVE_WEEK);
      const sql = rows(`SELECT count(*)::int AS visits, count(*) FILTER (WHERE outcome = 'no_one_home')::int AS noh FROM ${SC02} WHERE ${WEEK} = '${afterLast.week}'`)[0];
      expect(sql).toEqual({ visits: afterLast.visits, noh: afterLast.count });
      const o = await open(browser, '/office/reports');
      try {
        await ready(o.page);
        await pickLiveWeek(o.page);
        expect(await texts(o.page, `${SCREEN} .kpi:nth-child(3) .s [data-ctl="CTL-OFC-11-17"]`)).toEqual([`${count(afterLast.count)} of ${count(afterLast.visits)} visits - goal under 3%.`]);
        expect(await texts(o.page, `${SCREEN} .kpi:nth-child(3) .v`)).toEqual([pct(afterLast.rate)]);
      } finally {
        await o.g.context.close();
      }
    } finally {
      // The autopilot still owns this job: the live week below needs it as the seed left it.
      psql(`UPDATE world.job SET status = 'scheduled', arrived_at = NULL, ended_at = NULL WHERE job_number = ${n}`);
    }
  }, 120_000);

  // why: FR-REP-4 changing 1 generated visit changes the report: an on-time past visit made 40 minutes late takes 1 off its week's on-time count, on the API, in the file and on the page, and the SQL agrees
  it('changes when 1 generated visit changes', async () => {
    const range = { from: '2026-07-06', to: '2026-07-06' };
    const q = `?branch=columbus&fromWeek=${range.from}&toWeek=${range.to}`;
    const [picked] = rows<{ id: string; arrived: string }>(`SELECT pv.id, pv.arrived_at::text AS arrived FROM world.past_visit pv JOIN world.customer c ON c.id = pv.customer_id
      WHERE c.branch_id = 'columbus' AND pv.date = '2026-07-08' AND pv.arrived_at <= pv.window_end ORDER BY pv.id LIMIT 1`);
    expect(picked).toBeDefined();
    const before = (await report(q)).data.onTime[0].points[0];
    const beforeFile = fileLines((await call(people.dana!, `/reports/export${q}`)).text);
    psql(`UPDATE world.past_visit SET arrived_at = window_end + interval '40 minutes' WHERE id = '${picked!.id}'`);
    try {
      const after = (await report(q)).data.onTime[0].points[0];
      expect([after.onTime, after.visits]).toEqual([before.onTime - 1, before.visits]);
      expect(after.rate).not.toBe(before.rate);
      const sql = truth(range).onTime.find((x) => x.branch_id === 'columbus')!;
      expect([after.onTime, after.visits, after.rate]).toEqual([sql.ontime, sql.arrived, sql.rate]);
      const afterFile = fileLines((await call(people.dana!, `/reports/export${q}`)).text);
      expect(afterFile.filter((l) => !beforeFile.includes(l))).toHaveLength(1);
      const o = await open(browser, `/office/reports?branch=columbus&from=${range.from}&to=${range.to}`);
      try {
        await ready(o.page);
        expect(await texts(o.page, `${SCREEN} .kpi:nth-child(1) .v`)).toEqual([pct(after.rate)]);
      } finally {
        await o.g.context.close();
      }
    } finally {
      psql(`UPDATE world.past_visit SET arrived_at = '${picked!.arrived}'::timestamptz WHERE id = '${picked!.id}'`);
    }
    expect((await report(q)).data.onTime[0].points[0]).toEqual(before);
  }, 120_000);

  // why: FR-REP-5 picking Jul 6 to Aug 30 shows only those weeks in every card, chart and table, and their values equal an independent query over that range
  it('shows Jul 6 to Aug 30 and every figure equals the independent query over that range', async () => {
    const t = truth(JUL_AUG);
    const WEEKS = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'];
    const o = await open(browser, '/office/reports');
    try {
      await ready(o.page);
      await o.page.locator(`${SCREEN} .rh select[aria-label="From"]`).selectOption({ label: 'Jul 6' });
      await o.page.locator(`${SCREEN} .rh select[aria-label="To"]`).selectOption({ label: 'Aug 30' });
      await o.page.waitForFunction((want) => document.querySelector('h3[data-ctl="CTL-OFC-11-16"]')?.textContent === want, 'By technician - All branches, Jul 6 to Aug 30');
      await o.page.waitForFunction(() => document.querySelector('.kpi:nth-child(1) .l')?.textContent === 'On-time arrivals, week of Aug 24');
      expect(o.page.url()).toContain('from=2026-07-06');
      expect(o.page.url()).toContain('to=2026-08-24');
      // the API answers those 8 weeks and the SQL's figures
      const r = (await report('?fromWeek=2026-07-06&toWeek=2026-08-24')).data;
      expect(r.weeks).toEqual(WEEKS);
      expectEveryNumberToEqualTheQuery(r, t);
      // the cards, from the SQL
      const wk = WEEKS[7]!;
      const onTime = t.onTimeWeek.find((x) => x.wk === wk)!;
      const calls = t.calls.find((x) => x.wk === wk)!;
      const noh = t.noh.find((x) => x.wk === wk)!;
      const kpi = (n: number, part: string) => texts(o.page, `${SCREEN} .kpi:nth-child(${n}) ${part}`).then((a) => a[0]);
      expect(await kpi(1, '.v')).toBe(pct(onTime.rate));
      expect(await kpi(1, '.s')).toBe(`Goal: 90% inside the 2-hour window. Before ${pct(t.before.onTime)}, after ${pct(t.after.onTime)}`);
      expect(await kpi(2, '.v')).toBe(count(calls.n));
      expect(await kpi(2, '.s')).toBe(`This week, about ${count(calls.per_day)} a day. Before ${count(t.before.calls)}, after ${count(t.after.calls)}`);
      expect(await kpi(3, '.v')).toBe(pct(noh.rate));
      expect(await kpi(3, '.s')).toBe(`${count(noh.noh)} of ${count(noh.visits)} visits - goal under 3%. Before ${pct(t.before.noh)}, after ${pct(t.after.noh)}`);
      expect(await kpi(4, '.v')).toBe(count(t.late.find((x) => x.wk === wk)?.n ?? 0));
      // the 3 charts: each mark names its week and the SQL's value, and no other week has a mark
      const marks = (sel: string) => o.page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      const branchLines = [['columbus', 'Columbus'], ['dayton', 'Dayton'], ['springfield', 'Springfield']] as const;
      expect(await marks(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-06"] circle`)).toEqual(
        branchLines.flatMap(([id, name]) => WEEKS.map((w) => `${name}, week of ${day(w)}: ${pct(t.onTime.find((x) => x.wk === w && x.branch_id === id)!.rate)}`)));
      expect(await marks(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-08"] path[data-ctl="CTL-OFC-11-13"]`)).toEqual(WEEKS.map((w) => `Week of ${day(w)}: ${count(t.calls.find((x) => x.wk === w)!.n)}`));
      expect(await marks(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-09"] path[data-ctl="CTL-OFC-11-13"]`)).toEqual(WEEKS.map((w) => `Week of ${day(w)}: ${pct(t.noh.find((x) => x.wk === w)!.rate)}`));
      // the 3 data tables and the by-technician table
      const table = (sel: string) => o.page.$$eval(`${sel} tbody tr`, (trs: any[]) => trs.map((tr) => Array.from(tr.querySelectorAll('td') as ArrayLike<{ textContent: string | null }>, (td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())));
      const data = `${SCREEN} .bw-rp-dt`;
      const dataRows = await o.page.locator(data).evaluateAll((els: any[]) => els.map((el) => Array.from(el.querySelectorAll('tbody tr') as ArrayLike<any>, (tr: any) => Array.from(tr.querySelectorAll('td') as ArrayLike<{ textContent: string | null }>, (td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()))));
      expect(dataRows[0]).toEqual(WEEKS.map((w) => [day(w), ...branchLines.map(([id]) => pct(t.onTime.find((x) => x.wk === w && x.branch_id === id)!.rate))]));
      expect(dataRows[1]).toEqual(WEEKS.map((w) => { const c = t.calls.find((x) => x.wk === w)!; return [day(w), count(c.n), count(c.per_day)]; }));
      expect(dataRows[2]).toEqual(WEEKS.map((w) => { const n = t.noh.find((x) => x.wk === w)!; return [day(w), pct(n.rate), `${count(n.noh)} / ${count(n.visits)}`]; }));
      const sorted = [...t.tech].sort((x, y) => (y.rate ?? -1) - (x.rate ?? -1) || x.name.localeCompare(y.name));
      const cells = await table(`${SCREEN} table[data-ctl="CTL-OFC-11-10"]`);
      expect(cells).toEqual(sorted.map((x) => [expect.stringContaining(x.name), count(x.visits), pct(x.rate), x.late_avg === null ? 'n/a' : decimal(x.late_avg), count(x.noh), count(x.calls)]));
    } finally {
      await o.g.context.close();
    }
  }, 180_000);

  // why: FR-REP-6 a screen reader reads each goal (the accessibility tree the browser gives it: both charts' names and, on a phone, the data tables' names), and the goal lines stand at 90% and 3% on their charts' scales
  it('gives a screen reader each goal and draws the goal lines at 90% and 3%', async () => {
    const o = await open(browser, '/office/reports');
    try {
      await ready(o.page);
      const onTime = o.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-06"]`);
      const noOneHome = o.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-09"]`);
      expect(await onTime.ariaSnapshot()).toContain('Goal 90%.');
      expect(await noOneHome.ariaSnapshot()).toContain('No-one-home visits by week. Goal: under 3%.');
      // the line itself: its height on the chart's own scale, read from the axis the chart draws
      const goalAt = (chart: string) => o.page.locator(`${SCREEN} ${chart}`).evaluate((svg: any) => {
        const ticks = Array.from(svg.querySelectorAll('g') as ArrayLike<any>, (g: any) => ({ line: g.querySelector(':scope > line'), label: g.querySelector(':scope > text') }))
          .filter((x) => x.line && x.label && /%$/.test(x.label.textContent))
          .map((x) => ({ y: Number(x.line.getAttribute('y1')), v: Number(x.label.textContent.replace('%', '')) }));
        const dashed = Array.from(svg.querySelectorAll('line') as ArrayLike<any>).filter((l: any) => l.getAttribute('stroke-dasharray') === '5 4');
        const a = ticks[0]!;
        const b = ticks[ticks.length - 1]!;
        return { lines: dashed.length, value: a.v + ((Number(dashed[0].getAttribute('y1')) - a.y) * (b.v - a.v)) / (b.y - a.y) };
      });
      const ninety = await goalAt('svg.chart[data-ctl="CTL-OFC-11-06"]');
      const three = await goalAt('svg.chart[data-ctl="CTL-OFC-11-09"]');
      expect(ninety.lines).toBe(1);
      expect(three.lines).toBe(1);
      expect(ninety.value).toBeCloseTo(90, 5);
      expect(three.value).toBeCloseTo(3, 5);
    } finally {
      await o.g.context.close();
    }
    const es = await open(browser, '/office/reports', { lang: 'es' });
    try {
      await ready(es.page);
      expect(await es.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-06"]`).ariaSnapshot()).toContain('Meta 90%.');
      expect(await es.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-09"]`).ariaSnapshot()).toContain('Visitas sin nadie en casa por semana. Meta: menos de 3%.');
    } finally {
      await es.g.context.close();
    }
    // A phone swaps the charts for their data tables: the table's accessible name is the goal.
    const phone = await open(browser, '/office/reports', { viewport: { width: 390, height: 844 } });
    try {
      await ready(phone.page);
      expect(await phone.page.getByRole('table', { name: 'Goal 90%', exact: true }).count()).toBe(1);
      expect(await phone.page.getByRole('table', { name: 'Goal: under 3%', exact: true }).count()).toBe(1);
    } finally {
      await phone.g.context.close();
    }
  }, 180_000);

  // why: FR-REP-1 FR-REP-2 NFR-06 a chart tip sits over the chart and never moves it, holds still with the pointer resting on a mark, and stays while the pointer is on the tip itself (the pointer passes through it, F-786): reachable from the marks nearest and farthest from it (CTL-OFC-11-13)
  it('keeps the chart still under a tip and the tip up with the pointer on it', async () => {
    const o = await open(browser, '/office/reports');
    try {
      await ready(o.page);
      const tip = o.page.locator(`${SCREEN} .r1-pop[role="tooltip"]`);
      const tops = () => o.page.evaluate(() => Array.from(document.querySelectorAll('svg.chart') as ArrayLike<any>, (e: any) => Math.round(e.getBoundingClientRect().top)));
      const still = await tops();
      expect(still).toHaveLength(3);
      expect(await tip.count()).toBe(0);
      /** Holds for 1 s: the tip up and the charts where they were, sampled each 100 ms (a tip that loops or shifts shows here, not on a single read). */
      const holds = async (what: string) => {
        for (let i = 0; i < 10; i += 1) {
          expect([await tip.count(), await tops()], `${what}, sample ${i}`).toEqual([1, still]);
          await o.page.waitForTimeout(100);
        }
      };
      const points = o.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-06"] circle`);
      for (const mark of [points.nth(await lastPoint(o.page, 'Columbus')), points.first(), o.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-08"] path[data-ctl="CTL-OFC-11-13"]`).first(), o.page.locator(`${SCREEN} svg.chart[data-ctl="CTL-OFC-11-09"] path[data-ctl="CTL-OFC-11-13"]`).last()]) {
        await pointerOver(o.page, mark);
        await holds('the pointer on the mark');
        expect(await tip.evaluate((e: any) => (globalThis as any).getComputedStyle(e).position)).toBe('absolute');
        const said = await tip.innerText();
        // the pointer travels to the tip, past whatever lies between
        const box = (await tip.boundingBox())!;
        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await o.page.mouse.move(at.x, at.y, { steps: 25 });
        // F-786: the tip lets the pointer through, so a mark under it stays hoverable; the point still lies inside the panel that holds the tip
        expect(await tip.evaluate((e: any) => (globalThis as any).getComputedStyle(e).pointerEvents)).toBe('none');
        expect(await o.page.evaluate((p) => { const hit = document.elementFromPoint(p.x, p.y); const el = document.querySelector('.r1-pop[role="tooltip"]'); return hit !== null && hit.closest('.r1-pop') === null && !!el && !!el.parentElement && el.parentElement.contains(hit); }, at)).toBe(true);
        await holds('the pointer on the tip');
        expect(await tip.innerText()).not.toBe('');
        expect(said).not.toBe('');
        // off the panel it closes, and nothing moved
        await o.page.mouse.move(1, 1, { steps: 3 });
        await expect.poll(() => tip.count(), { timeout: 5_000 }).toBe(0);
        expect(await tops()).toEqual(still);
      }
      // keyboard focus: the same place, and Escape closes it
      await points.last().focus();
      await holds('keyboard focus on a mark');
      await o.page.keyboard.press('Escape');
      await expect.poll(() => tip.count(), { timeout: 5_000 }).toBe(0);
      expect(await tops()).toEqual(still);
    } finally {
      await o.g.context.close();
    }
  }, 180_000);

  // why: FR-DISP-12 the live bell on this page shows the open alert count: with 1 open alert the name reads Alerts, 1, the count API-43 answers
  it('shows the open alert count on the bell', async () => {
    const subject = `reports-stack-${engine}`;
    psql(`INSERT INTO world.alert (type, state, branch_id, at, at_real, subject, message_key, message_values, link_target, emailed)
          VALUES ('billing_waiting_person', 'open', 'columbus', '2026-09-15T07:00:00-04:00', now(), '${subject}', 'alert.billing_waiting_person', '{"count":1}'::jsonb, '/office/billing', false)`);
    try {
      expect((await call(people.dana!, '/alerts?branch=columbus')).body.data.alerts).toHaveLength(1);
      const o = await open(browser, '/office/reports');
      try {
        await ready(o.page);
        const bell = o.page.locator('button[data-ctl="CTL-CMP-07-06"]');
        await expect.poll(() => bell.getAttribute('aria-label'), { timeout: 30_000 }).toBe('Alerts, 1');
      } finally {
        await o.g.context.close();
      }
    } finally {
      psql(`DELETE FROM world.alert WHERE subject = '${subject}'`);
    }
  }, 120_000);

  // why: FR-DISP-10 FR-AUTH-1 the top bar's Reports item opens this page for the manager, and for no other role: the dispatcher and a technician are refused
  it('opens from the top bar for the manager only', async () => {
    const m = await open(browser, '/office/jobs');
    try {
      await m.page.waitForSelector('.topbar nav a');
      const item = m.page.locator('.topbar nav a', { hasText: 'Reports' });
      expect(await item.count()).toBe(1);
      await item.click();
      await m.page.waitForURL(/\/office\/reports/);
      await ready(m.page);
      expect(await texts(m.page, `${SCREEN} .rh .sim .chip`)).toEqual(['Simulated pilot data']);
      expect(await m.page.locator(`${SCREEN} .topbar nav a[aria-current="page"]`).innerText()).toBe('Reports');
    } finally {
      await m.g.context.close();
    }
    const office = await open(browser, '/office/jobs', { who: 'keisha' });
    try {
      await office.page.waitForSelector('.topbar nav a');
      expect(await office.page.locator('.topbar nav a', { hasText: 'Reports' }).count()).toBe(0);
    } finally {
      await office.g.context.close();
    }
    for (const who of ['keisha', { token: techToken(psql("SELECT user_id FROM world.technician WHERE branch_id = 'columbus' AND user_id IS NOT NULL ORDER BY id LIMIT 1")) }] as const) {
      const refused = await open(browser, '/office/reports', { who });
      try {
        expect(refused.status).toBe(403);
        expect(await refused.page.locator('.kpis').count()).toBe(0);
      } finally {
        await refused.g.context.close();
      }
    }
    expect((await call(people.keisha!, '/reports')).status).toBe(403);
  }, 120_000);

  // why: NFR-06 on a phone the charts give way to their data tables, which are the screen-reader view too, and nothing is clipped or scrolls sideways
  it('shows the data tables on a phone', async () => {
    const o = await open(browser, '/office/reports', { viewport: { width: 390, height: 844 } });
    try {
      await ready(o.page);
      expect(await o.page.locator(`${SCREEN} svg.chart`).first().isVisible()).toBe(false);
      expect(await o.page.locator(`${SCREEN} .bw-rp-dt:not(.on) table`).first().isVisible()).toBe(true);
      const sideways = await o.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      expect(sideways).toBe(false);
    } finally {
      await o.g.context.close();
    }
  }, 120_000);
});

// The autopilot finishes the demo week's jobs as the clock passes them (SD-21). Run last: a clock move cannot be undone.
describe('the live week: SC-02 holds the visits the autopilot finished', () => {
  const [, type] = engines[0]!;
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  const instant = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));
  /** API-12 as the manager (a replay still running answers 409, so retry), then until the replay has ended at the target. */
  async function jumpTo(to: string): Promise<void> {
    const write = () => fetch(`${origin}/api/v1/clock/jumps`, { method: 'POST', headers: { cookie: `bw_session=${people.dana}`, origin: APP_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ to }) });
    await expect.poll(async () => (await write()).status, { timeout: 120_000, interval: 500 }).toBe(202);
    await expect.poll(async () => {
      const c = (await call(people.dana!, '/clock')).body.data;
      return !c.replay.running && instant(c.demoNow) >= instant(to) - 1_000;
    }, { timeout: 420_000, interval: 1_000 }).toBe(true);
  }
  /** The week of Sep 14 from the job rows alone, SC-02's words: the ended pilot jobs of Sep 14, and the live jobs of Sep 15 on that were finished or recorded as No one home. */
  const fromJobs = () => rows<{ visits: number; noh: number }>(`SELECT count(*)::int AS visits, count(*) FILTER (WHERE status = 'no_one_home')::int AS noh FROM world.job
    WHERE date BETWEEN '2026-09-14' AND '2026-09-20' AND status IN ('done', 'no_one_home') AND (pilot OR date >= '2026-09-15')`)[0]!;
  const listed = () => Number(psql(`SELECT count(*) FROM ${VISITS} WHERE ${inWeeks(WHOLE)}`));

  const pageSays = async (want: { visits: number; noh: number; rate: number }) => {
    const o = await open(browser, '/office/reports');
    try {
      await ready(o.page);
      await pickLiveWeek(o.page);
      expect(await texts(o.page, `${SCREEN} .kpi:nth-child(3) .s [data-ctl="CTL-OFC-11-17"]`)).toEqual([`${want.noh} of ${want.visits} visits - goal under 3%.`]);
      expect(await texts(o.page, `${SCREEN} .kpi:nth-child(3) .v`)).toEqual([`${want.rate}%`]);
    } finally {
      await o.g.context.close();
    }
  };
  /** What must not have moved: the live finished visits are in the no-one-home denominator and nowhere else. */
  const expectOnlyTheDenominatorMoved = async (at7: Json, r: Json) => {
    expectEveryNumberToEqualTheQuery(r, truth(WHOLE));
    expect(r.onTime).toEqual(at7.onTime);
    expect(r.calls).toEqual(at7.calls);
    expect(r.headline.onTime).toEqual(at7.headline.onTime);
    expect(r.technicians.map((x: Json) => [x.name, x.visits, x.onTimeRate, x.averageMinutesLate, x.calls])).toEqual(at7.technicians.map((x: Json) => [x.name, x.visits, x.onTimeRate, x.averageMinutesLate, x.calls]));
    expect(r.totals.visits).toBe(listed());
    const file = fileLines((await call(people.dana!, `/reports/export${LIVE_QUERY}`)).text);
    expect(file).toHaveLength(r.totals.visits);
    expect(file).toEqual(exportLines(WHOLE));
  };

  let at7: Json;
  // why: SC-02 the autopilot alone, end of Sep 15: 1 of 134 is 0.7%, typed and from the job rows (56 pilot jobs of Sep 14, 1 of them No one home, and 78 live jobs, none of them No one home); the live finished visits move the no-one-home denominator and no other figure, on the API, in the file and on the page
  // The Jobs page story (dcc50303, F-292, F-1733) left 24840 to 24842 unassigned, so 3 fewer live visits, and redrew the week's
  // sample-day outcomes: Sep 15's scripted No one home visits went from 2 (24804, 24818) to none (3 of 137 and 7 of 428 before).
  it('end of Sep 15: 1 of 134 visits, 0.7%', async () => {
    at7 = (await report(LIVE_QUERY)).data;
    await jumpTo('2026-09-15T23:59:00-04:00[America/New_York]');
    const r = (await report(LIVE_QUERY)).data;
    expect(r.headline.week).toBe(LIVE_WEEK);
    expect(fromJobs()).toEqual({ visits: 134, noh: 1 });
    expect(r.headline.noOneHome).toMatchObject({ rate: 0.7, count: 1, visits: 134 });
    await expectOnlyTheDenominatorMoved(at7, r);
    await pageSays({ visits: 134, noh: 1, rate: 0.7 });
  }, 600_000);

  // why: SC-02 the autopilot alone, end of the demo week: 6 of 425 is 1.4%, typed and from the job rows, and the after period stays under the 3% goal
  it('end of the demo week: 6 of 425 visits, 1.4%', async () => {
    await jumpTo('2026-09-20T23:59:00-04:00[America/New_York]');
    const r = (await report(LIVE_QUERY)).data;
    expect(r.headline.week).toBe(LIVE_WEEK);
    expect(fromJobs()).toEqual({ visits: 425, noh: 6 });
    expect(r.headline.noOneHome).toMatchObject({ rate: 1.4, count: 6, visits: 425 });
    expect(r.headline.noOneHome.after).toBeLessThan(3);
    await expectOnlyTheDenominatorMoved(at7, r);
    await pageSays({ visits: 425, noh: 6, rate: 1.4 });
  }, 600_000);
});
