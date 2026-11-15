// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-15 in each state its frame shows (mockups/pages/tech-map.html), for the look comparator
// (ci/look-values/tech-map.pw.test.ts) and the page walkers. Never a release route; every state is fixed and no read is made.
import { notFound } from 'next/navigation';
import { MAP_PREVIEWS } from '../../../../src/tech/preview-day.ts';
import { TechMapScreen } from '../../../../src/tech/TechMapScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function TechMapPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const p = MAP_PREVIEWS[name];
  if (!p) notFound();
  return <TechMapScreen fixedData={p.data} fixedOutbox={p.outbox} />;
}
