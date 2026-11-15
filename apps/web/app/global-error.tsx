// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-SHR-03 when the root layout itself fails: the page has no layout, so this renders its own document, in the
// language the browser chose (read from the cookie on the client; English when unreadable).
import '../styles/app/shell.css';
import { Announcer } from '../src/shell/Announcer.tsx';
import { ShellIntl } from '../src/shell/intl.tsx';
import { LANG_COOKIE, langFromCookie } from '../src/shell/lang.ts';
import { SharedPage } from '../src/shell/SharedPages.tsx';

export default function GlobalError() {
  const raw = typeof document === 'undefined' ? undefined : new RegExp(`(?:^|; )${LANG_COOKIE}=(en|es)`).exec(document.cookie)?.[1];
  const lang = langFromCookie(raw);
  return (
    <html lang={lang}>
      <body className="r1">
        <ShellIntl lang={lang}>
          <Announcer>
            <SharedPage kind="failed" />
          </Announcer>
        </ShellIntl>
      </body>
    </html>
  );
}
