// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only: SCR-TEC-05 Add note in each state its frames show (DK-111), on fixed data (preview-fixtures.ts), for the look comparator and the
// page walkers. Never a release route.
import type { NOTE_PREVIEWS } from '../preview-names.ts';
import { CLOCK_RUNNING } from '../../shell/preview-fixtures.ts';
import { NoteScreen, type NoteScreenProps } from './NoteScreen.tsx';
import { ON_SITE, OUT } from './preview-fixtures.ts';

const job = { kind: 'job' as const, job: ON_SITE, fromPhone: false };
const TEXT = 'Replaced 6 ft of condensate hose. Heat exchanger looks clean, no cra';
const S: Record<(typeof NOTE_PREVIEWS)[number], NonNullable<NoteScreenProps['fixed']>> = {
  typing: { view: job, outbox: OUT.offline3, text: TEXT, clock: { ...CLOCK_RUNNING, demoNow: '2026-09-15T11:06:00-04:00[America/New_York]' } },
  empty: { view: job, outbox: OUT.synced },
  restored: { view: job, outbox: OUT.synced, text: TEXT, restored: true },
  'saved-offline': { view: job, outbox: OUT.offline4, clock: { ...CLOCK_RUNNING, demoNow: '2026-09-15T11:07:00-04:00[America/New_York]' } },
  discard: { view: job, outbox: OUT.offline3, text: 'Replaced 6 ft of condensate hose.', asking: true },
};

export function NotePreview({ name }: { name: (typeof NOTE_PREVIEWS)[number] }) {
  return <NoteScreen jobNumber={24830} fixed={{ clock: CLOCK_RUNNING, mini: name !== 'typing', ...S[name] }} />;
}
