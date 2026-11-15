// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SURF-CUS / INB / EML / GATE-02 / TEC-11 public frame (demo strip, CMP-14) with the public kit slices.
import './css/public.ts';
import type { Branch } from './branches.ts';
import { passFrame, type FrameData } from './frame-data.ts';
import { PublicHeader } from './Headers.tsx';
import { Screen } from './Surface.tsx';

export function PublicFrame(d: FrameData & { branch: Branch; surface?: 'SURF-CUS' | 'SURF-INB' | 'SURF-EML' | 'SURF-GATE' | 'SURF-TWA'; showPhone?: boolean }) {
  return (
    <Screen screen={d.screen} surface={d.surface ?? 'SURF-CUS'} {...passFrame(d)}>
      <PublicHeader branch={d.branch} {...(d.showPhone !== undefined ? { showPhone: d.showPhone } : {})} />
      <main>{d.children}</main>
    </Screen>
  );
}
