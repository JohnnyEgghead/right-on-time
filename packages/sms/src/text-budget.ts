// SPDX-License-Identifier: AGPL-3.0-or-later
// text-budget-check (SPECIFICATIONS SD-17, REQUIREMENTS FR-TEXT-9): renders every template x
// both languages x every value of every slot, with every bookable day as the visit day, and
// passes only when each render is GSM-7 and 1 message (at most 160 septets).
import { analyzeSms, isGsm7BasicChar } from './gsm.ts';

export type Lang = 'en' | 'es';
export const LANGS: readonly Lang[] = ['en', 'es'];

/** Bookable days, Monday (1) to Saturday (6), ISO numbering. Saturday is included (review c1 M3). */
export const BOOKABLE_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6];

export const SLOTS = [
  'weekday',
  'date',
  'window',
  'service',
  'tech',
  'arrival',
  'mapLink',
  'rescheduleLink',
  'phone',
] as const;
export type Slot = (typeof SLOTS)[number];

/** SD-17 maxima in characters, [English, Spanish]. */
export const SLOT_MAX: Record<Slot, Record<Lang, number>> = {
  weekday: { en: 3, es: 4 },
  date: { en: 6, es: 12 },
  window: { en: 15, es: 20 },
  service: { en: 22, es: 22 },
  tech: { en: 10, es: 10 },
  arrival: { en: 8, es: 8 },
  mapLink: { en: 20, es: 20 },
  rescheduleLink: { en: 20, es: 20 },
  phone: { en: 14, es: 14 },
};

/**
 * SD-17 fixed-copy budgets in characters, [English, Spanish]: a template's text with every {slot} taken out. Keyed by the
 * catalog id (`text.<id>`); the second reminder template keeps the Reminder budget (SD-17). An id not listed has no fixed-copy
 * budget here (the 160-septet render check still holds for it).
 */
export const FIXED_COPY_MAX: Readonly<Record<string, Record<Lang, number>>> = {
  confirmation: { en: 114, es: 106 },
  reminder: { en: 145, es: 140 },
  reminder_today: { en: 145, es: 140 },
  on_the_way: { en: 112, es: 112 },
  late: { en: 142, es: 142 },
  r_reply: { en: 117, es: 114 },
};

export interface Template {
  id: string;
  /** Copy per language; a slot is written {weekday}, {date} and so on. */
  text: Record<Lang, string>;
}

export interface SlotValues {
  /** The weekday label of a bookable day (ISO 1 to 6) in a language. */
  weekday: (lang: Lang, day: number) => string;
  /** Every other slot: the values to enumerate, per language. */
  values: Record<Exclude<Slot, 'weekday'>, Record<Lang, readonly string[]>>;
}

export interface CheckInput {
  templates: readonly Template[];
  /** The visit days enumerated. Must cover Monday to Saturday. */
  days: readonly number[];
  slots: SlotValues;
}

export type FailureKind =
  | 'not-gsm7'
  | 'over-160'
  | 'missing-day'
  | 'slot-over-max'
  | 'unknown-slot'
  | 'missing-language'
  /** F-166: a placeholder that is not a bare {slot}, such as an ICU {arrival, time, short}. */
  | 'formatted-slot'
  /** F-165: a template in a language rendered 0 times (a slot with an empty value list). */
  | 'no-renders'
  /** F-163: a slot value outside the GSM-7 basic set (REQUIREMENTS FR-TEXT-9 table). */
  | 'slot-not-basic'
  /** SD-17: the fixed copy (the template without its slots) is longer than its language's fixed-copy budget. */
  | 'fixed-over-budget';

export interface Failure {
  kind: FailureKind;
  template?: string;
  lang?: Lang;
  detail: string;
}

export type Outcome = 'pass' | 'fail' | 'empty';

export interface Report {
  /** 'empty' means 0 templates, nothing was checked: it is not a pass. */
  outcome: Outcome;
  templates: number;
  renders: number;
  failures: Failure[];
}

const MAX_FAILURES_PER_KEY = 3;

/** Every brace group of a template: its inner text. A bare slot is letters only; anything else is formatted. */
function braceGroups(text: string): string[] {
  return [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] as string);
}

function placeholders(text: string): string[] {
  return braceGroups(text).filter((g) => /^[A-Za-z]+$/.test(g));
}

/** The characters of a text outside the GSM-7 BASIC set: the extension table (costs 2, REQUIREMENTS:319) is refused too. */
function nonBasicChars(text: string): string[] {
  return [...text].filter((ch) => !isGsm7BasicChar(ch));
}

function dayName(day: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day % 7] as string;
}

