// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-CUS-03 You're booked at `/book/done/<bookingToken>` (DK-121; UI-SPECIFICATION SCR-CUS-03; FR-BOOK-1, FR-BOOK-11, FR-TEXT-1): reads API-114 by
// the token in the link (no phone number or address in it, NFR-05) and shows the visit, what happens next and the confirmation text as it was
// queued: Sent, or held until 8:00 AM the customer's time.
import '../../styles/page-booking-done.css';
import '../../styles/app/booking.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookingSummaryAnswer } from '@bw/api';
import { BookingFrame } from '../shell/BookingFrame.tsx';
import { branchById } from '../shell/branches.ts';
import { bookingApi, type BookingApi } from './api.ts';
import { DoneError, DoneLoading, DoneNotFound, DoneView } from './DoneView.tsx';

type State = { kind: 'loading' } | { kind: 'ready'; data: BookingSummaryAnswer } | { kind: 'missing' } | { kind: 'error' };

export function DoneScreen({ bookingToken, api: given }: { bookingToken: string; api?: BookingApi }) {
  const api = useMemo(() => given ?? bookingApi(), [given]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const load = useCallback(() => {
    setState({ kind: 'loading' });
    void api.summary(bookingToken).then((r) => setState(r.ok ? { kind: 'ready', data: r.data } : r.status === 404 ? { kind: 'missing' } : { kind: 'error' }));
  }, [api, bookingToken]);
  useEffect(load, [load]);
  const branch = branchById(state.kind === 'ready' ? state.data.visit.branch : undefined);
  return (
    <BookingFrame screen="SCR-CUS-03" branch={branch}>
      {state.kind === 'ready' ? <DoneView data={state.data} branch={branch} /> : state.kind === 'missing' ? <DoneNotFound /> : state.kind === 'error' ? <DoneError retry={load} /> : <DoneLoading />}
    </BookingFrame>
  );
}
