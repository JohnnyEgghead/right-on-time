// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Client-side catalog access: the provider the root layout mounts, and the hook client components read text with.
import { BwIntlProvider, type MessageKey } from '@bw/i18n';
import type { Language } from '@bw/time';
import { createContext, useContext, type ReactNode } from 'react';
import { useIntl } from 'react-intl';

const LangContext = createContext<Language>('en');

export function ShellIntl({ lang, children }: { lang: Language; children: ReactNode }) {
  return (
    <LangContext.Provider value={lang}>
      <BwIntlProvider locale={lang}>{children}</BwIntlProvider>
    </LangContext.Provider>
  );
}

export type ClientT = {
  (key: MessageKey, values?: Record<string, string | number>): string;
  rich(key: MessageKey, values: Record<string, string | number | ((chunks: ReactNode[]) => ReactNode)>): ReactNode;
  lang: Language;
};

export function useT(): ClientT {
  const intl = useIntl();
  const lang = useContext(LangContext);
  const t = ((key: MessageKey, values?: Record<string, string | number>) => intl.formatMessage({ id: key }, values)) as ClientT;
  t.rich = (key, values) => intl.formatMessage({ id: key }, values) as ReactNode;
  t.lang = lang;
  return t;
}
