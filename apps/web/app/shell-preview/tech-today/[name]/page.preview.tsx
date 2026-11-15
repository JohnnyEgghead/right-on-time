// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-02 Today and the confirm sheets SCR-TEC-03, -13 and -14 on the states their frames show
// (DK-107 to DK-109), fixed, for the look comparator (ci/look-values/tech-today.pw.test.ts) and the page walkers. Never a release route.
import { notFound } from 'next/navigation';
import { TODAY_PREVIEWS } from '../../../../src/tech/today/preview-data.ts';
import { TodayPreview } from '../../../../src/tech/today/TodayPreview.tsx';

export const dynamic = 'force-dynamic';

export default async function TechTodayPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = TODAY_PREVIEWS.find((s) => s === name);
  if (!state) notFound();
  return <TodayPreview name={state} />;
}
