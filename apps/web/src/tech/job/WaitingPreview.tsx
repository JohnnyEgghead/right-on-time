// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only: SCR-TEC-09 Waiting to send in each state its frames show (DK-111), on fixed data (preview-fixtures.ts), for the look comparator and the
// page walkers. Never a release route.
import type { WAITING_PREVIEWS } from '../preview-names.ts';
import { CLOCK_RUNNING } from '../../shell/preview-fixtures.ts';
import { OUT } from './preview-fixtures.ts';
import { WaitingScreen, type WaitingScreenProps } from './WaitingScreen.tsx';

const names = { 24830: 'Harold Jenkins' };
const S: Record<(typeof WAITING_PREVIEWS)[number], NonNullable<WaitingScreenProps['fixed']>> = {
  nothing: { outbox: OUT.synced, names, nowMs: 0 },
  offline: { outbox: OUT.offline3, names, nowMs: 0 },
  sending: { outbox: OUT.sending3, names, nowMs: 0, sending: true },
  partial: { outbox: OUT.partial, names, nowMs: 0 },
  refused: { outbox: OUT.refused, names, nowMs: 0 },
  old: { outbox: OUT.old, names, nowMs: 0 },
};

export function WaitingPreview({ name }: { name: (typeof WAITING_PREVIEWS)[number] }) {
  return <WaitingScreen fixed={{ clock: CLOCK_RUNNING, mini: true, demoNowMs: Date.parse(CLOCK_RUNNING.demoNow.slice(0, 25)), ...S[name] }} />;
}
