// SPDX-License-Identifier: AGPL-3.0-or-later
// The catalog holds a word, in both languages, for every reason the outbox writes (FR-TEXT-15: a held, a failed and a delivered text each show a
// status word with the reason; F-352). The Messages page reads text_reason.* from outbox_text.reason_key and text_attempt.<reason> from
// text_attempt.reason; a key with no word would render nothing, so this test fails the day a new reason is written without its words.
import { describe, expect, it } from 'vitest';
import { catalogs } from '../../i18n/src/catalog.ts';
import { SIMULATOR_REASON } from './gateway.ts';
import { REASON } from './model.ts';

describe('the words of the outbox reasons (F-352)', () => {
  // why: FR-TEXT-15
  it('has a word in English and Spanish for every outbox_text.reason_key the outbox writes', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const key of Object.values(REASON)) expect(catalogs[lang][key as keyof (typeof catalogs)['en']], `${lang} ${key}`).toBeTruthy();
    }
  });

  // why: FR-TEXT-12
  it('has a word in English and Spanish for every text_attempt.reason the simulator writes, under text_attempt.<reason>', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const reason of Object.values(SIMULATOR_REASON)) expect(catalogs[lang][`text_attempt.${reason}` as keyof (typeof catalogs)['en']], `${lang} ${reason}`).toBeTruthy();
    }
  });

  // why: FR-TEXT-8
  it('has a word for the job change a customer\'s C reply writes (job_change.confirmed_by_reply)', () => {
    for (const lang of ['en', 'es'] as const) expect(catalogs[lang]['job_change.confirmed_by_reply' as keyof (typeof catalogs)['en']]).toBeTruthy();
  });
});
