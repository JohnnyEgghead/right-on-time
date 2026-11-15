// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's map, parts and Me screens, the pure part (P5-TWA-MAP-ME; UI-SPECIFICATION SCR-TEC-08, -10, -15, -16): the
// numbers and words the screens show, from the reads' answers. No React, no clock of its own, no storage (local.ts keeps the phone's
// copies), so the rules are tested without a browser (model.test.ts).
import type { dayRoute, partsList, routeLeg, TodayAnswer, z } from '@bw/api';

/** API-100, the one read of the day (Today, Me, Directions and the Map tab all read it). */
export type DayData = TodayAnswer;
export type RouteData = z.output<typeof dayRoute.response>;
export type Stop = RouteData['stops'][number];
export type Leg = z.output<typeof routeLeg>;
export type StopLeg = RouteData['legs'][number];
export type Part = z.output<typeof partsList.response>['parts'][number];

/** The milliseconds of a wire time ("2026-09-15T10:26:00-04:00[America/New_York]"); the bracketed zone name is not part of the instant. */
export const wireMs = (wire: string): number => Date.parse(wire.replace(/\[.*\]$/, ''));

/** The most parts a search lists at once; the count line says how many matched. */
export const PARTS_SHOWN = 100;

/** The parts whose name or code holds every word typed (any case); the list in its order, capped at PARTS_SHOWN. */
export function searchParts(parts: readonly Part[], query: string): { shown: Part[]; matched: number } {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return { shown: [], matched: 0 };
  const hits = parts.filter((p) => {
    const hay = `${p.name} ${p.code}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return { shown: hits.slice(0, PARTS_SHOWN), matched: hits.length };
}

/** A price as the pages show it: "$38.00". */
export const priceText = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Whole minutes from the start to now, never below 0 (FR-TECH-15 "hours on the clock", by the demo clock). */
export const minutesOnClock = (startedAt: string, now: string): number => Math.max(0, Math.floor((wireMs(now) - wireMs(startedAt)) / 60_000));

/**
 * The start the Me screen shows (OI-40): the server's, or the phone's own first action of the day while the server's has not arrived, whichever
 * is earlier. Wire times in, the earlier one out; null when neither exists.
 */
export function startOfDay(server: string | null, phone: string | null): string | null {
  if (server === null) return phone;
  if (phone === null) return server;
  return wireMs(phone) < wireMs(server) ? phone : server;
}

/** Jobs done today (FR-TECH-15, UD-51): the phone's own statuses count at once. */
export const jobsDone = (stops: readonly Pick<Stop, 'state'>[]): number => stops.filter((s) => s.state === 'done').length;

/** The text sizes of CTL-TEC-10-09 and the share of the standard size each draws (percent of the root's font size). */
export const TEXT_SIZES = ['standard', 'large', 'larger'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_PERCENT: Record<TextSize, number> = { standard: 100, large: 112.5, larger: 125 };
export const isTextSize = (v: unknown): v is TextSize => typeof v === 'string' && (TEXT_SIZES as readonly string[]).includes(v);

/** One day-changed notice's cause (CTL-TEC-02-14): a job added, one that left the day, or one with a new window. */
export type DayChange = { kind: 'added' | 'removed' | 'window'; job: number };
export interface SnapshotJob { jobNumber: number; start: string; end: string }
export interface DaySnapshot { date: string; jobs: SnapshotJob[] }

export const snapshotOf = (day: { date: string; jobs: readonly { jobNumber: number; window: { start: string; end: string } }[] }): DaySnapshot => ({
  date: day.date,
  jobs: day.jobs.map((j) => ({ jobNumber: j.jobNumber, start: j.window.start, end: j.window.end })),
});

/**
 * What a re-read found changed against what the phone last saw (UD-43, SPECIFICATIONS Me screen: "compared on the phone"): a job added, a job
 * that is no longer on the technician's day (moved to another person, canceled), a job given a new window. A new day is not a change.
 */
export function dayChanges(prev: DaySnapshot | null, next: DaySnapshot): DayChange[] {
  if (prev === null || prev.date !== next.date) return [];
  const before = new Map(prev.jobs.map((j) => [j.jobNumber, j]));
  const now = new Map(next.jobs.map((j) => [j.jobNumber, j]));
  const out: DayChange[] = [];
  for (const j of next.jobs) {
    const old = before.get(j.jobNumber);
    if (!old) out.push({ kind: 'added', job: j.jobNumber });
    else if (old.start !== j.start || old.end !== j.end) out.push({ kind: 'window', job: j.jobNumber });
  }
  for (const j of prev.jobs) if (!now.has(j.jobNumber)) out.push({ kind: 'removed', job: j.jobNumber });
  return out;
}

/** The leg into a stop, by job number. */
export const legTo = (route: Pick<RouteData, 'legs'>, job: number): StopLeg | undefined => route.legs.find((l) => l.toJob === job);

/** A leg's length in miles, to 1 decimal (CTL-TEC-15-09); null on an approximate leg, which has no length. */
export const miles = (meters: number | null): string | null => (meters === null ? null : (meters / 1609.344).toFixed(1));

/** The sign-in name as the server matches it (API-03 trims, and matches an email without case), so the UD-20 lock compares like the server (F-1065). */
export const loginKey = (login: string): string => login.trim().toLowerCase();
