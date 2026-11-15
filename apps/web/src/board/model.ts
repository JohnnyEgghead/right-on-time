// SPDX-License-Identifier: AGPL-3.0-or-later
// The day board's pure rules (P4-BOARD; UI-SPECIFICATION section 6 SCR-OFC-02, SCR-OFC-19; DK-74 timeline.js): where a
// block sits on the timeline, which kit class and words each job carries, the window and span labels, where a drag
// lands, and the version_conflict message. No React, no fetch: the screen components and the unit tests share these.
import type { BoardDayAnswer, VanPositionsAnswer, VersionConflictDetail } from '@bw/api';
import { fromWire, Temporal } from '@bw/time';
import type { ClientT } from '../shell/intl.tsx';

export type Board = BoardDayAnswer;
export type BoardJob = Board['unassigned'][number];
export type BoardTech = Board['technicians'][number];
export type BoardBlock = BoardTech['blocks'][number];
export type Conflict = VersionConflictDetail;
export type Van = VanPositionsAnswer['vans'][number];

/** The timeline's hours (DK-74 render options: 7 AM to 6 PM, as the finished board, Figure 8.5). */
export interface Span {
  start: number;
  end: number;
}
export const DAY_SPAN: Span = { start: 7, end: 18 };

/** The hours a day's board shows: the frame's 7 AM to 6 PM, longer when a job or block runs past 6 PM (F-1540). */
export function daySpan(board: Pick<Board, 'unassigned' | 'technicians'>): Span {
  let end = DAY_SPAN.end;
  for (const j of [...board.unassigned, ...board.technicians.flatMap((x) => x.jobs)]) end = Math.max(end, jobHours(j).end);
  for (const b of board.technicians.flatMap((x) => x.blocks)) end = Math.max(end, hourOf(b.end));
  return { start: DAY_SPAN.start, end: Math.min(24, Math.ceil(end - 1e-6)) };
}

/** A wire time as hours of its local day (10:30 AM is 10.5). */
export function hourOf(wire: string): number {
  const z = fromWire(wire);
  return z.hour + z.minute / 60 + z.second / 3600;
}

/** DK-74 pct: an hour as a percentage across the span, clamped to it. */
export function pct(hour: number, span: Span = DAY_SPAN): number {
  const h = Math.min(Math.max(hour, span.start), span.end);
  return ((h - span.start) / (span.end - span.start)) * 100;
}

/** left and width (percent) of a [start, end) hour range, as DK-74 blockHTML draws it. */
export function place(start: number, end: number, span: Span = DAY_SPAN): { left: number; width: number } {
  const left = pct(start, span);
  return { left, width: Math.max(0, pct(end, span) - left) };
}

