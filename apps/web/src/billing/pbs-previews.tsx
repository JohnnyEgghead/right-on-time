// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The pretend billing screens in each state their frames show, with the frames' own data, for the harness build's preview routes
// (apps/web/app/shell-preview/pbs-list, pbs-invoice). Their own module so a route loads only its own frame's sheets.
// The office kit slices first: a page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/kit/kit.unit-pbs.css';
import { PbsFrame } from '../shell/Frames.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../shell/preview-fixtures.ts';
import { PbsInvoiceBody, type PbsInvoiceBodyProps } from './PbsInvoiceBody.tsx';
import { PbsListBody, type PbsListBodyProps } from './PbsListBody.tsx';
import { INVOICE_BY_HAND, INVOICE_SUCCESS, INVOICES_EMPTY, INVOICES_SUCCESS, MODE_UP } from './preview-data.ts';
import type { PBS_INVOICE_STATES, PBS_LIST_STATES } from './preview-states.ts';

const noop = () => undefined;

const PBS_LIST: PbsListBodyProps = {
  invoices: INVOICES_SUCCESS, mode: MODE_UP, pick: 'reject_next_n', nText: '2', onPick: noop, onN: noop, onApply: noop, onMore: noop, onReload: noop,
};

export function PbsListPreview({ name }: { name: (typeof PBS_LIST_STATES)[number] }) {
  const body: PbsListBodyProps =
    name === 'loading' ? { ...PBS_LIST, invoices: 'loading' }
    : name === 'empty' ? { ...PBS_LIST, invoices: INVOICES_EMPTY }
    : name === 'error' ? { ...PBS_LIST, invoices: 'error' }
    : name === 'applying' ? { ...PBS_LIST, applying: true }
    : PBS_LIST;
  return (
    <PbsFrame screen="SCR-PBS-01" className="p-a list" me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false}>
      <PbsListBody {...body} />
    </PbsFrame>
  );
}

export function PbsInvoicePreview({ name }: { name: (typeof PBS_INVOICE_STATES)[number] }) {
  const body: PbsInvoiceBodyProps =
    name === 'loading' ? { jobNumber: 24812, invoice: 'loading', onReload: noop }
    : name === 'hand' ? { jobNumber: 24790, invoice: INVOICE_BY_HAND, onReload: noop }
    : { jobNumber: 24812, invoice: INVOICE_SUCCESS, onReload: noop };
  return (
    <PbsFrame screen="SCR-PBS-02" className="p-a inv" me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false}>
      <PbsInvoiceBody {...body} />
    </PbsFrame>
  );
}
