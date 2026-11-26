// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-SHR-01 No access, SCR-SHR-02 Page not found, SCR-SHR-03 Something went wrong (DK-48; frames DK-132 to DK-134).
// Nothing of the refused or missing page is sent: the card is the whole page.
import './css/shared-pages.ts';
import type { MessageKey } from '@bw/i18n';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ClockAnswer } from './clock.ts';
import type { AppInfo } from './Footer.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './icon-paths.ts';
import { useT } from './intl.tsx';
import type { Me } from './OfficeTopBar.tsx';
import { createReader, type Reader } from './reads.ts';
import { Screen, SharedHeader } from './Surface.tsx';

// Its own chunk: the booking kit slice must reach only this page, never the other shared pages' look.
const BookingSiteHeader = dynamic(() => import('./BookingSiteHeader.tsx'));

export type SharedKind = 'no-access' | 'not-found' | 'failed';

const KINDS: Record<SharedKind, { screen: string; ctl: string; ico: string; icon: IconName; code: number; title: MessageKey; body: MessageKey; doc: MessageKey }> = {
  'no-access': { screen: 'SCR-SHR-01', ctl: 'CTL-SHR-01', ico: 'lock', icon: 'lock', code: 403, title: 'shell.shr.noAccess.title', body: 'shell.shr.noAccess.body', doc: 'shell.shr.noAccess.doc' },
  'not-found': { screen: 'SCR-SHR-02', ctl: 'CTL-SHR-02', ico: 'lost', icon: 'pin', code: 404, title: 'shell.shr.notFound.title', body: 'shell.shr.notFound.body', doc: 'shell.shr.notFound.doc' },
  failed: { screen: 'SCR-SHR-03', ctl: 'CTL-SHR-03', ico: 'err', icon: 'alert', code: 500, title: 'shell.shr.failed.title', body: 'shell.shr.failed.body', doc: 'shell.shr.failed.doc' },
};

/** The role's home page (API-07): SCR-TEC-02 for a technician, SCR-OFC-02 for staff; signed out, Book a visit. */
function homeFor(me: Pick<Me, 'role'> | null, signedOutHome: string): string {
  if (!me) return signedOutHome;
  return me.role === 'technician' ? '/tech' : '/office/board';
}

export interface SharedPageProps {
  kind: SharedKind;
  onRetry?: () => void;
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
  reader?: Reader | false;
}

export function SharedPage({ kind, onRetry, clock, appInfo, reader }: SharedPageProps) {
  const t = useT();
  const k = KINDS[kind];
  // SCR-CUS-07's unknown page (DK-133): a /book/ page name that is not one of the 5 answers 404 under the booking site header, with Book a visit as the way on.
  // F-926: kept here, by the path: the page gate answers /book/<unknown> before any route renders, so no layout can choose the header.
  const booking = kind === 'not-found' && /^\/book\//.test(usePathname() ?? '');
  const signedOutHome = kind === 'no-access' ? '/' : '/book';
  const [home, setHome] = useState(signedOutHome);
  useEffect(() => {
    if (reader === false || booking) return;
    void (reader ?? createReader({ baseUrl: window.location.origin })).read<Me>('API-07').then((r) => setHome(homeFor(r.ok ? r.data : null, signedOutHome)));
  }, [reader, signedOutHome, booking]);
  // F-925: a signed-out reader's way on from any not-found page is Book a visit (CTL-SHR-02-02); home is /book only until a session says otherwise.
  const bookWay = booking || (kind === 'not-found' && home === '/book');
  const homeLink = (primary: boolean, ctl: string) => (
    <a className={primary ? 'btn primary' : 'btn'} href={home} data-ctl={ctl}>
      <Icon name={bookWay ? 'calendar' : 'home'} />
      {t(bookWay ? 'shell.booking.book' : 'shell.shr.home')}
    </a>
  );
  const signOut = async () => {
    // API-06 clears the httpOnly session cookie in its answer on every outcome (F-230); the sign-in page opens either way.
    await (reader || createReader({ baseUrl: window.location.origin })).read('API-06');
    window.location.assign('/sign-in');
  };
  return (
    <Screen screen={k.screen} surface="SURF-SHR" title={t(k.doc)} {...(clock !== undefined ? { clock } : {})} {...(appInfo !== undefined ? { appInfo } : {})} {...(reader !== undefined ? { reader } : {})}>
      {booking ? <BookingSiteHeader /> : <SharedHeader />}
      <main className="shr-main">
        <div className="shr-card" data-ctl={`${k.ctl}-01`}>
          <div className={`shr-ico ${k.ico}`}>
            <Icon name={k.icon} />
          </div>
          <h1>{t(k.title)}</h1>
          <p>{t(k.body)}</p>
          <div className="shr-acts">
            {kind === 'no-access' ? (
              <>
                {homeLink(true, 'CTL-SHR-01-02')}
                <button type="button" className="btn" data-ctl="CTL-SHR-01-03" onClick={() => void signOut()}>
                  {t('shell.signOut')}
                </button>
              </>
            ) : kind === 'not-found' ? (
              homeLink(true, 'CTL-SHR-02-02')
            ) : (
              <>
                <button type="button" className="btn primary" data-ctl="CTL-SHR-03-02" onClick={() => (onRetry ? onRetry() : window.location.reload())}>
                  <Icon name="refresh" />
                  {t('shell.error.tryAgain')}
                </button>
                {homeLink(false, 'CTL-SHR-03-03')}
              </>
            )}
          </div>
          <div className="shr-code">{t.rich('shell.shr.code', { code: k.code, b: (c) => <b>{c}</b> })}</div>
        </div>
      </main>
    </Screen>
  );
}
