// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-16 and SCR-OFC-28 in each state their frames show, with the frames' own data, for the harness build's preview routes
// (apps/web/app/shell-preview/health, alerts). Client components, because the views take handlers and a server page cannot pass a function
// (or read a constant of a client module). Never read by a release route.
import '../shell/css/office.ts';
import { AlertsPanelView, type PanelState } from '../shell/AlertsPanel.tsx';
import { OfficeFrame } from '../shell/Frames.tsx';
import { ToastView } from '../shell/Announcer.tsx';
import { useT } from '../shell/intl.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { HealthView, IDLE_UI, type HealthState, type HealthUi } from './HealthView.tsx';
import { BELL_ALERTS, BELL_NEW, DISMISSED_ALERT, DISMISS_ALERT, HEALTH_ALERTS, HEALTH_NO_BACKUP, HEALTH_SUCCESS, type ALERT_STATES, type HEALTH_STATES } from './preview-data.ts';

const FRAME = { me: MANAGER, clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false as const, bar: { alertCount: 2, currentPath: '/office/admin/health' } };
const ready = (data = HEALTH_SUCCESS): HealthState => ({ kind: 'ready', data });
const SIM_ALL = { mode: 'all_fail' as const, customerId: null, customerName: null, nLeft: null, setBy: 'Dana R.', setAt: '2026-09-15T10:32:00-04:00[America/New_York]' };

export function HealthPreview({ name }: { name: (typeof HEALTH_STATES)[number] }) {
  const t = useT();
  const view = (state: HealthState, ui: Partial<HealthUi> = {}) => <HealthView state={state} ui={{ ...IDLE_UI, ...ui }} on={{}} frame={FRAME} />;
  switch (name) {
    case 'loading':
      return view({ kind: 'loading' });
    case 'error':
      return view({ kind: 'error' });
    case 'no-backup':
      return view(ready(HEALTH_NO_BACKUP));
    case 'checking':
      return view(ready(), { checking: true });
    case 'applying':
      return view(ready(), { applying: true, pick: { mode: 'all_fail', customerId: null, n: '' } });
    case 'applied':
      return view(ready({ ...HEALTH_SUCCESS, textSimulator: SIM_ALL }), { pick: { mode: 'all_fail', customerId: null, n: '' }, toast: t('health.sim.applied', { mode: t('health.sim.mode.all_fail') }) });
    case 'email-opened':
      return view(ready({ ...HEALTH_SUCCESS, alerts: [{ ...HEALTH_ALERTS[0]!, type: 'restore_test_failed', messageKey: 'alert.restore_test_failed', messageValues: {}, emailWaiting: false, emailOpened: true }, ...HEALTH_ALERTS.slice(1)] }));
    case 'new-alert':
      return view(ready({ ...HEALTH_SUCCESS, alerts: [{ ...BELL_NEW, id: 'a-new' }, ...HEALTH_ALERTS] }));
    case 'dismiss':
      return view(ready({ ...HEALTH_SUCCESS, alerts: [DISMISS_ALERT, ...HEALTH_ALERTS] }));
    case 'dismissed':
      return view(ready({ ...HEALTH_SUCCESS, alerts: [DISMISSED_ALERT, ...HEALTH_ALERTS] }), { toast: t('health.alerts.dismissed') });
    case 'n-field':
      return view(ready(), { pick: { mode: 'fail_next_n', customerId: null, n: '25' }, fieldMsg: 'n' });
    case 'table':
      return view(ready(), { delayAsTable: true });
    default:
      return view(ready());
  }
}

/** The bell's panel alone, in its host page's chrome (the frame draws only the panel in its tile). */
export function AlertsPreview({ name }: { name: (typeof ALERT_STATES)[number] }) {
  const t = useT();
  const state: PanelState =
    name === 'loading' ? { kind: 'loading' }
    : name === 'empty' ? { kind: 'ready', alerts: [] }
    : name === 'dismiss' ? { kind: 'ready', alerts: [DISMISS_ALERT] }
    : name === 'dismissed' ? { kind: 'ready', alerts: [DISMISSED_ALERT, BELL_ALERTS[1]!] }
    : name === 'new' ? { kind: 'ready', alerts: [BELL_NEW, ...BELL_ALERTS], fresh: BELL_NEW.id }
    : { kind: 'ready', alerts: BELL_ALERTS };
  return (
    <OfficeFrame screen="SCR-OFC-28" {...FRAME} bar={{ alertCount: name === 'new' ? 3 : name === 'empty' ? 0 : 2, currentPath: '/office/board' }}>
      <div className="bw-alerts-tile">
        <AlertsPanelView state={state} manager inline />
        {name === 'dismissed' ? <div className="bw-alerts-toast"><ToastView text={t('health.alerts.dismissed')} /></div> : null}
      </div>
    </OfficeFrame>
  );
}
