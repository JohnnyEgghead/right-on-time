// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain calendar dates as day numbers (days since 1970-01-01). The generator writes local wall-clock dates and times
// only, never an instant, so no time-zone arithmetic happens here (the importer applies the branch zone).

const DAY_MS = 86_400_000;

export function day(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`calendar.day: not a YYYY-MM-DD date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

export function iso(d: number): string {
  return new Date(d * DAY_MS).toISOString().slice(0, 10);
}

/** ISO day of week: 1 = Monday ... 7 = Sunday. */
export function isoDow(d: number): number {
  return ((((d + 3) % 7) + 7) % 7) + 1;
}

/** The Monday that starts d's week (weeks start Monday, SD-25). */
export function weekStart(d: number): number {
  return d - (isoDow(d) - 1);
}

/** Minutes after midnight as HH:MM. */
export function hhmm(minutes: number): string {
  if (minutes < 0 || minutes >= 24 * 60) throw new Error(`calendar.hhmm: out of the day: ${minutes}`);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function minutesOf(t: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) throw new Error(`calendar.minutesOf: not HH:MM: ${t}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
