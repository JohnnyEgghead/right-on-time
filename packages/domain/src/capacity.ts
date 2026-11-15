// SPDX-License-Identifier: AGPL-3.0-or-later
// The capacity model (SPECIFICATIONS section 6.1 FR-BOOK-5, FR-BOOK-6, FR-BOOK-10; SD-27). Pure: facts in, numbers out.
// Availability (API-29, API-112), the office writes and the booking write call these same functions; a write calls
// them under the locks of section 5.3, so the numbers it acts on cannot change before it commits.
//
// Interpretation (reported in the P3-OFFICE-WRITES report): FR-BOOK-5's "an installer counts 1 and only for services
// whose skill is install" is read as 2 pools. An install service's day room is the installers' (1 each) minus the day's
// live install jobs; any other service's is the other technicians' (5, 6 or 3 each) minus the day's live jobs of
// services that are not installs. Only installers hold the install skill in the seed, so the pools never mix.

export type DayMode = 'two_hour' | 'four_hour';
export type Saturdays = 'none' | 'even_weeks' | 'odd_weeks';
export type JobStatus = 'scheduled' | 'on_the_way' | 'on_site' | 'done' | 'no_one_home' | 'canceled';

/** A live job counts against capacity: every status but canceled (FR-BOOK-5). */
export const isLive = (status: string): boolean => status !== 'canceled';

/** Per-technician daily capacity by kind of day (FR-BOOK-5; OA-29 rows 2 and 3). */
export const DAY_CAPACITY = { two_hour: 5, four_hour: 6, saturday: 3 } as const;
/** An installer's daily capacity: 1 install a day (FR-BOOK-5). */
export const INSTALLER_DAY_CAPACITY = 1;
/**
 * A technician's live jobs in 1 window must stay under this (SD-27): 2 in a 2-hour window, 3 in a 4-hour window.
 * Build-tuned on the sample day: docs/build/spikes/P3-OFFICE-WRITES.md.
 */
export const PER_WINDOW_LIMIT: Readonly<Record<DayMode, number>> = { two_hour: 2, four_hour: 3 };
/** A Saturday is a half-day that offers only its 2-hour windows starting at these local times (FR-BOOK-10). */
export const SATURDAY_WINDOW_STARTS: readonly string[] = ['08:00', '10:00'];

export type DayKind = 'two_hour' | 'four_hour' | 'saturday' | 'sunday';

/** ISO weekday (1 Monday to 7 Sunday) and ISO week number of a local date YYYY-MM-DD. */
export function isoWeek(date: string): { weekday: number; week: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  const weekday = ((new Date(t).getUTCDay() + 6) % 7) + 1;
  // The ISO week holds the week's Thursday.
  const thursday = new Date(t + (4 - weekday) * 86_400_000);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1;
  return { weekday, week };
}

/** The kind of a date for a branch whose day_mode row for it says `mode` (no row: two_hour). A Saturday has no 4-hour mode. */
export function dayKind(date: string, mode: DayMode): DayKind {
  const { weekday } = isoWeek(date);
  if (weekday === 7) return 'sunday';
  if (weekday === 6) return 'saturday';
  return mode;
}

export interface TechnicianFacts {
  id: string;
  installer: boolean;
  /** ISO weekdays 1 to 5. */
  workingDays: readonly number[];
  saturdays: Saturdays;
  /** Inclusive local-date spans of time off. */
  timeOff: readonly { from: string; to: string }[];
}

/** Whether the technician works the date and has no time off on it (section 5.3 step 2; FR-BOOK-10). */
export function worksOn(t: TechnicianFacts, date: string): boolean {
  if (t.timeOff.some((s) => s.from <= date && date <= s.to)) return false;
  const { weekday, week } = isoWeek(date);
  if (weekday === 7) return false;
  if (weekday === 6) return t.saturdays === (week % 2 === 0 ? 'even_weeks' : 'odd_weeks');
  return t.workingDays.includes(weekday);
}

/** The technician's daily capacity on a day of this kind (FR-BOOK-5): installers 1, everyone else 5, 6 or 3. */
export function technicianDayCapacity(t: Pick<TechnicianFacts, 'installer'>, kind: DayKind): number {
  if (kind === 'sunday') return 0;
  return t.installer ? INSTALLER_DAY_CAPACITY : DAY_CAPACITY[kind];
}

export interface WindowFacts {
  id: string;
  mode: DayMode;
  /** Local start time HH:MM. */
  startLocal: string;
}

/** The windows a date offers (FR-BOOK-7, FR-BOOK-10): none on a Sunday, the 2 morning 2-hour windows on a Saturday, else the day's mode. */
export function offeredWindows<W extends WindowFacts>(windows: readonly W[], kind: DayKind): W[] {
  if (kind === 'sunday') return [];
  if (kind === 'saturday') return windows.filter((w) => w.mode === 'two_hour' && SATURDAY_WINDOW_STARTS.includes(w.startLocal.slice(0, 5)));
  return windows.filter((w) => w.mode === kind);
}

/** SD-27: room in a window = live jobs that day under the daily capacity and live jobs in that window under the per-window limit. */
export function technicianHasRoom(input: { capacity: number; jobsThatDay: number; jobsInWindow: number; windowMode: DayMode }): boolean {
  return input.jobsThatDay < input.capacity && input.jobsInWindow < PER_WINDOW_LIMIT[input.windowMode];
}

/**
 * dayRoom(branch, date, service) (FR-BOOK-5): the capacity of the technicians who work the date and count for the
 * service's pool, minus the day's live jobs in that pool. Never below 0. Blocks never count.
 */
export function dayRoom(input: {
  kind: DayKind;
  /** The branch's technicians who work the date with no time off. */
  working: readonly Pick<TechnicianFacts, 'installer'>[];
  serviceIsInstall: boolean;
  /** The day's live jobs, each marked whether its service is an install. */
  liveJobs: readonly { install: boolean }[];
}): number {
  const pool = input.working.filter((t) => t.installer === input.serviceIsInstall);
  const capacity = pool.reduce((sum, t) => sum + technicianDayCapacity(t, input.kind), 0);
  const used = input.liveJobs.filter((j) => j.install === input.serviceIsInstall).length;
  return Math.max(0, capacity - used);
}

/**
 * windowRoom(branch, date, window, service) (FR-BOOK-6): on a 2-hour day the smaller of the window's capacity minus its
 * live jobs and dayRoom; a 4-hour window has no per-window limit (capacity null), so its room is dayRoom.
 */
export function windowRoom(input: { windowCapacity: number | null; windowLiveJobs: number; dayRoom: number }): number {
  if (input.windowCapacity === null) return input.dayRoom;
  return Math.max(0, Math.min(input.windowCapacity - input.windowLiveJobs, input.dayRoom));
}
