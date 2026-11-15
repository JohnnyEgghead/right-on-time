// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): CMP-10 Sync strip in each state its frames show (DK-111 mockups/pages/tech-offline.html,
// and DK-107's No signal card), on fixed engine states, for the look comparator (ci/look-values/tech-shell.pw.test.ts). Never a release route.
import '../../../../styles/app/tech.css';
import { notFound } from 'next/navigation';
import { SYNC_PREVIEWS } from '../../../../src/tech/preview-names.ts';
import { SyncPreview } from '../../../../src/tech/SyncPreview.tsx';

export const dynamic = 'force-dynamic';

export default async function TechSyncPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = SYNC_PREVIEWS.find((s) => s === name);
  if (!state) notFound();
  return <SyncPreview name={state} />;
}
