// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-16 in each state its frame shows (mockups/pages/admin-health.html), for the look comparator
// (ci/look-values/health.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { HEALTH_STATES } from '../../../../src/health/preview-data.ts';
import { HealthPreview } from '../../../../src/health/previews.tsx';

export const dynamic = 'force-dynamic';

export default async function HealthPreviewPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = HEALTH_STATES.find((s) => s === name);
  if (!state) notFound();
  return <HealthPreview name={state} />;
}