export function runTextBudgetCheck(input: CheckInput): Report {
  const failures: Failure[] = [];
  let renders = 0;

  for (const day of BOOKABLE_DAYS) {
    if (!input.days.includes(day)) {
      failures.push({ kind: 'missing-day', detail: `the day enumeration skips ${dayName(day)}` });
    }
  }

  // Slot values longer than the SD-17 maximum fail on their own, whichever template uses them.
  const checkMax = (slot: Slot, lang: Lang, value: string): void => {
    if ([...value].length > SLOT_MAX[slot][lang]) {
      failures.push({
        kind: 'slot-over-max',
        lang,
        detail: `${slot} "${value}" is ${[...value].length} characters, SD-17 maximum ${SLOT_MAX[slot][lang]}`,
      });
    }
    if (nonBasicChars(value).length > 0) {
      failures.push({
        kind: 'slot-not-basic',
        lang,
        detail: `${slot} "${value}" holds characters outside the GSM-7 basic set: ${nonBasicChars(value).join(' ')}`,
      });
    }
  };
  // A language's weekday labels are checked only when one of its templates prints {weekday}: the Spanish copy leaves the
  // weekday out (no Spanish word for Saturday is GSM-7 basic, F-419), so its labels never reach a customer.
  const printsWeekday = (lang: Lang): boolean => input.templates.some((t) => placeholders(t.text[lang]).includes('weekday'));
  for (const lang of LANGS) {
    if (printsWeekday(lang)) for (const day of input.days) checkMax('weekday', lang, input.slots.weekday(lang, day));
    for (const slot of SLOTS) {
      if (slot === 'weekday') continue;
      for (const v of input.slots.values[slot][lang]) checkMax(slot, lang, v);
    }
  }

  for (const t of input.templates) {
    for (const lang of LANGS) {
      const body = t.text[lang];
      const formatted = braceGroups(body).filter((g) => !/^[A-Za-z]+$/.test(g));
      if (formatted.length > 0) {
        failures.push({ kind: 'formatted-slot', template: t.id, lang, detail: `placeholder {${formatted[0] as string}} is not a bare slot` });
        continue;
      }
      const used = placeholders(body);
      const unknown = used.filter((s) => !(SLOTS as readonly string[]).includes(s));
      if (unknown.length > 0) {
        failures.push({ kind: 'unknown-slot', template: t.id, lang, detail: `unknown slot ${unknown.join(', ')}` });
        continue;
      }
      const budget = FIXED_COPY_MAX[t.id]?.[lang];
      if (budget !== undefined) {
        const fixed = [...body.replace(/\{[A-Za-z]+\}/g, '')].length;
        if (fixed > budget) {
          failures.push({ kind: 'fixed-over-budget', template: t.id, lang, detail: `fixed copy is ${fixed} characters, SD-17 budget ${budget}` });
        }
      }
      const slotsUsed = [...new Set(used)] as Slot[];
      // Every combination of every value of every slot the template uses.
      const lists = slotsUsed.map((slot): readonly string[] =>
        slot === 'weekday'
          ? input.days.map((d) => input.slots.weekday(lang, d))
          : input.slots.values[slot][lang],
      );
      const seen = new Map<string, number>();
      const rendersBefore = renders;
      const combo: string[] = [];
      const render = (i: number): void => {
        if (i === slotsUsed.length) {
          let text = body;
          slotsUsed.forEach((slot, k) => {
            text = text.replaceAll(`{${slot}}`, combo[k] as string);
          });
          renders += 1;
          const a = analyzeSms(text);
          let kind: FailureKind | null = null;
          let detail = '';
          if (nonBasicChars(text).length > 0) {
            kind = 'not-gsm7';
            detail = `${a.encoding === 'GSM-7' ? 'extension-table' : 'UCS-2'} text, characters outside the GSM-7 basic set: ${nonBasicChars(text).join(' ')}`;
          } else if (a.messages !== 1) {
            kind = 'over-160';
            detail = `${a.units} septets, ${a.messages} messages`;
          }
          if (kind !== null) {
            const key = `${t.id}|${lang}|${kind}`;
            const n = (seen.get(key) ?? 0) + 1;
            seen.set(key, n);
            if (n <= MAX_FAILURES_PER_KEY) {
              failures.push({ kind, template: t.id, lang, detail: `${detail} in "${text}"` });
            }
          }
          return;
        }
        for (const v of lists[i] as readonly string[]) {
          combo[i] = v;
          render(i + 1);
        }
      };
      render(0);
      if (renders === rendersBefore) {
        failures.push({ kind: 'no-renders', template: t.id, lang, detail: 'rendered 0 times: a slot it uses has no values' });
      }
      // F-167: the fixed copy plus every slot at its SD-17 maximum times its uses is at most 160 septets.
      let atMax = body;
      for (const slot of slotsUsed) atMax = atMax.replaceAll(`{${slot}}`, 'x'.repeat(SLOT_MAX[slot][lang]));
      renders += 1;
      const m = analyzeSms(atMax);
      if (m.messages !== 1) {
        failures.push({ kind: 'over-160', template: t.id, lang, detail: `${m.units} septets at the SD-17 slot maxima, ${m.messages} messages` });
      }
    }
  }

  const outcome: Outcome =
    failures.length > 0 ? 'fail' : input.templates.length === 0 || renders === 0 ? 'empty' : 'pass';
  return { outcome, templates: input.templates.length, renders, failures };
}

/** Templates from a pair of flat catalogs: every key `text.<id>` present in both languages. */
export function templatesFromCatalogs(
  en: Record<string, string>,
  es: Record<string, string>,
): { templates: Template[]; failures: Failure[] } {
  const failures: Failure[] = [];
  const ids = new Set<string>();
  for (const k of [...Object.keys(en), ...Object.keys(es)]) {
    if (k.startsWith('text.')) ids.add(k.slice(5));
  }
  const templates: Template[] = [];
  for (const id of [...ids].sort()) {
    const e = en[`text.${id}`];
    const s = es[`text.${id}`];
    if (e === undefined || s === undefined) {
      failures.push({ kind: 'missing-language', template: id, detail: `text.${id} is missing in ${e === undefined ? 'en' : 'es'}` });
      continue;
    }
    templates.push({ id, text: { en: e, es: s } });
  }
  return { templates, failures };
}
