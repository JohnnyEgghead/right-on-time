// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-08 in each state its frame shows (mockups/pages/office-messages.html), for the look comparator
// (ci/look-values/messages.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { MessagesPreview } from '../../../../src/messages/previews.tsx';
import { LOG_STATES } from '../../../../src/messages/preview-states.ts';

export const dynamic = 'force-dynamic';

export default async function MessagesPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = LOG_STATES.find((s) => s === name);
  if (!state) notFound();
  return <MessagesPreview name={state} />;
}
