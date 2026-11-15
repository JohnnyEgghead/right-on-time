// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-02's frame in the web technician app (SURF-TWA): the shell P5-TWA-OUTBOX built (src/tech/TechAppFrame.tsx: the item
// engine, the service worker, CMP-09 and CMP-10), with the header DK-107 draws (title, the date with the van and the day's
// progress, CMP-10's waiting count, the demo clock inside the header with Refresh; F-938) and the list P5-TWA-TODAY fills
// (today/TodayView.tsx). A confirm sheet (SCR-TEC-03, -13, -14) opens over it. The live container is today/TodayScreen.tsx; the
// preview routes pass the same props fixed. The kit slices before the page's own sheet, in the frame's order (its own rules last).
import '../shell/css/phone.ts';
import '../../styles/page-tech-today.css';
import '../../styles/app/tech-today.css';
import type { OutboxState } from './engine.ts';
import type { ClockAnswer } from '../shell/clock.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { useT } from '../shell/intl.tsx';
import { TechAppFrame } from './TechAppFrame.tsx';
import { ConfirmSheet, SHEET_SCREEN } from './today/Sheets.tsx';
import { TodayHeader, TodayList, type SheetKind, type TodayViewProps } from './today/TodayView.tsx';
import type { LocalJob } from './today/model.ts';

export interface TodayShellProps extends Omit<TodayViewProps, 'fixed' | 'clock'> {
  fixed?: OutboxState;
  clock?: ClockAnswer | null;
  info?: AppInfo | null;
  mini?: boolean;
  sheet?: { kind: SheetKind; job: LocalJob } | null;
  onCancel?: () => void;
  onConfirm?: () => void;
}

export function TodayShell(p: TodayShellProps) {
  const t = useT();
  const { sheet, onCancel, onConfirm, ...view } = p;
  const f = p.fixed ? { fixed: p.fixed } : {};
  const c = p.clock !== undefined ? { clock: p.clock } : {};
  return (
    <TechAppFrame
      screen={sheet ? SHEET_SCREEN[sheet.kind] : 'SCR-TEC-02'}
      tab="today"
      clockInHeader
      {...(p.mini ? { mini: true } : {})}
      {...f}
      {...(p.fixed ? { reader: false as const, clock: null } : {})}
      header={<TodayHeader day={p.day} jobs={p.jobs} loading={p.loading} online={p.online} {...f} {...c} {...(p.onRefresh ? { onRefresh: p.onRefresh } : {})} t={t} />}
    >
      <TodayList {...view} {...f} {...c} />
      {sheet ? <ConfirmSheet kind={sheet.kind} job={sheet.job} zone={p.day?.zone ?? 'America/New_York'} online={p.online} onCancel={onCancel ?? (() => undefined)} onConfirm={onConfirm ?? (() => undefined)} /> : null}
    </TechAppFrame>
  );
}
