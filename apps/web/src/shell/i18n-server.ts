// SPDX-License-Identifier: AGPL-3.0-or-later
// Server-side catalog access for server components: the request's language and its formatter (next/headers makes
// this module server-only: a client import fails the build). react-intl's entry is a client module under React Server
// Components, so the server formats with intl-messageformat over the same catalogs, the same ICU syntax, and the same
// rule: a missing key throws, never falls back to English (FR-LANG-3).
import { cookies } from 'next/headers';
import { catalogs, type MessageKey } from '@bw/i18n';
import type { Language } from '@bw/time';
import { IntlMessageFormat } from 'intl-messageformat';
import type { ReactNode } from 'react';
import { LANG_COOKIE, langFromCookie } from './lang.ts';

export async function requestLang(): Promise<Language> {
  return langFromCookie((await cookies()).get(LANG_COOKIE)?.value);
}

export type Values = Record<string, string | number | ((chunks: ReactNode[]) => ReactNode)>;

export interface ServerT {
  (key: MessageKey, values?: Record<string, string | number>): string;
  rich(key: MessageKey, values: Values): ReactNode;
  lang: Language;
}

export function formatCatalog(lang: Language, key: string, values?: Values): unknown {
  const source = catalogs[lang][key];
  if (source === undefined) throw new Error(`catalog key "${key}" is missing in ${lang}`);
  return new IntlMessageFormat(source, lang).format(values as never);
}

export function serverT(lang: Language): ServerT {
  const t = ((key: MessageKey, values?: Record<string, string | number>) => String(formatCatalog(lang, key, values))) as ServerT;
  t.rich = (key, values) => formatCatalog(lang, key, values) as ReactNode;
  t.lang = lang;
  return t;
}
