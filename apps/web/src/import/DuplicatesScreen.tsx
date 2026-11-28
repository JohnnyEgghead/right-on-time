// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-14 Admin: import, duplicates (frame mockups/pages/admin-import-duplicates.html, DK-99): the review queue (API-85) and the
// shown pair, with Merge, Keep separate and Skip for later (API-86) and their keys M, K and S (FR-IMP-11). The keys act only while the
// shown pair's region has focus: the handler sits on that region and nowhere else (WCAG 2.2 success criterion 2.1.4, OI-32); after each
// decision focus moves to the next shown pair.
import '../shell/css/office.ts';
import '../../styles/page-admin-import-duplicates.css';
import '../../styles/page-admin-import.css';
import { decidePair, importRuns, likelyDuplicates } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useAnnounce } from '../shell/Announcer.tsx';
import { branchById } from '../shell/branches.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { useNewestAnswer } from '../shell/newest-answer.ts';
import { ErrorPanel } from '../shell/Panels.tsx';
import { dateLong, equipmentWord, formatPhone } from '../customers/model.ts';
import { canDecide, decisionForKey, differs, fmtNumber, indexAfter, monthYear, pct, whyParts, whenText, type Decision, type Pair, type PairRecord, type PairsAnswer, type RunsAnswer } from './model.ts';
import { BusyLabel, call, Fill, ImportFrame, type FrameProps } from './ui.tsx';

export type Filter = 'to_check' | 'merged' | 'kept_separate' | 'skipped' | 'all';
const FILTERS: Filter[] = ['to_check', 'merged', 'kept_separate', 'skipped', 'all'];

