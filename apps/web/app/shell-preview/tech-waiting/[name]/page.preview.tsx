// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-09 (DK-111) on fixed data, for the look comparator and the page walkers. Never a release route.
import '../../../../styles/app/tech.css';
import { notFound } from 'next/navigation';
import { WAITING_PREVIEWS } from '../../../../src/tech/preview-names.ts';
import { WaitingPreview } from '../../../../src/tech/job/WaitingPreview.tsx';

export const dynamic = 'force-dynamic';

export default async function Preview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = WAITING_PREVIEWS.find((s) => s === name);
  if (!state) notFound();
  return <WaitingPreview name={state} />;
}
