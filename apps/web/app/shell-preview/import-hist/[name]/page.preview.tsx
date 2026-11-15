// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-15 and SCR-OFC-26 in each state its frame shows, for the look comparator (ci/look-values/import.pw.test.ts) and the page walkers.
// One route per screen, so each loads only its own frame's sheet. One fixed state per name. Never a release route.
import '../../../../src/shell/css/office.ts';
import { notFound } from 'next/navigation';
import { HistoryView, IDLE_HISTORY_UI, UndoDialog, type HistoryState } from '../../../../src/import/HistoryScreen.tsx';
import { DRY, MERGES, MERGES_TOTAL, runsReal, SETUP_DRY } from '../../../../src/import/preview-data.ts';
import { requestLang, serverT } from '../../../../src/shell/i18n-server.ts';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const FRAME = { me: MANAGER, clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false as const, bar: { alertCount: 2 } };
// The document title is the catalog's product name, as Screen renders it for a page without its own title.
const tile = (title: string, node: React.ReactNode) => (
  <div className="bw-screen">
    <title>{title}</title>
    <div className="r1-st">
      <div className="b flat">{node}</div>
    </div>
  </div>
);

export default async function ImportHistPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const t = serverT(await requestLang());
  const hist = (state: HistoryState, ui = IDLE_HISTORY_UI) => <HistoryView state={state} ui={ui} frame={FRAME} />;
  const histOk: HistoryState = { runs: { kind: 'ready', data: runsReal }, merges: { kind: 'ready', data: { items: MERGES, next: 'x', total: MERGES_TOTAL } }, dupCount: 428 };
  switch (name) {
    case 'hist-success':
      return hist(histOk);
    case 'hist-loading':
      return hist({ runs: { kind: 'loading' }, merges: { kind: 'loading' }, dupCount: 428 });
    case 'hist-nomatch':
      return hist({ ...histOk, merges: { kind: 'ready', data: { items: [], next: null, total: 0 } } }, { ...IDLE_HISTORY_UI, find: 'Hendricks' });
    case 'hist-error':
      return hist({ ...histOk, merges: { kind: 'error' } });
    case 'hist-running': {
      const a = { ...DRY, status: 'running' as const, finishedAt: null, counts: null };
      const b = { ...SETUP_DRY, status: 'failed' as const, counts: null };
      return hist({ ...histOk, runs: { kind: 'ready', data: { runs: [a, b], realRun: null } } });
    }
    case 'undo-asking':
      return tile(t('shell.app.doc'), <UndoDialog m={MERGES[1]!} ui={{ ...IDLE_HISTORY_UI, inline: true }} />);
    case 'undo-undoing':
      return tile(t('shell.app.doc'), <UndoDialog m={MERGES[1]!} ui={{ ...IDLE_HISTORY_UI, inline: true, undoing: true }} />);
    default:
      notFound();
  }
}
