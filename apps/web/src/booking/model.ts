// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers of the booking site's pages (SCR-CUS-01 to SCR-CUS-03; UI-SPECIFICATION section 9; FR-BOOK-1 to FR-BOOK-16): the draft the
// customer fills in, the steps and what each needs, the calendar's month grid, the words of a day and a window, the nearest-window words of
// the Window just taken page, and the draft's keeping across a reload (UIS.FR-STATE-4). No React, no network.
import type { OnlineDay, OnlineWindow } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import type { IconName } from '../shell/icon-paths.ts';
import type { ClientT } from '../shell/intl.tsx';
import { fromWire, zoneAbbreviation } from '@bw/time';
import { windowText } from '../board/model.ts';

export type Lang = 'en' | 'es';
export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6;
export const STEPS: readonly StepNumber[] = [1, 2, 3, 4, 5, 6];

export interface Street { streetId: string; name: string; city: string; zip: string; branch: string }
export interface ServiceItem { serviceId: string; screenLabelKey: string; priceTextKey: string; typicalLengthKey: string }

/** Everything the customer has typed or picked. The mobile number and the name stay in the browser only (NFR-05: never in a URL). */
export interface Draft {
  serviceId: string | null;
  /** The text in the street field. */
  streetText: string;
  street: Street | null;
  house: string;
  date: string | null;
  windowId: string | null;
  name: string;
  mobile: string;
  textsOn: boolean;
  textLanguage: Lang;
  /** True once the customer picked the text language: it then stops following the page's language (CTL-CUS-01-16). */
  languagePicked: boolean;
}

export const emptyDraft = (lang: Lang): Draft => ({
  serviceId: null, streetText: '', street: null, house: '', date: null, windowId: null, name: '', mobile: '', textsOn: true, textLanguage: lang, languagePicked: false,
});

/** The service icons of the Book a visit page's picker (DK-118; a service the frame does not draw takes its nearest trade's). */
const SERVICE_ICON: Record<string, IconName> = {
  furnace_tune_up: 'flame', ac_tune_up: 'snow', heating_or_ac_fix: 'wrench', plumbing_repair: 'drop', water_heater: 'heater', thermostat: 'gauge',
};
export const serviceIcon = (serviceId: string): IconName => SERVICE_ICON[serviceId] ?? 'wrench';

/** A US mobile as 10 digits, or null (the server stores E.164; this only checks what the field holds, CTL-CUS-01-08). */
export function mobileDigits(text: string): string | null {
  const d = text.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return /^\d{10}$/.test(ten) && /^[0-9+().\s-]*$/.test(text) ? ten : null;
}
export const hasMobile = (d: Draft): boolean => d.mobile.trim() !== '';
/** "(614) 555-0148" for 10 digits; the text as typed otherwise. */
export function phoneText(text: string): string {
  const m = mobileDigits(text);
  return m ? `(${m.slice(0, 3)}) ${m.slice(3, 6)}-${m.slice(6)}` : text.trim();
}

/** A house number the booking form accepts: a whole number from 1 to 99999, else null (CTL-CUS-01-14). */
export const houseNumber = (text: string): number | null => (/^\d{1,5}$/.test(text.trim()) && Number(text) >= 1 ? Number(text) : null);

/** Whether a step's own fields are complete (the Continue button of steps 1 to 5, CTL-CUS-01-10). */
export function stepComplete(step: StepNumber, d: Draft): boolean {
  switch (step) {
    case 1: return d.serviceId !== null;
    case 2: return d.street !== null && houseNumber(d.house) !== null;
    case 3: return d.date !== null;
    case 4: return d.windowId !== null;
    case 5: return d.name.trim() !== '' && (!hasMobile(d) || mobileDigits(d.mobile) !== null);
    case 6: return true;
  }
}

/** The first step whose fields are not complete, 6 when all are: where a restored draft lands. */
export const firstOpenStep = (d: Draft): StepNumber => STEPS.find((s) => s < 6 && !stepComplete(s, d)) ?? 6;

/** Texts need a mobile number: with none the box is unticked and off whatever the draft says (UD-42). */
export const textsOn = (d: Draft): boolean => hasMobile(d) && d.textsOn;

