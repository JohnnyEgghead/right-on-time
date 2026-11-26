// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers of the customer screens (SCR-OFC-05, SCR-OFC-38, SCR-OFC-06, SCR-OFC-39, SCR-OFC-40): phone and date text, the
// New customer and Edit customer form rules, the search request, and the time zones the page offers. No React, no network.
import type { MessageKey } from '@bw/i18n';
import type { ClientT } from '../shell/intl.tsx';
import { usDigits } from '../shell/phone.ts';

// The phone helpers live in shell/phone.ts (F-1888: the 1 formatter every screen shows a stored number through).
export { formatPhone, usDigits } from '../shell/phone.ts';

export function dateNumbers(date: string): { year: number; month: number; day: number; weekday: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { year: y, month: m, day: d, weekday: ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1 };
}

const wd = (n: number) => `time.weekday.${n}` as MessageKey;
const mo = (n: number) => `time.month.${n}` as MessageKey;

/** "Mar 3, 2026". */
export function dateLong(t: ClientT, date: string): string {
  const n = dateNumbers(date);
  return t('customers.date.long', { month: t(mo(n.month)), day: n.day, year: n.year });
}
/** "Oct 2014". */
export function monthYear(t: ClientT, date: string): string {
  const n = dateNumbers(date);
  return t('customers.date.monthYear', { month: t(mo(n.month)), year: n.year });
}
/** "Thu, Sep 17". */
export function dayShort(t: ClientT, date: string): string {
  const n = dateNumbers(date);
  return t('customers.date.short', { weekday: t(wd(n.weekday)), month: t(mo(n.month)), day: n.day });
}

function hourParts(h: number, m: number): { text: string; ap: string } {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { text: m === 0 ? String(h12) : `${h12}:${String(m).padStart(2, '0')}`, ap: h < 12 ? 'AM' : 'PM' };
}
const clock = (wire: string): { date: string; h: number; m: number } => {
  const x = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(wire);
  if (!x) throw new Error(`not an RFC 9557 time: ${wire}`);
  return { date: x[1] as string, h: Number(x[2]), m: Number(x[3]) };
};
/** "10 AM-12 PM", "8-10 AM". */
export function windowText(start: string, end: string): string {
  const a = clock(start);
  const b = clock(end);
  const pa = hourParts(a.h, a.m);
  const pb = hourParts(b.h, b.m);
  return `${pa.ap === pb.ap ? pa.text : `${pa.text} ${pa.ap}`}-${pb.text} ${pb.ap}`;
}
/** "10:40 AM". */
export function clockText(wire: string): string {
  const c = clock(wire);
  const p = hourParts(c.h, c.m);
  return `${p.text.includes(':') ? p.text : `${p.text}:00`} ${p.ap}`;
}

export const initialsOf = (name: string): string => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? (w[w.length - 1]?.[0] ?? '') : '')).toUpperCase();
};
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;
/** "Keisha T." for "Keisha Thompson". */
export const shortName = (name: string): string => {
  const w = name.trim().split(/\s+/);
  return w.length > 1 ? `${w[0]} ${w[w.length - 1]?.[0]}.` : name;
};

// --- The customer search request and its filters (CTL-OFC-05-01, -06 to -11) -------------------------------------------------------------------

export interface SearchFilters {
  branch: string | null;
  city: string | null;
  plan: 'comfort_club' | 'none' | null;
  textLanguage: 'en' | 'es' | null;
  upcomingVisit: boolean | null;
}
export const NO_FILTERS: SearchFilters = { branch: null, city: null, plan: null, textLanguage: null, upcomingVisit: null };
export const filtersSet = (f: SearchFilters): boolean => Object.values(f).some((v) => v !== null);
/** The empty state: no text and no filter (CTL-OFC-05-01: nothing is sent). */
export const searchIsEmpty = (query: string, f: SearchFilters): boolean => query.trim() === '' && !filtersSet(f);

