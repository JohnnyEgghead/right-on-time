// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-11 in each state its frame shows (mockups/pages/office-reports.html), with the frame's own data, for the harness build's preview
// route (apps/web/app/shell-preview/reports) and the look comparator (ci/look-values/reports.pw.test.ts). A client component, because the view
// takes handlers and a server page cannot pass a function. Never read by a release route.
import '../shell/css/office.ts';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { NO_FILTERS, type Filters } from './model.ts';
import { REPORTS_EMPTY, REPORTS_SUCCESS, type REPORTS_STATES } from './preview-data.ts';
import { IDLE_UI, ReportsView, type ReportsState, type ReportsUi } from './ReportsView.tsx';

const FRAME = { me: MANAGER, clock: CLOCK_RUNNING, appInfo: APP_INFO, reader: false as const, bar: { alertCount: 2, currentPath: '/office/reports' } };
const TIP = 'Columbus, week of Aug 24: 89.9%';

export function ReportsPreview({ name }: { name: (typeof REPORTS_STATES)[number] }) {
  const view = (state: ReportsState, ui: Partial<ReportsUi> = {}, filters: Filters = NO_FILTERS) => (
    <ReportsView state={state} filters={filters} ui={{ ...IDLE_UI, ...ui }} on={{}} frame={FRAME} />
  );
  const ready: ReportsState = { kind: 'ready', data: REPORTS_SUCCESS };
  switch (name) {
    case 'loading':
      return view({ kind: 'loading' });
    case 'error':
      return view({ kind: 'error' });
    case 'empty':
      return view({ kind: 'ready', data: REPORTS_EMPTY }, {}, { branch: 'springfield', technician: REPORTS_EMPTY.technicianId as string, from: '', to: '' });
    case 'exporting':
      return view(ready, { exporting: true });
    case 'tip':
      return view(ready, { tip: { chart: 'onTime', text: TIP } });
    case 'tables':
      return view(ready, { tables: { onTime: true, calls: true, noOneHome: true } });
    default:
      return view(ready);
  }
}
