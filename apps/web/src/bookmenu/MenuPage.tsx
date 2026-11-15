// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-CUS-07 Booking site page at its 5 routes (frame mockups/pages/r1-book-c-club.html, DK-122, option C): Heating, Cooling, Plumbing, Comfort Club
// and About us, each a short made-up page from the catalog in the page's language, inside the booking site frame (CMP-15), with no link to an
// outside site (FR-BOOK-13, NFR-12). Book a visit opens step 1 of SCR-CUS-01 (CTL-CUS-07-02). The pages read nothing and write nothing: Comfort
// Club describes the plan and signs nobody up (FR-DISP-32).
import { BookingFrame } from '../shell/BookingFrame.tsx';
import '../../styles/app/bookmenu.css';
import { BRANCHES } from '../shell/branches.ts';
import type { FrameData } from '../shell/frame-data.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { Art } from './Art.tsx';
import type { MenuPageData } from './model.ts';

/** The branch whose office number the pages print: the frame's, Columbus (the made-up office number of FR-IMP-7). */
const BRANCH = BRANCHES[0]!;

export function MenuPage({ page, ...frame }: { page: MenuPageData } & Omit<FrameData, 'screen' | 'children'>) {
  const t = useT();
  return (
    <BookingFrame screen="SCR-CUS-07" branch={BRANCH} className="b-c" mainClassName="pg" mainCtl="CTL-CUS-07-01" currentPath={`/book/${page.slug}`} {...frame}>
      <div className="split">
        <div className="txt">
          <span className="kicker">{t(page.name)}</span>
          <h1>{t(page.h1)}</h1>
          <p className="lead">{t(page.lead)}</p>
          <div className="strip">
            {page.squares.map((s) => (
              <div className="sq" key={s.title}>
                <span className="yi">
                  <Icon name={s.icon} />
                </span>
                <b>{t(s.title)}</b>
                <span>{'key' in s.text ? t(s.text.key) : s.text.branches}</span>
              </div>
            ))}
          </div>
          <a className="btn accent lg cta" href="/book" data-ctl="CTL-CUS-07-02">
            <Icon name="calendar" />
            {t('shell.booking.book')}
          </a>
          {page.join ? <p className="join">{t('bookmenu.club.join', { phone: BRANCH.officePhone })}</p> : null}
        </div>
        <div className="art2">
          <Art art={page.art} />
        </div>
      </div>
    </BookingFrame>
  );
}