export interface DupsData {
  progress: PairsAnswer['progress'];
  pairs: Pair[];
  next: string | null;
  filter: Filter;
  index: number;
  /** The import's own counts (API-82): likely duplicates found and exact matches merged; null when no run reported them. */
  found: { total: number; exact: number } | null;
  importedAt: string | null;
}
export type DupsState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: DupsData };
export interface DupsUi {
  deciding: Decision | null;
  message: string | null;
  /** Bumped when focus should move to the shown pair (a pair opened, a decision finished). */
  focusTick: number;
}
export const IDLE_DUPS_UI: DupsUi = { deciding: null, message: null, focusTick: 0 };
export interface DupsActions {
  onRetry: () => void;
  onFilter: (f: Filter) => void;
  onPick: (i: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onDecide: (d: Decision) => void;
}
const NOOP: DupsActions = { onRetry: () => {}, onFilter: () => {}, onPick: () => {}, onPrev: () => {}, onNext: () => {}, onDecide: () => {} };
type Frame = Pick<FrameProps, 'me' | 'clock' | 'appInfo' | 'reader' | 'bar'>;

const CHIP: Record<Pair['status'], string> = { listed: 'todo', merged: 'merged', kept_separate: 'kept', skipped: 'skip' };
const TOTAL: Record<Filter, (p: PairsAnswer['progress']) => number> = {
  to_check: (p) => p.left - p.skipped, merged: (p) => p.merged, kept_separate: (p) => p.keptSeparate, skipped: (p) => p.skipped, all: (p) => p.listed,
};

export function DuplicatesView({ state, ui = IDLE_DUPS_UI, actions = NOOP, frame = {} }: { state: DupsState; ui?: DupsUi; actions?: DupsActions; frame?: Frame }) {
  const t = useT();
  const left = state.kind === 'ready' ? state.data.progress.left : null;
  return (
    <ImportFrame
      screen="SCR-OFC-14"
      tab="dups"
      column="main"
      title={t('admin.dups.doc')}
      sub={state.kind === 'ready' && state.data.importedAt ? t('admin.dups.sub', { date: whenDay(state.data.importedAt, t) }) : t('admin.dups.subNoRun')}
      {...(left !== null ? { dupText: t('admin.dups.left', { count: left }) } : {})}
      {...frame}
    >
      <Body state={state} ui={ui} actions={actions} />
    </ImportFrame>
  );
}

function whenDay(wire: string, t: ClientT): string {
  return whenText(wire, t.lang, t).split(',').slice(0, 2).join(',');
}

function Body({ state, ui, actions }: { state: DupsState; ui: DupsUi; actions: DupsActions }) {
  const t = useT();
  if (state.kind === 'loading') {
    return (
      <div className="body" aria-busy="true">
        <span className="r1-skel bw-w-40" />
        <span className="r1-skel" />
        <span className="r1-skel" />
        <span className="r1-skel" />
        <span className="r1-skel" />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="body">
        <ErrorPanel title={t('admin.dups.errorTitle')} hint={t('shell.error.checkConnection')} onRetry={actions.onRetry} />
      </div>
    );
  }
  const d = state.data;
  const done = d.filter === 'to_check' && d.pairs.length === 0;
  return (
    <div className="body">
      <Summary d={d} />
      {done ? (
        <p className="r1-note bw-n-t10">
          {t('admin.dups.done')}
          {d.progress.skipped > 0 ? t('admin.dups.doneSkipped', { count: d.progress.skipped }) : null}
        </p>
      ) : (
        <div className="work">
          <Queue d={d} actions={actions} />
          {d.pairs[d.index] ? <Shown d={d} pair={d.pairs[d.index]!} ui={ui} actions={actions} /> : <section className="panel cmp"><p className="r1-note bw-n-14">{t('admin.dups.nonePicked')}</p></section>}
        </div>
      )}
    </div>
  );
}

function Summary({ d }: { d: DupsData }) {
  const t = useT();
  const n = (v: number) => fmtNumber(v, t.lang);
  const p = d.progress;
  return (
    <section className="panel sum">
      {d.found ? (
        <>
          <div className="st">
            <b>{n(d.found.total)}</b>
            <span>{t('admin.dups.found')}</span>
          </div>
          <div className="st">
            <b>{n(d.found.exact)}</b>
            <span>{t('admin.dups.exactMerged')}</span>
          </div>
        </>
      ) : null}
      <div className="st">
        <b>{n(p.listed)}</b>
        <span>{t('admin.dups.listed')}</span>
      </div>
      <div className="prog" data-ctl="CTL-OFC-14-01">
        <div className="t">
          <b>{t('admin.dups.checked', { checked: n(p.checked), listed: n(p.listed) })}</b>
          <span>{t('admin.dups.leftShort', { count: n(p.left) })}</span>
        </div>
        <div className="pbar">
          <Fill className="bw-c-merged" width={pct(p.merged, p.listed)} />
          <Fill className="bw-c-kept" width={pct(p.keptSeparate, p.listed)} />
        </div>
        <div className="pk">
          <span>
            <i className="bw-c-merged" />
            {t('admin.dups.merged', { count: n(p.merged) })}
          </span>
          <span>
            <i className="bw-c-kept" />
            {t('admin.dups.kept', { count: n(p.keptSeparate) })}
          </span>
          <span>
            <i className="bw-c-skip" />
            {t('admin.dups.skipped', { count: n(p.skipped) })}
          </span>
        </div>
      </div>
    </section>
  );
}

function Queue({ d, actions }: { d: DupsData; actions: DupsActions }) {
  const t = useT();
  const more = d.filter === 'to_check' ? TOTAL.to_check(d.progress) - d.pairs.length : 0;
  return (
    <section className="panel queue">
      <div className="ph">
        <h3>{t('admin.dups.queue')}</h3>
        <span className="shw bw-overlay" data-ctl="CTL-OFC-14-02">
          {t('admin.dups.show')} <b>{t(`admin.dups.show.${d.filter}` as MessageKey)}</b>
          <Icon name="chevDown" />
          <select value={d.filter} aria-label={t('admin.dups.show')} onChange={(e) => actions.onFilter(e.target.value as Filter)}>
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {t(`admin.dups.show.${f}` as MessageKey)}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div>
        {d.pairs.map((p, i) => (
          <div
            key={p.pairId}
            role="button"
            tabIndex={0}
            data-ctl="CTL-OFC-14-03"
            className={i === d.index ? 'qi now' : 'qi'}
            aria-current={i === d.index ? 'true' : undefined}
            onClick={() => actions.onPick(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                actions.onPick(i);
              }
            }}
          >
            <span className="no">{i + 1}</span>
            <div>
              <b>{`${p.recordA.name} / ${p.recordB.name}`}</b>
              <small>{`${p.recordA.city} - ${p.recordA.street}`}</small>
              <span className={`chip ${CHIP[p.status]}`}>
                <span className="dot" />
                {t(`admin.dups.status.${p.status}` as MessageKey)}
              </span>
            </div>
          </div>
        ))}
      </div>
      {more > 0 ? <div className="qmore">{t('admin.dups.more', { count: more })}</div> : null}
    </section>
  );
}

