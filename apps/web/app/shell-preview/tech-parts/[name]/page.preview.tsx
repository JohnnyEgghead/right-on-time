// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-16 in each state its frames show (mockups/pages/r1-techweb-parts.html), for the look comparator
// (ci/look-values/tech-map.pw.test.ts) and the page walkers. Never a release route; every state is fixed and no read is made.
import { notFound } from 'next/navigation';
import { PARTS_PREVIEWS } from '../../../../src/tech/preview-day.ts';
import { TechPartsScreen } from '../../../../src/tech/TechPartsScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function TechPartsPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const p = PARTS_PREVIEWS[name];
  if (!p) notFound();
  return <TechPartsScreen fixedData={p.data} fixedOutbox={p.outbox} fixedQuery={p.query} />;
}
