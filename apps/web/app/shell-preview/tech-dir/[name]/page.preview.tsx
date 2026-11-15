// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-08 in each state its frames show (mockups/pages/tech-map.html, Directions), for the look comparator
// (ci/look-values/tech-map.pw.test.ts) and the page walkers. Never a release route; every state is fixed and no read is made.
import { notFound } from 'next/navigation';
import { DIR_PREVIEWS } from '../../../../src/tech/preview-day.ts';
import { TechDirectionsScreen } from '../../../../src/tech/TechDirectionsScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function TechDirectionsPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const p = DIR_PREVIEWS[name];
  if (!p) notFound();
  return <TechDirectionsScreen jobNumber={p.job} fixedData={p.data} fixedOutbox={p.outbox} fixedRoute={p.read} fixedUpdated={p.updated ?? false} />;
}
