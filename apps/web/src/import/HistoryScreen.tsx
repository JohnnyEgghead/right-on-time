// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-15 Admin: import, history, and SCR-OFC-26 Undo a merge (frame mockups/pages/r1-admin-history.html, DK-100): every run, setup's
// among them (API-82, FR-IMP-10), and every merge with Undo (API-87, API-88, FR-IMP-4).
import '../shell/css/office.ts';
import '../../styles/page-admin-import-history.css';
import '../../styles/page-admin-import.css';
import { importRuns, likelyDuplicates, merges, undoMerge } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnnounce } from '../shell/Announcer.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import { clockOf, dayText, fmtNumber, whenText, type MergeItem, type RunsAnswer, type RunSummary } from './model.ts';
import { BusyLabel, call, Dialog, ImportFrame, type FrameProps } from './ui.tsx';

export type Part<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: T };
/** The merges loaded so far and the total the search matches (API-87 total: "Showing 5 of 1,206 merges"). */
export interface MergesData { items: MergeItem[]; next: string | null; total: number }
export interface HistoryState { runs: Part<RunsAnswer>; merges: Part<MergesData>; dupCount?: number | null }
export interface HistoryUi {
  find: string;
  /** The merge the Undo dialog is open for, and whether Undo is running. */
  dialog: MergeItem | null;
  undoing: boolean;
  message: string | null;
  /** Preview: the dialog is drawn inside its tile. */
  inline?: boolean;
}
export const IDLE_HISTORY_UI: HistoryUi = { find: '', dialog: null, undoing: false, message: null };
export interface HistoryActions {
  onRetryRuns: () => void;
  onRetryMerges: () => void;
  onFind: (v: string) => void;
  onUndo: (m: MergeItem) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onMore: () => void;
}
const NOOP: HistoryActions = { onRetryRuns: () => {}, onRetryMerges: () => {}, onFind: () => {}, onUndo: () => {}, onCancel: () => {}, onConfirm: () => {}, onMore: () => {} };
type Frame = Pick<FrameProps, 'me' | 'clock' | 'appInfo' | 'reader' | 'bar'>;

const STATUS_CHIP: Record<RunSummary['status'], string> = { done: 'ok', running: 'info', failed: 'bad' };
const bold = { b: (chunks: React.ReactNode[]) => <b>{chunks}</b> };

export function HistoryView({ state, ui = IDLE_HISTORY_UI, actions = NOOP, frame = {} }: { state: HistoryState; ui?: HistoryUi; actions?: HistoryActions; frame?: Frame }) {
  const t = useT();
  return (
    <ImportFrame screen="SCR-OFC-15" tab="history" column="mainc" title={t('admin.history.doc')} sub={t('admin.import.sub.history')} dupCount={state.dupCount ?? null} {...frame}>
      <div className="body">
        <RunsPanel part={state.runs} actions={actions} />
        <MergesPanel part={state.merges} ui={ui} actions={actions} />
      </div>
      {ui.dialog ? <UndoDialog m={ui.dialog} ui={ui} actions={actions} /> : null}
    </ImportFrame>
  );
}

function Skeleton() {
  return (
    <div className="bw-padb" aria-busy="true">
      <span className="r1-skel bw-w-40" />
      <span className="r1-skel" />
      <span className="r1-skel" />
    </div>
  );
}

