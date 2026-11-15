// SPDX-License-Identifier: AGPL-3.0-or-later
// The provider without a catalog of its own (F-1199): the caller passes the catalogs. provider.tsx binds the shared catalog; the native
// app binds its subset (apps/tech-native/src/ui/catalog.ts), so its bundle never holds the whole catalog.
import { IntlProvider, createIntl, createIntlCache } from 'react-intl';
import type { IntlConfig, IntlShape } from 'react-intl';
import type { ReactNode } from 'react';
import type { Language } from './language.ts';

/** True in a test build: vitest sets NODE_ENV to "test"; bundlers inline NODE_ENV. */
export function isTestBuild(): boolean {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.['NODE_ENV'] === 'test';
}

/**
 * react-intl never reports a missing message for its default locale when a call site passes defaultMessage (F-133).
 * A default locale no catalog uses makes the missing-message error fire in English too.
 */
const NO_DEFAULT_LOCALE = 'und';

type OnError = NonNullable<IntlConfig['onError']>;

/**
 * No defaultMessage anywhere (FR-LANG-3): a missing key is never papered over with English.
 * In a test build every intl error, a missing message included, throws.
 */
export function makeOnError(throwOnError: boolean = isTestBuild(), report?: OnError): OnError {
  return (error) => {
    if (throwOnError) throw error;
    report?.(error);
  };
}

export type BwIntlOptions = { throwOnError?: boolean; onError?: OnError };

/** A catalog per language: the shared catalog (provider.tsx) or an app's subset of it (the native app, F-1199). */
export type Catalogs = Record<Language, Record<string, string>>;

export function createBwIntlFrom(catalogs: Catalogs, locale: Language, options: BwIntlOptions = {}): IntlShape {
  return createIntl(
    { locale, defaultLocale: NO_DEFAULT_LOCALE, messages: catalogs[locale], onError: makeOnError(options.throwOnError, options.onError) },
    createIntlCache(),
  );
}

export function BwIntlProviderFrom(props: { catalogs: Catalogs; locale: Language; children: ReactNode } & BwIntlOptions) {
  const { catalogs, locale, children, throwOnError, onError } = props;
  return (
    <IntlProvider locale={locale} defaultLocale={NO_DEFAULT_LOCALE} messages={catalogs[locale]} onError={makeOnError(throwOnError, onError)}>
      {children}
    </IntlProvider>
  );
}
