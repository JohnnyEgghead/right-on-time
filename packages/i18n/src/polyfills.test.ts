// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-LANG-1, F-141
// The Hermes Intl polyfill set (R7 section 3.1) run for real: Node has full Intl, so `force` answers every check as "needs the
// polyfill", and the forced run installs the 7 packages and both languages' data over the platform's Intl, then formats with them.
import { describe, expect, it } from 'vitest';
import { INTL_SERVICES, installIntlPolyfills } from './polyfills.ts';

type Polyfilled = { polyfilled?: boolean };
const intl = Intl as unknown as Record<string, Polyfilled | undefined>;

describe('installIntlPolyfills', () => {
  it('unforced, follows the checks: Node (full ICU) serves every locale service in both languages, so no locale data loads', async () => {
    const r = await installIntlPolyfills();
    expect(r.localeData).toEqual([]);
    // Only the 2 services without locale data may still ask (Node 24's Intl.Locale lacks members FormatJS checks for).
    for (const s of r.installed) expect(['getCanonicalLocales', 'Locale']).toContain(s);
  });

  // why: F-989 a service forced for es alone replaces the native one for en too, so it must hold en data as well
  it('a check that fails for es only installs the service once and loads both languages data', async () => {
    const r = await installIntlPolyfills({ check: (s, lang) => s === 'NumberFormat' && lang === 'es' });
    expect(r.installed).toEqual(['NumberFormat']);
    expect(r.localeData).toEqual(['NumberFormat:en', 'NumberFormat:es']);
  });

  it('forced: installs all 7 services of R7 section 3.1 in dependency order, and each locale service loads en and es on its own', async () => {
    const r = await installIntlPolyfills({ force: true });
    expect(INTL_SERVICES).toHaveLength(7);
    expect(r.installed).toEqual(['getCanonicalLocales', 'Locale', 'PluralRules', 'NumberFormat', 'DateTimeFormat', 'RelativeTimeFormat', 'ListFormat']);
    expect(r.localeData).toEqual([
      'PluralRules:en', 'PluralRules:es', 'NumberFormat:en', 'NumberFormat:es', 'DateTimeFormat:en', 'DateTimeFormat:es',
      'RelativeTimeFormat:en', 'RelativeTimeFormat:es', 'ListFormat:en', 'ListFormat:es',
    ]);
    // The platform's classes were replaced by the polyfills (FormatJS marks each one it installs).
    for (const name of ['PluralRules', 'NumberFormat', 'DateTimeFormat', 'RelativeTimeFormat', 'ListFormat', 'Locale'] as const) {
      expect(intl[name]?.polyfilled, name).toBe(true);
    }
    // The polyfills format both app languages from the data that loaded, Spanish checked on its own.
    expect(new Intl.PluralRules('es').select(1)).toBe('one');
    expect(new Intl.PluralRules('en').select(2)).toBe('other');
    expect(new Intl.NumberFormat('es').format(1234.5)).toBe('1234,5');
    expect(new Intl.RelativeTimeFormat('es', { numeric: 'auto' }).format(-1, 'day')).toBe('ayer');
    expect(new Intl.RelativeTimeFormat('en').format(2, 'hour')).toBe('in 2 hours');
    expect(new Intl.ListFormat('es', { type: 'conjunction' }).format(['Miller', 'Holloway'])).toBe('Miller y Holloway');
    expect(new Intl.ListFormat('en', { type: 'conjunction' }).format(['a', 'b', 'c'])).toBe('a, b, and c');
    // The branch zone resolves through the polyfilled DateTimeFormat (the golden zone set loaded with it): Tue, Sep 15, 2026 at
    // 14:41Z is 10:41 AM in America/New_York (EDT). temporal-polyfill (@bw/time) reads zone offsets this way.
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(Date.UTC(2026, 8, 15, 14, 41));
    expect(parts.filter((p) => p.type === 'hour' || p.type === 'minute').map((p) => p.value)).toEqual(['10', '41']);
    expect(Intl.getCanonicalLocales('ES')).toEqual(['es']);
  });
});
