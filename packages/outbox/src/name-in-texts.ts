// SPDX-License-Identifier: AGPL-3.0-or-later
// A technician's "name in texts" (REQUIREMENTS FR-TEXT-11, SPECIFICATIONS section 6.4 and SD-17; API-32 and API-33 call
// this before they save). A value that would break FR-TEXT-9 is refused and the office is told why; the screen name is a
// separate field and keeps its accents.
import { isGsm7BasicChar, LANGS, SLOT_MAX, SLOTS, type Slot } from '@bw/sms';
import { TEMPLATE_IDS } from './model.ts';
import type { TextCatalogs } from './slots.ts';

export const NAME_IN_TEXTS_MAX = SLOT_MAX.tech.en;

export type NameProblem = 'empty' | 'too_long' | 'not_gsm7_basic' | 'breaks_template';

export type NameCheck =
  | { ok: true }
  | {
      ok: false;
      /** The API error code the handler answers with (packages/api errors.ts). */
      code: 'text_value_breaks_limit';
      problem: NameProblem;
      /** The name's length in characters and the limit it broke. */
      length: number;
      limit: number;
      /** not_gsm7_basic: the characters outside the GSM-7 basic set ("Ramon" is saved, "Ramón" is not: the o-acute). */
      chars?: string[];
      /** breaks_template: the template and language that would pass 160 septets, and how many it would take. */
      template?: string;
      lang?: 'en' | 'es';
      septets?: number;
    };

const bare = /\{([A-Za-z]+)\}/g;

/**
 * Whether `name` may be saved as a name in texts: 1 to 10 characters, GSM-7 basic set only (SD-17), and every template
 * that prints it stays at most 160 septets with every other slot at its SD-17 maximum, whichever language.
 */
export function checkNameInTexts(name: string, catalogs: TextCatalogs): NameCheck {
  const length = [...name].length;
  const limit = NAME_IN_TEXTS_MAX;
  if (name.trim() === '') return { ok: false, code: 'text_value_breaks_limit', problem: 'empty', length, limit };
  if (length > limit) return { ok: false, code: 'text_value_breaks_limit', problem: 'too_long', length, limit };
  const chars = [...name].filter((ch) => !isGsm7BasicChar(ch));
  if (chars.length > 0) return { ok: false, code: 'text_value_breaks_limit', problem: 'not_gsm7_basic', length, limit, chars };
  for (const kind of TEMPLATE_IDS) {
    for (const lang of LANGS) {
      const template = catalogs[lang][`text.${kind}`];
      if (template === undefined || !template.includes('{tech}')) continue;
      const body = template.replace(bare, (_, slot: string) =>
        slot === 'tech' ? name : 'x'.repeat((SLOTS as readonly string[]).includes(slot) ? SLOT_MAX[slot as Slot][lang] : 0),
      );
      const septets = [...body].reduce((n, ch) => n + (isGsm7BasicChar(ch) ? 1 : 2), 0);
      if (septets > 160) return { ok: false, code: 'text_value_breaks_limit', problem: 'breaks_template', length, limit, template: kind, lang, septets };
    }
  }
  return { ok: true };
}