/** DK-74 hourLabel: 7 AM ... 12 PM ... 5 PM (both languages say AM and PM, UD-16). */
export function hourLabel(h: number): string {
  return h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`;
}

const parts = (wire: string) => {
  const z = fromWire(wire);
  const h12 = z.hour % 12 === 0 ? 12 : z.hour % 12;
  return { h12, minute: z.minute, pm: z.hour >= 12 };
};
const clock = (p: { h12: number; minute: number }, always: boolean) => (always || p.minute !== 0 ? `${p.h12}:${String(p.minute).padStart(2, '0')}` : `${p.h12}`);
const mer = (pm: boolean) => (pm ? 'PM' : 'AM');

/** "10:40 AM" (UD-16: AM and PM in both languages). */
export function timeText(wire: string): string {
  const p = parts(wire);
  return `${clock(p, true)} ${mer(p.pm)}`;
}

/** F-933: a flagged line's values with its `at` (the server writes a raw wire time) as the board's own clock text; any other value as sent. */
export function flagValues<V extends Record<string, string | number | null>>(values: V): V {
  const at = values['at'];
  return typeof at === 'string' && /^\d{4}-\d\d-\d\dT/.test(at) ? { ...values, at: timeText(at) } : values;
}

export type FlaggedItem = Board['needsAttention']['flagged'][number];

/**
 * F-1139 (CTL-OFC-02-15; owner ruling c4aa4366, "Keep and show it"): what the technician entered, under a flagged row, as lines. A finish: each part
 * with its name and quantity (the id the phone sent for a part the list does not hold), or No parts used, then the labor minutes and the
 * work-done lines; a note: its text; a status change: none; a photo or signature is a link, not lines.
 */
export function entryLines(entry: FlaggedItem['entry'], t: ClientT): string[] {
  if (entry === null) return [];
  if (entry.kind === 'photo' || entry.kind === 'signature') return []; // F-1168: shown as a link to the kept image (BoardScreen)
  if (entry.kind === 'note') return [t('board.att.entry.note', { text: entry.text })];
  const lines = [entry.noPartsUsed ? t('board.att.entry.noParts') : t('board.att.entry.parts', { parts: entry.parts.map((p) => `${p.name ?? p.partId} x ${p.quantity}`).join(', ') })];
  lines.push(t('board.att.entry.labor', { minutes: entry.laborMinutes }));
  if (entry.workDone.length > 0) lines.push(t('board.att.entry.workDone', { lines: entry.workDone.join('; ') }));
  return lines;
}

/** A window as the board names it: "8-10 AM", "10 AM-12 PM", "12-2 PM" (minutes only when not on the hour). */
export function windowText(start: string, end: string): string {
  const a = parts(start);
  const b = parts(end);
  return a.pm === b.pm ? `${clock(a, false)}-${clock(b, false)} ${mer(b.pm)}` : `${clock(a, false)} ${mer(a.pm)}-${clock(b, false)} ${mer(b.pm)}`;
}

/** A block's times: "2:00-2:30 PM", "11:30 AM-12:15 PM" (minutes always, as the frames write them). */
export function spanText(start: string, end: string): string {
  const a = parts(start);
  const b = parts(end);
  return a.pm === b.pm ? `${clock(a, true)}-${clock(b, true)} ${mer(b.pm)}` : `${clock(a, true)} ${mer(a.pm)}-${clock(b, true)} ${mer(b.pm)}`;
}

/** "HH:MM" of a wire time in its own zone (API-137's and API-136's start and end). */
export function hhmm(wire: string): string {
  const z = fromWire(wire);
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

/** The kit class of a job block (DK-17): the timing word wins over the status for an open job (FR-DISP-4). */
export type JobClass = 'sched' | 'way' | 'site' | 'done' | 'risk' | 'late' | 'unas';
export function jobClass(j: BoardJob): JobClass {
  if (j.technicianId === null) return 'unas';
  if (j.status === 'done' || j.status === 'no_one_home') return 'done';
  if (j.timing === 'late' && j.status !== 'on_site') return 'late';
  if (j.timing === 'atRisk' && j.status !== 'on_site') return 'risk';
  if (j.status === 'on_site') return 'site';
  if (j.status === 'on_the_way') return 'way';
  return 'sched';
}

/** A job block's span on the timeline: its planned arrival (else its window start) for its expected minutes. */
export function jobHours(j: BoardJob): { start: number; end: number } {
  const anchor = j.status !== 'scheduled' && j.eta ? j.eta : j.plannedArrival ?? j.window.start;
  const start = hourOf(anchor);
  return { start, end: start + j.expectedMinutes / 60 };
}

/** CTL-OFC-02-09 drag: a job not Done, No one home or Canceled may be dragged (online). */
export const draggable = (j: BoardJob): boolean => j.status === 'scheduled' || j.status === 'on_the_way' || j.status === 'on_site';

/** The status word's catalog key (CMP-06, FR-DISP-14): the 6 words of the legend, plus No one home and Unassigned. */
export function statusKey(j: BoardJob): 'status.job.unassigned' | 'status.job.scheduled' | 'status.job.onTheWay' | 'status.job.onSite' | 'status.job.done' | 'status.job.noOneHome' {
  if (j.technicianId === null) return 'status.job.unassigned';
  return ({ scheduled: 'status.job.scheduled', on_the_way: 'status.job.onTheWay', on_site: 'status.job.onSite', done: 'status.job.done', no_one_home: 'status.job.noOneHome' } as const)[j.status];
}
export function timingKey(j: BoardJob): 'status.timing.late' | 'status.timing.atRisk' | null {
  return j.timing === 'late' ? 'status.timing.late' : j.timing === 'atRisk' ? 'status.timing.atRisk' : null;
}

/** Where a drop lands: a technician's row, the Unassigned row, or outside any row (no move, FR-DISP-17). */
export type Target = { kind: 'tech'; id: string } | { kind: 'unassigned' } | { kind: 'none' };

/** The move a job drop asks for, or null when the drop changes nothing (its own row, or outside every row). */
export function jobDrop(j: BoardJob, t: Target): { technicianId: string | null } | null {
  if (t.kind === 'none') return null;
  const to = t.kind === 'unassigned' ? null : t.id;
  return to === j.technicianId ? null : { technicianId: to };
}

/** A block drop: its new technician and start (snapped to 5 minutes, kept inside the day), or a refusal with no call. */
export function blockDrop(b: BoardBlock, from: string, t: Target, startHour: number): { technicianId: string; start: string; end: string } | 'needs_technician' | null {
  if (t.kind === 'none') return null;
  if (t.kind === 'unassigned') return 'needs_technician';
  const length = Math.round((hourOf(b.end) - hourOf(b.start)) * 60);
  const minutes = Math.min(Math.max(Math.round((startHour * 60) / 5) * 5, 0), 24 * 60 - length - 1);
  const asTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const start = asTime(minutes);
  if (t.id === from && start === hhmm(b.start)) return null;
  return { technicianId: t.id, start, end: asTime(minutes + length) };
}

/** The hour under a pointer x inside a lane of the given left and width (CSS px). */
export function hourAt(x: number, laneLeft: number, laneWidth: number, span: Span = DAY_SPAN): number {
  const f = Math.min(Math.max((x - laneLeft) / laneWidth, 0), 1);
  return span.start + f * (span.end - span.start);
}

/** "Keisha T." from "Keisha Thompson" (the frames' short names; CMP-07 shortName). */
export function shortName(name: string | null): string | null {
  if (!name) return null;
  const w = name.trim().split(/\s+/);
  return w.length > 1 ? `${w[0]} ${w[w.length - 1]!.charAt(0)}.` : name;
}

/** The parts of a conflict message (CTL-OFC-19-01): who, the change, to whom or to when, and when; null parts are unknown. */
export interface ConflictWords {
  /** The catalog key that names who changed it when the answer gives no person's name. */
  who: { name: string } | { key: 'board.conflict.someone' | 'board.conflict.customer' | 'board.conflict.system' };
  change: string;
  at: string | null;
}

export function conflictWords(c: Conflict): ConflictWords {
  const who: ConflictWords['who'] = c.by ? { name: shortName(c.by) as string }
    : c.byKind === 'customer' ? { key: 'board.conflict.customer' } : c.byKind === 'system' ? { key: 'board.conflict.system' } : { key: 'board.conflict.someone' };
  return { who, change: c.change ?? 'other', at: c.at ? timeText(c.at) : null };
}

/** The local date (YYYY-MM-DD) a step of days from another (the date arrows). */
export function stepDate(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** The date's weekday (1 Monday to 7 Sunday), month and day, for the catalog's names. */
export function dateParts(date: string): { weekday: number; month: number; day: number; year: number } {
  const d = Temporal.PlainDate.from(date);
  return { weekday: d.dayOfWeek, month: d.month, day: d.day, year: d.year };
}

/** Whether a value is a YYYY-MM-DD date the board can show (else the page shows today). */
export function isDate(v: string | undefined | null): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  try {
    Temporal.PlainDate.from(v);
    return true;
  } catch {
    return false;
  }
}

/** The board URL of a branch day (the route P4-WEEK links to, UI-SPECIFICATION SCR-OFC-02). */
export function boardHref(branch: string | null, date: string | 'today'): string {
  const q = new URLSearchParams();
  if (branch) q.set('branch', branch);
  q.set('date', date);
  return `/office/board?${q.toString()}`;
}

// --- the map panel (P4-BOARD-MAP; CTL-OFC-02-24, -28 to -31) ------------------------------------------------------------

/** The Vans / Jobs / Both choice (CTL-OFC-02-24) and the job list tabs (CTL-OFC-02-28), Needs attention open as the frame draws it. */
export type MapShows = 'vans' | 'jobs' | 'both';
export type JobTab = 'all' | 'attention' | 'onTheWay' | 'onSite';
export const JOB_TABS: readonly JobTab[] = ['all', 'attention', 'onTheWay', 'onSite'];

/** Every job of the day, in window order. */
export function allJobs(b: Board): BoardJob[] {
  return [...b.technicians.flatMap((x) => x.jobs), ...b.unassigned].sort((x, y) => x.window.start.localeCompare(y.window.start) || x.jobNumber - y.jobNumber);
}

/** Each skill of the shown day's technicians, in the order they first appear (CTL-OFC-02-30). */
export function boardSkills(b: Board): string[] {
  return [...new Set(b.technicians.flatMap((x) => x.skills))];
}

/** What the skill filter leaves: the day's lists and the technicians (null: All skills). A job with no technician has no skill. */
export function filtered(b: Board, skill: string | null) {
  const techs = skill === null ? null : new Set(b.technicians.filter((x) => x.skills.includes(skill)).map((x) => x.id));
  const jobs = allJobs(b).filter((j) => techs === null || (j.technicianId !== null && techs.has(j.technicianId)));
  const numbers = new Set(jobs.map((j) => j.jobNumber));
  const on = <T extends { jobNumber: number }>(xs: readonly T[]) => (techs === null ? [...xs] : xs.filter((x) => numbers.has(x.jobNumber)));
  const a = b.needsAttention;
  const attention = { rows: [...on(a.late), ...on(a.atRisk), ...on(a.unassigned)], flagged: on(a.flagged) };
  return { techs, jobs, attention };
}

/** The rows a tab lists; a count equals its rows (CTL-OFC-02-28), so Needs attention counts its jobs and its flagged items. */
export function tabCounts(f: ReturnType<typeof filtered>): Record<JobTab, number> {
  return {
    all: f.jobs.length, attention: f.attention.rows.length + f.attention.flagged.length,
    onTheWay: f.jobs.filter((j) => j.status === 'on_the_way').length, onSite: f.jobs.filter((j) => j.status === 'on_site').length,
  };
}
export function tabJobs(f: ReturnType<typeof filtered>, tab: Exclude<JobTab, 'attention'>): BoardJob[] {
  return tab === 'all' ? f.jobs : f.jobs.filter((j) => j.status === (tab === 'onTheWay' ? 'on_the_way' : 'on_site'));
}

/** A window as the list's short column: "10-12", "12-2" (the frame's .w). */
export function shortWindow(start: string, end: string): string {
  return `${parts(start).h12}-${parts(end).h12}`;
}

/** A van's marker color state (FR-DISP-19's legend): its current job's timing wins, as a job block's does. */
export function vanState(v: Van, job: BoardJob | undefined): 'site' | 'way' | 'free' | 'late' {
  if (v.status === 'between_jobs') return 'free';
  if (job && v.status === 'on_the_way' && (job.timing === 'late' || job.timing === 'atRisk')) return 'late';
  return v.status === 'on_site' ? 'site' : 'way';
}

/** A job marker's state (the legend under Jobs): the timing word, or No technician, else where the visit stands (F-816: a begun or closed job is not Scheduled). */
export function jobMarkerState(j: BoardJob): 'sched' | 'late' | 'risk' | 'unas' | 'way' | 'site' | 'closed' {
  if (j.technicianId === null) return 'unas';
  if (j.timing === 'late') return 'late';
  if (j.timing === 'atRisk') return 'risk';
  return j.status === 'on_the_way' ? 'way' : j.status === 'on_site' ? 'site' : j.status === 'scheduled' ? 'sched' : 'closed';
}
