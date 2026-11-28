// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-08 Messages: text log at `/office/messages` (FR-TEXT-15, FR-TEXT-24): reads API-40 for the branch and day with the filters, keeps it
// live (text.changed, EVT-03), opens a text's API-41 detail beside the list, and calls the writes API-144 Try now and API-145 Add to call
// list and the export API-146. The call list's count on its tab is API-42's.
// The office kit slices first: a page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/page-office-messages.css';
import { ApiError, callList, createClient, textDetail, textLog, textLogExport, tryTextNow, addToCallList, type z } from '@bw/api';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { branchById } from '../shell/branches.ts';
import { officeClock, useDemoDay } from '../shell/demo-day.ts';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useNewestAnswer } from '../shell/newest-answer.ts';
import { useT } from '../shell/intl.tsx';
import { useBranch } from '../shell/useBranch.ts';
import { LogBody, type DetailView } from './LogBody.tsx';
import { logRows, NO_FILTERS, type DetailData, type LogData, type LogFilters } from './model.ts';
import { useMessagesLive } from './useMessagesLive.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FRESH_MS = 4000;
const LOG_EVENTS = ['text.changed'] as const;

const IDLE: DetailView = { state: 'loading', data: null, trying: false, tried: null, adding: false, added: null, message: null };

type LogQuery = z.input<typeof textLog.request>;