/** The picked service's line on a tile or in the summary: the price, and for a plain amount its length after it ("$89, about 1 hr"). */
export function serviceLine(t: ClientT, s: ServiceItem): string {
  const price = t(s.priceTextKey as MessageKey);
  return /^\$\d+$|^\$\d+ USD$/.test(price) ? `${price}, ${t(s.typicalLengthKey as MessageKey)}` : price;
}
/** The price alone ("$89", "$79 visit fee"): the Confirm summary's "Furnace tune-up, $89". */
export const serviceWithPrice = (t: ClientT, s: ServiceItem): string => `${t(s.screenLabelKey as MessageKey)}, ${t(s.priceTextKey as MessageKey)}`;

/** "418 Maple Hollow Ct, Westerville 43081" (the street and its city and ZIP code come from the street list). */
export const addressLine = (house: number | string, street: Pick<Street, 'name' | 'city' | 'zip'>): string => `${house} ${street.name}, ${street.city} ${street.zip}`;

// --- Dates -----------------------------------------------------------------------------------------------------------------------------

const ymd = (date: string) => ({ y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) });
/** ISO weekday of a "YYYY-MM-DD": 1 Monday to 7 Sunday. */
function isoWeekday(date: string): number {
  const x = ymd(date);
  const w = new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay();
  return w === 0 ? 7 : w;
}
export const addDaysTo = (date: string, n: number): string => {
  const x = ymd(date);
  return new Date(Date.UTC(x.y, x.m - 1, x.d + n)).toISOString().slice(0, 10);
};
export const monthOf = (date: string): string => date.slice(0, 7);
export const addMonthsTo = (month: string, n: number): string => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  return `${y + Math.floor(m / 12)}-${String(((m % 12) + 12) % 12 + 1).padStart(2, '0')}`;
};
const daysInMonth = (month: string): number => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

type DateValues = Record<'weekday' | 'month' | 'day' | 'year', string | number>;
const dateValues = (t: ClientT, date: string): DateValues => {
  const x = ymd(date);
  return { weekday: t(`time.weekday.${isoWeekday(date)}` as MessageKey), month: t(`time.month.${x.m}` as MessageKey), day: x.d, year: x.y };
};
/** "Tue, Sep 15" (Spanish: "mar 15 sep"). */
export const dayShort = (t: ClientT, date: string): string => t('booking.date.short', dateValues(t, date));
/** "Tue, Sep 15, 2026". */
export const dayLong = (t: ClientT, date: string): string => t('booking.date.long', dateValues(t, date));
/** "September 2026". */
export const monthTitle = (t: ClientT, month: string): string =>
  t('booking.cal.month', { month: t(`booking.month.${Number(month.slice(5, 7))}` as MessageKey), year: month.slice(0, 4) });

/**
 * A window as a customer page names it, with the branch zone after it: "10 AM-12 PM EDT" (UD-15, owner ruling 037420bb "Branch zone",
 * F-1122; DK-118 to DK-121). The zone is the one the server told the time in (the wire time's own zone, F-1084), and its abbreviation
 * is the one at that instant, so a window in November reads EST.
 */
export function windowZoned(start: string, end: string): string {
  const at = fromWire(start);
  return `${windowText(start, end)} ${zoneAbbreviation(at.toInstant(), at.timeZoneId)}`;
}

/** A window as the booking pages name it: "10 AM-12 PM EDT". */
export const windowLabel = (w: Pick<OnlineWindow, 'start' | 'end'>): string => windowZoned(w.start, w.end);

// --- The booking calendar and the kind of each day (CTL-CUS-01-05, CTL-CUS-01-19) -----------------------------------------------------------------------------------------

export type DayKind = 'past' | 'today' | 'open' | 'few' | 'sunday' | 'noTech' | 'closed' | 'full' | 'unknown';

/** What a calendar day is: its word and whether it can be picked. A day the answer does not carry is `unknown` (not offered). */
export function dayKind(date: string, today: string, days: ReadonlyMap<string, OnlineDay>): DayKind {
  if (date < today) return 'past';
  if (date === today) return 'today';
  const d = days.get(date);
  if (!d) return 'unknown';
  if (d.reason === 'sunday') return 'sunday';
  if (d.reason === 'no_technicians') return 'noTech';
  if (d.reason === 'booking_closed') return 'closed';
  if (d.state === 'full') return 'full';
  return d.fewLeft ? 'few' : 'open';
}
export const pickable = (k: DayKind): boolean => k === 'open' || k === 'few';

