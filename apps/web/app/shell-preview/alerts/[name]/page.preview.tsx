// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-28 in each state its frame shows (mockups/pages/office-board.html, "Office alerts"), for the look
// comparator (ci/look-values/health.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { ALERT_STATES } from '../../../../src/health/preview-data.ts';
import { AlertsPreview } from '../../../../src/health/previews.tsx';

export const dynamic = 'force-dynamic';

export default async function AlertsPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = ALERT_STATES.find((s) => s === name);
  if (!state) notFound();
  return <AlertsPreview name={state} />;
}
