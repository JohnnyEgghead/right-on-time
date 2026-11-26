// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-34 Week board: the pure part (UI-SPECIFICATION CTL-OFC-34-01 to CTL-OFC-34-20). API-132's answer in, the numbers and
// words the screen shows out; no React, no clock of its own (FR-DEMO-2: "today" is the answer's `today`, the demo clock's date).
import type { boardWeek, z } from '@bw/api';
import type { Language } from '@bw/time';

export type WeekData = z.infer<typeof boardWeek.response>;
export type WeekDay = WeekData['days'][number];
export type WeekTech = WeekData['technicians'][number];
export type WeekCell = WeekTech['cells'][number];

/** The date as numbers; weekday is ISO (1 Monday to 7 Sunday). */
export function dateNumbers(date: string): { year: number; month: number; day: number; weekday: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
  return { year: y, month: m, day: d, weekday };
}

export function addDays(date: string, n: number): string {
  const { year, month, day } = dateNumbers(date);
  return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10);
}

/** The Monday of the week that holds the date. */
export function mondayOf(date: string): string {
  return addDays(date, 1 - dateNumbers(date).weekday);
}

/** The Monday of the week that holds a week param's date (CTL-OFC-02-20); null when the param is not a real date. */
export function weekParamMonday(param: string | null): string | null {
  if (!param || !/^\d{4}-\d{2}-\d{2}$/.test(param)) return null;
  const { year, month, day } = dateNumbers(param);
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null;
  return mondayOf(param);
}

/** The wall time of an RFC 9557 string as numbers (its own offset, never the device's). */
export function wireClock(wire: string): { date: string; hour: number; minute: number } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(wire);
  if (!m) throw new Error(`not an RFC 9557 time: ${wire}`);
  return { date: m[1]!, hour: Number(m[2]), minute: Number(m[3]) };
}

type Meridiem = 'AM' | 'PM';
function hourParts(hour: number, minute: number): { text: string; meridiem: Meridiem } {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return { text: minute === 0 ? String(h12) : `${h12}:${String(minute).padStart(2, '0')}`, meridiem: hour < 12 ? 'AM' : 'PM' };
}

/**
 * "8 AM-12 PM", "12-2 PM": a window's start and end, "AM" and "PM" in both languages (UD-16), the start's mark left out when
 * the end carries the same one.
 */
export function windowLabel(start: { hour: number; minute: number }, end: { hour: number; minute: number }): string {
  const a = hourParts(start.hour, start.minute);
  const b = hourParts(end.hour, end.minute);
  return `${a.meridiem === b.meridiem ? a.text : `${a.text} ${a.meridiem}`}-${b.text} ${b.meridiem}`;
}

