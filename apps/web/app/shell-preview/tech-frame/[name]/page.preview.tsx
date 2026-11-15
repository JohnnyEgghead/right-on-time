// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): the web technician app's shell (CMP-09 tab bar and the Today header with CMP-10's
// waiting count, DK-107 mockups/pages/tech-today.html) on fixed engine states, for the look comparator
// (ci/look-values/tech-shell.pw.test.ts). Never a release route.
import { notFound } from 'next/navigation';
import { FRAME_PREVIEWS } from '../../../../src/tech/preview-names.ts';
import { FramePreview } from '../../../../src/tech/FramePreview.tsx';

export const dynamic = 'force-dynamic';

export default async function TechFramePreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = FRAME_PREVIEWS.find((s) => s === name);
  if (!state) notFound();
  return <FramePreview name={state} />;
}
