// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1777: the technician panels draw the shared panel's last-try time and busy state.
import { BwIntlProvider } from '@bw/i18n';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lastTryOf, TechErrorPanel } from './TechErrorPanel.tsx';

const draw = (lastTry: string | undefined, locale: 'en' | 'es') =>
  renderToStaticMarkup(
    createElement(BwIntlProvider, { locale, children: createElement(TechErrorPanel, { title: 'Could not load', lastTry, onRetry: () => undefined }) }),
  );

describe('TechErrorPanel', () => {
  // why: NFR-06 a failed read's panel names the time of the last try and keeps the Try again button, in both languages
  it('names the last try when a failed time is known, in both languages', () => {
    const at = Date.UTC(2026, 10, 16, 15, 30);
    const en = lastTryOf(at, 'America/New_York', 'en') as string;
    expect(en).toBeTruthy();
    expect(draw(en, 'en')).toContain(en);
    const es = lastTryOf(at, 'America/New_York', 'es') as string;
    expect(draw(es, 'es')).toContain(es);
  });

  // why: NFR-06 a panel with no failed time draws no last-try words and still keeps the Try again button
  it('draws no last-try words without a failed time, and keeps the button', () => {
    expect(lastTryOf(null, 'America/New_York', 'en')).toBeUndefined();
    const html = draw(undefined, 'en');
    expect(html).not.toMatch(/Last try/i);
    expect(html).toContain('CTL-CMP-12-02');
  });
});
