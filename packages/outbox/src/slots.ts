// SPDX-License-Identifier: AGPL-3.0-or-later
// The text slot formatter (SPECIFICATIONS section 6.4, SD-17; REQUIREMENTS FR-TEXT-9 slot table, FR-TEXT-10, FR-TEXT-18):
// the one place a visit's weekday, date, window, service, technician, arrival time and links become the words a
// template prints. Every label is GSM-7 basic set only and within SD-17's maxima; text-budget-check (G-CI8) enumerates
// these same functions over every value, so a label that could break a text fails CI, never a customer.
import { formatTime, Temporal, zoned, zoneAbbreviation, type Instant, type Zone } from '@bw/time';
import { catalogTexts, type TextCatalog, type TextLanguage } from './render.ts';
import type { VisitDayLabels } from './reply.ts';

/** The flat catalogs per language (for example @bw/i18n's `catalogs`). */
export type TextCatalogs = Record<TextLanguage, Record<string, string>>;

/** The templates of a pair of catalogs. */
export function textCatalogOf(catalogs: TextCatalogs): TextCatalog {
  return catalogTexts(catalogs);
}

function word(catalogs: TextCatalogs, lang: TextLanguage, key: string): string {
  const v = catalogs[lang][key];
  if (v === undefined) throw new Error(`the ${lang} catalog has no key ${key} (a text slot label)`);
  return v;
}

/** Weekday label of a bookable day, ISO 1 (Monday) to 6 (Saturday). The Spanish Saturday is "sáb", which is not GSM-7 basic, so no Spanish template prints a weekday (F-419, FR-TEXT-10). */
export function weekdayLabel(catalogs: TextCatalogs, lang: TextLanguage, isoDay: number): string {
  return word(catalogs, lang, `slot.weekday.${isoDay}`);
}

/** Date label: English "Sep 15", Spanish "15 de sep" (SD-17 maxima 6 and 12; the booklet's date format). */
export function dateLabel(catalogs: TextCatalogs, lang: TextLanguage, month: number, day: number): string {
  const m = word(catalogs, lang, `time.month.${month}`);
  return lang === 'en' ? `${m} ${day}` : `${day} de ${m}`;
}

/** P3-TEXTS's slot formatter for the R-reply (reply.ts VisitDayLabels). */
export function visitDayLabels(catalogs: TextCatalogs): VisitDayLabels {
  return (localDate, lang) => {
    const d = Temporal.PlainDate.from(localDate);
    return { weekday: weekdayLabel(catalogs, lang, d.dayOfWeek), date: dateLabel(catalogs, lang, d.month, d.day) };
  };
}

/** A whole hour of a window as a 12-hour number and its meridiem. */
function hour12(h: number): { n: number; mer: 'AM' | 'PM' } {
  return { n: h % 12 === 0 ? 12 : h % 12, mer: h < 12 ? 'AM' : 'PM' };
}

/**
 * Window label from its local start and end hours: "8-10 AM", "10 AM-12 PM", "12-2 PM", "8 AM-12 PM" (SD-17 maximum
 * 14 in English, 17 in Spanish before the zone). Both languages keep "AM" and "PM" (FR-TEXT-10).
 */
export function windowLabel(startHour: number, endHour: number, lang: TextLanguage = 'en'): string {
  const s = hour12(startHour);
  const e = hour12(endHour);
  // Spanish is the approved frame's wording (SD-17, DK-127): "de 2 a 4 PM", "de 10 AM a 12 PM" (the start's meridiem is left out where it matches the end's).
  if (lang === 'es') return s.mer === e.mer ? `de ${s.n} a ${e.n} ${e.mer}` : `de ${s.n} ${s.mer} a ${e.n} ${e.mer}`;
  return s.mer === e.mer ? `${s.n}-${e.n} ${e.mer}` : `${s.n} ${s.mer}-${e.n} ${e.mer}`;
}

/** The label of a job's window instants in the job's zone. */
export function windowLabelOf(start: Instant, end: Instant, zone: Zone, lang: TextLanguage = 'en'): string {
  return windowLabel(zoned(start, zone).hour, zoned(end, zone).hour, lang);
}

/**
 * The window label a customer text prints, with the branch zone after it: "10 AM-12 PM EDT" (UD-15, owner ruling 037420bb "Branch zone",
 * F-1122; DK-126, DK-127). The zone is the job's, its abbreviation the one at the window's start (EST after the November change).
 */
export function windowLabelZoned(start: Instant, end: Instant, zone: Zone, lang: TextLanguage = 'en'): string {
  return `${windowLabelOf(start, end, zone, lang)} ${zoneAbbreviation(start, zone)}`;
}

/** The arrival time as the text prints it: rounded to 5 minutes, "10:40 AM" (SPECIFICATIONS section 6.4; SD-17 maximum 8). */
export function arrivalLabel(eta: Instant, zone: Zone, lang: TextLanguage): { label: string; rounded: Instant } {
  const rounded = zoned(eta, zone).round({ smallestUnit: 'minute', roundingIncrement: 5, roundingMode: 'halfExpand' }).toInstant();
  return { label: formatTime(rounded, zone, lang), rounded };
}

/** The service's text label (kept separate from its screen label so "-cion" words stay out, FR-TEXT-9). */
export function serviceLabel(catalogs: TextCatalogs, lang: TextLanguage, textLabelKey: string): string {
  return word(catalogs, lang, textLabelKey);
}

export type LinkKind = 'map' | 'reschedule';
const LINK_PATH: Record<LinkKind, string> = { map: 'm', reschedule: 'r' };

/** A link as a text writes it: the text link host, no scheme, SD-17's shapes: bw.j7l.io/m/7Hk2Ab9Q (20 characters). */
export function textLink(host: string, kind: LinkKind, token: string): string {
  return `${host}/${LINK_PATH[kind]}/${token}`;
}

/**
 * FR-TEXT-18: the hosts a rendered text names. A word that looks like a link (a dotted name followed by a path, or
 * http/https) must be exactly the text link host; returns the others.
 */
export function foreignHosts(body: string, linkHost: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/(?:https?:\/\/)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?=\/|\b)/g)) {
    const host = m[1] as string;
    if (host.toLowerCase() !== linkHost.toLowerCase() && /[A-Za-z]{2,}$/.test(host) && !/^\d+(?:\.\d+)+$/.test(host)) out.push(host);
  }
  return out;
}
