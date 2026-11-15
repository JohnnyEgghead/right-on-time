// SPDX-License-Identifier: AGPL-3.0-or-later
// FR-TEXT-11: a name in texts that would break FR-TEXT-9 is refused with the problem; "Ramon" is saved.
import { describe, expect, it } from 'vitest';
import { analyzeSms } from '@bw/sms';
import { catalogs } from '../../i18n/src/catalog.ts';
import { checkNameInTexts } from './name-in-texts.ts';
import { renderTemplate } from './render.ts';
import { textCatalogOf, type TextCatalogs } from './slots.ts';

describe('checkNameInTexts', () => {
  // why: FR-TEXT-11
  it('refuses "Ramón" (the o-acute is not GSM-7 basic) naming the character, and saves "Ramon"', () => {
    expect(checkNameInTexts('Ramón', catalogs)).toEqual({
      ok: false, code: 'text_value_breaks_limit', problem: 'not_gsm7_basic', length: 5, limit: 10, chars: ['ó'],
    });
    expect(checkNameInTexts('Ramon', catalogs)).toEqual({ ok: true });
    expect(checkNameInTexts('José', catalogs)).toEqual({ ok: true }); // the e-acute is in the basic set
  });

  // why: FR-TEXT-11
  it('refuses a name over 10 characters and an empty one, with counts', () => {
    expect(checkNameInTexts('Maximilian!!', catalogs)).toMatchObject({ ok: false, problem: 'too_long', length: 12, limit: 10 });
    expect(checkNameInTexts('   ', catalogs)).toMatchObject({ ok: false, problem: 'empty' });
    expect(checkNameInTexts('Zachary Q.!', catalogs)).toMatchObject({ ok: false, problem: 'too_long' });
    expect(checkNameInTexts('Zachary Q.', catalogs)).toEqual({ ok: true });
  });

  // why: FR-TEXT-11; F-490
  it('refuses a name that would make the on-the-way text 161 characters, and the real templates fit a 10-character name in 160', () => {
    // The real on-the-way text with 10 more characters of fixed copy (F-490: the story wording 'Follow the van:' is shorter, so the name has 2 uses and 8 more characters fit): a 10-character name in its uses, with the other slots at their maxima, makes 161.
    const tight: TextCatalogs = {
      en: { ...catalogs.en, 'text.on_the_way': `${catalogs.en['text.on_the_way']!}${'a'.repeat(10)}` },
      es: { ...catalogs.es },
    };
    const long = checkNameInTexts('Zachary Q.', tight);
    expect(long).toMatchObject({ ok: false, problem: 'breaks_template', template: 'on_the_way', lang: 'en' });
    expect((long as { septets: number }).septets).toBe(161);
    // A shorter name fits the same copy.
    expect(checkNameInTexts('Zach', tight)).toEqual({ ok: true });
    // The real catalog: a 10-character name fits every template in both languages, and renders as exactly 1 message.
    for (const lang of ['en', 'es'] as const) {
      const r = renderTemplate(textCatalogOf(catalogs), 'on_the_way', lang, { tech: 'Zachary Q.', arrival: '12:45 PM', mapLink: 'bw.j7l.io/m/AbC12345' });
      expect(analyzeSms(r.body)).toMatchObject({ encoding: 'GSM-7', messages: 1 });
    }
  });
});
