// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): each shared office component in the state its kit frame shows, with the frame's
// data, for the look comparator (ci/look-values/shell.pw.test.ts). Never a release route. It loads the office kit set,
// as its frames do; the shared pages have their own route (../../shared) with theirs.
import '../../../../src/shell/css/office.ts';
import { notFound } from 'next/navigation';
import { ToastView } from '../../../../src/shell/Announcer.tsx';
import { CallButton } from '../../../../src/shell/CallButton.tsx';
import { DemoStrip } from '../../../../src/shell/DemoStrip.tsx';
import { AdminFrame, OfficeFrame } from '../../../../src/shell/Frames.tsx';
import { requestLang, serverT } from '../../../../src/shell/i18n-server.ts';
import { OfficeTopBar } from '../../../../src/shell/OfficeTopBar.tsx';
import { LiveIndicator } from '../../../../src/shell/Panels.tsx';
import {
  APP_INFO, CALL, CLOCK_AFTER_RESET, CLOCK_CATCHING_UP, CLOCK_MOVED, CLOCK_PAUSED, CLOCK_RUNNING, MANAGER, RESET_TO, SEARCH_JENK, TOAST_MOVED,
} from '../../../../src/shell/preview-fixtures.ts';
import { Screen } from '../../../../src/shell/Surface.tsx';
import { RetryLater } from './retry.tsx';

export const dynamic = 'force-dynamic';

export default async function FramePreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const t = serverT(await requestLang());
  switch (name) {
    case 'admin-clock':
      // r1-admin-clock main screen: CMP-01 with Change, CMP-07 with Admin current, CMP-08 with Demo clock current, CMP-04.
      return (
        <AdminFrame
          screen="CMP-08"
          me={MANAGER}
          clock={CLOCK_RUNNING}
          appInfo={APP_INFO}
          reader={false}
          currentPath="/office/admin/clock"
          bar={{ alertCount: 2, currentPath: '/office/admin/clock' }}
        />
      );
    case 'office-board':
      // office-board main screen: CMP-07 with Board current.
      return <OfficeFrame screen="CMP-07" me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false} bar={{ alertCount: 2, currentPath: '/office/board' }} />;
    case 'topbar-states':
      // office-board tiles CMP-07 More menu, Search results, User menu with Press / to search: the bar in each state.
      return (
        <Screen screen="CMP-07" surface="SURF-OFC" noClock footer={false}>
          <div data-state="more">
            <OfficeTopBar me={MANAGER} alertCount={2} currentPath="/office/board" initialMenu="more" />
          </div>
          <div data-state="search">
            <OfficeTopBar me={MANAGER} alertCount={2} currentPath="/office/board" initialSearch={SEARCH_JENK} />
          </div>
          <div data-state="user">
            <OfficeTopBar me={MANAGER} alertCount={2} currentPath="/office/board" initialMenu="user" />
          </div>
        </Screen>
      );
    case 'clock-states':
      // r1-admin-clock tiles: CMP-01 Paused, CMP-02 Last move, Catching up, World reset notice.
      return (
        <Screen screen="CMP-02" surface="SURF-OFC" noClock footer={false}>
          <div data-state="paused">
            <DemoStrip initial={CLOCK_PAUSED} changeHref="/office/admin/clock" reader={false} />
          </div>
          <div data-state="moved">
            <DemoStrip initial={CLOCK_MOVED} changeHref="/office/admin/clock" reader={false} />
          </div>
          <div data-state="catching-up">
            <DemoStrip initial={CLOCK_CATCHING_UP} changeHref="/office/admin/clock" reader={false} />
          </div>
          <div data-state="reset">
            <DemoStrip initial={CLOCK_AFTER_RESET} resetTo={RESET_TO} changeHref="/office/admin/clock" reader={false} />
          </div>
        </Screen>
      );
    case 'components':
      // office-board tiles CMP-11, CMP-13 (3 states), CMP-16 (on a computer, number shown); r1-admin-history CMP-12.
      return (
        <Screen screen="CMP-13" surface="SURF-OFC" noClock footer={false}>
          <div data-state="toast">
            <ToastView text={t('board.toast.moved', TOAST_MOVED)} />
          </div>
          <div data-state="live">
            <LiveIndicator state="live" />
          </div>
          <div data-state="reconnecting">
            <LiveIndicator state="reconnecting" />
          </div>
          <div data-state="paused">
            <LiveIndicator state="paused" />
          </div>
          <div data-state="call">
            <CallButton name={CALL.name} fullName={CALL.fullName} number={CALL.number} initialShown />
          </div>
          <div data-state="error">
            <RetryLater title={t('admin.history.mergesFailed')} hint={t('shell.error.checkConnection')} />
          </div>
        </Screen>
      );
    default:
      notFound();
  }
}
