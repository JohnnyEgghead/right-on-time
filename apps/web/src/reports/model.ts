// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-11 Reports (FR-REP-1 to FR-REP-8): the page's words and chart geometry, from API-50's answer. Pure, so a test can hold them.
import type { reports, z } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import type { Language } from '@bw/time';

export type Report = z.infer<typeof reports.response>;
export type T = (key: MessageKey, values?: Record<string, string | number>) => string;

/**
 * SCR-OFC-11 Empty (F-1133, manager ruling on F-791): the filters match no row of the report view, pilot or live. Every view row of a week is in
 * the no-one-home denominator (a live finished visit too, SD-25), so a technician or range that holds only live finished visits shows its
 * figures and never No visits beside a card that counts them. The listed count (`totals.visits`) alone does not decide it.
 */
export function isEmptyReport(r: Report): boolean {
  return r.totals.visits === 0 && r.noOneHome.every((p) => p.visits === 0);
}

/** The filters, as the page's address holds them (UI-SPECIFICATION 2.3: `?branch=<id or all>&technician=<id or all>&from=<week>&to=<week>`). */
export interface Filters { branch: string; technician: string; from: string; to: string }

/** An empty `from` or `to` means the default range (first pilot week to the demo clock's week). */
export const NO_FILTERS: Filters = { branch: 'all', technician: 'all', from: '', to: '' };

const MONDAY = /^\d{4}-\d{2}-\d{2}$/;

export function filtersOf(params: { get(name: string): string | null }): Filters {
  const week = (v: string | null) => (v !== null && MONDAY.test(v) ? v : '');
  return { branch: params.get('branch') || 'all', technician: params.get('technician') || 'all', from: week(params.get('from')), to: week(params.get('to')) };
}

/** The address query of a filter set: only what differs from the defaults. */
export function queryOf(f: Filters): string {
  const q = new URLSearchParams();
  if (f.branch !== 'all') q.set('branch', f.branch);
  if (f.technician !== 'all') q.set('technician', f.technician);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}

/** API-50's request for a filter set (`all` is no technician; a branch of `all` is none). */
export function requestOf(f: Filters): { branch?: string; technicianId?: string; fromWeek?: string; toWeek?: string } {
  return {
    ...(f.branch !== 'all' ? { branch: f.branch } : {}),
    ...(f.branch !== 'all' && f.technician !== 'all' ? { technicianId: f.technician } : {}),
    ...(f.from ? { fromWeek: f.from } : {}),
    ...(f.to ? { toWeek: f.to } : {}),
  };
}

/** The 2 week selects hold an inverted range: the field message shows and no read goes out (CTL-OFC-11-11). */
export const weeksInverted = (from: string, to: string): boolean => from !== '' && to !== '' && to < from;

const parts = (date: string) => date.split('-').map(Number) as [number, number, number];

/** "Aug 24": a local date as the page writes it (the month words are the catalog's, in both languages). */
export function dayText(date: string, t: T): string {
  const [, m, d] = parts(date);
  return t('week.date.md', { month: t(`time.month.${m}` as MessageKey), day: d });
}

/** The Sunday ending a week named by its Monday. */
export function weekEnd(monday: string): string {
  const [y, m, d] = parts(monday);
  return new Date(Date.UTC(y, m - 1, d + 6)).toISOString().slice(0, 10);
}

/** The first pilot week (SD-25), the first Monday the week selects offer. */
export const FIRST_WEEK = '2026-06-01';
const REAL_MONDAY = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && d.getUTCDay() === 1;
};

/**
 * The weeks the selects offer while the page holds no answer (Loading, Error; CTL-OFC-11-11 is enabled always, F-741): every Monday from the first
 * pilot week to the later of the address's real Mondays, or 11 weeks on when it holds none, so a bad address still has a select to repair it with.
 */
export function fallbackWeeks(f: Filters): string[] {
  const held = [f.from, f.to].filter((w) => REAL_MONDAY(w) && w >= FIRST_WEEK).sort();
  const [y, m, d] = parts(FIRST_WEEK);
  const end = held.at(-1) ?? new Date(Date.UTC(y, m - 1, d + 7 * 11)).toISOString().slice(0, 10);
  const out: string[] = [];
  for (let k = 0; k < 260; k += 1) {
    const w = new Date(Date.UTC(y, m - 1, d + 7 * k)).toISOString().slice(0, 10);
    if (w > end) break;
    out.push(w);
  }
  return out;
}

export const rangeText = (from: string, to: string, t: T): string => t('reports.range', { from: dayText(from, t), to: dayText(to, t) });

