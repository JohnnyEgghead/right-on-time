// SPDX-License-Identifier: AGPL-3.0-or-later
// What every surface frame takes. Its own module, so a frame can share it without importing another surface's CSS.
import type { ReactNode } from 'react';
import type { ClockAnswer } from './clock.ts';
import type { AppInfo } from './Footer.tsx';
import type { Reader } from './reads.ts';

export interface FrameData {
  screen: string;
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
  reader?: Reader | false;
  children?: ReactNode;
}

export const passFrame = (d: FrameData) => ({
  ...(d.clock !== undefined ? { clock: d.clock } : {}),
  ...(d.appInfo !== undefined ? { appInfo: d.appInfo } : {}),
  ...(d.reader !== undefined ? { reader: d.reader } : {}),
});
