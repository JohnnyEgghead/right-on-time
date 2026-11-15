// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-10 Jobs not in billing at `/office/billing` (UC-20; FR-BILL-2, FR-BILL-10, FR-BILL-11, FR-BILL-12): reads API-60 for the
// branch, keeps it live (billing.changed, EVT-07), and calls the writes API-61 Send again, API-156 Retry now, API-157 Retry all and
// API-158 Mark fixed, and API-159 Export to spreadsheet. Mark fixed opens SCR-OFC-47. Correct the finish opens SCR-OFC-22 in correction
// mode as a dialog on this page, with no route (UI-SPECIFICATION SCR-OFC-22 Route; F-597): the job page's FinishDialog (P4-JOB).
// The office kit slices first: a page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/page-office-billing.css';
import {
  ApiError, billingExport, billingQueue, createClient, markFixed, retryAll, retryNow, sendAgain,
} from '@bw/api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { branchById } from '../shell/branches.ts';
import { useAnnounce } from '../shell/Announcer.tsx';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import { useBranch } from '../shell/useBranch.ts';
import { jobApi } from '../job/api.ts';
import { FinishDialog } from '../job/FinishDialog.tsx';
import { BillingBody, type Queue, type RowBusy } from './BillingBody.tsx';
import { MarkFixedDialog } from './MarkFixedDialog.tsx';
import { useBillingLive } from './useBillingLive.ts';

const GONE = new Set(['not_waiting_for_person', 'not_retrying', 'not_on_billing_list']);

export function BillingScreen() {
  const t = useT();
  const announce = useAnnounce();
  const client = useMemo(() => createClient({ baseUrl: typeof window === 'undefined' ? '' : window.location.origin }), []);
  // The top bar's branch (CTL-CMP-07-04, F-594): URL, then storage, then API-07; null until known, and nothing is read before it is.
  const branch = useBranch();
  const shown = useRef(branch);
  shown.current = branch;
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [data, setData] = useState<Queue | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<number, RowBusy>>({});
  const [retryAllBusy, setRetryAllBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [arrived, setArrived] = useState<number | null>(null);
  const [fix, setFix] = useState<{ jobNumber: number; reason: string; saving: boolean; error: string | null } | null>(null);
  const [correcting, setCorrecting] = useState<number | null>(null);
  const finishApi = useMemo(() => jobApi(client), [client]);
  const known = useRef<Set<number>>(new Set());
  // The read must not change identity on each render (useT and the announcer are new functions each time): the effect below would read again forever.
  const say = useRef({ t, announce });
  say.current = { t, announce };

  const load = useCallback(async () => {
    if (branch === null) return;
    try {
      const answer = await client.call(billingQueue, { branch });
      // An answer for a branch the page no longer shows (the top bar moved on during the read) is dropped.
      if (shown.current !== branch) return;
      const next = answer.data;
      // A job that was waiting and is now in the Fixed table reached billing: announce it (the Live row frame).
      for (const l of next.leftLast7Days) {
        if (known.current.has(l.jobNumber) && l.how !== 'marked_fixed') {
          known.current.delete(l.jobNumber);
          setArrived(l.jobNumber);
          say.current.announce(say.current.t('billing.toast.reached', { job: l.jobNumber }));
        }
      }
      known.current = new Set(next.items.map((i) => i.jobNumber));
      setData(next);
      setStatus('ready');
    } catch {
      if (shown.current === branch) setStatus((s) => (s === 'ready' ? s : 'error'));
    }
  }, [client, branch]);

  useEffect(() => {
    // A new branch is a new list: the previous branch's rows never show under its name.
    known.current = new Set();
    setData(null);
    setStatus('loading');
    void load();
  }, [load]);

  const live = useBillingLive(branch, () => void load());

  const done = async (fn: () => Promise<unknown>, clear: () => void) => {
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof ApiError && GONE.has(e.problem.code) ? t('billing.act.gone') : t('billing.act.failed'));
    } finally {
      clear();
    }
    await load();
  };

  const rowAction = (kind: RowBusy, jobNumber: number, call: () => Promise<unknown>) => {
    if (rowBusy[jobNumber]) return; // a repeated press is ignored while the row is busy
    setRowBusy((b) => ({ ...b, [jobNumber]: kind }));
    void done(call, () =>
      setRowBusy((b) => Object.fromEntries(Object.entries(b).filter(([k]) => Number(k) !== jobNumber))),
    );
  };

  const onExport = async () => {
    if (exporting || branch === null) return;
    setExporting(true);
    setMessage(null);
    try {
      const answer = await client.call(billingExport, { branch, lang: t.lang });
      const text = answer.data;
      // The client reads the answer as text, which drops the file's byte order mark (SPECIFICATIONS 7.5): the saved file carries it again.
      const blob = new Blob([text.startsWith('\uFEFF') ? text : `\uFEFF${text}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = answer.fileName ?? 'billing-list.csv';
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setMessage(t('billing.act.failed'));
    } finally {
      setExporting(false);
    }
  };

  const confirmFix = async () => {
    if (!fix || fix.saving) return;
    setFix({ ...fix, saving: true, error: null });
    try {
      await client.call(markFixed, { jobNumber: fix.jobNumber, reason: fix.reason.trim() });
      announce(t('billing.toast.fixed', { job: fix.jobNumber }));
      setFix(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && GONE.has(e.problem.code)) {
        setFix(null);
        setMessage(t('billing.fix.gone'));
        await load();
      } else {
        setFix({ ...fix, saving: false, error: t('billing.fix.failed') });
      }
    }
  };

  return (
    <OfficeFrame screen="SCR-OFC-10" bar={{ currentPath: '/office/billing' }}>
      <BillingBody
        status={status}
        data={data}
        branchName={branch === null ? '' : branchById(branch).name}
        live={live}
        rowBusy={rowBusy}
        arrived={arrived}
        retryAllBusy={retryAllBusy}
        exporting={exporting}
        message={message}
        onReload={load}
        onRefresh={() => void load()}
        onExport={() => void onExport()}
        onRetryAll={() => {
          if (retryAllBusy || branch === null) return;
          setRetryAllBusy(true);
          void done(() => client.call(retryAll, { branch }), () => setRetryAllBusy(false));
        }}
        onRetryNow={(n) => rowAction('retry', n, () => client.call(retryNow, { jobNumber: n }))}
        onSendAgain={(n) => rowAction('resend', n, () => client.call(sendAgain, { jobNumber: n }))}
        onCorrect={(n) => setCorrecting(n)}
        onMarkFixed={(n) => setFix({ jobNumber: n, reason: '', saving: false, error: null })}
      />
      {fix ? (
        <MarkFixedDialog
          jobNumber={fix.jobNumber}
          reason={fix.reason}
          saving={fix.saving}
          error={fix.error}
          onReason={(reason) => setFix({ ...fix, reason })}
          onCancel={() => setFix(null)}
          onConfirm={() => void confirmFix()}
        />
      ) : null}
      {correcting !== null ? (
        <FinishDialog
          mode="correction"
          jobNumber={correcting}
          api={finishApi}
          onClose={() => setCorrecting(null)}
          onKeep={() => { setCorrecting(null); void load(); }}
          onDone={(how) => {
            const n = correcting;
            setCorrecting(null);
            if (how === 'sentAgain') announce(t('job.finish.sentAgain', { job: n }), 'check');
            if (how === 'noLongerWaiting') announce(t('job.finish.notWaiting'), 'info');
            void load();
          }}
        />
      ) : null}
    </OfficeFrame>
  );
}
