// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-14 in each state its frame shows, for the look comparator (ci/look-values/import.pw.test.ts) and the page walkers.
// One route per screen, so each loads only its own frame's sheet. One fixed state per name. Never a release route.
import '../../../../src/shell/css/office.ts';
import { notFound } from 'next/navigation';
import { DuplicatesView, IDLE_DUPS_UI } from '../../../../src/import/DuplicatesScreen.tsx';
import { dupsData, dupsSpanishData } from '../../../../src/import/preview-data.ts';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const FRAME = { me: MANAGER, clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false as const, bar: { alertCount: 2 } };

export default async function ImportDupsPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const dups = (state: Parameters<typeof DuplicatesView>[0]['state'], ui = IDLE_DUPS_UI) => <DuplicatesView state={state} ui={ui} frame={FRAME} />;
  switch (name) {
    case 'dups-success':
      return dups({ kind: 'ready', data: dupsData() });
    case 'dups-spanish':
      return dups({ kind: 'ready', data: dupsSpanishData() });
    case 'dups-loading':
      return dups({ kind: 'loading' });
    case 'dups-done':
      return dups({ kind: 'ready', data: dupsData({ progress: { listed: 428, checked: 428, left: 0, merged: 300, keptSeparate: 124, skipped: 0 }, pairs: [], next: null, index: 0 }) });
    case 'dups-deciding':
      return dups({ kind: 'ready', data: dupsData() }, { ...IDLE_DUPS_UI, deciding: 'merge' });
    case 'dups-error':
      return dups({ kind: 'error' });
    default:
      notFound();
  }
}
