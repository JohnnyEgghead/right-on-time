// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-30 Jobs: what the page derives from API-133's rows (UI-SPECIFICATION 5 SCR-OFC-30; FR-DISP-24, FR-DISP-14, UD-52): the status chip of
// a row, its status detail line (CTL-OFC-30-16), the group rows (CTL-OFC-30-17), the page buttons (CTL-OFC-30-12) and the Date filter's days.
// Pure: no React, no clock of the device (the demo clock's date arrives in the answer).
import type { jobsList, JobTab, z } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { formatTime, fromWire, type Language } from '@bw/time';
import type { StatusWord } from '../shell/Panels.tsx';
import { addDays, dateNumbers, windowLabel, wireClock } from '../week/week-model.ts';

export type JobsData = z.infer<typeof jobsList.response>;
export type JobRow = JobsData['rows'][number];
export type T = (key: MessageKey, values?: Record<string, string | number>) => string;
export type SortPick = 'attention' | 'window';
export type DatePick = 'upcoming' | 'today' | string;

/** The events that make the list re-read (EVT-01 job.changed, EVT-07 billing.changed; the clock and a world reset move every row). */
export const JOBS_EVENTS: readonly string[] = ['job.changed', 'billing.changed', 'clock.changed', 'world.reset'];

export const TAB_LABEL = {
  all: 'jobs.tab.all', unassigned: 'jobs.tab.unassigned', 'at-risk': 'jobs.tab.atRisk', late: 'jobs.tab.late', 'not-in-billing': 'jobs.tab.notInBilling',
} as const satisfies Record<JobTab, MessageKey>;

/** The count badge's class on a tab (the frame's `.n.unas`, `.n.risk`, `.n.late`, `.n.bill`). */
export const TAB_BADGE: Record<JobTab, string> = { all: '', unassigned: 'unas', 'at-risk': 'risk', late: 'late', 'not-in-billing': 'bill' };

export const countOf = (data: JobsData, tab: JobTab): number =>
  tab === 'all' ? data.counts.all : tab === 'unassigned' ? data.counts.unassigned : tab === 'at-risk' ? data.counts.atRisk : tab === 'late' ? data.counts.late : data.counts.notInBilling;

/** A tab from the URL's `?tab=`; anything else is All. */
export const tabOf = (value: string | null): JobTab =>
  value === 'unassigned' || value === 'at-risk' || value === 'late' || value === 'not-in-billing' ? value : 'all';

/** "Tue, Sep 15": a local date as the page writes it (the weekday and month words are the catalog's, in both languages). */
export function dayText(date: string, t: T): string {
  const n = dateNumbers(date);
  return t('week.date.short', { weekday: t(`time.weekday.${n.weekday}` as MessageKey), month: t(`time.month.${n.month}` as MessageKey), day: n.day });
}

/** The page subtitle (CTL-OFC-30-18): the branch, the days the list covers and the demo time of the read. */
export function subtitle(data: JobsData, date: DatePick, branchName: string, time: string, t: T): string {
  const key = date === 'upcoming' ? 'jobs.sub.upcoming' : date === 'today' ? 'jobs.sub.today' : 'jobs.sub.day';
  return t(key, { branch: branchName, from: dayText(data.range.from, t), to: dayText(data.range.to, t), time });
}

/** The time of day of an RFC 9557 string in its own zone ("12:25 PM"). */
export function clock(wire: string, lang: Language): string {
  const z = fromWire(wire);
  return formatTime(z.toInstant(), z.timeZoneId, lang);
}

/** Two letters for the technician's avatar: the first letters of the first and last name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  return (words[0]!.charAt(0) + (words.length > 1 ? words[words.length - 1]!.charAt(0) : '')).toUpperCase();
}

const OPEN = new Set(['scheduled', 'on_the_way', 'on_site']);
const isOpen = (r: JobRow): boolean => OPEN.has(r.status);

/** The status word of a row (FR-DISP-14): Late or At risk over the job's own status, Unassigned for an open job with no technician. */
export function chipOf(r: JobRow): StatusWord {
  if (isOpen(r) && r.timing === 'late') return 'late';
  if (isOpen(r) && r.timing === 'at_risk') return 'at_risk';
  if (isOpen(r) && r.technicianId === null) return 'unassigned';
  return r.status;
}

