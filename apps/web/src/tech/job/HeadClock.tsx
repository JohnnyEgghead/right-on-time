// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-01 inside the job screens' headers, where DK-110 to DK-112 draw it (.apphead .r1p-clk; "(no signal)" offline): main's DemoStrip
// header variant, as Today draws it (P5-TWA-TODAY, F-938), so the frame strip above the header is left out (TechAppFrame clockInHeader).
// A preview passes its frame's demo time and never reads; a page reads the clock itself.
import type { ClockAnswer } from '../../shell/clock.ts';
import { DemoStrip } from '../../shell/DemoStrip.tsx';

export function HeadClock({ online, fixed }: { online: boolean; fixed?: ClockAnswer | undefined }) {
  return <DemoStrip variant="header" offline={!online} {...(fixed ? { initial: fixed, reader: false as const } : {})} />;
}
