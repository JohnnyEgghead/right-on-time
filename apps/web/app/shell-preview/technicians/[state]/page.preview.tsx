// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-07, -41 and -42 in each state DK-92 draws (src/technicians/TechniciansPreview.tsx), for the look comparator
// (ci/look-values/technicians.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { TECH_PREVIEW_STATES, type TechPreviewState } from '../../../../src/technicians/tech-fixtures.ts';
import { TechniciansPreview } from '../../../../src/technicians/TechniciansPreview.tsx';

export const dynamic = 'force-dynamic';

// `solo-<state>`: a dialog alone in a frame named for it (the page walkers' dialog rows).
export default async function TechniciansStatePreview({ params }: { params: Promise<{ state: string }> }) {
  const { state: asked } = await params;
  const solo = asked.startsWith('solo-');
  const state = solo ? asked.slice(5) : asked;
  if (!(TECH_PREVIEW_STATES as readonly string[]).includes(state)) notFound();
  return (
    <Suspense>
      <TechniciansPreview state={state as TechPreviewState} solo={solo} />
    </Suspense>
  );
}
