// SPDX-License-Identifier: AGPL-3.0-or-later
// Hermes Intl polyfills (R7 section 3.1; FormatJS Hermes guide). Hermes has Locale, PluralRules and getCanonicalLocales; NumberFormat
// and DateTimeFormat are partial; RelativeTimeFormat and ListFormat are missing. The native entry (apps/tech-native/index.ts) calls
// installIntlPolyfills once before the first render (F-141). Time zone data belongs to @bw/time.
//
// The 7 packages of R7 section 3.1, in dependency order (RelativeTimeFormat needs PluralRules and NumberFormat). Each service is
// checked for each app language: when the platform cannot serve any one of them, the polyfill is installed once and replaces the
// platform's service for every language, so the locale data of every app language loads with it (F-989). Imports are static paths (Metro bundles no computed import), 1 per package and locale.
import { shouldPolyfill as canonical } from '@formatjs/intl-getcanonicallocales/should-polyfill.js';
import { shouldPolyfill as listformat } from '@formatjs/intl-listformat/should-polyfill.js';
import { shouldPolyfill as locale } from '@formatjs/intl-locale/should-polyfill.js';
import { shouldPolyfill as datetime } from '@formatjs/intl-datetimeformat/should-polyfill.js';
import { shouldPolyfill as number } from '@formatjs/intl-numberformat/should-polyfill.js';
import { shouldPolyfill as plural } from '@formatjs/intl-pluralrules/should-polyfill.js';
import { shouldPolyfill as relativetime } from '@formatjs/intl-relativetimeformat/should-polyfill.js';
import { LANGUAGES, type Language } from './language.ts';

export type IntlService = 'getCanonicalLocales' | 'Locale' | 'PluralRules' | 'NumberFormat' | 'DateTimeFormat' | 'RelativeTimeFormat' | 'ListFormat';

/** The services in install order (R7 section 3.1's 7 packages). */
export const INTL_SERVICES: readonly IntlService[] = ['getCanonicalLocales', 'Locale', 'PluralRules', 'NumberFormat', 'DateTimeFormat', 'RelativeTimeFormat', 'ListFormat'];

type Load = () => Promise<unknown>;
interface ServiceSpec {
  /** FormatJS's check: for a per-locale service, the locale data to load for that language, or undefined when the platform serves it. */
  check: (lang: Language) => string | boolean | undefined;
  install: Load;
  /** Locale data by app language; absent for the 2 services that carry no locale data. */
  data?: Record<Language, Load>;
}

const SERVICES: Record<IntlService, ServiceSpec> = {
  getCanonicalLocales: { check: () => canonical(), install: () => import('@formatjs/intl-getcanonicallocales/polyfill-force.js') },
  Locale: { check: () => locale(), install: () => import('@formatjs/intl-locale/polyfill-force.js') },
  PluralRules: {
    check: (l) => plural(l), install: () => import('@formatjs/intl-pluralrules/polyfill-force.js'),
    data: { en: () => import('@formatjs/intl-pluralrules/locale-data/en.js'), es: () => import('@formatjs/intl-pluralrules/locale-data/es.js') },
  },
  NumberFormat: {
    check: (l) => number(l), install: () => import('@formatjs/intl-numberformat/polyfill-force.js'),
    data: { en: () => import('@formatjs/intl-numberformat/locale-data/en.js'), es: () => import('@formatjs/intl-numberformat/locale-data/es.js') },
  },
  DateTimeFormat: {
    // The polyfilled DateTimeFormat knows no time zone until its zone data loads; temporal-polyfill (@bw/time) reads zone offsets
    // through it, so the golden set (America/New_York, UTC and the other main zones) loads with it, never the full 600 KB set.
    check: (l) => datetime(l),
    install: async () => {
      await import('@formatjs/intl-datetimeformat/polyfill-force.js');
      await import('@formatjs/intl-datetimeformat/add-golden-tz.js');
    },
    data: { en: () => import('@formatjs/intl-datetimeformat/locale-data/en.js'), es: () => import('@formatjs/intl-datetimeformat/locale-data/es.js') },
  },
  RelativeTimeFormat: {
    check: (l) => relativetime(l), install: () => import('@formatjs/intl-relativetimeformat/polyfill-force.js'),
    data: { en: () => import('@formatjs/intl-relativetimeformat/locale-data/en.js'), es: () => import('@formatjs/intl-relativetimeformat/locale-data/es.js') },
  },
  ListFormat: {
    check: (l) => listformat(l), install: () => import('@formatjs/intl-listformat/polyfill-force.js'),
    data: { en: () => import('@formatjs/intl-listformat/locale-data/en.js'), es: () => import('@formatjs/intl-listformat/locale-data/es.js') },
  },
};

export interface PolyfillOptions {
  /** For tests: answer every check as "needs the polyfill", so the install path runs on a platform that has full Intl (Node). */
  force?: boolean;
  /** For tests: answer a service's check for 1 language (replaces FormatJS's own check; `force` still wins). */
  check?: (service: IntlService, lang: Language) => boolean;
}

/** What 1 run installed: each service's polyfill and the locale data it loaded, in install order. */
export interface PolyfillReport {
  installed: IntlService[];
  localeData: `${IntlService}:${Language}`[];
}

export async function installIntlPolyfills(opts: PolyfillOptions = {}): Promise<PolyfillReport> {
  const report: PolyfillReport = { installed: [], localeData: [] };
  for (const name of INTL_SERVICES) {
    const s = SERVICES[name];
    if (!s.data) {
      if (opts.force || s.check('en')) {
        await s.install();
        report.installed.push(name);
      }
      continue;
    }
    // F-989: a forced service replaces the platform's own for every language, so once any language needs it, all languages load their data.
    const needed = LANGUAGES.some((lang) => opts.force || (opts.check ? opts.check(name, lang) : s.check(lang)));
    if (!needed) continue;
    await s.install();
    report.installed.push(name);
    for (const lang of LANGUAGES) {
      await s.data[lang]();
      report.localeData.push(`${name}:${lang}`);
    }
  }
  return report;
}
