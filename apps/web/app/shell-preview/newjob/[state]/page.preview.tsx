// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-04 New job in each state DK-89 draws (src/newjob/NewJobPreview.tsx), for the look
// comparator (ci/look-values/newjob.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { NewJobPreview } from '../../../../src/newjob/NewJobPreview.tsx';
import { NEWJOB_PREVIEW_STATES, type NewJobPreviewState } from '../../../../src/newjob/preview-data.ts';

export const dynamic = 'force-dynamic';

export default async function NewJobStatePreview({ params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  if (!(NEWJOB_PREVIEW_STATES as readonly string[]).includes(state)) notFound();
  return (
    <Suspense>
      <NewJobPreview state={state as NewJobPreviewState} />
    </Suspense>
  );
}
