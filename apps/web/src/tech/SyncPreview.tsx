// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (the shell-preview routes tech-sync and tech-frame): CMP-10 and CMP-09 in each state their frames
// show, on fixed engine states, each drawn in the wrapper its frame tile draws it in (DK-64 .r1-st .b; a phone screen
// inside a tile is .screen.r1p-mini), for the look comparator (ci/look-values/tech-shell.pw.test.ts) and the page walkers.
import type { ReactNode } from 'react';
import { STATES } from './preview-states.ts';
import { NoSignalBanner, OldItemsBanner, SentAnnouncer, WaitingCount } from './SyncStrip.tsx';
// The kit slices first, then DK-111's own sheet (the route's frame), in the frame's order.
import '../shell/css/phone.ts';
import '../../styles/page-tech-offline.css';
import type { SYNC_PREVIEWS } from './preview-names.ts';

const tile = (cap: string, node: ReactNode, cls = 'b') => (
  <div className="bw-screen bw-tech-tile">
    <div className="r1-st" data-bw-cap={cap}><div className={cls}>{node}</div></div>
  </div>
);

export function SyncPreview({ name }: { name: (typeof SYNC_PREVIEWS)[number] }) {
  switch (name) {
    case 'nosignal':
      return tile('CMP-10 Sync strip: No signal, waiting count', <div className="screen r1p-mini"><NoSignalBanner fixed={STATES.offline!} /></div>);
    case 'old':
      return tile('CMP-10 Sync strip: 24-hour banner', <div className="r1p-pad"><OldItemsBanner fixed={STATES.old!} /></div>, 'b flat');
    case 'count-synced':
      return tile('SCR-TEC-05 Add note, web: Empty', <div className="screen r1p-mini"><div className="apphead"><div className="clkrow"><WaitingCount fixed={STATES.synced!} /></div></div></div>);
    case 'sent':
      return tile('Sent announcement', <SentAnnouncer fixed={STATES.sent!} />);
  }
}
