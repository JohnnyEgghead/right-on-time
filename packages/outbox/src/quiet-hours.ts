// SPDX-License-Identifier: AGPL-3.0-or-later
// Quiet hours and the try schedule (FR-TEXT-7, FR-TEXT-12; invariant 9; SPECIFICATIONS section 5.2 steps 2 and 3).
// Pure Temporal arithmetic in the customer's own IANA zone: nothing reads the host zone or the database session zone,
// so the answer is the same under every host zone of NFR-08's matrix (gate G-CI9 runs it under all 3).
import { inLocalWindow, nextLocalTime, type Instant, type Zone } from '@bw/time';
import { isQuietHoursExempt, MAX_TRIES, QUIET_END, QUIET_START, TRY_OFFSETS_MINUTES } from './model.ts';

/**
 * Whether `at` falls between 9:00 PM (included) and 8:00 AM (excluded) in `zone`. A text `kind` in
 * QUIET_HOURS_EXEMPT_KINDS is never in quiet hours (F-1545).
 */
export function inQuietHours(at: Instant, zone: Zone, kind?: string): boolean {
  if (isQuietHoursExempt(kind)) return false;
  return inLocalWindow(at, zone, QUIET_START, QUIET_END);
}

/**
 * The earliest time at or after `at` a text may be sent in `zone`: `at` itself outside quiet hours, else the next
 * 8:00 AM there (exact on daylight-saving days: 8:00 AM is a wall time, never `at` plus a number of hours).
 */
export function releaseTime(at: Instant, zone: Zone, kind?: string): Instant {
  return inQuietHours(at, zone, kind) ? nextLocalTime(at, zone, QUIET_END) : at;
}

/**
 * The planned time of try `number` (1 to 5) of a text whose first try ran at `firstTryAt`: the first try's time plus
 * 0, 2, 4, 9 or 19 minutes. A try that lands in quiet hours is pushed to the next 8:00 AM, and the tries after it keep
 * their spacing from there (owner-approved 7ccb76ec, F-371): the first pushed try is at 8:00 AM, the next 8:00 AM plus the
 * gap between their offsets, so a text first tried at 8:52 PM does not run 2 or 3 tries back to back at 8:00 AM. The try
 * handler schedules with this and API-41's plannedTries reads it, so the two can never disagree (section 6.4, FR-TEXT-12).
 */
export function plannedTryAt(firstTryAt: Instant, number: number, zone: Zone, kind?: string): Instant {
  const offset = TRY_OFFSETS_MINUTES[number - 1];
  if (offset === undefined) throw new RangeError(`there is no try ${number}: a text has tries 1 to ${MAX_TRIES} (FR-TEXT-12)`);
  for (let k = 1; k <= number; k++) {
    const raw = firstTryAt.add({ minutes: TRY_OFFSETS_MINUTES[k - 1]! });
    if (inQuietHours(raw, zone, kind)) return releaseTime(raw, zone, kind).add({ minutes: offset - TRY_OFFSETS_MINUTES[k - 1]! });
  }
  return firstTryAt.add({ minutes: offset });
}

/** API-41's plannedTries: the tries numbered after `afterNumber`, at their planned times (empty after try 5). */
export function plannedTries(firstTryAt: Instant, afterNumber: number, zone: Zone, kind?: string): { number: number; at: Instant }[] {
  const out: { number: number; at: Instant }[] = [];
  for (let n = afterNumber + 1; n <= MAX_TRIES; n++) out.push({ number: n, at: plannedTryAt(firstTryAt, n, zone, kind) });
  return out;
}
