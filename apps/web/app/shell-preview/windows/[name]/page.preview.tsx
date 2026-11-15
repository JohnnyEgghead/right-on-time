// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-12 and its dialog SCR-OFC-24 in each state their frame shows (mockups/pages/admin-windows.html), for
// the look comparator (ci/look-values/windows.pw.test.ts) and the page walkers. One fixed state per name. Never a release route.
import '../../../../src/shell/css/office.ts';
import { notFound } from 'next/navigation';
import { requestLang, serverT } from '../../../../src/shell/i18n-server.ts';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../../../../src/shell/preview-fixtures.ts';
import { draftOf } from '../../../../src/windows/model.ts';
import { SETTINGS, THURSDAY_FOUR, WINDOWS_STATES } from '../../../../src/windows/preview-data.ts';
import { IDLE_UI, PickedBody, SwitchDialog, WindowsView, type DialogUi, type WindowsState, type WindowsUi } from '../../../../src/windows/WindowsView.tsx';

export const dynamic = 'force-dynamic';

const FRAME = { me: MANAGER, clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false as const, bar: { alertCount: 2, currentPath: '/office/admin/windows' } };
const ready = (data = SETTINGS): WindowsState => ({ kind: 'ready', data });
const WED = '2026-09-16';
const THU = '2026-09-17';
const LAST = SETTINGS.windows[4]!.windowId;

// The states board draws a part of the screen in a tile body (DK-64 .r1-st .b); the app draws the same part in the same wrapper.
const tile = (title: string, node: React.ReactNode) => (
  <div className="bw-screen">
    <title>{title}</title>
    <div className="r1-st">
      <div className="b flat">{node}</div>
    </div>
  </div>
);

export default async function WindowsPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const state = WINDOWS_STATES.find((s) => s === name);
  if (!state) notFound();
  const lang = await requestLang();
  const t = serverT(lang);
  const base: WindowsUi = { ...IDLE_UI, draft: draftOf(SETTINGS.windows), picked: WED };
  const changed = { ...base.draft, [LAST]: '9' };
  const view = (s: WindowsState, ui: Partial<WindowsUi> = {}, data = SETTINGS) => (
    <WindowsView state={s} ui={{ ...base, draft: draftOf(data.windows), ...ui }} on={{}} branch="columbus" frame={FRAME} />
  );
  const dlg = (d: Partial<DialogUi>): DialogUi => ({ mode: 'four_hour', date: THU, reason: '', touched: false, switching: false, message: null, ...d });
  switch (state) {
    case 'success':
      return view(ready());
    case 'loading':
      return view({ kind: 'loading' });
    case 'error':
      return view({ kind: 'error' });
    case 'changed':
      return view(ready(), { draft: changed });
    case 'saving':
      return view(ready(), { draft: changed, saving: true });
    case 'refused':
      return view(ready(), { draft: { ...base.draft, [LAST]: '8' }, refused: { windowId: LAST, text: t('windows.refused', { branch: 'Columbus', window: '4-6 PM', bookings: 10, day: 'Wed, Sep 16' }) } });
    case 'switched':
      return view(ready(THURSDAY_FOUR), { picked: THU, toast: t('windows.toast.four', { day: 'Thu, Sep 17' }) }, THURSDAY_FOUR);
    case 'day-picked':
      return view(ready(), { picked: THU });
    case 'saturday':
      return view(ready(), { picked: '2026-09-19' });
    case 'dlg-asking':
      return tile(t('shell.app.doc'), (
        <>
          <div className="bw-tile-pad"><PickedBody data={SETTINGS} ui={{ ...base, picked: THU, dialog: dlg({}) }} on={{}} /></div>
          <SwitchDialog data={SETTINGS} dlg={dlg({})} on={{}} inline />
        </>
      ));
    case 'dlg-switching':
      return tile(t('shell.app.doc'), <SwitchDialog data={SETTINGS} dlg={dlg({ reason: 'Heat advisory', switching: true })} on={{}} inline />);
    case 'dlg-done':
      return tile(t('shell.app.doc'), <PickedBody data={THURSDAY_FOUR} ui={{ ...base, picked: THU }} on={{}} />);
    default:
      notFound();
  }
}
