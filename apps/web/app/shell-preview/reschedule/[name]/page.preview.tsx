// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-CUS-06 in each state its frame shows (mockups/pages/customer-reschedule.html), for the look
// comparator (ci/look-values/inbox.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { RESCHEDULE_STATES } from '../../../../src/inbox/preview-data.ts';
import { ReschedulePreview } from '../../../../src/inbox/previews.tsx';

export const dynamic = 'force-dynamic';

export default async function ReschedulePreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = RESCHEDULE_STATES.find((s) => s === name);
  if (!state) notFound();
  return <ReschedulePreview name={state} />;
}
