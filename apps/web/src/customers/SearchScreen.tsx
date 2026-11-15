// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-05 Customer search at `/office/customers` (UI-SPECIFICATION 2.3; FR-DISP-7, FR-DISP-30): holds the query in page state (never
// in the URL, NFR-05), searches as the office types (API-34, the newest answer wins), shows the selected row's customer in the preview
// panel (API-35), and opens SCR-OFC-38 for a new customer, whose page then opens. The text is sent exactly as typed, trimmed only.
import { customerDetail, jobsList, searchCustomers } from '@bw/api';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useBranch } from '../shell/useBranch.ts';
import { CustomerFormDialog } from './CustomerFormDialog.tsx';
import { jobsSearchRequest, NO_FILTERS, searchIsEmpty, type SearchFilters } from './model.ts';
import { SearchView, type JobsFound, type PreviewState, type SearchPhase } from './SearchView.tsx';
import type { CustomerPage, Detail } from './types.ts';
import { call } from './ui.tsx';

const DEBOUNCE_MS = 200;

export function SearchScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const branch = useBranch();
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const [started, setStarted] = useState(false);
  // The Branch filter starts on the top bar's branch (CTL-OFC-05-06); that choice alone is not a search.
  useEffect(() => {
    if (branch && !started) {
      setStarted(true);
      setFilters((f) => ({ ...f, branch }));
    }
  }, [branch, started]);
  const home = branch;
  const [phase, setPhase] = useState<SearchPhase>('empty');
  const [page, setPage] = useState<CustomerPage | null>(null);
  const [allTotal, setAllTotal] = useState<number | null>(null);
  const [cities, setCities] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'none' });
  const [moreFailed, setMoreFailed] = useState(false);
  const [jobs, setJobs] = useState<JobsFound>(null);
  const [dialog, setDialog] = useState(false);
  const seq = useRef(0);
  const details = useRef(new Map<string, Detail>());

  // The subtitle's count, the City filter's choices: 1 read of the whole list (limit 1).
  useEffect(() => {
    void call(searchCustomers, { query: '', limit: 1 }).then((r) => {
      if (r.ok) {
        setAllTotal(r.data.total);
        setCities(r.data.cities);
      }
    });
  }, []);

  const run = useCallback(async (q: string, f: SearchFilters) => {
    const mine = ++seq.current;
    if (searchIsEmpty(q, { ...f, branch: f.branch === home ? null : f.branch })) {
      setPhase('empty');
      setPage(null);
      setSelectedId(null);
      setJobs(null);
      return;
    }
    setPhase('searching');
    setMoreFailed(false);
    // CTL-OFC-05-15: the same text also searches the jobs (API-133); a failed read leaves the customer results standing.
    const jobsReq = jobsSearchRequest(q, f.branch, home);
    setJobs(null);
    // F-850: the jobs read answers in its own time; the customer table never waits for it (a slow or hung API-133 delays only its own panel).
    if (jobsReq) {
      void call(jobsList, jobsReq).then((jr) => {
        if (mine !== seq.current) return;
        setJobs(jr.ok ? { kind: 'found', rows: jr.data.rows } : { kind: 'failed' });
      });
    }
    const r = await call(searchCustomers, { query: q.trim(), filters: f, limit: 25 });
    if (mine !== seq.current) return;
    if (!r.ok) {
      setPhase('error');
      return;
    }
    setCities(r.data.cities);
    setPage(r.data);
    setPhase(r.data.customers.length === 0 ? 'none' : 'results');
    // When results arrive the first row is selected (CTL-OFC-05-16).
    setSelectedId(r.data.customers[0]?.id ?? null);
  }, [home]);

  useEffect(() => {
    const h = setTimeout(() => void run(query, filters), query === '' ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [query, filters, run]);

  // Only the latest selection may set the panel.
  const selectedRef = useRef<string | null>(null);
  const loadPreview = useCallback(async (id: string | null) => {
    if (id === null) {
      setPreview({ kind: 'none' });
      return;
    }
    const known = details.current.get(id);
    if (known) {
      setPreview({ kind: 'ready', data: known });
      return;
    }
    setPreview({ kind: 'loading' });
    const r = await call(customerDetail, { customerId: id });
    if (r.ok) details.current.set(id, r.data);
    if (selectedRef.current === id) setPreview(r.ok ? { kind: 'ready', data: r.data } : { kind: 'error' });
  }, []);
  useEffect(() => {
    selectedRef.current = selectedId;
    void loadPreview(selectedId);
  }, [selectedId, loadPreview]);

  const more = async () => {
    if (!page?.next) return;
    setMoreFailed(false);
    const r = await call(searchCustomers, { query: query.trim(), filters, cursor: page.next, limit: 25 });
    if (!r.ok) {
      setMoreFailed(true);
      return;
    }
    setPage({ ...r.data, customers: [...page.customers, ...r.data.customers] });
  };

  return (
    <OfficeFrame screen="SCR-OFC-05">
      <SearchView
        phase={phase} query={query} filters={filters} page={page} allTotal={allTotal} homeBranch={home} cities={cities} selectedId={selectedId} preview={preview} moreFailed={moreFailed} jobs={jobs}
        onQuery={setQuery}
        onFilters={setFilters}
        onClear={() => setQuery('')}
        onClearFilters={() => setFilters({ ...NO_FILTERS, branch: home })}
        onSelect={setSelectedId}
        onMore={() => void more()}
        onRetry={() => void run(query, filters)}
        onRetryPreview={() => {
          details.current.delete(selectedId ?? '');
          void loadPreview(selectedId);
        }}
        onNew={() => setDialog(true)}
        onNewJob={(id) => router.push(`/office/jobs/new?customer=${id}`)}
      />
      {dialog ? <CustomerFormDialog mode="new" onClose={() => setDialog(false)} onSaved={(c) => router.push(`/office/customers/${c.id}`)} /> : null}
    </OfficeFrame>
  );
}
