// SPDX-License-Identifier: AGPL-3.0-or-later
// The root layout: <html lang> from the page language (UI-SPECIFICATION 13.1 item 6), the copied kit sheets
// (styles/kit, byte-identical to docs/design; Inter served by the app through the kit's own @font-face), the page
// adaptation sheet, the catalog provider and the CMP-11 announcement region. When the page gate refused the request
// (src/server.ts sets the verdict header and the status), the layout renders that shared page in place of the route.
import '../styles/app/shell.css';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { GateLoader } from '../src/auth/GateLoader.tsx';
import { Announcer } from '../src/shell/Announcer.tsx';
import { requestLang } from '../src/shell/i18n-server.ts';
import { ShellIntl } from '../src/shell/intl.tsx';
import { PAGE_VERDICT_HEADER, REFUSED_PAGE, refusedVerdict } from '../src/shell/page-verdict.ts';
import { SharedPage } from '../src/shell/SharedPages.tsx';
import { WorldResetBoundary } from '../src/shell/world-reset.tsx';

// No title here: each page renders its own <title> from the catalog (the shared pages: SharedPages.tsx), and a layout
// title would come first in <head> and mask it.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await requestLang();
  const refused = refusedVerdict((await headers()).get(PAGE_VERDICT_HEADER));
  return (
    <html lang={lang}>
      <body className="r1">
        <ShellIntl lang={lang}>
          <Announcer>
            <WorldResetBoundary>{refused === 'gate' ? <GateLoader /> : refused ? <SharedPage kind={REFUSED_PAGE[refused]} /> : children}</WorldResetBoundary>
          </Announcer>
        </ShellIntl>
      </body>
    </html>
  );
}
