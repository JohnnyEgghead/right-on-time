// SPDX-License-Identifier: AGPL-3.0-or-later
// Local-time computation, all of it in Temporal (invariant 4; SPECIFICATIONS section 3 time rule, section 7.1).
// A stored time is an instant; a local date or wall time only means something with its IANA zone. Nothing here reads
// the host's zone: every function takes the zone it computes in, so the result is the same under any TZ (NFR-08).
import { Temporal } from 'temporal-polyfill';
import type { Instant } from './clock.ts';

/** An IANA zone name, e.g. 'America/New_York'. */
export type Zone = string;
/** A local calendar date, 'YYYY-MM-DD'. */
export type LocalDate = string;
/** A local wall time, 'HH:MM' (24-hour). */
export type LocalTime = string;

/**
 * How a wall time that does not exist (spring forward) or happens twice (fall back) maps to an instant: Temporal's
 * own options. Callers choose; the seam picks no default (the specifications state no rule for the gap or the overlap).
 */
export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';

export function zoned(at: Instant, zone: Zone): Temporal.ZonedDateTime {
  return at.toZonedDateTimeISO(zone);
}

/** The instant of a local date and wall time in a zone. */
export function atLocal(date: LocalDate, time: LocalTime, zone: Zone, disambiguation: Disambiguation): Instant {
  const plain = Temporal.PlainDate.from(date).toPlainDateTime(Temporal.PlainTime.from(time));
  return plain.toZonedDateTime(zone, { disambiguation }).toInstant();
}

export function localDateOf(at: Instant, zone: Zone): LocalDate {
  return zoned(at, zone).toPlainDate().toString();
}

export function localTimeOf(at: Instant, zone: Zone): LocalTime {
  return zoned(at, zone).toPlainTime().toString({ smallestUnit: 'minute' });
}

/** Calendar arithmetic on a local date (a day is a date step, never 24 hours). */
export function addDays(date: LocalDate, days: number): LocalDate {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** Whether the local wall time of `at` falls in [start, end); a window with start after end runs past midnight. */
export function inLocalWindow(at: Instant, zone: Zone, start: LocalTime, end: LocalTime): boolean {
  const t = zoned(at, zone).toPlainTime();
  const s = Temporal.PlainTime.from(start);
  const e = Temporal.PlainTime.from(end);
  const afterStart = Temporal.PlainTime.compare(t, s) >= 0;
  const beforeEnd = Temporal.PlainTime.compare(t, e) < 0;
  return Temporal.PlainTime.compare(s, e) <= 0 ? afterStart && beforeEnd : afterStart || beforeEnd;
}

/**
 * The first instant at or after `at` whose wall time in `zone` is `time`. A wall time inside a spring-forward gap
 * resolves forward (Temporal 'compatible'), so the result is never before the gap.
 */
export function nextLocalTime(at: Instant, zone: Zone, time: LocalTime): Instant {
  const date = localDateOf(at, zone);
  const same = atLocal(date, time, zone, 'compatible');
  if (Temporal.Instant.compare(same, at) >= 0) return same;
  return atLocal(addDays(date, 1), time, zone, 'compatible');
}

/** The wire form (section 7.1; UI-SPECIFICATION 12.1 rule 5): RFC 9557 with instant, offset and IANA zone. */
export function toWire(at: Instant, zone: Zone): string {
  return zoned(at, zone).toString();
}

/** A wire time carries a full date-time, its numeric offset (or Z) and the IANA zone (section 7.1). */
const WIRE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\[[^\]]+\]$/;

/**
 * Parse a wire time; an offset that disagrees with the zone at that instant is refused, never silently moved. A time
 * with no offset is refused too (F-182): with none, Temporal would pick the instant itself ('compatible'), moving a
 * time in a gap or taking the earlier of two in a fall-back hour, and a date alone would pass as midnight.
 */
export function fromWire(text: string): Temporal.ZonedDateTime {
  if (!WIRE_SHAPE.test(text)) throw new RangeError(`not an RFC 9557 time with an offset and an IANA zone: ${text}`);
  return Temporal.ZonedDateTime.from(text, { offset: 'reject' });
}
