// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-09 Messages: call list at `/office/messages/call-list` (FR-TEXT-13, FR-TEXT-25): reads API-42 for the branch and the day the calls
// are made, keeps it live (text.changed, EVT-03, and job.changed, EVT-01), records an outcome with API-38 (Mark confirmed, No answer; Reschedule
// is the job page's dialog, SCR-OFC-20, mounted here in place; after API-24 moves the visit this page records the outcome, CTL-OFC-20-03),
// and prints the day's rows.
// The office kit slices first: a page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/page-office-call-list.css';
import { ApiError, callList, createClient, recordCallOutcome } from '@bw/api';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Busy, Dialog } from '../board/Dialogs.tsx';
import { RescheduleJobDialog } from '../job/RescheduleJobDialog.tsx';
import type { Shown } from '../job/model.ts';
import { useAnnounce } from '../shell/Announcer.tsx';
import { branchById } from '../shell/branches.ts';
import { officeClock, useDemoDay } from '../shell/demo-day.ts';
import { OfficeFrame } from '../shell/Frames.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import type { MessageKey } from '@bw/i18n';
import { useBranch } from '../shell/useBranch.ts';
import { CallListBody } from './CallListBody.tsx';
import type { CallData, CallOutcome, FailedText, ReminderCall } from './model.ts';
import { useMessagesLive } from './useMessagesLive.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CALL_EVENTS = ['text.changed', 'job.changed'] as const;