function whyText(why: string, t: ClientT): string {
  const w = whyParts(why);
  if (w.exact) return t('admin.dups.why.exact');
  const list = (fs: string[]) => new Intl.ListFormat(t.lang, { type: 'conjunction' }).format(fs.map((f) => t(`admin.dups.fact.${f}` as MessageKey)));
  if (w.match.length && w.differ.length) return t('admin.dups.why.matchDiffer', { match: list(w.match), m: w.match.length, differ: list(w.differ), d: w.differ.length });
  if (w.match.length) return t('admin.dups.why.match', { facts: list(w.match), n: w.match.length });
  return t('admin.dups.why.differ', { facts: list(w.differ), n: w.differ.length });
}

interface Row { label: string; a: Cell; b: Cell; same: boolean }
/** A cell's first line and the lines under it (each a <small>, a line of its own). */
type Cell = { main: string; sub?: string[] };

const lines = (all: string[], none: string): Cell => (all.length === 0 ? { main: none } : { main: all[0]!, ...(all.length > 1 ? { sub: all.slice(1) } : {}) });

/** "9 visits, Mar 2020 - Apr 2026", "2 visits, Jul 2021 and May 2023", "1 visit, May 2023"; then "Last: Furnace tune-up, Apr 2, 2026". */
function visitsCell(v: PairRecord['visits'], t: ClientT): Cell {
  const visits = t('admin.dups.visitsCount', { count: v.count });
  if (v.count === 0 || !v.first || !v.last || !v.lastVisit) return { main: visits };
  const [first, last] = [monthYear(v.first, t), monthYear(v.last, t)];
  const main = first === last ? t('admin.dups.visitsOne', { visits, first })
    : v.count === 2 ? t('admin.dups.visitsTwo', { visits, first, last }) : t('admin.dups.visitsSpan', { visits, first, last });
  const service = v.lastVisit.serviceId ? t(`service.${v.lastVisit.serviceId}.screen` as MessageKey) : v.lastVisit.service;
  return { main, sub: [t('admin.dups.lastVisit', { service, date: dateLong(t, v.lastVisit.date) })] };
}

/** The 10 rows of CTL-OFC-14-06 (UI-SPECIFICATION v0.13), in its order; no other row shows (F-870: no Email row). */
export function rowsOf(a: PairRecord, b: PairRecord, t: ClientT): Row[] {
  const none = t('admin.dups.none');
  const phone = (r: PairRecord) => lines(r.phones.map((p) => t(p.kind === 'mobile' ? 'admin.dups.mobile' : 'admin.dups.home', { phone: formatPhone(p.number) })), none);
  const lang = (r: PairRecord) => t(r.textLanguage === 'es' ? 'auth.lang.es' : 'auth.lang.en');
  // The second line in the reader's words, as the customer page prints it ("Upper Arlington, OH 43221"; Spanish "Ohio"): every branch is in Ohio (API-85 state).
  const addr = (r: PairRecord): Cell => ({ main: r.street, sub: [t('customers.address.cityLine', { city: r.city, zip: r.zip })] });
  const equip = (r: PairRecord) => lines(r.equipment.map((e) => [equipmentWord(t, e.type), e.year, e.details].filter((x) => x !== null && x !== '').join(', ')), none);
  const plan = (r: PairRecord) => (r.plan === 'comfort_club' ? t('customers.plan.clubMember') : none);
  const mk = (label: MessageKey, x: Cell, y: Cell): Row => ({ label: t(label), a: x, b: y, same: !differs(JSON.stringify(x), JSON.stringify(y)) });
  return [
    mk('admin.dups.row.name', { main: a.name }, { main: b.name }),
    mk('admin.dups.row.address', addr(a), addr(b)),
    mk('admin.dups.row.phone', phone(a), phone(b)),
    mk('admin.dups.row.language', { main: lang(a) }, { main: lang(b) }),
    mk('admin.dups.row.since', { main: monthYear(a.customerSince, t) }, { main: monthYear(b.customerSince, t) }),
    mk('admin.dups.row.equipment', equip(a), equip(b)),
    mk('admin.dups.row.visits', visitsCell(a.visits, t), visitsCell(b.visits, t)),
    mk('admin.dups.row.branch', { main: branchById(a.branchId).name }, { main: branchById(b.branchId).name }),
    mk('admin.dups.row.plan', { main: plan(a) }, { main: plan(b) }),
    mk('admin.dups.row.notes', { main: a.notes ?? none }, { main: b.notes ?? none }),
  ];
}

