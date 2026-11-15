// SPDX-License-Identifier: AGPL-3.0-or-later
// A catalog formatter outside React (a server answer in the reader's language, such as the billing export, API-159): the same catalogs,
// the same ICU syntax, and the same rule as the pages, a missing key throws and never falls back to English (FR-LANG-3).
import { IntlMessageFormat } from 'intl-messageformat';
import { catalogs, type MessageKey } from './catalog.ts';
import type { Language } from './language.ts';

export function formatterFor(lang: Language): (key: MessageKey, values?: Record<string, string | number>) => string {
  return (key, values) => {
    const source = catalogs[lang][key];
    if (source === undefined) throw new Error(`catalog key "${key}" is missing in ${lang}`);
    return String(new IntlMessageFormat(source, lang).format(values));
  };
}
