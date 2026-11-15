// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-CUS-03 You're booked in each state DK-121 draws (src/booking/BookingPreview.tsx), for the look
// comparator (ci/look-values/booking.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { DonePreview } from '../../../../src/booking/DonePreview.tsx';
import { DONE_PREVIEW_STATES, type DonePreviewState } from '../../../../src/booking/preview-data.ts';

export const dynamic = 'force-dynamic';

export default async function DoneStatePreview({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  if (!(DONE_PREVIEW_STATES as readonly string[]).includes(state)) notFound();
  return (
    <Suspense>
      <DonePreview state={state as DonePreviewState} />
    </Suspense>
  );
}
