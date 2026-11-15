// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-17 and SCR-OFC-27 in each state its frame shows, for the look comparator (ci/look-values/clock.pw.test.ts) and the page walkers.
// One fixed state per name. Never a release route.
import '../../../../src/shell/css/office.ts';
import { fromWire } from '@bw/time';
import { notFound } from 'next/navigation';
import { ClockView, ResetDialog } from '../../../../src/clock/ClockScreen.tsx';
import { RESET_TARGET, shortWhen } from '../../../../src/clock/model.ts';
import { CATCHING_UP, COOLDOWN, JUMPED, PAUSED, presetsAt, RUNNING } from '../../../../src/clock/preview-data.ts';
import { IDLE_UI, type ClockState } from '../../../../src/clock/state.ts';
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

export default async function ClockPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const lang = await requestLang();
  const t = serverT(lang);
  const resetWhen = shortWhen(fromWire(RESET_TARGET).toInstant(), 'America/New_York', lang, t);
  const ready = (clock = RUNNING, presets = presetsAt()): ClockState => ({ clock: { kind: 'ready', data: clock }, presets: { kind: 'ready', data: presets } });
  const view = (state: ClockState, ui = IDLE_UI, left = 0) => <ClockView state={state} ui={ui} left={left} frame={FRAME} />;
  switch (name) {
    case 'running':
      return view(ready());
    case 'loading':
      return view({ clock: { kind: 'loading' }, presets: { kind: 'loading' } });
    case 'error':
      return view({ clock: { kind: 'error' }, presets: { kind: 'error' } });
    case 'paused':
      return view(ready(PAUSED));
    case 'catching-up':
      return view(ready(CATCHING_UP));
    case 'cooldown':
      return view(ready(COOLDOWN), IDLE_UI, 240);
    case 'refused':
      return view(ready(), { ...IDLE_UI, time: '09:00', refused: { place: 'jump', text: t('admin.clock.err.notForward') } });
    case 'preset-off':
      return view(ready(JUMPED, presetsAt((id) => id !== 'reminder_6pm')));
    case 'done':
      return view(ready({ ...COOLDOWN, resetAvailableInSeconds: 300 }), { ...IDLE_UI, resetTo: RESET_TARGET }, 300);
    case 'dlg-asking':
      return tile(t('shell.app.doc'), <ResetDialog ui={{ ...IDLE_UI, inline: true }} resetWhen={resetWhen} />);
    case 'dlg-resetting':
      return tile(t('shell.app.doc'), <ResetDialog ui={{ ...IDLE_UI, inline: true, resetting: true }} resetWhen={resetWhen} />);
    default:
      notFound();
  }
}
