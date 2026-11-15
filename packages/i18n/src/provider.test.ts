// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormattedMessage } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { BwIntlProvider, createBwIntl, isTestBuild } from './provider.tsx';

const render = (locale: 'en' | 'es', id: string, values: Record<string, number> = {}) =>
  renderToStaticMarkup(
    createElement(BwIntlProvider, { locale, children: createElement(FormattedMessage, { id, values }) }),
  );

describe('provider', () => {
  // why: FR-LANG-3
  it('is a test build under vitest', () => {
    expect(isTestBuild()).toBe(true);
  });

  // why: FR-LANG-3
  it('throws when a test build renders a missing key, in both languages', () => {
    expect(() => render('en', 'planted.missing.key')).toThrow(/planted\.missing\.key/);
    expect(() => render('es', 'planted.missing.key')).toThrow(/planted\.missing\.key/);
  });

  // why: FR-LANG-3
  it('does not fall back to a default message', () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(BwIntlProvider, {
          locale: 'es',
          children: createElement(FormattedMessage, { id: 'planted.missing.key', defaultMessage: 'English fallback' }),
        }),
      ),
    ).toThrow();
  });

  // why: F-133
  it('throws in English too when a call site passes a defaultMessage for a missing key', () => {
    const withDefault = (locale: 'en' | 'es', id: string) =>
      renderToStaticMarkup(
        createElement(BwIntlProvider, {
          locale,
          children: createElement(FormattedMessage, { id, defaultMessage: 'English fallback' }),
        }),
      );
    expect(() => withDefault('en', 'planted.missing.key')).toThrow(/planted\.missing\.key/); // must-fail before the fix: it rendered the fallback
    expect(withDefault('en', 'common.save')).toBe('Save'); // control: a present key renders its catalog text
  });

  // why: FR-LANG-1
  it('renders a present key in each language, plurals included', () => {
    expect(render('en', 'common.save')).toBe('Save');
    expect(render('es', 'common.save')).toBe('Guardar');
    expect(render('en', 'jobs.count', { count: 1 })).toBe('1 job');
    expect(render('es', 'jobs.count', { count: 3 })).toBe('3 trabajos');
  });

  // why: FR-LANG-3
  it('reports instead of throwing outside a test build', () => {
    const seen: unknown[] = [];
    const intl = createBwIntl('en', { throwOnError: false, onError: (e) => seen.push(e) });
    expect(intl.formatMessage({ id: 'planted.missing.key' })).toBe('planted.missing.key');
    expect(seen.length).toBeGreaterThan(0);
  });
});
