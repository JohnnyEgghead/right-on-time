// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (imported by app/shell-preview/booking-done/[state]/page.preview.tsx): SCR-CUS-03 in each state DK-121 draws, with the
// frame's fixed data (preview-data.ts), for the look comparator and the page walkers. The page itself (DoneView), never a copy. Its own module:
// the done page's sheet must not load with the booking page's (their rules differ).
import '../../styles/page-booking-done.css';
import '../../styles/app/booking.css';
import type { ClockAnswer } from '../shell/clock.ts';
import { BookingFrame } from '../shell/BookingFrame.tsx';
import { branchById } from '../shell/branches.ts';
import { APP_INFO, CLOCK_RUNNING } from '../shell/preview-fixtures.ts';
import { DoneLoading, DoneNotFound, DoneView } from './DoneView.tsx';
import { SUMMARY, SUMMARY_HELD, SUMMARY_NO_TEXTS, type DonePreviewState } from './preview-data.ts';

const FRAME = { clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false } as const;
const DONE_CLOCK: ClockAnswer = { ...CLOCK_RUNNING, demoNow: '2026-09-10T19:42:00-04:00[America/New_York]' };
export function DonePreview({ state }: { state: DonePreviewState }) {
  const branch = branchById('columbus');
  const body = state === 'loading' ? <DoneLoading />
    : state === 'not-found' ? <DoneNotFound />
    : state === 'no-texts' ? <DoneView data={SUMMARY_NO_TEXTS} branch={branch} />
    : state === 'held' ? <DoneView data={SUMMARY_HELD} branch={branch} />
    : <DoneView data={SUMMARY} branch={branch} />;
  return (
    <BookingFrame screen="SCR-CUS-03" branch={branch} {...FRAME} clock={DONE_CLOCK}>
      {body}
    </BookingFrame>
  );
}
