// SPDX-License-Identifier: AGPL-3.0-or-later
// Rendering and counting a text body (SPECIFICATIONS section 5.2 step 1; FR-TEXT-9, FR-TEXT-20; invariant 8).
// The outbox owns no copy: templates come from the catalog as `text.<kind>` (the key shape @bw/sms's text-budget-check
// reads) with `{slot}` placeholders named by @bw/sms SLOTS, in the customer's language. P3-TEXTS writes the templates.
import { analyzeSms } from '@bw/sms';
import type { TemplateId } from './model.ts';

export type TextLanguage = 'en' | 'es';

/** Where templates come from: a flat catalog per language (for example @bw/i18n's `catalogs`). */
export interface TextCatalog {
  /** The template text of `text.<kind>` in `lang`; undefined when the catalog has none. */
  template(id: TemplateId, lang: TextLanguage): string | undefined;
}

export function catalogTexts(catalogs: Record<TextLanguage, Record<string, string>>): TextCatalog {
  return { template: (kind, lang) => catalogs[lang][`text.${kind}`] };
}

export interface CountedBody {
  body: string;
  encoding: 'gsm7' | 'ucs2';
  /** Septets for GSM-7 (an extension character counts 2), UTF-16 units for UCS-2 (@bw/sms). */
  characters: number;
  messages: number;
}

export function countBody(body: string): CountedBody {
  const a = analyzeSms(body);
  return { body, encoding: a.encoding === 'GSM-7' ? 'gsm7' : 'ucs2', characters: a.units, messages: a.messages };
}

/**
 * A template render that is not exactly 1 GSM-7 message. CI's text-budget-check makes this impossible for the real
 * templates (section 14), so reaching it is a defect, never a customer-facing refusal.
 */
export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

const SLOT = /\{([A-Za-z]+)\}/g;

/** Render `text.<kind>` with the slot values; refuses a missing template, a missing slot value, or not 1 GSM-7 message. */
export function renderTemplate(catalog: TextCatalog, kind: TemplateId, lang: TextLanguage, values: Record<string, string>): CountedBody {
  const template = catalog.template(kind, lang);
  if (template === undefined) throw new TemplateRenderError(`the catalog has no template text.${kind} in ${lang}`);
  const body = template.replace(SLOT, (_, slot: string) => {
    const v = values[slot];
    if (v === undefined) throw new TemplateRenderError(`text.${kind} (${lang}) uses the slot {${slot}}, which has no value`);
    return v;
  });
  const counted = countBody(body);
  if (counted.encoding !== 'gsm7' || counted.messages !== 1) {
    throw new TemplateRenderError(`text.${kind} (${lang}) rendered to ${counted.messages} ${counted.encoding} message(s); a template must be 1 GSM-7 message (FR-TEXT-9)`);
  }
  return counted;
}