/** The filters that go to the API: the empty ones are left out. */
function queryOf(branch: string, date: string, f: LogFilters, cursor: string | null): LogQuery {
  return {
    date, branch, limit: 50,
    ...(f.type ? { type: f.type as NonNullable<LogQuery['type']> } : {}),
    ...(f.status ? { status: f.status as NonNullable<LogQuery['status']> } : {}),
    ...(f.language ? { language: f.language as 'en' | 'es' } : {}),
    ...(f.customer.trim() ? { customer: f.customer.trim() } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function MessagesScreen() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const client = useMemo(() => createClient({ baseUrl: typeof window === 'undefined' ? '' : window.location.origin }), []);
  const branch = useBranch();
  const zone = branchById(branch).zone;
  const dateParam = params.get('date');
  // The demo clock's today (API-10): the day shown while the URL names none (UD-18).
  const { day: today, readDay } = useDemoDay(officeClock);
  const following = !(dateParam && DATE.test(dateParam));
  const date = following ? today : dateParam;
  const [filters, setFilters] = useState<LogFilters>(NO_FILTERS);
  const [applied, setApplied] = useState<LogFilters>(NO_FILTERS);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [data, setData] = useState<LogData | null>(null);
  const [callCount, setCallCount] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // Another day is another list: its first page, with no row open.
  const [listDay, setListDay] = useState(date);
  if (listDay !== date) {
    setListDay(date);
    setCursor(null);
    setPicked(null);
  }
  const [detail, setDetail] = useState<DetailView>(IDLE);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const shown = useRef({ branch, date });
  shown.current = { branch, date };
  const before = useRef<Map<string, string>>(new Map());
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (freshTimer.current !== null) clearTimeout(freshTimer.current);
  }, []);
  const pickedRef = useRef<string | null>(null);
  pickedRef.current = picked;
  // The read must not change identity on each render (useT is a new function each time): the effects below would read again forever.
  const say = useRef(t);
  say.current = t;

  // The customer search applies after a pause in typing; every other filter at once.
  useEffect(() => {
    const id = setTimeout(() => {
      setApplied((a) => (a.customer === filters.customer && a.type === filters.type && a.status === filters.status && a.language === filters.language ? a : filters));
    }, filters.customer === applied.customer ? 0 : 300);
    return () => clearTimeout(id);
  }, [filters, applied.customer]);

  const newest = useNewestAnswer();
  const load = useCallback(async () => {
    if (branch === null || date === null) return;
    // K-08.3: an answer to an earlier filter or page that lands after a newer read began is dropped, as one for another day or branch is.
    await newest.run(
      () => client.call(textLog, queryOf(branch, date, applied, cursor)).then((answer) => ({ answer }), () => ({ answer: null })),
      ({ answer }) => {
        if (shown.current.branch !== branch || shown.current.date !== date) return; // an answer for a day or branch no longer shown is dropped
        if (answer === null) {
          setStatus((s) => (s === 'ready' ? s : 'error'));
          return;
        }
        const next = answer.data;
        // A row that is new, or whose status changed since the last read, shows as live for a moment (the Live row frame).
        const now = new Map(logRows(next).map((r) => [r.key, r.kind === 'text' ? `${r.row.status}:${r.row.tries}` : r.row.handling] as const));
        const changed = new Set<string>();
        if (before.current.size > 0) for (const [k, v] of now) if (before.current.get(k) !== v) changed.add(k);
        before.current = now;
        setData(next);
        setStatus('ready');
        if (changed.size > 0) {
          setFresh(changed);
          // K-08.4: 1 timer at a time, in a ref: a new highlight re-arms it, and leaving the page clears it.
          if (freshTimer.current !== null) clearTimeout(freshTimer.current);
          freshTimer.current = setTimeout(() => {
            freshTimer.current = null;
            setFresh(new Set());
          }, FRESH_MS);
        }
      },
    );
  }, [client, branch, date, applied, cursor, newest]);

  const loadCount = useCallback(async () => {
    if (branch === null || date === null) return;
    try {
      const r = await client.call(callList, { branch, date });
      // A count for a day or branch no longer shown is dropped, as load() drops its rows (F-1977).
      if (shown.current.branch !== branch || shown.current.date !== date) return;
      setCallCount(r.data.count);
    } catch {
      if (shown.current.branch === branch && shown.current.date === date) setCallCount(null);
    }
  }, [client, branch, date]);

  useEffect(() => {
    before.current = new Map();
    setStatus('loading');
    setData(null);
    void load();
  }, [load]);
  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  const loadDetail = useCallback(async (key: string | null, keep = false) => {
    if (!key || !key.startsWith('text:')) return;
    if (!keep) setDetail(IDLE);
    try {
      const r = await client.call(textDetail, { textId: key.slice('text:'.length) });
      if (pickedRef.current !== key) return;
      setDetail((d) => ({ ...(keep ? d : IDLE), state: 'ready', data: r.data as DetailData, trying: false }));
    } catch {
      if (pickedRef.current === key) setDetail((d) => ({ ...d, state: 'error', trying: false }));
    }
  }, [client]);

  useEffect(() => {
    void loadDetail(picked);
  }, [picked, loadDetail]);

  // K-08.5: a burst of events reads the log once more, not once each. A read made for an event while another is in flight is made after it, once.
  const loadNow = useRef(load);
  loadNow.current = load;
  const eventRead = useRef({ running: false, again: false });
  const loadForEvent = async () => {
    const s = eventRead.current;
    if (s.running) {
      s.again = true;
      return;
    }
    s.running = true;
    try {
      do {
        s.again = false;
        await loadNow.current();
      } while (s.again);
    } finally {
      s.running = false;
    }
  };

  const live = useMessagesLive(branch, LOG_EVENTS, (notice) => {
    void loadForEvent();
    void loadCount();
    if (notice?.textId && pickedRef.current === `text:${notice.textId}`) void loadDetail(pickedRef.current, true);
  }, { following, day: today, readDay });

  const go = (nextDate: string) => {
    const q = new URLSearchParams({ branch: branch ?? 'columbus', date: nextDate });
    setCursor(null);
    setPicked(null);
    router.replace(`/office/messages?${q.toString()}`);
  };

  const tryNow = async () => {
    const key = picked;
    if (!key || detail.trying) return;
    setDetail((d) => ({ ...d, trying: true, message: null }));
    try {
      const r = await client.call(tryTextNow, { textId: key.slice('text:'.length) });
      const startedAt = r.data.text.nextTryAt;
      setDetail((d) => ({ ...d, trying: false, tried: { number: r.data.text.attempts.length + 1, startedAt, heldUntil: r.data.text.heldUntil } }));
    } catch (e) {
      setDetail((d) => ({ ...d, trying: false, message: e instanceof ApiError && e.problem.code === 'not_retryable' ? say.current('msg.err.notRetryable') : say.current('msg.err.failed') }));
      await loadDetail(key, true);
    }
  };

  const addToList = async () => {
    const key = picked;
    if (!key || detail.adding) return;
    setDetail((d) => ({ ...d, adding: true, message: null }));
    try {
      const r = await client.call(addToCallList, { textId: key.slice('text:'.length) });
      setDetail((d) => ({ ...d, adding: false, added: { by: r.data.entry.by, at: r.data.entry.at } }));
      void loadCount();
    } catch (e) {
      const dup = e instanceof ApiError && e.problem.code === 'already_on_call_list';
      setDetail((d) => ({ ...d, adding: false, message: dup ? say.current('msg.err.alreadyOnList') : say.current('msg.err.failed') }));
      if (dup) await loadDetail(key, true);
    }
  };

  const doExport = async () => {
    if (exporting || branch === null || date === null) return;
    setExporting(true);
    setExportFailed(false);
    try {
      const { type, status: st, language, customer } = queryOf(branch, date, applied, null);
      const answer = await client.call(textLogExport, { branch, date, lang: t.lang, ...(type ? { type } : {}), ...(st ? { status: st } : {}), ...(language ? { language } : {}), ...(customer ? { customer } : {}) });
      const text = answer.data;
      // The client reads the answer as text, which drops the file's byte order mark (SPECIFICATIONS 7.5): the saved file carries it again.
      const blob = new Blob([text.startsWith('﻿') ? text : `﻿${text}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = answer.fileName ?? 'text-log.csv';
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <OfficeFrame screen="SCR-OFC-08" bar={{ currentPath: '/office/messages' }}>
      <LogBody
        status={date === null ? 'loading' : status}
        data={data}
        date={date ?? ''}
        today={today}
        branch={branch ?? 'columbus'}
        branchName={branchById(branch).name}
        branchZone={zone}
        filters={filters}
        callCount={callCount}
        live={live}
        picked={picked}
        fresh={fresh}
        detail={picked ? detail : null}
        exporting={exporting}
        exportFailed={exportFailed}
        onDate={go}
        onFilter={(name, value) => {
          setCursor(null);
          setFilters((f) => ({ ...f, [name]: value }));
        }}
        onClear={() => {
          setCursor(null);
          setFilters(NO_FILTERS);
          setApplied(NO_FILTERS);
        }}
        onPick={(k) => {
          setPicked(k);
          setDetail(IDLE);
        }}
        onNewer={() => setCursor(data?.cursors.newer ?? null)}
        onOlder={() => setCursor(data?.cursors.older ?? null)}
        onTryNow={() => void tryNow()}
        onAddToCallList={() => void addToList()}
        onExport={() => void doExport()}
        onRetry={load}
        onRefresh={() => void load()}
      />
    </OfficeFrame>
  );
}

