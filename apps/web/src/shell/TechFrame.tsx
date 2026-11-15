// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SURF-TWA frame: the phone demo strip (DK-24 .ph) with the phone kit slices; the tab frame CMP-09 is the technician lane's.
import './css/phone.ts';
import type { FrameData } from './frame-data.ts';
import { Screen } from './Surface.tsx';

/** `noClock`: the screen draws the demo clock inside its own header (DK-107 .clkrow; F-938), so no strip sits above it. */
export function TechFrame(d: FrameData & { noClock?: boolean }) {
  return (
    <Screen
      screen={d.screen}
      surface="SURF-TWA"
      phone
      live
      footer={false}
      {...(d.noClock ? { noClock: true } : {})}
      {...(d.clock !== undefined ? { clock: d.clock } : {})}
      {...(d.reader !== undefined ? { reader: d.reader } : {})}
    >
      {d.children}
    </Screen>
  );
}
