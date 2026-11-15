// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-13 and SCR-OFC-25 in each state its frame shows, for the look comparator (ci/look-values/import.pw.test.ts) and the page walkers.
// One route per screen, so each loads only its own frame's sheet. One fixed state per name. Never a release route.
import '../../../../src/shell/css/office.ts';
import { notFound } from 'next/navigation';
import { DryRunView, IDLE_UI, RunDialog, type DryRunState } from '../../../../src/import/DryRunScreen.tsx';
import { dryData, DRY, REAL, runsNone, runsReal } from '../../../../src/import/preview-data.ts';
import type { RunAnswer } from '../../../../src/import/model.ts';
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

export default async function ImportDryPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const lang = await requestLang();
  const t = serverT(lang);
  const words = (r: string) => t(`admin.import.words.${r}` as never);
  const ready = (over = {}): DryRunState => ({ kind: 'ready', data: dryData(words, over, lang) });
  const running = (kind: 'dry_run' | 'real', percent: number, stage: RunAnswer['stage']): DryRunState => {
    const run: RunAnswer = { kind, status: 'running', stage, percent, report: null, failure: null };
    const summary = { ...(kind === 'real' ? REAL : DRY), status: 'running' as const, finishedAt: null, counts: null };
    return { kind: 'ready', data: { runs: { runs: [summary], realRun: null }, run, shown: summary, dupCount: 428 } };
  };
  const dry = (state: DryRunState, ui = IDLE_UI) => <DryRunView state={state} ui={ui} frame={FRAME} />;
  switch (name) {
    case 'dry-report':
      return dry(ready());
    case 'dry-report-realdone':
      return dry(ready({ runs: runsReal }));
    case 'dry-loading':
      return dry({ kind: 'loading' });
    case 'dry-none':
      return dry(ready({ runs: runsNone, run: null, shown: null }));
    case 'dry-running':
      return dry(running('dry_run', 62, 'validate'));
    case 'dry-failed': {
      const failed = { ...DRY, status: 'failed' as const, counts: null };
      return dry(ready({ runs: { runs: [failed], realRun: null }, shown: failed, run: { kind: 'dry_run', status: 'failed', stage: 'parse', percent: 41, report: null, failure: 'attempts_exhausted' } }));
    }
    case 'dry-error':
      return dry({ kind: 'error' });
    case 'dlg-asking':
      return tile(t('shell.app.doc'), <RunDialog data={dryData(words, {}, lang)} ui={{ ...IDLE_UI, dialog: 'asking', inline: true }} />);
    case 'dlg-starting':
      return tile(t('shell.app.doc'), <RunDialog data={dryData(words, {}, lang)} ui={{ ...IDLE_UI, dialog: 'starting', inline: true }} />);
    default:
      notFound();
  }
}
void runsReal;
void runsNone;
