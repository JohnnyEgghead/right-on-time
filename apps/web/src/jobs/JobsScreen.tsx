// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-30 Jobs at `/office/jobs?tab=<all, unassigned, at-risk, late, not-in-billing>` (UI-SPECIFICATION 2.3; FR-DISP-24, UD-52): reads
// API-133 for the branch, tab, search and filters, re-reads it in place on the events the screen lists (EVT-01, EVT-07), and exports the
// same list through API-134. Read only: no write path. The search text stays in this page's state and in the request body, never in the
// URL or a log (NFR-05); only the tab is in the URL.
import { createClient, JOB_STATUSES, jobsExport, jobsList, subscribeEvents, type JobTab } from '@bw/api';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import type { LiveState } from '../shell/Panels.tsx';
import { createLatest } from '../shell/search-latest.ts';
import { useBranch } from '../shell/useBranch.ts';
import { eventIsForBranch } from '../week/week-model.ts';
import { JobsView, type JobsState } from './JobsView.tsx';
import { JOBS_EVENTS, tabOf, type DatePick, type JobsData, type SortPick } from './jobs-model.ts';

/** The search is read as it is typed, after this pause (CTL-OFC-30-02). */
const TYPING_PAUSE_MS = 250;

export function JobsScreen() {
  const t = useT();
  const params = useSearchParams();
  const topBranch = useBranch();
  const [tab, setTab] = useState<JobTab>(tabOf(params.get('tab')));
  const [pickedBranch, setPickedBranch] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sent, setSent] = useState('');
  const [date, setDate] = useState<DatePick>('upcoming');
  const [technicianId, setTechnicianId] = useState('');
  const [status, setStatus] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [sort, setSort] = useState<SortPick>('attention');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<JobsData | null>(null);
  const [state, setState] = useState<JobsState>('loading');
  const [live, setLive] = useState<LiveState>('reconnecting');
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const client = useMemo(() => (typeof window === 'undefined' ? null : createClient({ baseUrl: window.location.origin })), []);
  const latest = useRef(createLatest());
  const branch = pickedBranch ?? topBranch;

  // A move in the top bar is a new list: the page's own Branch pick and the technician it narrowed to are dropped.
  // F-2072: reset in render (as MessagesScreen does for its day), not in an effect: an effect's setPage(1) lands after the read effect of the same
  // flush has sent the old page number for the new branch.
  const [listBranch, setListBranch] = useState(topBranch);
  if (listBranch !== topBranch) {
    setListBranch(topBranch);
    setPickedBranch(null);
    setTechnicianId('');
    setPage(1);
  }

  // The search is sent after a pause in typing, and at once on Enter (the box is not a form: Enter is read below).
  useEffect(() => {
    if (query === sent) return;
    const id = window.setTimeout(() => setSent(query), TYPING_PAUSE_MS);
    return () => window.clearTimeout(id);
  }, [query, sent]);

  // The request without its page: the export is every row of it (API-134).
  const filters = useMemo(() => {
    if (!branch) return null;
    return {
      branch, tab, date, sort,
      ...(sent.trim() !== '' ? { query: sent.trim() } : {}),
      ...(technicianId ? { technicianId } : {}),
      ...(status ? { status: status as (typeof JOB_STATUSES)[number] } : {}),
      ...(serviceId ? { serviceId } : {}),
    };
  }, [branch, tab, date, sort, sent, technicianId, status, serviceId]);
  const body = useMemo(() => (filters ? { ...filters, page } : null), [filters, page]);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  const read = useCallback(async (): Promise<boolean> => {
    const asked = bodyRef.current;
    if (!client || !asked) return false;
    try {
      await latest.current.run(
        () => client.call(jobsList, asked),
        (answer) => {
          // K-08.1: a page past the last (the list shrank, or the page number came from another branch) goes to the last page; its rows are not drawn.
          if (answer.data.pages > 0 && asked.page > answer.data.pages) {
            setPage(answer.data.pages);
            return;
          }
          setData(answer.data);
          setState('ready');
        },
      );
      return true;
    } catch {
      setState((s) => (s === 'ready' ? s : 'error'));
      return false;
    }
  }, [client]);

  // The first read, and a read for each change of the request (tab, search, filters, page, branch).
  useEffect(() => {
    if (!body) return;
    void read();
  }, [body, read]);

  // The event stream: each event for this branch re-reads the list in place.
  useEffect(() => {
    if (!client || !branch) return;
    const handle = subscribeEvents({
      onEvent: (e) => {
        if (!JOBS_EVENTS.includes(e.name)) return;
        if (e.name !== 'world.reset' && !eventIsForBranch(e, branch)) return;
        void read();
      },
      onReconnect: () => void read(),
      onState: (s) => setLive(s === 'live' ? 'live' : s === 'closed' ? 'paused' : 'reconnecting'),
    });
    return () => handle.close();
  }, [client, branch, read]);

  // A new request shows the old rows until its answer lands, except a new branch, which never shows another branch's rows under its name.
  useEffect(() => {
    setData((d) => (d && branch && d.branch !== branch ? null : d));
    setState((s) => (s === 'error' ? 'loading' : s));
  }, [branch]);

  const reset = () => setPage(1);
  const onExport = async () => {
    if (exporting || !filters || !client) return;
    setExporting(true);
    setExportFailed(false);
    try {
      const answer = await client.call(jobsExport, { ...filters, lang: t.lang });
      const text = answer.data;
      // The client reads the answer as text, which drops the file's byte order mark (SPECIFICATIONS 7.5): the saved file carries it again.
      const blob = new Blob([text.startsWith('﻿') ? text : `﻿${text}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = answer.fileName ?? 'jobs.csv';
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
    <OfficeFrame screen="SCR-OFC-30" bar={{ currentPath: '/office/jobs' }}>
      <JobsView
        state={branch ? state : 'loading'}
        data={data}
        branch={branch ?? 'columbus'}
        tab={tab}
        query={query}
        date={date}
        technicianId={technicianId}
        status={status}
        serviceId={serviceId}
        sort={sort}
        page={page}
        live={live}
        exporting={exporting}
        exportFailed={exportFailed}
        handlers={{
          tab: (next) => {
            setTab(next);
            reset();
            try {
              // K-08.2: the rest of the address (?branch=) stays; only the tab changes.
              const q = new URLSearchParams(window.location.search);
              if (next === 'all') q.delete('tab');
              else q.set('tab', next);
              const rest = q.toString();
              window.history.replaceState(null, '', rest === '' ? '/office/jobs' : `/office/jobs?${rest}`);
            } catch {
              // the address bar is only a convenience
            }
          },
          query: (text) => {
            setQuery(text);
            reset();
          },
          search: () => setSent(query),
          date: (next) => {
            setDate(next);
            reset();
          },
          branch: (next) => {
            setPickedBranch(next);
            setTechnicianId('');
            reset();
          },
          technician: (id) => {
            setTechnicianId(id);
            reset();
          },
          status: (s) => {
            setStatus(s);
            reset();
          },
          service: (s) => {
            setServiceId(s);
            reset();
          },
          sort: (s) => {
            setSort(s);
            reset();
          },
          clear: () => {
            setQuery('');
            setSent('');
            setDate('upcoming');
            setTechnicianId('');
            setStatus('');
            setServiceId('');
            reset();
          },
          page: setPage,
          export: () => void onExport(),
          retry: async () => {
            setState('loading');
            await read();
          },
          refresh: () => void read(),
        }}
      />
    </OfficeFrame>
  );
}
