// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only (imported by app/shell-preview/booking*/[state]/page.preview.tsx): SCR-CUS-01, SCR-CUS-02 and SCR-CUS-03 in each state DK-118
// to DK-121 draw, with the frames' fixed data (preview-data.ts) and handlers that do nothing, for the look comparator
// (ci/look-values/booking.pw.test.ts) and the page walkers. Each state is the page itself (the same BookingView and DoneView the release routes
// draw), never a copy.
import '../../styles/page-booking.css';
import '../../styles/page-booking-taken.css';
import '../../styles/page-booking-phone.css';
import '../../styles/app/booking.css';
import { BookingFrame } from '../shell/BookingFrame.tsx';
import { branchById } from '../shell/branches.ts';
import { APP_INFO, CLOCK_RUNNING } from '../shell/preview-fixtures.ts';
import { BookingView, type ViewProps } from './BookingView.tsx';
import { useLayout } from './layout.ts';
import { emptyDraft } from './model.ts';
import {
  AVAILABILITY, DAY_FULL, FILLED, HAROLD, NEAREST, NO_DAYS, SERVICES, STREETS, TAKEN_DAYS, TODAY, type BookingPreviewState, type TakenPreviewState,
} from './preview-data.ts';

const nop = () => undefined;
const FRAME = { clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false } as const;
const ON: ViewProps['on'] = {
  service: nop, streetText: nop, pickStreet: nop, house: nop, retryStreets: nop, month: nop, day: nop, window: nop, name: nop, mobile: nop, textsOn: nop, language: nop,
  change: nop, next: nop, back: nop, confirm: nop, retryServices: nop, retryDays: nop,
};
const BASE: ViewProps = {
  layout: 'wide', step: 6, draft: HAROLD, services: SERVICES, street: { kind: 'idle' }, avail: { kind: 'ready', data: AVAILABILITY() }, month: '2026-09', today: TODAY,
  phone: '(614) 555-0100', branchName: 'Columbus', booking: false, shown: null, invalid: {}, on: ON,
};

function viewOf(state: BookingPreviewState): ViewProps {
  switch (state) {
    case 'phone': return { ...BASE, layout: 'phone', step: 4, draft: { ...HAROLD, windowId: 'w10' } };
    case 'phone-day': return { ...BASE, layout: 'phone', step: 3, draft: { ...HAROLD, windowId: null } };
    case 'loading': return { ...BASE, step: 1, draft: emptyDraft('en'), services: 'loading', avail: { kind: 'idle' }, branchName: null };
    case 'no-match': return { ...BASE, step: 2, draft: { ...emptyDraft('en'), serviceId: 'furnace_tune_up', streetText: 'Mapel Holow' }, street: { kind: 'none' }, avail: { kind: 'idle' }, branchName: null };
    case 'street-results': return { ...BASE, step: 2, draft: { ...emptyDraft('en'), serviceId: 'furnace_tune_up', streetText: 'Maple H' }, street: { kind: 'results', streets: STREETS }, avail: { kind: 'idle' }, branchName: null };
    case 'no-days': return { ...BASE, step: 3, draft: { ...HAROLD, date: null, windowId: null }, avail: { kind: 'ready', data: AVAILABILITY(NO_DAYS) } };
    case 'day-full': return { ...BASE, step: 4, draft: { ...HAROLD, windowId: null }, avail: { kind: 'ready', data: AVAILABILITY(DAY_FULL) } };
    case 'no-mobile': return { ...BASE, step: 5, draft: { ...HAROLD, mobile: '' } };
    case 'restored': return { ...BASE, step: 5 };
    case 'booking': return { ...BASE, booking: true };
    case 'booking-closed': return { ...BASE, step: 3, draft: { ...HAROLD, date: null, windowId: null }, shown: { key: 'booking.err.closed', values: { day: 'Tue, Sep 15' } } };
    default: return BASE;
  }
}

export function BookingPreview({ state }: { state: BookingPreviewState }) {
  // The walkers open every state at 520 and 390 px: below the phone width the page draws its phone layout, as the release page does.
  const layout = useLayout();
  return (
    <BookingFrame screen="SCR-CUS-01" branch={branchById('columbus')} {...FRAME}>
      <BookingView {...viewOf(state)} layout={state === 'phone' || state === 'phone-day' ? 'phone' : layout} />
    </BookingFrame>
  );
}

export function TakenPreview({ state }: { state: TakenPreviewState }) {
  const options = state === 'none-nearby' ? [] : state === 'filled-again' ? NEAREST.slice(1) : state === 'booking' ? NEAREST.slice(0, 2) : NEAREST;
  const picked = state === 'booking' ? `${NEAREST[0]?.date}|${NEAREST[0]?.windowId}` : null;
  const layout = useLayout();
  const view: ViewProps = {
    ...BASE, layout, step: 4, draft: { ...HAROLD, windowId: null }, avail: { kind: 'ready', data: AVAILABILITY(TAKEN_DAYS()) },
    taken: { filled: FILLED, options, picked, busy: state === 'booking', onPick: nop, onBook: nop, onOtherDay: nop },
  };
  return (
    <BookingFrame screen="SCR-CUS-02" branch={branchById('columbus')} {...FRAME}>
      <BookingView {...view} />
    </BookingFrame>
  );
}

