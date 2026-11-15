// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-10 in each state its frames show (mockups/pages/tech-me.html), for the look comparator
// (ci/look-values/tech-map.pw.test.ts) and the page walkers. Never a release route; every state is fixed and no read is made.
import { notFound } from 'next/navigation';
import { ME_PREVIEWS } from '../../../../src/tech/preview-day.ts';
import { TechMeScreen } from '../../../../src/tech/TechMeScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function TechMePreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const p = ME_PREVIEWS[name];
  if (!p) notFound();
  return <TechMeScreen fixedData={p.data} fixedOutbox={p.outbox} {...(p.phase ? { fixedPhase: p.phase } : {})} {...(p.sizeOpen ? { fixedSizeOpen: true } : {})} />;
}
