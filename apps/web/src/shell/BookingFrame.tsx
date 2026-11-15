// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SURF-CUS booking site frame: demo strip and CMP-15. Its own module so the booking unit's kit slice (DK-66 to DK-68)
// loads only on the routes that render it (UI-DESIGN-KIT 0.1), never on every page.
import './css/booking.ts';
import '../../styles/app/booking-frame.css';
import type { Branch } from './branches.ts';
import type { FrameData } from './frame-data.ts';
import { BookingHeader } from './Headers.tsx';
import { Screen } from './Surface.tsx';

/** `className` rides on the screen root and `mainClassName` and `mainCtl` on the `<main>` (the frame page's own classes and control tag, as `Screen` takes them); `currentPath` is the route the site menu marks current when it is not the URL's (a preview route); all 4 are optional. */
export function BookingFrame(d: FrameData & { branch: Branch; className?: string; mainClassName?: string; mainCtl?: string; currentPath?: string }) {
  return (
    <Screen
      screen={d.screen}
      surface="SURF-CUS"
      {...(d.className !== undefined ? { className: d.className } : {})}
      {...(d.clock !== undefined ? { clock: d.clock } : {})}
      {...(d.appInfo !== undefined ? { appInfo: d.appInfo } : {})}
      {...(d.reader !== undefined ? { reader: d.reader } : {})}
    >
      <BookingHeader branch={d.branch} {...(d.currentPath !== undefined ? { currentPath: d.currentPath } : {})} />
      <main {...(d.mainClassName !== undefined ? { className: d.mainClassName } : {})} {...(d.mainCtl !== undefined ? { 'data-ctl': d.mainCtl } : {})}>
        {d.children}
      </main>
    </Screen>
  );
}
