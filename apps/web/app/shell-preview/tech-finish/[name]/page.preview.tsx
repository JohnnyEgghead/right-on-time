// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-07 (DK-112) on fixed data, for the look comparator and the page walkers. Never a release route.
import '../../../../styles/app/tech.css';
import { notFound } from 'next/navigation';
import { FINISH_PREVIEWS } from '../../../../src/tech/preview-names.ts';
import { FinishPreview } from '../../../../src/tech/job/FinishPreview.tsx';

export const dynamic = 'force-dynamic';

export default async function Preview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = FINISH_PREVIEWS.find((s) => s === name);
  if (!state) notFound();
  return <FinishPreview name={state} />;
}
