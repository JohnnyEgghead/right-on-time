// SPDX-License-Identifier: AGPL-3.0-or-later
// The block conflict sentence names the other branch's time only when the page read it.
import { BwIntlProvider } from '@bw/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useConflictText } from './Dialogs.tsx';
import type { Conflict } from './model.ts';

const conflict = { by: 'Keisha Thompson', byKind: 'office', change: 'moved', technician: 'Kevin Doyle', at: '2026-09-15T13:12:00-04:00[America/New_York]', currentVersion: 3 } as unknown as Conflict;

const say = (locale: 'en' | 'es', theirs: string | null): string => {
  const Probe = () => createElement('p', null, useConflictText()(conflict, { kind: 'block', mine: '9:00 AM', theirs }));
  return renderToStaticMarkup(createElement(BwIntlProvider, { locale, children: createElement(Probe) }));
};

describe('the block conflict sentence', () => {
  // why: FR-DISP-34 a block conflict with no read of the other branch uses the sentence without a time
  it.each([
    ['en', 'This changed after you opened it.'],
    ['es', 'Esto cambió después de que usted lo abrió.'],
  ] as const)('falls back to the sentence with no time when the other branch is unread (%s)', (locale, words) => {
    const html = say(locale, null);
    expect(html).toContain(words);
    expect(html).not.toMatch(/ to\s+at | a las\s+a las /);
  });

  // why: FR-DISP-34 a block conflict that read the other branch still names its time
  it('names the other time when the page read it', () => {
    expect(say('en', '9:12 AM')).toContain('moved this block to 9:12 AM');
  });
});
