// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-CUS-02 Window just taken in each state DK-120 draws (src/booking/BookingPreview.tsx), for the look
// comparator (ci/look-values/booking.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { TakenPreview } from '../../../../src/booking/BookingPreview.tsx';
import { TAKEN_PREVIEW_STATES, type TakenPreviewState } from '../../../../src/booking/preview-data.ts';

export const dynamic = 'force-dynamic';

export default async function TakenStatePreview({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  if (!(TAKEN_PREVIEW_STATES as readonly string[]).includes(state)) notFound();
  return (
    <Suspense>
      <TakenPreview state={state as TakenPreviewState} />
    </Suspense>
  );
}