/** "4:10 PM": a time of day with its minutes (UD-16). */
export function clockLabel(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** An "HH:MM" local time as a window label half: "8 AM". */
export function hourLabel(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const p = hourParts(h, m);
  return `${p.text} ${p.meridiem}`;
}

export const timeParts = (hhmm: string): { hour: number; minute: number } => {
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  return { hour, minute };
};

export const percent = (booked: number, capacity: number): number => (capacity > 0 ? Math.round((booked / capacity) * 100) : 0);
/** The bar's fill, 0 to 100, unrounded as the frame draws it. */
export const fill = (booked: number, capacity: number): number => (capacity > 0 ? Math.min(100, (booked / capacity) * 100) : 0);

/** What a technician cell shows (CTL-OFC-34-06, CTL-OFC-34-16). */
export type CellView =
  | { kind: 'off' }
  | { kind: 'install'; installs: number; classes: string }
  | { kind: 'load'; booked: number; capacity: number; word: 'done' | 'full' | 'open'; open: number; full: boolean; classes: string };

const dayClasses = (day: WeekDay, today: string): string => `${day.peak ? ' peak' : ''}${day.date === today ? ' today' : ''}${day.date < today ? ' past' : ''}`;

export function cellView(cell: WeekCell, day: WeekDay, today: string, installer: boolean): CellView {
  if (cell.state === 'day_off') return { kind: 'off' };
  const classes = dayClasses(day, today);
  if (installer && cell.installs > 0) return { kind: 'install', installs: cell.installs, classes };
  const past = day.date < today;
  const full = cell.state === 'full';
  return { kind: 'load', booked: cell.booked, capacity: cell.capacity, full, open: Math.max(0, cell.capacity - cell.booked), word: past ? 'done' : full ? 'full' : 'open', classes };
}


interface Totals {
  booked: number;
  capacity: number;
}

/** Each day's column: its cells' booked and capacity, the day's Unassigned jobs counted as booked (CTL-OFC-34-18). */
export function dayTotals(data: WeekData): Totals[] {
  return data.days.map((d) => ({ booked: d.booked, capacity: d.capacity }));
}

export interface Tiles {
  jobs: number;
  percent: number;
  open: number;
  peakDays: number;
  unassigned: number;
  /** The weekdays the Unassigned jobs fall on (ISO), in order; the page says "all today" when they are all on today. */
  unassignedDates: string[];
}

/** CTL-OFC-34-13: the week summed from the grid's own numbers. */
export function tiles(data: WeekData): Tiles {
  const booked = data.days.reduce((n, d) => n + d.booked, 0);
  const capacity = data.days.reduce((n, d) => n + d.capacity, 0);
  return {
    jobs: booked,
    percent: percent(booked, capacity),
    open: Math.max(0, capacity - booked),
    peakDays: data.days.filter((d) => d.peak).length,
    unassigned: data.days.reduce((n, d) => n + d.unassigned, 0),
    unassignedDates: data.days.filter((d) => d.unassigned > 0).map((d) => d.date),
  };
}

/** The booked counts that changed since the last read: "tech id|date" keys, for the Live state's highlighted cells. */
export function changedCells(before: WeekData | null, after: WeekData): Set<string> {
  const out = new Set<string>();
  if (!before || before.week !== after.week || before.branch !== after.branch) return out;
  const was = new Map(before.technicians.map((t) => [t.id, t]));
  for (const t of after.technicians) {
    const b = was.get(t.id);
    if (!b) continue;
    t.cells.forEach((c, i) => {
      if (b.cells[i] && b.cells[i]!.booked !== c.booked) out.add(`${t.id}|${c.date}`);
    });
  }
  return out;
}

/** Where a day's board is (SCR-OFC-02, `/office/board?branch&date`, UI-SPECIFICATION 2.3). */
export const dayBoardHref = (branch: string, date: string): string => `/office/board?${new URLSearchParams({ branch, date }).toString()}`;
/** The week board's link for any date: it names the Monday of the week that holds the date (API-132 needs a Monday). */
export const weekHref = (branch: string, date: string): string => {
  const week = weekParamMonday(date) ?? date;
  return `/office/board/week?${new URLSearchParams({ branch, week }).toString()}`;
};
export const jobHref = (jobNumber: number): string => `/office/jobs/${jobNumber}`;

/** The week board's list of weekday names joined for the language ("Tue and Wed"). */
export function joinList(items: readonly string[], lang: Language): string {
  return new Intl.ListFormat(lang, { type: 'conjunction', style: 'long' }).format(items);
}

/** The events that make the week re-read (the screen's Live row, UI-SPECIFICATION SCR-OFC-34). */
export const WEEK_EVENTS: readonly string[] = ['job.changed', 'board.refresh', 'clock.changed', 'world.reset', 'settings.changed', 'block.changed'];

/** Whether an event is for this branch: an event with no branch (clock, world, settings) is for every board. */
export function eventIsForBranch(e: { ids: Record<string, string | number> }, branch: string): boolean {
  const b = e.ids.branch;
  return b === undefined || b === branch || b === 'all';
}
