// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-09 in each state its frame shows (mockups/pages/office-call-list.html), with the frame's own data, for the harness build's preview
// route (apps/web/app/shell-preview/call-list). Its own module and its own page sheet: 2 page sheets on 1 route would leak rules between pages.
// The office kit slices first: a page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/page-office-call-list.css';
import { OfficeFrame } from '../shell/Frames.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { CallListBody, type CallListBodyProps } from './CallListBody.tsx';
import { CALLS_EMPTY, CALLS_SUCCESS } from './preview-data.ts';
import type { CALL_STATES } from './preview-states.ts';

const noop = () => undefined;

const CALL_BASE: CallListBodyProps = {
  status: 'ready', data: CALLS_SUCCESS, date: '2026-09-15', branch: 'columbus', branchName: 'Columbus', branchZone: 'America/New_York', live: 'live',
  selected: '00000000-0000-4000-b000-000000000005', scriptLang: null, changing: new Set(), recording: null, message: null, onRetry: noop,
};

export function CallListPreview({ name }: { name: (typeof CALL_STATES)[number] }) {
  const body = (p: CallListBodyProps) => (
    <OfficeFrame screen="SCR-OFC-09" me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false} bar={{ alertCount: 2, currentPath: '/office/messages' }}>
      <CallListBody {...p} />
    </OfficeFrame>
  );
  switch (name) {
    case 'loading':
      return body({ ...CALL_BASE, status: 'loading', data: null, selected: null });
    case 'empty':
      return body({ ...CALL_BASE, data: CALLS_EMPTY, selected: null });
    case 'recording':
      return body({ ...CALL_BASE, recording: { entryId: '00000000-0000-4000-b000-000000000005', outcome: 'confirmed' } });
    case 'correcting':
      return body({ ...CALL_BASE, changing: new Set(['00000000-0000-4000-b000-000000000001']), selected: '00000000-0000-4000-b000-000000000007' });
    case 'error':
      return body({ ...CALL_BASE, status: 'error', data: null, selected: null });
    case 'script-es':
      return body({ ...CALL_BASE, selected: '00000000-0000-4000-b000-000000000007' }); // Ernesto Salinas, whose texts are in Spanish
    default:
      return body(CALL_BASE);
  }
}
