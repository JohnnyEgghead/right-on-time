// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-CUS-05 in each state its frame shows (mockups/pages/customer-live-map-ended.html) and the Visit changed
// state, for the look comparator (ci/look-values/livemap.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { EndedView } from '../../../../src/livemap/LiveMapView.tsx';
import { ENDED_PREVIEWS } from '../../../../src/livemap/preview-data.ts';

export const dynamic = 'force-dynamic';

export default async function LiveMapEndedPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const p = ENDED_PREVIEWS[name];
  if (!p) notFound();
  return <EndedView detail={p.detail} fixed={p.fixed} />;
}