function RunsPanel({ part, actions }: { part: Part<RunsAnswer>; actions: HistoryActions }) {
  const t = useT();
  const n = (v: number) => fmtNumber(v, t.lang);
  return (
    <section className="panel">
      <div className="ph">
        <h3>{t('admin.history.runs')}</h3>
        {part.kind === 'ready' && part.data.realRun ? <span className="s">{t('admin.history.runsNote', { date: dayText(part.data.realRun.finishedAt, t) })}</span> : null}
      </div>
      {part.kind === 'loading' ? <Skeleton /> : null}
      {part.kind === 'error' ? <div className="bw-padb"><ErrorPanel title={t('admin.history.runsFailed')} hint={t('shell.error.checkConnection')} onRetry={actions.onRetryRuns} /></div> : null}
      {part.kind === 'ready' && part.data.runs.length === 0 ? <p className="r1-note bw-n-side">{t('admin.history.noRuns')}</p> : null}
      {part.kind === 'ready' && part.data.runs.length > 0 ? (
        <table className="t" data-ctl="CTL-OFC-15-01">
          <thead>
            <tr>
              <th>{t('admin.history.col.run')}</th>
              <th>{t('admin.history.col.started')}</th>
              <th>{t('admin.history.col.finished')}</th>
              <th>{t('admin.history.col.by')}</th>
              <th>{t('admin.history.col.status')}</th>
              <th>{t('admin.history.col.counts')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {part.data.runs.map((r) => (
              <tr key={r.runId}>
                <td><b>{t(`admin.history.kind.${r.kind}` as MessageKey)}</b></td>
                <td className="n">{whenText(r.startedAt, t.lang, t)}</td>
                <td className="n">{r.finishedAt ? finishedText(r, t) : ''}</td>
                <td {...(r.by.kind === 'user' ? { translate: 'no' as const } : {})}>{r.by.kind === 'setup' ? t('admin.import.bySetup') : r.by.name}</td>
                <td>
                  <span className={`chip ${STATUS_CHIP[r.status]}`}>
                    <span className="dot" />
                    {t(`admin.history.status.${r.status}` as MessageKey)}
                  </span>
                </td>
                <td className="cnts">
                  {r.counts
                    ? r.kind === 'dry_run'
                      ? t.rich('admin.history.countsDry', { ...bold, clean: n(r.counts.customers.clean), flagged: n(r.counts.customers.flagged), problems: n(r.counts.problems) })
                      : t.rich('admin.history.countsReal', { ...bold, customers: n(r.counts.customers.total), visits: n(r.counts.visits.imported), equipment: n(r.counts.equipment.imported) })
                    : null}
                </td>
                <td>
                  {r.kind === 'dry_run' && r.status === 'done' ? (
                    <a className="jl" href={`/office/admin/import?run=${r.runId}`} data-ctl="CTL-OFC-15-02">
                      {t('admin.history.seeReport')}
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function finishedText(r: RunSummary, t: ClientT): string {
  const f = r.finishedAt as string;
  return dayText(f, t) === dayText(r.startedAt, t) ? clockOf(f, t.lang) : whenText(f, t.lang, t);
}

function MergesPanel({ part, ui, actions }: { part: Part<MergesData>; ui: HistoryUi; actions: HistoryActions }) {
  const t = useT();
  return (
    <section className="panel">
      <div className="ph">
        <h3>{t('admin.history.merges')}</h3>
        <span className="s">{t('admin.history.mergesNote')}</span>
        <span className="find" data-ctl="CTL-OFC-15-03">
          <label htmlFor="bw-find-merge">{t('admin.history.find')}</label>
          <span className="r1-input">
            <Icon name="search" />
            <input id="bw-find-merge" type="search" className="bw-search-input" placeholder={t('admin.history.findPlaceholder')} value={ui.find} onChange={(e) => actions.onFind(e.target.value)} />
          </span>
        </span>
      </div>
      {part.kind === 'loading' ? <Skeleton /> : null}
      {part.kind === 'error' ? <div className="bw-padb"><ErrorPanel title={t('admin.history.mergesFailed')} hint={t('shell.error.checkConnection')} onRetry={actions.onRetryMerges} /></div> : null}
      {part.kind === 'ready' && part.data.items.length === 0 ? (
        <p className="r1-note bw-n-side">{ui.find.trim() ? t('admin.history.noMatch', { name: ui.find.trim() }) : t('admin.history.noMerges')}</p>
      ) : null}
      {part.kind === 'ready' && part.data.items.length > 0 ? (
        <>
          <table className="t" data-ctl="CTL-OFC-15-04">
            <thead>
              <tr>
                <th>{t('admin.history.col.records')}</th>
                <th>{t('admin.history.col.how')}</th>
                <th>{t('admin.history.col.when')}</th>
                <th>{t('admin.history.col.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {part.data.items.map((m) => (
                <tr key={m.mergeId}>
                  <td className="pair">
                    <b translate="no">{`${m.records.a.name} + ${m.records.b.name}`}</b>
                    <small translate="no">{m.address}</small>
                  </td>
                  <td>{t(`admin.history.how.${m.kind === 'exact' ? 'exact' : 'office'}` as MessageKey)}</td>
                  <td className="n">{whenText(m.at, t.lang, t)}</td>
                  <td>
                    <span className={m.status === 'active' ? 'chip ok' : 'chip neutral'}>
                      <span className="dot" />
                      {t(`admin.history.mstatus.${m.status}` as MessageKey)}
                    </span>
                  </td>
                  <td>
                    {m.status === 'active' ? (
                      <button type="button" className="btn sm" data-ctl="CTL-OFC-15-05" onClick={() => actions.onUndo(m)}>
                        {t('admin.history.undo')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ft">
            <span>{t('admin.history.showing', { shown: fmtNumber(part.data.items.length, t.lang), total: fmtNumber(part.data.total, t.lang), count: part.data.total })}</span>
            {part.data.next ? (
              <button type="button" className="btn sm" data-ctl="CTL-OFC-15-06" onClick={actions.onMore}>
                {t('admin.history.showMore')}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function UndoDialog({ m, ui, actions = NOOP }: { m: MergeItem; ui: HistoryUi; actions?: HistoryActions }) {
  const t = useT();
  return (
    <Dialog
      screen="SCR-OFC-26"
      {...(ui.inline ? { inline: true } : {})}
      title={t('admin.history.dialog.title')}
      closeCtl="CTL-OFC-26-03"
      onClose={ui.undoing ? () => {} : actions.onCancel}
      body={
        <div data-ctl="CTL-OFC-26-01">
          <p>{t('admin.history.dialog.message', { a: m.records.a.name, b: m.records.b.name })}</p>
          {ui.message ? <p role="alert">{ui.message}</p> : null}
        </div>
      }
      foot={
        <>
          <button type="button" className={ui.undoing ? 'btn dis' : 'btn'} aria-disabled={ui.undoing ? true : undefined} data-initial data-ctl="CTL-OFC-26-03" onClick={ui.undoing ? undefined : actions.onCancel}>
            {t('admin.history.dialog.keep')}
          </button>
          <button type="button" className={ui.undoing ? 'btn busy primary' : 'btn primary'} aria-busy={ui.undoing ? true : undefined} data-ctl="CTL-OFC-26-02" onClick={ui.undoing ? undefined : actions.onConfirm}>
            {ui.undoing ? <BusyLabel>{t('admin.history.dialog.undoing')}</BusyLabel> : t('admin.history.dialog.undo')}
          </button>
        </>
      }
    />
  );
}

const PAGE = 20;

/** The page: API-82 for the runs, API-87 for the merges (Show more pages, Find filters), API-88 for Undo. */
export function HistoryScreen() {
  const t = useT();
  const announce = useAnnounce();
  const [state, setState] = useState<HistoryState>({ runs: { kind: 'loading' }, merges: { kind: 'loading' } });
  const [ui, setUi] = useState<HistoryUi>(IDLE_HISTORY_UI);
  const timer = useRef<number | undefined>(undefined);

  const loadRuns = useCallback(async () => {
    const r = await call(importRuns);
    const d = await call(likelyDuplicates, { status: 'to_check', limit: 1 });
    setState((s) => ({ ...s, dupCount: d.ok ? d.data.progress.left : null, runs: r.ok ? { kind: 'ready', data: r.data } : { kind: 'error' } }));
  }, []);
  const loadMerges = useCallback(async (name: string, cursor?: string) => {
    const r = await call(merges, { limit: PAGE, ...(name.trim() ? { name: name.trim() } : {}), ...(cursor ? { cursor } : {}) });
    setState((s) => {
      if (!r.ok) return { ...s, merges: { kind: 'error' } };
      const before = cursor && s.merges.kind === 'ready' ? s.merges.data.items : [];
      return { ...s, merges: { kind: 'ready', data: { items: [...before, ...r.data.merges], next: r.data.next, total: r.data.total } } };
    });
  }, []);
  useEffect(() => {
    void loadRuns();
    void loadMerges('');
  }, [loadRuns, loadMerges]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const actions: HistoryActions = {
    onRetryRuns: () => void loadRuns(),
    onRetryMerges: () => void loadMerges(ui.find),
    onFind: (v) => {
      setUi((u) => ({ ...u, find: v }));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void loadMerges(v), 300);
    },
    onUndo: (m) => setUi((u) => ({ ...u, dialog: m, message: null })),
    onCancel: () => setUi((u) => ({ ...u, dialog: null, message: null })),
    onMore: () => {
      if (state.merges.kind === 'ready' && state.merges.data.next) void loadMerges(ui.find, state.merges.data.next);
    },
    onConfirm: async () => {
      const m = ui.dialog;
      if (!m || ui.undoing) return;
      setUi((u) => ({ ...u, undoing: true, message: null }));
      const r = await call(undoMerge, { mergeId: m.mergeId });
      if (r.ok || r.code === 'already_undone') {
        setUi((u) => ({ ...u, undoing: false, dialog: null }));
        if (r.ok) announce(t('admin.history.toast.undone'));
        setState((s) => (s.merges.kind === 'ready' ? { ...s, merges: { kind: 'ready', data: { ...s.merges.data, items: s.merges.data.items.map((x) => (x.mergeId === m.mergeId ? { ...x, status: 'undone' as const } : x)) } } } : s));
      } else {
        setUi((u) => ({ ...u, undoing: false, message: t('admin.history.dialog.failed') }));
      }
    },
  };
  return <HistoryView state={state} ui={ui} actions={actions} />;
}
