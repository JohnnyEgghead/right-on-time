// SPDX-License-Identifier: AGPL-3.0-or-later
// catalog-parity (FR-LANG-2): every key exists in both languages, no empty value, and no
// Spanish value equal to its English one outside the allowlist.
import type { CatalogMap } from './catalog-format.ts';
import { IntlMessageFormat } from 'intl-messageformat';
import { parseCatalog, serializeCatalog } from './catalog-format.ts';

/**
 * Values that legitimately read the same in both languages (SPECIFICATIONS section 6.11).
 * English and Español: the language choices show each language's own name in every language (UI-SPECIFICATION
 * 13.1 item 7, CTL-CMP-03-01; F-140). Right On Time and Heating & Air: proper names, the product name and the trade
 * name the kit frames keep unchanged in Spanish (13.1 item 3; P2-SHELL report, same doc batch as F-140).
 * "© OpenStreetMap": the map credit, a proper name; FR-MAP-2's criterion and the kit frame (DK-85) show this exact text
 * on every map in either language (HC-04; P3-MAP-WEB).
 * "Aa": the text size glyph of the technician app's Me screen (P5-TWA-MAP-ME, CTL-TEC-10-09), the same letters in either language.
 * "{m} min": the van marker's minutes, in the approved design's own abbreviation in either language (F-731; the Spanish hr/min line already uses it).
 * "{n} mi": a turn-by-turn step's miles (SCR-TEC-08 Step words), "mi" in either language as the approved Spanish frame draws it (DK-117 "En 0.3 mi:").
 * "Comfort Club": the club's brand name, the same in every language (owner ruling 62461d7b, Nov 3, 2026; F-677, F-631).
 */
export const SAME_VALUE_ALLOWLIST: readonly string[] = ['Brightwater', 'PM', 'OK', 'English', 'Español', 'Right On Time', 'Right On Time {version}', 'Heating & Air', '© OpenStreetMap', 'No', 'Comfort Club', 'Aa', '{m} min', '{n} mi'];

export type ParityIssue = {
  kind: 'missing-in-es' | 'missing-in-en' | 'empty-en' | 'empty-es' | 'es-equals-en' | 'icu-mismatch' | 'file-format' | 'curly-quote';
  key: string;
};

type MessageFormatElement = ReturnType<IntlMessageFormat['getAst']>[number];

/**
 * The ICU arguments of a message (F-148): each argument name with its type, a select with its option keys, a tag with its
 * name, found at any depth. A plural's option keys are left out because the languages' plural categories differ (es has many).
 */
function icuArguments(message: string): string[] {
  const out = new Set<string>();
  const walk = (els: readonly MessageFormatElement[]): void => {
    for (const el of els) {
      if (el.type === 1) out.add(`${el.value}`);
      else if (el.type === 2 || el.type === 3 || el.type === 4) out.add(`${el.value}:${el.type}`);
      else if (el.type === 5) {
        out.add(`${el.value}:select:${Object.keys(el.options).sort().join('|')}`);
        for (const o of Object.values(el.options)) walk(o.value);
      } else if (el.type === 6) {
        out.add(`${el.value}:plural:${el.pluralType ?? 'cardinal'}`);
        for (const o of Object.values(el.options)) walk(o.value);
      } else if (el.type === 8) {
        out.add(`<${el.value}>`);
        walk(el.children);
      }
    }
  };
  walk(new IntlMessageFormat(message, 'en').getAst());
  return [...out].sort();
}

export function checkParity(
  en: CatalogMap,
  es: CatalogMap,
  allowlist: readonly string[] = SAME_VALUE_ALLOWLIST,
): ParityIssue[] {
  const issues: ParityIssue[] = [];
  // FR-TEXT-10: a text template never holds a curly quote or apostrophe (not GSM-7; a texts lint, not a screens one).
  for (const map of [en, es]) {
    for (const key of Object.keys(map).sort()) {
      if (key.startsWith('text.') && /[\u2018\u2019\u201C\u201D]/.test(map[key] as string)) issues.push({ kind: 'curly-quote', key });
    }
  }
  for (const key of Object.keys(en).sort()) {
    const enValue = en[key] as string;
    if (!(key in es)) {
      issues.push({ kind: 'missing-in-es', key });
      continue;
    }
    const esValue = es[key] as string;
    if (enValue.trim() === '') issues.push({ kind: 'empty-en', key });
    if (esValue.trim() === '') issues.push({ kind: 'empty-es', key });
    else if (esValue === enValue && !allowlist.includes(esValue)) issues.push({ kind: 'es-equals-en', key });
    if (enValue.trim() !== '' && esValue.trim() !== '' && !sameIcu(enValue, esValue, key.startsWith('text.'))) issues.push({ kind: 'icu-mismatch', key });
  }
  for (const key of Object.keys(es).sort()) {
    if (!(key in en)) issues.push({ kind: 'missing-in-en', key });
  }
  return issues;
}

/** True when both values carry the same ICU arguments; a value that is not valid ICU is a mismatch. */
function sameIcu(en: string, es: string, spanishMayLeaveWeekdayOut = false): boolean {
  try {
    // F-419: no Spanish word for Saturday is GSM-7 basic, so a Spanish text template may leave {weekday} out (the date names
    // the day, REQUIREMENTS:319). It may never add an argument the English one lacks, and no other argument may differ.
    const enArgs = icuArguments(en).filter((a) => !(spanishMayLeaveWeekdayOut && a === 'weekday' && !icuArguments(es).includes(a)));
    return JSON.stringify(enArgs) === JSON.stringify(icuArguments(es));
  } catch {
    return false;
  }
}

/** Parity on the 2 files' text, plus the D-16 layout rule (key-sorted, 1 key per line). */
export function checkCatalogFiles(enText: string, esText: string): ParityIssue[] {
  const en = parseCatalog(enText, 'en.json');
  const es = parseCatalog(esText, 'es.json');
  const issues = checkParity(en, es);
  if (serializeCatalog(en) !== enText) issues.push({ kind: 'file-format', key: 'en.json' });
  if (serializeCatalog(es) !== esText) issues.push({ kind: 'file-format', key: 'es.json' });
  return issues;
}
