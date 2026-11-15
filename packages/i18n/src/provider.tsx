// SPDX-License-Identifier: AGPL-3.0-or-later
// The provider bound to the shared catalog (every web surface). The logic is provider-core.tsx's (F-1199: the native app binds its subset).
import type { IntlShape } from 'react-intl';
import type { ReactNode } from 'react';
import { catalogs } from './catalog.ts';
import type { Language } from './language.ts';
import { BwIntlProviderFrom, createBwIntlFrom, type BwIntlOptions } from './provider-core.tsx';

export { isTestBuild, makeOnError } from './provider-core.tsx';
export type { BwIntlOptions, Catalogs } from './provider-core.tsx';

export function createBwIntl(locale: Language, options: BwIntlOptions = {}): IntlShape {
  return createBwIntlFrom(catalogs, locale, options);
}

export function BwIntlProvider(props: { locale: Language; children: ReactNode } & BwIntlOptions) {
  return <BwIntlProviderFrom catalogs={catalogs} {...props} />;
}
