// SPDX-License-Identifier: AGPL-3.0-or-later
// Text the billing pages show from the API's values: money from cents (SD-20), times from the RFC 9557 strings the API writes
// (UD-15, UD-16: 12-hour "AM" and "PM" in both languages), and a person's short name ("Keisha T.").
import type { MessageKey } from '@bw/i18n';
import { dateParts, formatTime, fromWire, type Language } from '@bw/time';

/** 13265 -> "$132.65"; a negative amount is "-$13.35" (the discount row). */
export function money(cents: number): string {
  const abs = Math.abs(cents);
  const text = `$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `-${text}` : text;
}

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

const instantOf = (wire: string) => fromWire(wire);

/** "10:28 AM" in the stamp's own zone. */
export function clockText(wire: string, lang: Language): string {
  const z = instantOf(wire);
  return formatTime(z.toInstant(), z.timeZoneId, lang);
}

/** "Mon, 3:12 PM": the weekday and the time (the Fixed table's When). */
export function dayTimeText(wire: string, lang: Language, t: T): string {
  const z = instantOf(wire);
  const p = dateParts(z.toInstant(), z.timeZoneId);
  return `${t(`time.weekday.${p.weekday}` as MessageKey)}, ${formatTime(z.toInstant(), z.timeZoneId, lang)}`;
}

/** "Tue, Sep 15, 10:15 AM" (the pretend billing pages). */
export function fullText(wire: string, lang: Language, t: T): string {
  const z = instantOf(wire);
  const p = dateParts(z.toInstant(), z.timeZoneId);
  return `${t(`time.weekday.${p.weekday}` as MessageKey)}, ${t(`time.month.${p.month}` as MessageKey)} ${p.day}, ${formatTime(z.toInstant(), z.timeZoneId, lang)}`;
}

/** Whether the stamp falls on the same local date as `nowWire` (the "Today" under a done-at time). */
export function sameDay(wire: string, nowWire: string): boolean {
  const a = instantOf(wire);
  const b = instantOf(nowWire).withTimeZone(a.timeZoneId);
  return a.toPlainDate().equals(b.toPlainDate());
}

/** "Keisha Thompson" -> "Keisha T." (the billing rows' words own it, so the export says the same name: @bw/i18n billing-rows). */
export { shortName } from '@bw/i18n';

/** "boiler repair" -> "Boiler repair". */
export const capitalFirst = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));
