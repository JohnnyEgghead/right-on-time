// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { MessageKey } from './catalog.ts';
import { formatterFor } from './format.ts';

const KEYS = ['assigned', 'canceled', 'not_found', 'rescheduled', 'status_set', 'validation_failed'] as const;
const values = (action: string) => ({
  tech: 'Marcus', action, job: 24791, by: 'Keisha T.', byKind: 'office', to: 'Ana R.', toKind: 'tech', date: 'Sep 15', at: '10:12 AM',
});

describe('the flagged-item lines name the item (F-932)', () => {
  // why: F-932 a flagged note, photo or signature is not read as No one home
  it('names a note, a photo and a signature in every offline.flag line, in both languages', () => {
    const words = { en: { note: 'a note', photo: 'a photo', signature: 'a signature' }, es: { note: 'una nota', photo: 'una foto', signature: 'una firma' } };
    for (const lang of ['en', 'es'] as const) {
      const f = formatterFor(lang);
      for (const key of KEYS) {
        for (const action of ['note', 'photo', 'signature'] as const) {
          const line = f(`offline.flag.${key}` as MessageKey, values(action));
          expect(line).toContain(words[lang][action]);
          expect(line).not.toMatch(/No one home|No había nadie/);
        }
        expect(f(`offline.flag.${key}` as MessageKey, values('no_one_home'))).toMatch(/No one home|No había nadie/);
      }
    }
  });
});