/** The range as the table heading and the chart notes say it: the first week's Monday to the last week's Sunday ("Jul 6 to Aug 30"). */
export const spanText = (fromWeek: string, toWeek: string, t: T): string => rangeText(fromWeek, weekEnd(toWeek), t);

/** A number of up to 1 decimal in the page's language ("89.6", "89,6", "96" for 96.0): the figure the answer holds, rounded to 1 decimal, with no trailing .0. */
export const decimal = (n: number, lang: Language): string => new Intl.NumberFormat(lang, { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n);

/** A rate with exactly 1 decimal ("88.0%"): the line-end labels of the on-time chart write it so, as the frame does. */
export const fixed1 = (rate: number | null, lang: Language, t: T): string =>
  rate === null ? t('reports.value.none') : `${new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(rate)}%`;

/** A percent as the page writes it ("89.6%"); no rate is "n/a". */
export function pct(rate: number | null, lang: Language, t: T): string {
  return rate === null ? t('reports.value.none') : `${decimal(rate, lang)}%`;
}

export const goalPct = (rate: number, lang: Language): string => `${new Intl.NumberFormat(lang).format(rate)}%`;

/** A whole count with the language's grouping ("1,264"). */
export function num(n: number | null, lang: Language, t: T): string {
  return n === null ? t('reports.value.none') : new Intl.NumberFormat(lang).format(n);
}

/** Two letters for the avatar: the first letters of the first and last name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  return (words[0]!.charAt(0) + (words.length > 1 ? words[words.length - 1]!.charAt(0) : '')).toUpperCase();
}

/** The weeks of a period that the range holds, as its first and last Monday; null when the range holds none (no band, no label). */
export function periodSpan(weeks: readonly string[], p: { from: string; to: string }): { first: number; last: number } | null {
  const idx = weeks.map((w, i) => (w >= p.from && w <= p.to ? i : -1)).filter((i) => i >= 0);
  return idx.length === 0 ? null : { first: idx[0]!, last: idx[idx.length - 1]! };
}

/** The line chart's value axis: 75 to 95 as the frame draws it, widened in steps of 5 for a rate outside it (the goal line is always inside). */
export function rateAxis(values: readonly (number | null)[]): { lo: number; hi: number; ticks: number[] } {
  const v = values.filter((x): x is number => x !== null);
  const lo = Math.max(0, Math.min(75, v.length ? Math.floor(Math.min(...v) / 5) * 5 : 75));
  const hi = Math.min(100, Math.max(95, v.length ? Math.ceil(Math.max(...v) / 5) * 5 : 95));
  const ticks: number[] = [];
  for (let x = lo; x <= hi; x += 5) ticks.push(x);
  return { lo, hi, ticks };
}

/** The bar charts' value axis: 4 equal steps of a round size that hold the largest value (and the goal): 1264 and 6.4 give 1600 by 400 and 8 by 2. */
export function barAxis(max: number): { top: number; ticks: number[] } {
  const want = Math.max(max, 1e-9);
  const mags = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
  for (const k of mags) {
    for (const m of [1, 2, 2.5, 4, 5]) {
      const step = m * 10 ** k;
      if (step * 4 >= want) return { top: Math.round(step * 4 * 1e6) / 1e6, ticks: [0, 1, 2, 3, 4].map((i) => Math.round(step * i * 1e6) / 1e6) };
    }
  }
  return { top: want, ticks: [0, want] };
}

/** Where a line's points go: a path with a gap at each week with no rate. */
export function linePath(points: readonly { x: number; y: number | null }[]): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.y === null) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

/** Line-end labels nudged apart (the highest first), at least 15 px between baselines, as the frame spaces them. */
export function spreadLabels(ends: readonly { key: string; y: number }[]): { key: string; y: number }[] {
  const out: { key: string; y: number }[] = [];
  let last = -999;
  for (const e of [...ends].sort((a, b) => a.y - b.y)) {
    let y = e.y;
    if (y - last < 15) y = last + 15;
    last = y;
    out.push({ key: e.key, y });
  }
  return out;
}

/** The meter's class: the bar's width is a whole percent, drawn by a class (the page's CSP allows no style attribute). */
export const meterClass = (rate: number | null): string => `bw-mw-${rate === null ? 0 : Math.max(0, Math.min(100, Math.round(rate)))}`;

export const branchLabel = (id: string, t: T, names: Record<string, string>): string => (id === 'all' ? t('reports.filter.allBranches') : (names[id] ?? id));
