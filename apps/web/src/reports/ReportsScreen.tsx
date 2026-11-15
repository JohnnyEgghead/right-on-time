// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-11 Reports at `/office/reports` (FR-REP-1 to FR-REP-8; UC-09): reads API-50 for the filters the address holds, keeps them in the
// address as they change, and downloads API-51 for the same filters. Managers only: the page gate decides before this renders.
import { createClient, reports, reportsExport } from '@bw/api';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../shell/intl.tsx';
import { filtersOf, queryOf, requestOf, weeksInverted, type Filters } from './model.ts';
import { IDLE_UI, ReportsView, type ChartId, type ReportsState, type ReportsUi } from './ReportsView.tsx';

export function ReportsScreen() {
  const t = useT();
  const params = useSearchParams();
  const client = useMemo(() => createClient({ baseUrl: typeof window === 'undefined' ? '' : window.location.origin }), []);
  const [filters, setFilters] = useState<Filters>(() => filtersOf(params));
  const [state, setState] = useState<ReportsState>({ kind: 'loading' });
  const [ui, setUi] = useState<ReportsUi>(IDLE_UI);
  const latest = useRef(0);
  const urlBranch = params.get('branch') || 'all';

  const load = useCallback(
    async (f: Filters) => {
      const mine = ++latest.current;
      try {
        const answer = await client.call(reports, requestOf(f));
        if (mine === latest.current) setState({ kind: 'ready', data: answer.data });
      } catch {
        if (mine === latest.current) setState({ kind: 'error' });
      }
    },
    [client],
  );

  // A range that ends before it starts is held on the page with its message and sent nowhere (CTL-OFC-11-11).
  const inverted = weeksInverted(filters.from, filters.to);
  useEffect(() => {
    if (!inverted) void load(filters);
  }, [filters, inverted, load]);

  // The top bar's branch choice replaces ?branch= (CTL-CMP-07-04): the Branch filter follows it, and the technician of the old branch leaves the
  // address with it (F-741), so a reload does not read the old technician against the new branch.
  const held = useRef(filters);
  held.current = filters;
  useEffect(() => {
    const f = held.current;
    if (f.branch === urlBranch) return;
    const next = { ...f, branch: urlBranch, technician: 'all' };
    setFilters(next);
    if (weeksInverted(next.from, next.to)) return;
    try {
      window.history.replaceState(null, '', `/office/reports${queryOf(next)}`);
    } catch {
      // the address bar is only a convenience
    }
  }, [urlBranch]);

  const patch = (p: Partial<ReportsUi>) => setUi((u) => ({ ...u, ...p }));

  // A chart tip closes with Escape wherever the focus is (CTL-OFC-11-13).
  const tipShown = ui.tip !== null;
  useEffect(() => {
    if (!tipShown) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUi((u) => ({ ...u, tip: null }));
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [tipShown]);

  const apply = (next: Filters) => {
    setFilters(next);
    if (weeksInverted(next.from, next.to)) return;
    try {
      window.history.replaceState(null, '', `/office/reports${queryOf(next)}`);
    } catch {
      // the address bar is only a convenience
    }
  };

  /** The week selects show the answer's range while the address holds none: picking 1 end keeps the other as shown. */
  const shownWeeks = (): { from: string; to: string } =>
    state.kind === 'ready' ? { from: filters.from || state.data.fromWeek, to: filters.to || state.data.toWeek } : { from: filters.from, to: filters.to };

  const onExport = async () => {
    if (ui.exporting) return;
    patch({ exporting: true, exportFailed: false });
    try {
      const answer = await client.call(reportsExport, { ...requestOf(filters), language: t.lang });
      const text = answer.data;
      // The client reads the answer as text, which drops the file's byte order mark (SPECIFICATIONS 7.5): the saved file carries it again.
      const blob = new Blob([text.startsWith('﻿') ? text : `﻿${text}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = answer.fileName ?? 'reports.csv';
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      patch({ exporting: false });
    } catch {
      patch({ exporting: false, exportFailed: true });
    }
  };

  return (
    <ReportsView
      state={state}
      filters={filters}
      ui={{ ...ui, weekOrder: inverted }}
      on={{
        onBranch: (id) => apply({ ...filters, branch: id, technician: 'all' }),
        onTechnician: (id) => apply({ ...filters, technician: id }),
        onFrom: (week) => apply({ ...filters, ...shownWeeks(), from: week }),
        onTo: (week) => apply({ ...filters, ...shownWeeks(), to: week }),
        onExport: () => void onExport(),
        // The table takes the chart's place, and the tip of a mark that is gone with it.
        onTable: (chart: ChartId) => setUi((u) => ({ ...u, tip: null, tables: { ...u.tables, [chart]: !u.tables[chart] } })),
        // A close names its chart: leaving 1 panel never closes the tip another chart's keyboard focus holds open.
        onTip: (chart, text) => setUi((u) => (text !== null ? (u.tip?.chart === chart && u.tip.text === text ? u : { ...u, tip: { chart, text } }) : u.tip?.chart === chart ? { ...u, tip: null } : u)),
        onRetry: () => load(filters),
      }}
    />
  );
}
