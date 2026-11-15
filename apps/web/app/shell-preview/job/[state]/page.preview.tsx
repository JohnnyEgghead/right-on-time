// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-03 and its 7 dialogs in each state DK-87 draws (src/job/JobPreview.tsx), for the
// look comparator (ci/look-values/job.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { JobPreview } from '../../../../src/job/JobPreview.tsx';
import { JOB_PREVIEW_STATES, type JobPreviewState } from '../../../../src/job/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

// `solo-<state>`: a dialog alone in a frame named for it (the page walkers' dialog rows).
export default async function JobStatePreview({ params }: { params: Promise<{ state: string }> }) {
  const { state: asked } = await params;
  const solo = asked.startsWith('solo-');
  const state = solo ? asked.slice(5) : asked;
  if (!(JOB_PREVIEW_STATES as readonly string[]).includes(state)) notFound();
  return (
    <Suspense>
      <JobPreview state={state as JobPreviewState} solo={solo} />
    </Suspense>
  );
}