function CellView({ c }: { c: Cell }) {
  return (
    <td className="v">
      {c.main}
      {c.sub?.map((s, i) => <small key={i}>{s}</small>)}
    </td>
  );
}

/** "Record A" with its old customer number under it (CTL-OFC-14-06: "Record A, old customer 10288"); none when the record has none. */
function RecordHead({ label, r }: { label: string; r: PairRecord }) {
  const t = useT();
  return (
    <th>
      {label}
      {r.oldCustomerNumber ? <> <small translate="no">{t('admin.dups.oldNumber', { number: r.oldCustomerNumber })}</small></> : null}
    </th>
  );
}

function Shown({ d, pair, ui, actions }: { d: DupsData; pair: Pair; ui: DupsUi; actions: DupsActions }) {
  const t = useT();
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ui.focusTick > 0) region.current?.focus();
  }, [ui.focusTick, pair.pairId]);
  const total = TOTAL[d.filter](d.progress) || d.pairs.length;
  const label = t('admin.dups.pair', { n: d.index + 1, total });
  const busy = ui.deciding !== null;
  const can = (x: Decision) => !busy && canDecide(pair.status, x);
  const btn = (x: Decision, cls: string, ctl: string, text: string, key: string, icon?: boolean) => (
    <button
      type="button"
      className={`btn ${cls}${can(x) || ui.deciding === x ? '' : ' dis'}${ui.deciding === x ? ' busy' : ''}`.replace('  ', ' ')}
      aria-disabled={can(x) ? undefined : true}
      aria-busy={ui.deciding === x ? true : undefined}
      data-ctl={ctl}
      onClick={can(x) ? () => actions.onDecide(x) : undefined}
    >
      {ui.deciding === x ? <BusyLabel>{x === 'merge' ? t('admin.dups.merging') : text}</BusyLabel> : (<>{icon ? <Icon name="check" /> : null}{text}</>)}
      <kbd>{key}</kbd>
    </button>
  );
  return (
    <section
      className="panel cmp"
      tabIndex={0}
      aria-label={label}
      data-ctl="CTL-OFC-14-06"
      ref={region}
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        const x = decisionForKey(e);
        if (x && can(x)) {
          e.preventDefault();
          actions.onDecide(x);
        }
      }}
    >
      <div className="top">
        <div>
          <h2>{t('admin.dups.pairTitle', { n: d.index + 1, total })}</h2>
          <p>{whyText(pair.whyListed, t)}</p>
        </div>
        <div className="nav">
          <button type="button" className={d.index > 0 ? 'btn sm' : 'btn sm dis'} aria-disabled={d.index > 0 ? undefined : true} data-ctl="CTL-OFC-14-07" onClick={d.index > 0 ? actions.onPrev : undefined}>
            <Icon name="chevLeft" />
            {t('admin.dups.prev')}
          </button>
          <button type="button" className={d.index < d.pairs.length - 1 || d.next ? 'btn sm' : 'btn sm dis'} aria-disabled={d.index < d.pairs.length - 1 || d.next ? undefined : true} data-ctl="CTL-OFC-14-08" onClick={actions.onNext}>
            {t('admin.dups.next')}
            <Icon name="chevRight" />
          </button>
        </div>
      </div>
      <table className="c">
        <colgroup>
          <col className="bw-col-128" />
          <col />
          <col />
          <col className="bw-col-84" />
        </colgroup>
        <thead>
          <tr>
            <th />
            <RecordHead label={t('admin.dups.recordA')} r={pair.recordA} />
            <RecordHead label={t('admin.dups.recordB')} r={pair.recordB} />
            <th />
          </tr>
        </thead>
        <tbody>
          {rowsOf(pair.recordA, pair.recordB, t).map((r) => (
            <tr key={r.label} className={r.same ? undefined : 'diff'}>
              <td className="k">{r.label}</td>
              <CellView c={r.a} />
              <CellView c={r.b} />
              <td className="m">
                <span className={r.same ? 'tag same' : 'tag diff'}>{r.same ? t('admin.dups.same') : t('admin.dups.differs')}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="acts">
        {btn('merge', 'primary', 'CTL-OFC-14-04', t('admin.dups.merge'), 'M', true)}
        {btn('keep_separate', '', 'CTL-OFC-14-05', t('admin.dups.keep'), 'K')}
        {btn('skip', 'ghost', 'CTL-OFC-14-09', t('admin.dups.skip'), 'S')}
        <span className="hint">
          <span data-ctl="CTL-OFC-14-10">{t('admin.dups.keys')}</span>{' '}
          <span data-ctl="CTL-OFC-14-11">{t('admin.dups.mergeNote', { visits: t('admin.dups.visitsCount', { count: pair.mergePreview.visits }), equipment: t('admin.dups.equipCount', { count: pair.mergePreview.equipment }) })}</span>
          {ui.message ? <Fragment> <span role="alert">{ui.message}</span></Fragment> : null}
        </span>
      </div>
    </section>
  );
}

/** The page: reads API-85 (the queue, 50 pairs a page) and API-82 (the import's own counts); decides through API-86. */
export function DuplicatesScreen() {
  const t = useT();
  const announce = useAnnounce();
  const [state, setState] = useState<DupsState>({ kind: 'loading' });
  const [ui, setUi] = useState<DupsUi>(IDLE_DUPS_UI);
  const runs = useRef<RunsAnswer | null>(null);

  const newest = useNewestAnswer();
  // K-05: the queue of another filter that lands after a newer filter's is dropped; the runs answer is kept either way (it does not change).
  const load = useCallback(async (filter: Filter, index: number, focus = false) => {
    await newest.run(async () => {
      const [r, rr] = await Promise.all([call(likelyDuplicates, { status: filter, limit: 50 }), runs.current ? Promise.resolve(null) : call(importRuns)]);
      if (rr?.ok) runs.current = rr.data;
      return r;
    }, (r) => {
      if (!r.ok) return setState({ kind: 'error' });
      const real = runs.current?.runs.find((x) => x.kind === 'real' && x.status === 'done') ?? null;
      const done = real ?? runs.current?.runs.find((x) => x.status === 'done') ?? null;
      const rep = done?.counts?.duplicates;
      setState({
        kind: 'ready',
        data: {
          progress: r.data.progress, pairs: r.data.pairs, next: r.data.next, filter, index: Math.max(0, Math.min(index, r.data.pairs.length - 1)),
          found: rep ? { total: rep.total, exact: rep.exact } : null, importedAt: real?.finishedAt ?? null,
        },
      });
      if (focus) setUi((u) => ({ ...u, focusTick: u.focusTick + 1 }));
    });
  }, [newest]);

  useEffect(() => {
    void load('to_check', 0);
  }, [load]);

  const data = state.kind === 'ready' ? state.data : null;
  const actions: DupsActions = {
    onRetry: () => {
      setState({ kind: 'loading' });
      void load('to_check', 0);
    },
    onFilter: (f) => void load(f, 0),
    onPick: (i) => {
      setState((s) => (s.kind === 'ready' ? { kind: 'ready', data: { ...s.data, index: i } } : s));
      setUi((u) => ({ ...u, message: null, focusTick: u.focusTick + 1 }));
    },
    onPrev: () => data && actions.onPick(Math.max(0, data.index - 1)),
    onNext: async () => {
      if (!data) return;
      if (data.index < data.pairs.length - 1) return actions.onPick(data.index + 1);
      if (!data.next) return;
      const more = await call(likelyDuplicates, { status: data.filter, limit: 50, cursor: data.next });
      if (!more.ok) return;
      setState({ kind: 'ready', data: { ...data, pairs: [...data.pairs, ...more.data.pairs], next: more.data.next, index: data.index + 1 } });
      setUi((u) => ({ ...u, focusTick: u.focusTick + 1 }));
    },
    onDecide: async (x) => {
      const pair = data?.pairs[data.index];
      if (!data || !pair || ui.deciding) return;
      setUi((u) => ({ ...u, deciding: x, message: null }));
      const r = await call(decidePair, { pairId: pair.pairId, decision: x });
      if (r.ok) announce(t(`admin.dups.toast.${r.data.pair.status}` as MessageKey));
      const message = r.ok ? null : r.code === 'already_decided' ? t('admin.dups.alreadyDecided') : t('admin.dups.decideFailed');
      await load(data.filter, indexAfter(data.index, data.pairs.length, data.filter), true);
      setUi((u) => ({ ...u, deciding: null, message }));
    },
  };
  return <DuplicatesView state={state} ui={ui} actions={actions} />;
}
