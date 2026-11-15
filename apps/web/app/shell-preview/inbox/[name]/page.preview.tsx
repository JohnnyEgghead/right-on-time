// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-INB-01 in each state its frames show (mockups/pages/customer-texts*.html), for the look
// comparator (ci/look-values/inbox.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { INBOX_STATES } from '../../../../src/inbox/preview-data.ts';
import { InboxPreview } from '../../../../src/inbox/previews.tsx';

export const dynamic = 'force-dynamic';

export default async function InboxPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = INBOX_STATES.find((s) => s === name);
  if (!state) notFound();
  return <InboxPreview name={state} />;
}
