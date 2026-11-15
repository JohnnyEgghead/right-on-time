// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-PBS-01 in each state its frame shows (mockups/pages/r1-pbs-a-list.html, option A), for the
// look comparator (ci/look-values/billing.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { PbsListPreview } from '../../../../src/billing/pbs-previews.tsx';
import { PBS_LIST_STATES } from '../../../../src/billing/preview-states.ts';

export const dynamic = 'force-dynamic';

export default async function PbsListPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = PBS_LIST_STATES.find((s) => s === name);
  if (!state) notFound();
  return <PbsListPreview name={state} />;
}
