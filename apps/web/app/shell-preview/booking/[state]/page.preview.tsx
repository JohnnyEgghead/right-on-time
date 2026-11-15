// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-CUS-01 Book a visit in each state DK-118 and DK-119 draw (src/booking/BookingPreview.tsx), for the look
// comparator (ci/look-values/booking.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { BookingPreview } from '../../../../src/booking/BookingPreview.tsx';
import { BOOKING_PREVIEW_STATES, type BookingPreviewState } from '../../../../src/booking/preview-data.ts';

export const dynamic = 'force-dynamic';

export default async function BookingStatePreview({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  if (!(BOOKING_PREVIEW_STATES as readonly string[]).includes(state)) notFound();
  return (
    <Suspense>
      <BookingPreview state={state as BookingPreviewState} />
    </Suspense>
  );
}
