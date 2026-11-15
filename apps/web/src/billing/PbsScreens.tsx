// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-PBS-01 at `/billing-system` and SCR-PBS-02 at `/billing-system/invoices/{jobNumber}`: the pretend billing system's pages
// (FR-BILL-4 received invoices, FR-BILL-5 the modes Up, Not answering, Down and Reject the next N). The reads are API-65, API-66 and
// API-67; Apply is the write API-68. Both pages sit on the pretend billing surface: the demo strip has no Change (D5a-2).
// The office kit slices first: a page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/kit/kit.unit-pbs.css';
import { ApiError, createClient, pbsInvoice, pbsInvoices, pbsMode, setPretendBillingMode } from '@bw/api';
import { notFound } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PbsFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import { PbsInvoiceBody, type PbsInvoiceView } from './PbsInvoiceBody.tsx';
import { PbsListBody, type Mode, type PbsInvoices, type PbsModeView } from './PbsListBody.tsx';

const origin = () => (typeof window === 'undefined' ? '' : window.location.origin);

export function PbsListScreen() {
  const t = useT();
  const client = useMemo(() => createClient({ baseUrl: origin() }), []);
  const [invoices, setInvoices] = useState<'loading' | 'error' | PbsInvoices>('loading');
  const [mode, setMode] = useState<PbsModeView | null>(null);
  const [pick, setPick] = useState<Mode>('up');
  const [nText, setN] = useState('1');
  const [applying, setApplying] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadInvoices = useCallback(async () => {
    setInvoices('loading');
    try {
      setInvoices((await client.call(pbsInvoices, {})).data);
    } catch {
      setInvoices('error');
    }
  }, [client]);

  const loadMode = useCallback(async () => {
    try {
      const m = (await client.call(pbsMode, {})).data;
      setMode(m);
      setPick(m.mode);
      if (m.nLeft) setN(String(m.nLeft));
    } catch {
      setMode(null);
    }
  }, [client]);

  useEffect(() => {
    void loadInvoices();
    void loadMode();
  }, [loadInvoices, loadMode]);

  const apply = async () => {
    if (applying) return;
    setApplying(true);
    setMessage(null);
    try {
      await client.call(setPretendBillingMode, pick === 'reject_next_n' ? { mode: pick, n: Number(nText) } : { mode: pick });
      await loadMode();
    } catch (e) {
      setMessage(e instanceof ApiError && e.problem.code === 'validation_failed' ? t('pbs.n.bad') : t('pbs.applyFailed'));
    } finally {
      setApplying(false);
    }
  };

  const more = async () => {
    if (moreBusy || typeof invoices === 'string' || !invoices.next) return;
    setMoreBusy(true);
    try {
      const next = (await client.call(pbsInvoices, { cursor: invoices.next })).data;
      setInvoices({ ...next, invoices: [...invoices.invoices, ...next.invoices] });
    } catch {
      setMessage(t('billing.act.failed'));
    } finally {
      setMoreBusy(false);
    }
  };

  return (
    <PbsFrame screen="SCR-PBS-01" className="p-a list">
      <PbsListBody
        invoices={invoices}
        mode={mode}
        pick={pick}
        nText={nText}
        applying={applying}
        message={message}
        moreBusy={moreBusy}
        onPick={setPick}
        onN={setN}
        onApply={() => void apply()}
        onMore={() => void more()}
        onReload={loadInvoices}
      />
    </PbsFrame>
  );
}

export function PbsInvoiceScreen({ jobNumber }: { jobNumber: number }) {
  const client = useMemo(() => createClient({ baseUrl: origin() }), []);
  const [invoice, setInvoice] = useState<'loading' | 'error' | PbsInvoiceView>('loading');
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    setInvoice('loading');
    try {
      setInvoice((await client.call(pbsInvoice, { jobNumber })).data);
    } catch (e) {
      if (e instanceof ApiError && e.problem.code === 'not_found') setMissing(true);
      else setInvoice('error');
    }
  }, [client, jobNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  // No invoice for that job number: the Page not found page (SCR-SHR-02).
  if (missing) notFound();

  return (
    <PbsFrame screen="SCR-PBS-02" className="p-a inv">
      <PbsInvoiceBody jobNumber={jobNumber} invoice={invoice} onReload={load} />
    </PbsFrame>
  );
}