/** CTL-OFC-30-16: the time each status gives, and the 4-hour day's note. '' when the row has neither. */
export function detailText(r: JobRow, t: T, lang: Language): string {
  const parts: string[] = [];
  if ((r.timing === 'late' || r.status === 'on_the_way') && r.eta) {
    parts.push(t(r.lateTextSentAt ? 'jobs.detail.etaLate' : 'jobs.detail.eta', { time: clock(r.eta, lang) }));
  } else if (r.status === 'on_site' && r.arrivedAt) parts.push(t('jobs.detail.since', { time: clock(r.arrivedAt, lang) }));
  else if (r.status === 'done' && r.endedAt) parts.push(t('jobs.detail.done', { time: clock(r.endedAt, lang) }));
  else if (isOpen(r) && r.eta) parts.push(t('jobs.detail.eta', { time: clock(r.eta, lang) }));
  if (r.dayMode === 'four_hour') parts.push(t('jobs.detail.fourHour'));
  return parts.join(', ');
}

/** The arrival window as the page writes it ("10 AM-12 PM"). */
export function windowText(r: JobRow): string {
  const a = wireClock(r.window.start);
  const b = wireClock(r.window.end);
  return windowLabel(a, b);
}

/** The day under the window: Today, else "Wed, Sep 16". */
export const dayCell = (r: JobRow, today: string, t: T): string => (r.day === today ? t('jobs.day.today') : dayText(r.day, t));

export type Group = 'attention' | 'earlier' | 'today' | 'upcoming';

/** CTL-OFC-30-17: the group a row sits in. Under Arrival window there is no Needs attention group. */
function groupOf(r: JobRow, today: string, sort: SortPick): Group {
  if (sort === 'attention' && r.needsAttention) return 'attention';
  return r.day < today ? 'earlier' : r.day === today ? 'today' : 'upcoming';
}

export interface Section {
  group: Group;
  rows: JobRow[];
}

/** The shown rows in runs of their group, in the order given; a group row is drawn only when there are 2 or more runs' groups. */
export function sections(rows: readonly JobRow[], today: string, sort: SortPick): { sections: Section[]; showGroups: boolean } {
  const out: Section[] = [];
  for (const r of rows) {
    const g = groupOf(r, today, sort);
    const last = out[out.length - 1];
    if (last && last.group === g) last.rows.push(r);
    else out.push({ group: g, rows: [r] });
  }
  return { sections: out, showGroups: new Set(out.map((s) => s.group)).size >= 2 };
}

export function groupText(g: Group, today: string, t: T): string {
  switch (g) {
    case 'attention': return t('jobs.group.attention');
    case 'earlier': return t('jobs.group.earlier');
    case 'today': return t('jobs.group.today', { date: dayText(today, t) });
    case 'upcoming': return t('jobs.group.upcoming');
  }
}

/** CTL-OFC-30-12: the page numbers drawn, with a gap where numbers are left out: the first 3, the last, and the page with its neighbors. */
export function pageButtons(page: number, pages: number): (number | 'gap')[] {
  const keep = new Set<number>([1, 2, 3, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const out: (number | 'gap')[] = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push('gap');
    out.push(n);
    prev = n;
  }
  return out;
}

/** The days the Date select offers besides Today and upcoming: a week back and 2 weeks ahead of demo today (and the picked day, if outside). */
export function dateOptions(today: string, picked: DatePick): string[] {
  const days: string[] = [];
  for (let i = -7; i <= 14; i++) days.push(addDays(today, i));
  if (picked !== 'upcoming' && picked !== 'today' && !days.includes(picked)) days.push(picked);
  return days.sort();
}

/** What the Date select shows as its value. */
export function dateValue(picked: DatePick, t: T): string {
  return picked === 'upcoming' ? t('jobs.date.upcoming') : picked === 'today' ? t('jobs.date.today') : dayText(picked, t);
}

/** Which "when" an empty tab names (today or upcoming, today, or that day). */
export const whenKey = (date: DatePick): MessageKey => (date === 'upcoming' ? 'jobs.when.upcoming' : date === 'today' ? 'jobs.when.today' : 'jobs.when.day');

export const EMPTY_KEY = {
  all: 'jobs.empty.all', unassigned: 'jobs.empty.unassigned', 'at-risk': 'jobs.empty.atRisk', late: 'jobs.empty.late', 'not-in-billing': 'jobs.empty.notInBilling',
} as const satisfies Record<JobTab, MessageKey>;
