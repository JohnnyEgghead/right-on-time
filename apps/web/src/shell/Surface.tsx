// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The surface frames: the 1 screen root every page renders inside, with its surface header.
//
// The data-screen convention (BUILD_PLAN D-9, REC-TB-4; owned by P2-SHELL): every page's screen root is the element
// `.r1-screen[data-screen="<UI-SPECIFICATION screen ID>"]`, exactly 1 per document, and it also carries
// data-surface="<SURF id>". A dialog, sheet, popover or panel row of the page inventory carries its own
// data-screen on its own root, inside its host page. The page walkers and acceptance tests find a page by this
// attribute (ci/page-walkers/app-wiring.ts), never by its text or route.
//
// FR-DEMO-1: every surface header holds the demo strip (CMP-01, CMP-02), except SCR-GATE-01 (UD-13).
import type { ReactNode } from 'react';
import type { ClockAnswer } from './clock.ts';
import { DemoStrip } from './DemoStrip.tsx';
import { Footer, type AppInfo } from './Footer.tsx';
import { Mark } from './Icon.tsx';
import { useT } from './intl.tsx';
import { LanguageSwitch } from './LanguageSwitch.tsx';
import type { Reader } from './reads.ts';

export type SurfaceId = 'SURF-OFC' | 'SURF-PBS' | 'SURF-TWA' | 'SURF-CUS' | 'SURF-INB' | 'SURF-EML' | 'SURF-GATE' | 'SURF-SHR';

export interface ScreenProps {
  screen: string;
  surface: SurfaceId;
  children: ReactNode;
  /** Shared state for the strip and footer: preview states pass fixed data; pages leave them unset and they read. */
  clock?: ClockAnswer | null;
  changeHref?: string | null;
  resetTo?: string | null;
  appInfo?: AppInfo | null;
  reader?: Reader | false;
  /** A signed-in page: the strip hears EVT-06 (DemoStrip `live`). */
  live?: boolean;
  /** SCR-GATE-01 has no demo strip (UD-13). */
  noClock?: boolean;
  footer?: boolean;
  phone?: boolean;
  /** The document title (a catalog string); a page without its own title shows the product name. */
  title?: string;
  /** The frame's own classes on the screen root (`r1k`, `g-a code`): the frame page's root carries them. */
  className?: string;
  /** CMP-04's Demo mode on marker; false on SCR-GATE-01, whose frame shows the footer without it (UD-13). */
  demoMarker?: boolean;
}

export function Screen({ screen, surface, children, clock, changeHref = null, resetTo, appInfo, reader, live = false, noClock = false, footer = true, phone = false, title, className, demoMarker = true }: ScreenProps) {
  const t = useT();
  return (
    <div className={`r1-screen bw-screen${className ? ` ${className}` : ''}`} data-screen={screen} data-surface={surface}>
      <title>{title ?? t('shell.app.doc')}</title>
      {noClock ? null : (
        <DemoStrip
          variant={phone ? 'phone' : 'desktop'}
          changeHref={changeHref}
          {...(resetTo !== undefined ? { resetTo } : {})}
          live={live}
          {...(clock !== undefined ? { initial: clock } : {})}
          {...(reader !== undefined ? { reader } : {})}
        />
      )}
      {children}
      {footer ? <Footer demoMarker={demoMarker} {...(appInfo !== undefined ? { info: appInfo } : {})} {...(reader !== undefined ? { reader } : {})} /> : null}
    </div>
  );
}

/** The shared pages' header (DK-48 .shr-head): brand, product name and the language switch. */
export function SharedHeader() {
  const t = useT();
  return (
    <header className="shr-head">
      <span className="brand">
        <Mark />
        <span className="word">
          {t('brand.name')}
          <small>{t('brand.trade')}</small>
        </span>
      </span>
      <span className="prod">{t('brand.product')}</span>
      <span className="grow" />
      <LanguageSwitch />
    </header>
  );
}
