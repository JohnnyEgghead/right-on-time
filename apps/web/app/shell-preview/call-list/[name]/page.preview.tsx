// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-09 in each state its frame shows (mockups/pages/office-call-list.html), for the look comparator
// (ci/look-values/messages.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { CallListPreview } from '../../../../src/messages/call-previews.tsx';
import { CALL_STATES } from '../../../../src/messages/preview-states.ts';

export const dynamic = 'force-dynamic';

export default async function CallListPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = CALL_STATES.find((s) => s === name);
  if (!state) notFound();
  return <CallListPreview name={state} />;
}
