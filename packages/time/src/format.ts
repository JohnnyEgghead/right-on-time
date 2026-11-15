// SPDX-License-Identifier: AGPL-3.0-or-later
// The shared time formatter (SPECIFICATIONS SD-47 Times on screen; UI-SPECIFICATION UD-15, UD-16).
// Every time renders with "AM" and "PM" in both languages, like the texts. Weekday and month names come from the
// message catalog (UI-SPECIFICATION section 12 rule 7), so dateParts hands out numbers, never names.
import type { Instant } from './clock.ts';
import { zoned, type Zone } from './zone.ts';

export type Language = 'en' | 'es';

/** UD-16: both languages say "AM" and "PM" (never "a. m." or "p. m."). */
const MERIDIEM: Record<Language, readonly [am: string, pm: string]> = { en: ['AM', 'PM'], es: ['AM', 'PM'] };

/** '6:00 PM' in English and in Spanish (UD-16: Spanish screens keep "AM" and "PM"). */
export function formatTime(at: Instant, zone: Zone, lang: Language = 'en'): string {
  const z = zoned(at, zone);
  const h12 = z.hour % 12 === 0 ? 12 : z.hour % 12;
  const [am, pm] = MERIDIEM[lang];
  return `${h12}:${String(z.minute).padStart(2, '0')} ${z.hour < 12 ? am : pm}`;
}

/** The zone's abbreviation at that instant: 'EST', 'EDT', 'PST', 'MST' (UD-15: the header clock names its zone). */
export function zoneAbbreviation(at: Instant, zone: Zone): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(
    at.epochMilliseconds,
  );
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? zone;
}

/** '6:00 PM EST'. */
export function formatTimeWithZone(at: Instant, zone: Zone, lang: Language = 'en'): string {
  return `${formatTime(at, zone, lang)} ${zoneAbbreviation(at, zone)}`;
}

export interface DateParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** ISO weekday: 1 is Monday, 7 is Sunday. */
  weekday: number;
}

/** The local date of an instant as numbers, for the catalog's weekday and month names. */
export function dateParts(at: Instant, zone: Zone): DateParts {
  const z = zoned(at, zone);
  return { year: z.year, month: z.month, day: z.day, weekday: z.dayOfWeek };
}
