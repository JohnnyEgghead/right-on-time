// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-CUS-04 in each state its frame shows (mockups/pages/customer-live-map.html), for the look comparator
// (ci/look-values/livemap.pw.test.ts) and the page walkers. Never a release route; every state is fixed and no read is made.
import { notFound } from 'next/navigation';
import { LiveMapView } from '../../../../src/livemap/LiveMapView.tsx';
import { LIVE_PREVIEWS } from '../../../../src/livemap/preview-data.ts';

export const dynamic = 'force-dynamic';

export default async function LiveMapPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const p = LIVE_PREVIEWS[name];
  if (!p) notFound();
  return <LiveMapView state={p.state} fixed={p.fixed} officePhone={p.officePhone ?? null} />;
}