const DAY_WORD: Record<DayKind, MessageKey> = {
  open: 'booking.cal.open', few: 'booking.cal.few', sunday: 'booking.cal.sunday', noTech: 'booking.cal.noTech', closed: 'booking.cal.closed', full: 'booking.cal.full',
  past: 'booking.cal.past', today: 'booking.cal.closed', unknown: 'booking.cal.closed',
};
/** The accessible name of a day: "Wed, Sep 16, Only a few windows left"; a past day ends "past, not bookable" (CTL-CUS-01-19). */
export function dayName(t: ClientT, date: string, kind: DayKind): string {
  const day = dayShort(t, date);
  return kind === 'past' ? t('booking.cal.past', { day }) : `${day}, ${t(DAY_WORD[kind])}`;
}

export interface Cell { date: string | null; day: number | null; kind: DayKind | null }
/** The month's grid, Sunday first: leading blanks, then each day with its kind. */
export function monthGrid(month: string, today: string, days: ReadonlyMap<string, OnlineDay>): Cell[] {
  const first = `${month}-01`;
  const lead = isoWeekday(first) % 7;
  const cells: Cell[] = Array.from({ length: lead }, () => ({ date: null, day: null, kind: null }));
  for (let d = 1; d <= daysInMonth(month); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    cells.push({ date, day: d, kind: dayKind(date, today, days) });
  }
  return cells;
}

/** The 5 days a phone shows around the picked day or today (the strip of the Book a visit phone frame, DK-119): bookable or not, each its kind. */
export function dayStrip(from: string, today: string, days: ReadonlyMap<string, OnlineDay>): { date: string; kind: DayKind }[] {
  return Array.from({ length: 5 }, (_, i) => addDaysTo(from, i)).map((date) => ({ date, kind: dayKind(date, today, days) }));
}

/** The first day that can be picked, or null: where the calendar opens and whether "No open days right now" shows. */
export const firstPickable = (days: readonly OnlineDay[]): string | null => days.find((d) => d.state === 'open' && d.reason === null)?.date ?? null;

/** "4-hour day": the day's own windows are the 4-hour ones (CTL-CUS-01-06). */
export const isFourHour = (d: OnlineDay | undefined): boolean => d?.mode === 'four_hour';

// --- The Window just taken page (CTL-CUS-02-05) ----------------------------------------------------------------------------------------------

export interface Nearest extends OnlineWindow { date: string }
const hourOfWire = (wire: string): number => Number(/T(\d{2}):/.exec(wire)?.[1] ?? 0);

/** The words of 1 option against the window that filled: "Same day, 2 hours later", "Same day", "Same time, next day", else the weekday. */
export function optionWords(t: ClientT, filled: { date: string; start: string }, o: Nearest): string {
  if (o.date === filled.date) {
    const gap = hourOfWire(o.start) - hourOfWire(filled.start);
    if (gap > 0 && gap <= 4) return t('booking.taken.sameLater', { n: gap });
    if (gap < 0 && gap >= -4) return t('booking.taken.sameEarlier', { n: -gap });
    return t('booking.taken.sameDay');
  }
  if (o.date === addDaysTo(filled.date, 1) && hourOfWire(o.start) === hourOfWire(filled.start)) return t('booking.taken.sameTime');
  return t(`time.weekday.${isoWeekday(o.date)}` as MessageKey);
}
/** An option's room: "<n> left" when the answer gives places left, else Open. */
export const roomWords = (t: ClientT, w: Pick<OnlineWindow, 'placesLeft'>): string => (w.placesLeft !== null ? t('booking.window.left', { n: w.placesLeft }) : t('booking.window.open'));

// --- Keeping the booking draft in the browser (UIS.FR-STATE-4) -------------------------------------------------------------------------------------------------------

const KEY = 'bw.booking.draft';
export interface Kept { draft: Draft; step: StepNumber; taken: { date: string; windowId: string; start: string; end: string } | null }
/** The draft survives a reload and the language switch in this tab's session storage; no storage (a private window) simply keeps nothing. */
export function readKept(): Kept | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Kept) : null;
  } catch {
    return null;
  }
}
export function writeKept(k: Kept | null): void {
  try {
    if (k === null) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, JSON.stringify(k));
  } catch {
    // no storage: nothing is kept
  }
}

/** The widest a phone layout is (the menu button of the booking site header, CTL-CMP-15-05, shows below it too): wider is the computer layout. */
export const PHONE_MAX_WIDTH = 760;
