// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The per-surface frames: what each surface's layout renders around its pages (BUILD_PLAN P2-SHELL "per-surface
// layouts"). A page lane mounts its surface's frame in its route group's layout.tsx; the shell adds no route itself, so
// no page answers before the lane that builds it (and its policy entry) has merged. Each frame module loads the kit
// slices its surface's frames load (src/shell/css), so a surface never carries another surface's rules.
//   SURF-OFC  OfficeFrame: demo strip with Change for managers, CMP-07, page body, footer       (this file)
//   SURF-OFC  AdminFrame: OfficeFrame with CMP-08 beside the page body                           (this file)
//   SURF-PBS  PbsFrame: demo strip without Change (D5a-2), CMP-07                                (this file)
//   SURF-CUS  BookingFrame: demo strip, CMP-15                                                   (BookingFrame.tsx)
//   SURF-CUS / INB / EML / GATE-02 / TEC-11  PublicFrame: demo strip, CMP-14                     (PublicFrame.tsx)
//   SURF-TWA  TechFrame: the phone demo strip; the tab frame CMP-09 is the technician lane's     (TechFrame.tsx)
import './css/office.ts';
import { passFrame, type FrameData } from './frame-data.ts';
import { AdminSide } from './Headers.tsx';
import { useMe } from './me.ts';
import { OfficeTopBar, type Me, type OfficeTopBarProps } from './OfficeTopBar.tsx';
import { Screen } from './Surface.tsx';

const changeFor = (me: Me | null) => (me?.permissions.includes('SCR-OFC-17') ? '/office/admin/clock' : null);
const readerOf = (d: FrameData) => (d.reader === undefined ? {} : d.reader === false ? {} : { reader: d.reader });

// `me`: given (a page's own read, a preview state), or absent: the frame reads API-07 itself (src/shell/me.ts).
export function OfficeFrame(d: FrameData & { me?: Me; bar?: Omit<OfficeTopBarProps, 'me'> }) {
  const me = useMe(d.reader, d.me);
  return (
    <Screen screen={d.screen} surface="SURF-OFC" changeHref={changeFor(me)} live={me !== null} {...passFrame(d)}>
      {me ? <OfficeTopBar me={me} {...readerOf(d)} liveAlerts={d.reader !== false} {...d.bar} /> : null}
      <div className="r1-main">{d.children}</div>
    </Screen>
  );
}

export function AdminFrame(d: FrameData & { me?: Me; bar?: Omit<OfficeTopBarProps, 'me'>; currentPath?: string }) {
  const me = useMe(d.reader, d.me);
  return (
    <Screen screen={d.screen} surface="SURF-OFC" changeHref={changeFor(me)} live={me !== null} {...passFrame(d)}>
      {me ? <OfficeTopBar me={me} {...readerOf(d)} liveAlerts={d.reader !== false} {...d.bar} /> : null}
      <div className="shell">
        <AdminSide permissions={me?.permissions ?? []} {...(d.currentPath ? { currentPath: d.currentPath } : {})} />
        <div className="mainc">{d.children}</div>
      </div>
    </Screen>
  );
}

// `className`: the frame's own classes on the screen root (the pretend billing pages' `p-a list` and `p-a inv`, DK-65).
export function PbsFrame(d: FrameData & { me?: Me; className?: string }) {
  const me = useMe(d.reader, d.me);
  return (
    <Screen screen={d.screen} surface="SURF-PBS" changeHref={null} live={me !== null} {...(d.className ? { className: d.className } : {})} {...passFrame(d)}>
      {me ? <OfficeTopBar me={me} {...readerOf(d)} liveAlerts={d.reader !== false} /> : null}
      <div className="r1-main">{d.children}</div>
    </Screen>
  );
}
