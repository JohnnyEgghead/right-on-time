// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-11 in each state its frame shows (mockups/pages/office-reports.html), for the look comparator
// (ci/look-values/reports.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { REPORTS_STATES } from '../../../../src/reports/preview-data.ts';
import { ReportsPreview } from '../../../../src/reports/previews.tsx';

export const dynamic = 'force-dynamic';

export default async function ReportsPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = REPORTS_STATES.find((s) => s === name);
  if (!state) notFound();
  return <ReportsPreview name={state} />;
}
