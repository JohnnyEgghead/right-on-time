// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The billing screens in each state their frames show, with the frames' own data, for the harness build's preview routes
// (apps/web/app/shell-preview/billing, pbs-list, pbs-invoice). Client components, because the bodies take handlers and a server
// page cannot pass a function to a client component. Never read by a release route.
// The office kit slices first: a page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/page-office-billing.css';
import type { ReactNode } from 'react';
import { ToastView } from '../shell/Announcer.tsx';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { BillingBody, type BillingBodyProps } from './BillingBody.tsx';
import { MarkFixedDialog } from './MarkFixedDialog.tsx';
import { QUEUE_EMPTY, QUEUE_SUCCESS } from './preview-data.ts';

import { BILLING_STATES } from './preview-states.ts';

const noop = () => undefined;


const BASE: BillingBodyProps = { selected: 24800, status: 'ready', data: QUEUE_SUCCESS, branchName: 'Columbus', live: 'live', onReload: noop };

/** The Done state: the job the dialog marked fixed has joined the Fixed table, and the toast says so. */
const DONE = {
  ...QUEUE_EMPTY,
  items: [],
  leftLast7Days: [
    { jobNumber: 24688, reasonKind: 'data_error' as const, reason: 'Account closed', how: 'marked_fixed' as const, tries: 1, by: 'Dana Ruiz', markedReason: 'Entered in billing by hand', at: '2026-09-15T10:44:00-04:00[America/New_York]' },
  ],
};

/** The Live row state: job 24825 reached billing on try 4 and joined the Fixed table (the frame's own row). */
const ARRIVED = { jobNumber: 24825, reasonKind: 'timeout' as const, reason: null, how: 'automatic_retry' as const, tries: 4, by: null, markedReason: null, at: '2026-09-15T10:35:00-04:00[America/New_York]' };

function dialog(reason: string, saving: boolean) {
  return <MarkFixedDialog jobNumber={24688} reason={reason} saving={saving} error={null} onReason={noop} onCancel={noop} onConfirm={noop} />;
}

/** The dialog with a document title (the walkers' axe scan wants one; a page's title comes from its screen). */
function DialogOnly() {
  const t = useT();
  return (
    <>
      <title>{t('shell.app.doc')}</title>
      {dialog('', false)}
    </>
  );
}

export function BillingPreview({ name }: { name: (typeof BILLING_STATES)[number] }) {
  const t = useT();
  // The dialog alone, as the page walkers open it (SCR-OFC-47 is its own screen root, ci/page-walkers/app-wiring.ts).
  if (name === 'dialog') return <DialogOnly />;
  const page = (body: BillingBodyProps, extra?: ReactNode) => (
    <OfficeFrame screen="SCR-OFC-10" me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false} bar={{ alertCount: 2, currentPath: '/office/billing' }}>
      <BillingBody {...body} />
      {extra}
    </OfficeFrame>
  );
  switch (name) {
    case 'loading':
      return page({ ...BASE, status: 'loading', data: null });
    case 'error':
      return page({ ...BASE, status: 'error', data: null });
    case 'empty':
      return page({ ...BASE, data: QUEUE_EMPTY });
    case 'retrying':
      return page({ ...BASE, rowBusy: { 24825: 'retry' }, retryAllBusy: true, data: { ...QUEUE_SUCCESS, items: [QUEUE_SUCCESS.items[1]!] } });
    case 'sending':
      return page({ ...BASE, rowBusy: { 24800: 'resend' }, data: { ...QUEUE_SUCCESS, items: [QUEUE_SUCCESS.items[0]!] } });
    case 'exporting':
      return page({ ...BASE, exporting: true });
    case 'live':
      return page({ ...BASE, arrived: 24825, data: { ...QUEUE_SUCCESS, items: [QUEUE_SUCCESS.items[0]!], leftLast7Days: [ARRIVED, QUEUE_SUCCESS.leftLast7Days[0]!] } }, <ToastView text={t('billing.toast.reached', { job: 24825 })} />);
    case 'asking':
      return page(BASE, dialog('', false));
    case 'saving':
      return page(BASE, dialog('Entered in billing by hand', true));
    case 'done':
      return page({ ...BASE, data: DONE }, <ToastView text={t('billing.toast.fixed', { job: 24688 })} />);
    default:
      return page(BASE);
  }
}

