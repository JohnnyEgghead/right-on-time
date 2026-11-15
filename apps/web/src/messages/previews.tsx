// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-08 in each state its frame shows (mockups/pages/office-messages.html), with the frame's own data, for the harness build's preview
// route (apps/web/app/shell-preview/messages). Client component, because the body takes handlers and a server page cannot pass a function
// to a client component. Never read by a release route.
// The office kit slices first: a page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/page-office-messages.css';
import { OfficeFrame } from '../shell/Frames.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { LogBody, type DetailView, type LogBodyProps } from './LogBody.tsx';
import { NO_FILTERS } from './model.ts';
import { DETAIL_LINH, LINH_ID, LOG_EMPTY, LOG_LIVE, LOG_SUCCESS } from './preview-data.ts';
import type { LOG_STATES } from './preview-states.ts';

const noop = () => undefined;
const LINH = `text:${LINH_ID}`;
const READY: DetailView = { state: 'ready', data: DETAIL_LINH, trying: false, tried: null, adding: false, added: null, message: null };

const LOG_BASE: LogBodyProps = {
  status: 'ready', data: LOG_SUCCESS, date: '2026-09-15', today: '2026-09-15', branch: 'columbus', branchName: 'Columbus', branchZone: 'America/New_York',
  filters: NO_FILTERS, callCount: 5, live: 'live', picked: LINH, detail: READY, exporting: false, exportFailed: false, onRetry: noop,
};

export function MessagesPreview({ name }: { name: (typeof LOG_STATES)[number] }) {
  const body = (p: LogBodyProps) => (
    <OfficeFrame screen="SCR-OFC-08" me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false} bar={{ alertCount: 2, currentPath: '/office/messages' }}>
      <LogBody {...p} />
    </OfficeFrame>
  );
  switch (name) {
    case 'loading':
      return body({ ...LOG_BASE, status: 'loading', data: null, picked: null, detail: null });
    case 'empty-day':
      return body({ ...LOG_BASE, data: LOG_EMPTY, picked: null, detail: null });
    case 'empty-filter':
      return body({ ...LOG_BASE, data: LOG_EMPTY, filters: { ...NO_FILTERS, type: 'late' }, picked: null, detail: null });
    case 'error':
      return body({ ...LOG_BASE, status: 'error', data: null, picked: null, detail: null });
    case 'trying':
      return body({ ...LOG_BASE, detail: { ...READY, trying: true, tried: { number: 3, startedAt: '2026-09-15T10:30:00-04:00[America/New_York]', heldUntil: null } } });
    case 'added':
      return body({ ...LOG_BASE, detail: { ...READY, added: { by: 'Keisha Thompson', at: '2026-09-15T11:20:00-04:00[America/New_York]' } } });
    case 'exporting':
      return body({ ...LOG_BASE, exporting: true });
    case 'live':
      return body({ ...LOG_BASE, data: LOG_LIVE, picked: null, detail: null, fresh: new Set([`text:${LOG_LIVE.texts[0]!.id}`, `text:${LOG_LIVE.texts[2]!.id}`]) });
    default:
      return body(LOG_BASE);
  }
}
