// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-04 and SCR-TEC-06 (DK-110) on fixed data, for the look comparator and the page walkers. Never a release route.
import '../../../../styles/app/tech.css';
import { notFound } from 'next/navigation';
import { JOB_PREVIEWS } from '../../../../src/tech/preview-names.ts';
import { JobPreview } from '../../../../src/tech/job/JobPreview.tsx';

export const dynamic = 'force-dynamic';

export default async function Preview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = JOB_PREVIEWS.find((s) => s === name);
  if (!state) notFound();
  return <JobPreview name={state} />;
}
