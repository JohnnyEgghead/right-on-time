// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The frame of the 3 email pages (SCR-EML-01 to -03; frames r1-eml-email, r1-eml-setpw, r1-eml-forgot): the demo strip, the
// public header (CMP-14, with the branch office phone), main.mid and the footer, with the sheets the frames load in their
// order: base, r1-common, r1-single (DK-47), then each page's own rules (imported by the page module).
import '../../styles/kit/kit.base.css';
import '../../styles/kit/kit.r1-common.css';
import '../../styles/kit/kit.r1-single.css';
import '../../styles/app/accounts.css';
import type { ReactNode } from 'react';
import { branchById } from '../shell/branches.ts';
import type { ClockAnswer } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { PublicHeader } from '../shell/Headers.tsx';
import { Icon } from '../shell/Icon.tsx';
import type { IconName } from '../shell/icon-paths.ts';
import { Screen } from '../shell/Surface.tsx';

export interface EmlFrameProps {
  screen: 'SCR-EML-01' | 'SCR-EML-02' | 'SCR-EML-03';
  title: string;
  branch?: string;
  /** Preview states: the clock and footer fixed. */
  clock?: ClockAnswer | null;
  appInfo?: AppInfo | null;
  children: ReactNode;
}

export function EmlFrame({ screen, title, branch, clock, appInfo, children }: EmlFrameProps) {
  return (
    <Screen
      screen={screen} surface="SURF-EML" title={title}
      {...(clock !== undefined ? { clock, reader: false as const } : {})} {...(appInfo !== undefined ? { appInfo } : {})}
    >
      <PublicHeader branch={branchById(branch)} />
      <main className="mid">{children}</main>
    </Screen>
  );
}

/** A DK-47 message box (okbox, infobox2, warnbox) with its icon. */
export function MsgBox({ kind, icon, children, role, ctl }: { kind: 'okbox' | 'infobox2' | 'warnbox'; icon: IconName; children: ReactNode; role?: 'status' | 'alert'; ctl?: string }) {
  return (
    <div className={kind} {...(role ? { role } : {})} {...(ctl ? { 'data-ctl': ctl } : {})}>
      <Icon name={icon} {...(icon === 'check' ? { sw: 2.6 } : {})} />
      <span>{children}</span>
    </div>
  );
}

/** The loading skeleton of an email page's body, at the widths the frame tile gives it. */
/** `widths`: a width class per bar (bw-w-40 and the like, styles/app; inline styles are refused by the page CSP), or null. */
export function Skeleton({ widths }: { widths: (string | null)[] }) {
  return (
    <div className="bw-eml-skel" aria-busy="true">
      {widths.map((w, i) => (
        <span key={i} className={w ? `r1-skel ${w}` : 'r1-skel'} />
      ))}
    </div>
  );
}
