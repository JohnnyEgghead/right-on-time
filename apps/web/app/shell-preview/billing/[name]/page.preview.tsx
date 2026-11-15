// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-10 and SCR-OFC-47 in each state their frame shows (mockups/pages/office-billing.html), for
// the look comparator (ci/look-values/billing.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { BillingPreview } from '../../../../src/billing/previews.tsx';
import { BILLING_STATES } from '../../../../src/billing/preview-states.ts';

export const dynamic = 'force-dynamic';

export default async function BillingPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = BILLING_STATES.find((s) => s === name);
  if (!state) notFound();
  return <BillingPreview name={state} />;
}