/** The query words wrapped for <mark>: the parts of `name` the folded query matches, folded the way the server folds (apostrophes out). */
export function markParts(name: string, query: string): { text: string; hit: boolean }[] {
  const q = query.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (q === '') return [{ text: name, hit: false }];
  // Walk the name, folding as we go: apostrophes vanish, any other non-alphanumeric run is 1 space. Map folded offsets to name offsets.
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const ch = name[i] as string;
    if (/['’]/.test(ch)) continue;
    const lower = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (/[a-z0-9]/.test(lower)) {
      folded += lower;
      map.push(i);
    } else if (!folded.endsWith(' ') && folded !== '') {
      folded += ' ';
      map.push(i);
    }
  }
  const at = folded.indexOf(q);
  if (at < 0) return [{ text: name, hit: false }];
  const start = map[at] as number;
  const lastFolded = at + q.length - 1;
  const end = (map[lastFolded] as number) + 1;
  // Apostrophes inside the match belong to it; extend over a trailing one.
  const parts = [{ text: name.slice(0, start), hit: false }, { text: name.slice(start, end), hit: true }, { text: name.slice(end), hit: false }];
  return parts.filter((p) => p.text !== '');
}

// --- The new and edit customer forms (SCR-OFC-38, SCR-OFC-39) -----------------------------------------------------------------------------------

export interface CustomerForm {
  name: string;
  mobile: string;
  /** The picked street; null until one is picked from the list (CTL-OFC-38-03). */
  street: { streetId: string; name: string; city: string; zip: string; branch: string } | null;
  streetText: string;
  houseNumber: string;
  textLanguage: 'en' | 'es';
  textsOn: boolean;
}

export type FormProblem = 'name' | 'mobile' | 'street' | 'house';

/** The field messages of the form (empty name, a number that is not 10 digits, no picked street, an empty or out-of-range house number). */
export function formProblems(f: CustomerForm): FormProblem[] {
  const out: FormProblem[] = [];
  if (f.name.trim() === '') out.push('name');
  if (f.mobile.trim() !== '' && usDigits(f.mobile) === null) out.push('mobile');
  if (f.street === null) out.push('street');
  const h = Number(f.houseNumber.trim());
  if (!/^\d{1,5}$/.test(f.houseNumber.trim()) || h < 1 || h > 99999) out.push('house');
  return out;
}

/** Texts need a mobile phone (CTL-OFC-38-06): the checkbox is off and disabled without one. */
export const textsAllowed = (f: Pick<CustomerForm, 'mobile'>): boolean => usDigits(f.mobile) !== null;

/** Whether the form holds any input (CTL-OFC-38-09: Cancel asks to discard only then). */
export const formHasInput = (f: CustomerForm): boolean => f.name.trim() !== '' || f.mobile.trim() !== '' || f.streetText.trim() !== '' || f.houseNumber.trim() !== '';

export const EMPTY_FORM: CustomerForm = { name: '', mobile: '', street: null, streetText: '', houseNumber: '', textLanguage: 'en', textsOn: true };

// --- The customer page: time zones, equipment words, its controls' calls and note times (SCR-OFC-06); and the search page's Also found in jobs line (SCR-OFC-05) --------------------------------------------------------------------------------------------------

/** The United States zones the time zone select offers (CTL-OFC-06-06): IANA name and the catalog word of its name. */
export const US_ZONES = [
  { id: 'America/New_York', key: 'customers.zone.eastern' },
  { id: 'America/Chicago', key: 'customers.zone.central' },
  { id: 'America/Denver', key: 'customers.zone.mountain' },
  { id: 'America/Phoenix', key: 'customers.zone.arizona' },
  { id: 'America/Los_Angeles', key: 'customers.zone.pacific' },
  { id: 'America/Anchorage', key: 'customers.zone.alaska' },
  { id: 'Pacific/Honolulu', key: 'customers.zone.hawaii' },
] as const;

/** "Eastern (America/New_York)": the zone named in words with its IANA name (CTL-OFC-06-04). */
export function zoneText(t: ClientT, id: string): string {
  const z = US_ZONES.find((x) => x.id === id);
  return z ? `${t(z.key as MessageKey)} (${id})` : id;
}

/** The equipment icon of a type (CTL-OFC-06-10): the frame's flame, snowflake, water heater and gauge. */
export function equipmentIcon(type: string): { icon: 'flame' | 'snow' | 'heater' | 'gauge'; tone: 'orange' | 'teal' | 'blue' | 'ink' } {
  if (type === 'furnace' || type === 'boiler') return { icon: 'flame', tone: 'orange' };
  if (type === 'air_conditioner' || type === 'heat_pump') return { icon: 'snow', tone: 'teal' };
  if (type === 'water_heater') return { icon: 'heater', tone: 'blue' };
  return { icon: 'gauge', tone: 'ink' };
}

/** The seeded and imported equipment.type codes that have a catalog word; a type someone typed in SCR-OFC-37 has none (F-716). */
const EQUIPMENT_TYPES = new Set(['furnace', 'air_conditioner', 'water_heater', 'thermostat']);

/** "Gas furnace": the type's word; a typed type shows as typed. */
export function equipmentWord(t: ClientT, type: string): string {
  return EQUIPMENT_TYPES.has(type) ? t(`customers.equipment.${type}` as MessageKey) : type;
}

/** "Gas furnace 2011": the type's word with its year; a typed type shows as typed. */
export function equipmentLine(t: ClientT, e: { type: string; year: number | null }): string {
  const word = equipmentWord(t, e.type);
  return e.year ? `${word} ${e.year}` : word;
}

/** The contract each role-gated control of the customer page calls (CTL-OFC-06-02, -14, -17, -18, -19). */
export const CONTROL_CONTRACT = {
  inbox: 'API-37', text: 'API-143', addEquipment: 'API-141', editEquipment: 'API-142', note: 'API-140',
} as const satisfies Record<string, `API-${number}`>;

/**
 * CTL-OFC-05-15: the jobs the search text also finds (API-133): tab All, Today and upcoming, the Branch filter's branch or, with All branches, the
 * top bar's; the other filters do not apply. The text goes in the request body only (NFR-05). null when there is no text or no branch to search.
 */
export function jobsSearchRequest(query: string, filterBranch: string | null, homeBranch: string | null): { query: string; branch: string; tab: 'all'; date: 'upcoming' } | null {
  const q = query.trim();
  const branch = filterBranch ?? homeBranch;
  return q === '' || !branch ? null : { query: q, branch, tab: 'all', date: 'upcoming' };
}

/** "furnace tune-up" from "Furnace tune-up": the line's service word starts in lower case, an acronym ("AC tune-up") keeps its capitals. */
export const lineWord = (word: string): string => (/^[A-Z][a-z]/.test(word) ? word.charAt(0).toLowerCase() + word.slice(1) : word);

/** CTL-OFC-06-22: a note's "when": "Tue, Sep 15, 10:31 AM" in the year of the page's other dates, "Oct 14, 2025, 9:00 AM" in an earlier one. */
export function noteWhen(t: ClientT, at: string, thisYear: number): string {
  const date = at.slice(0, 10);
  return t('customers.note.dateTime', { date: Number(date.slice(0, 4)) === thisYear ? dayShort(t, date) : dateLong(t, date), time: clockText(at) });
}