export function CallListScreen() {
  const t = useT();
  const announce = useAnnounce();
  const router = useRouter();
  const params = useSearchParams();
  const client = useMemo(() => createClient({ baseUrl: typeof window === 'undefined' ? '' : window.location.origin }), []);
  const branch = useBranch();
  const dateParam = params.get('date');
  // The demo clock's today (API-10): the day shown while the URL names none (UD-18).
  const { day: today, readDay } = useDemoDay(officeClock);
  const following = !(dateParam && DATE.test(dateParam));
  const date = following ? today : dateParam;
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [data, setData] = useState<CallData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scriptLang, setScriptLang] = useState<'en' | 'es' | null>(null);
  const [changing, setChanging] = useState<ReadonlySet<string>>(new Set());
  const [recording, setRecording] = useState<{ entryId: string; outcome: CallOutcome } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // CTL-OFC-09-05: the row whose Reschedule dialog is open, and (after API-24 moved the visit but API-38 failed) the Outcome not saved state.
  const [rescheduling, setRescheduling] = useState<{ row: ReminderCall | FailedText; unsaved: boolean; saving: boolean } | null>(null);
  const shown = useRef({ branch, date });
  shown.current = { branch, date };
  const say = useRef(t);
  say.current = t;

  const load = useCallback(async () => {
    if (branch === null || date === null) return;
    try {
      const answer = await client.call(callList, { branch, date });
      if (shown.current.branch !== branch || shown.current.date !== date) return;
      setData(answer.data);
      setStatus('ready');
      // A row whose outcome changed (a Reschedule recorded by the job page, another office user) closes its open Change.
      setChanging((c) => new Set([...c].filter((id) => [...answer.data.reminderCalls, ...answer.data.failedTexts].some((r) => r.entryId === id && r.outcome !== null))));
    } catch {
      if (shown.current.branch === branch && shown.current.date === date) setStatus((s) => (s === 'ready' ? s : 'error'));
    }
  }, [client, branch, date]);

  useEffect(() => {
    setStatus('loading');
    setData(null);
    void load();
  }, [load]);

  const live = useMessagesLive(branch, CALL_EVENTS, () => void load(), { following, day: today, readDay });

  // The first row still to call shows its script (the frame's), else the first row.
  const rows = useMemo<(ReminderCall | FailedText)[]>(() => (data ? [...data.reminderCalls, ...data.failedTexts] : []), [data]);
  useEffect(() => {
    if (selected !== null && rows.some((r) => r.entryId === selected)) return;
    setSelected((rows.find((r) => r.outcome === null) ?? rows[0])?.entryId ?? null);
  }, [rows, selected]);

  // Escape closes the open Change of the focused row's table (CTL-OFC-09-15).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChanging((c) => (c.size === 0 ? c : new Set()));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const record = async (row: ReminderCall | FailedText, outcome: CallOutcome) => {
    if (recording) return;
    setRecording({ entryId: row.entryId, outcome });
    setMessage(null);
    try {
      await client.call(recordCallOutcome, { jobNumber: row.visit.jobNumber, outcome, entryId: row.entryId });
      setChanging((c) => new Set([...c].filter((id) => id !== row.entryId)));
    } catch (e) {
      setMessage(e instanceof ApiError && e.problem.code === 'rule_refused' ? say.current('calls.err.refused') : say.current('calls.err.failed'));
    } finally {
      setRecording(null);
    }
    await load();
  };

  // CTL-OFC-20-03: the visit is moved (API-24), now this row's Reschedule outcome (API-38). When that fails the dialog stays, saying so.
  const recordMoved = async (row: ReminderCall | FailedText, toast: Shown | null) => {
    setRescheduling({ row, unsaved: false, saving: true });
    try {
      await client.call(recordCallOutcome, { jobNumber: row.visit.jobNumber, outcome: 'reschedule', entryId: row.entryId });
    } catch {
      setRescheduling({ row, unsaved: true, saving: false });
      await load();
      return;
    }
    setRescheduling(null);
    if (toast) announce(say.current(toast.key as MessageKey, toast.values), 'check');
    await load();
  };

  return (
    <OfficeFrame screen="SCR-OFC-09" bar={{ currentPath: '/office/messages' }}>
      <CallListBody
        status={date === null ? 'loading' : status}
        data={data}
        date={date ?? ''}
        branch={branch ?? 'columbus'}
        branchName={branchById(branch).name}
        branchZone={branchById(branch).zone}
        live={live}
        selected={selected}
        scriptLang={scriptLang}
        changing={changing}
        recording={recording}
        message={message}
        onDate={(d) => router.replace(`/office/messages/call-list?${new URLSearchParams({ branch: branch ?? 'columbus', date: d }).toString()}`)}
        onSelect={(id) => {
          setSelected(id);
          setScriptLang(null);
        }}
        onScriptLang={setScriptLang}
        onOutcome={(row, outcome) => void record(row, outcome)}
        onReschedule={(row) => setRescheduling({ row, unsaved: false, saving: false })}
        onChange={(id) =>
          setChanging((c) => {
            const n = new Set(c);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          })
        }
        onPrint={() => window.print()}
        onRetry={load}
        onRefresh={() => void load()}
      />
      {rescheduling && !rescheduling.unsaved && !rescheduling.saving ? (
        <RescheduleJobDialog jobNumber={rescheduling.row.visit.jobNumber} onClose={() => setRescheduling(null)} onKeep={() => { setRescheduling(null); void load(); }}
          onDone={(_answer, toast) => void recordMoved(rescheduling.row, toast)} />
      ) : null}
      {rescheduling && (rescheduling.unsaved || rescheduling.saving) ? (
        <Dialog title={t('job.reschedule.titlePlain')} closeCtl="CTL-OFC-20-04" onClose={() => { if (!rescheduling.saving) setRescheduling(null); }} screen="SCR-OFC-20" alert wide
          foot={<>
            <button type="button" className="btn" data-ctl="CTL-OFC-20-04" onClick={() => { if (!rescheduling.saving) setRescheduling(null); }}>{t('common.cancel')}</button>
            {rescheduling.saving
              ? <Busy label={t('job.reschedule.saving')} ctl="CTL-OFC-20-03" />
              : <button type="button" className="btn primary" data-ctl="CTL-OFC-20-03" onClick={() => void recordMoved(rescheduling.row, null)}>{t('calls.resched.saveOutcome')}</button>}
          </>}>
          <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('calls.resched.notSaved')}</div>
        </Dialog>
      ) : null}
    </OfficeFrame>
  );
}
