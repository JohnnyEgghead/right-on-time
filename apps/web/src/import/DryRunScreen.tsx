// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-13 Admin: import, dry run, and SCR-OFC-25 Run the import (frame mockups/pages/admin-import-dryrun.html, DK-98): the latest
// dry run's report (API-81, FR-IMP-6), Run a dry run (API-80), the problem list (API-83), and Run the import (API-84), which is offered
// only on a world with no real run and otherwise disabled with its reason (FR-IMP-10, OA-56, OI-11). The progress line follows EVT-08.
import '../shell/css/office.ts';
import '../../styles/page-admin-import-dryrun.css';
import '../../styles/page-admin-import.css';
import { importRun, importRuns, likelyDuplicates, problemList, startDryRun, startRealRun, subscribeEvents } from '@bw/api';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAnnounce } from '../shell/Announcer.tsx';
import { Icon } from '../shell/Icon.tsx';
import type { MessageKey } from '@bw/i18n';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import {
  barSegments, clampPercent, dayText, failureWords, fmtNumber, reasonFile, reasonFlagged, REASON_ORDER, realRunOffer, runLine, runningRun, shownRun, STAGE_KEY, whenText,
  type RunAnswer, type RunReport, type RunsAnswer, type RunSummary,
} from './model.ts';
import { BusyLabel, call, callFile, Dialog, Fill, ImportFrame, type FrameProps } from './ui.tsx';

export interface DryRunData {
  runs: RunsAnswer;
  /** API-81 of the shown run (the running one, else the newest dry run or the one a report link named). */
  run: RunAnswer | null;
  shown: RunSummary | null;
  dupCount: number | null;
}
export type DryRunState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: DryRunData };
export interface DryRunUi {
  dialog: null | 'asking' | 'starting';
  /** An inline message under the buttons (run_in_progress, a start that failed). */
  notice: string | null;
  downloadFailed: boolean;
  starting: boolean;
  /** Preview: the dialog is drawn inside its tile, as the frame draws it. */
  inline?: boolean;
}
export const IDLE_UI: DryRunUi = { dialog: null, notice: null, downloadFailed: false, starting: false };

export interface DryRunActions {
  onRetry: () => void;
  onDry: () => void;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onDownload: () => void;
}
const NOOP: DryRunActions = { onRetry: () => {}, onDry: () => {}, onAsk: () => {}, onCancel: () => {}, onConfirm: () => {}, onDownload: () => {} };

type Frame = Pick<FrameProps, 'me' | 'clock' | 'appInfo' | 'reader' | 'bar'>;

export function DryRunView({ state, ui = IDLE_UI, actions = NOOP, frame = {} }: { state: DryRunState; ui?: DryRunUi; actions?: DryRunActions; frame?: Frame }) {
  const t = useT();
  const dupCount = state.kind === 'ready' ? state.data.dupCount : null;
  return (
    <ImportFrame screen="SCR-OFC-13" tab="dry" column="main" title={t('admin.import.doc')} sub={t('admin.import.sub.dry')} dupCount={dupCount} {...frame}>
      <Body state={state} ui={ui} actions={actions} />
      {state.kind === 'ready' && ui.dialog ? <RunDialog data={state.data} ui={ui} actions={actions} /> : null}
    </ImportFrame>
  );
}

const bar = (percent: number) => (
  <div className="bar bw-bar">
    <Fill width={`${percent}%`} />
  </div>
);

function Body({ state, ui, actions }: { state: DryRunState; ui: DryRunUi; actions: DryRunActions }) {
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
        <ErrorPanel title={t('admin.import.errorTitle')} hint={t('shell.error.checkConnection')} onRetry={actions.onRetry} />
      </div>
    );
  }
  const { data } = state;
  const offer = realRunOffer(data.runs);
  const running = runningRun(data.runs.runs);
  const dryBtn = (
    <button type="button" className={running || ui.starting ? 'btn dis' : 'btn'} aria-disabled={running || ui.starting ? true : undefined} data-ctl="CTL-OFC-13-04" onClick={running || ui.starting ? undefined : actions.onDry}>
      {running || ui.starting ? null : <Icon name="refresh" />}
      {t('admin.import.runDry')}
    </button>
  );
  const notice = ui.notice ? (
    <p className="r1-note bw-n-t6" role="status">
      {ui.notice}
    </p>
  ) : null;

  // Running: both Run buttons are off (the frame's Running tile).
  if (running && data.run) {
    const real = running.kind === 'real';
    return (
      <div className="body">
        <div data-ctl="CTL-OFC-13-05" role="status">
          <b className="bw-fs14">{t(real ? 'admin.import.running.real' : 'admin.import.running.dry', { percent: data.run.percent, stage: t(STAGE_KEY[data.run.stage]) })}</b>
          {bar(clampPercent(data.run.percent))}
        </div>
        <div className="row bw-mt12">
          {dryBtn}
          <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-13-08">
            {t('admin.import.runReal')}
          </button>
        </div>
        <p className="r1-note bw-n-t6">
          {t('admin.import.running.reason')}
        </p>
      </div>
    );
  }
  if (!data.shown) {
    return (
      <div className="body">
        <div data-ctl="CTL-OFC-13-06">
          <p className="r1-note bw-n-b10">
            {t('admin.import.noDry')}
          </p>
          {dryBtn}
          {notice}
        </div>
        {data.runs.realRun ? <RealDoneRow data={data} /> : null}
      </div>
    );
  }
  if (data.shown.status === 'failed') {
    const word = failureWords(data.run?.failure ?? null, t);
    return (
      <div className="body">
        <div data-ctl="CTL-OFC-13-06">
          <p className="r1-note bw-n-b10">
            {t(data.shown.kind === 'real' ? 'admin.import.failedReal' : 'admin.import.failed', { reason: word })}
          </p>
          {dryBtn}
          {notice}
        </div>
        {data.runs.realRun ? <RealDoneRow data={data} /> : null}
      </div>
    );
  }
  const report = data.run?.report;
  if (!report) return <div className="body" />;
  return <Report data={data} report={report} offer={offer} dryBtn={dryBtn} notice={notice} ui={ui} actions={actions} />;
}

function RealDoneRow({ data }: { data: DryRunData }) {
  const t = useT();
  const real = data.runs.realRun;
  if (!real) return null;
  return (
    <div className="bw-mt12">
      <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-13-08">
        {t('admin.import.runReal')}
      </button>
      <p className="r1-note bw-n-t6">
        {realDoneText(real, t)}
      </p>
    </div>
  );
}

function realDoneText(real: NonNullable<RunsAnswer['realRun']>, t: ReturnType<typeof useT>): string {
  return t('admin.import.realDone', { when: whenText(real.finishedAt, t.lang, t), who: real.by.kind === 'setup' ? t('admin.import.bySetup') : real.by.name });
}

function Report({ data, report, offer, dryBtn, notice, ui, actions }: { data: DryRunData; report: RunReport; offer: ReturnType<typeof realRunOffer>; dryBtn: ReactNode; notice: ReactNode; ui: DryRunUi; actions: DryRunActions }) {
  const t = useT();
  const n = (v: number) => fmtNumber(v, t.lang);
  const shown = data.shown as RunSummary;
  const line = runLine(shown, t.lang, t);
  const c = report.customers;
  const v = report.visits;
  const e = report.equipment;
  const cards = [
    { icon: 'user' as const, label: t('admin.import.card.customers'), note: t('admin.import.card.customersNote'), total: c.total, clean: c.clean, flagged: c.flagged, no: 0 },
    { icon: 'wrench' as const, label: t('admin.import.card.visits'), note: t('admin.import.card.visitsNote'), total: v.total, clean: v.imported, flagged: 0, no: v.notImported },
    { icon: 'flame' as const, label: t('admin.import.card.equipment'), note: t('admin.import.card.equipmentNote'), total: e.total, clean: e.imported, flagged: 0, no: e.notImported },
  ];
  const byReason = new Map(report.problems.byReason.map((r) => [r.reason, r]));
  const chip = (r: (typeof REASON_ORDER)[number]) =>
    reasonFlagged(r) ? (
      <span className="chip flag">
        <span className="dot" />
        {t('admin.import.chip.flagged')}
      </span>
    ) : (
      <span className="chip no">
        <span className="dot" />
        {t('admin.import.chip.no')}
      </span>
    );
  return (
    <div className="body" data-ctl="CTL-OFC-13-06">
      <div className="banner">
        <span className="big">
          <Icon name="info" />
        </span>
        <div>
          <h2>{t('admin.import.banner')}</h2>
          {line ? <p data-ctl="CTL-OFC-13-10">{line}</p> : null}
        </div>
        <div className="acts">
          <button type="button" className="btn" data-ctl="CTL-OFC-13-07" onClick={actions.onDownload}>
            <Icon name="sheet" />
            {t('admin.import.download')}
          </button>
          {dryBtn}
        </div>
      </div>
      {ui.downloadFailed ? (
        <p className="r1-note bw-n-0" role="alert">
          {t('admin.import.downloadFailed')}
        </p>
      ) : null}

      <div className="counts">
        {cards.map((k) => (
          <section className="panel cnt" key={k.label}>
            <div className="l">
              <Icon name={k.icon} />
              {k.label}
              <span>{k.note}</span>
            </div>
            <div className="v">{n(k.total)}</div>
            <div className="sbar">
              {barSegments(k.clean, k.flagged, k.no).map((s) => (
                <Fill key={s.cls} className={s.cls} width={s.width} />
              ))}
            </div>
            <div className="k3">
              <span>
                <i className="c-ok" />
                <b>{n(k.clean)}</b> {t('admin.import.clean')}
              </span>
              <span>
                <i className="c-flag" />
                <b>{n(k.flagged)}</b> {t('admin.import.flagged')}
              </span>
              <span>
                <i className="c-no" />
                <b>{n(k.no)}</b> {t('admin.import.notImported')}
              </span>
            </div>
          </section>
        ))}
      </div>

      <div className="lower">
        <section className="panel">
          <div className="ph">
            <h3>{t('admin.import.problems.title')}</h3>
            <span className="tot">
              <b>{t('admin.import.problems.rows', { count: report.problems.total })}</b>
              {t('admin.import.problems.onList')}
            </span>
          </div>
          <table className="pr">
            <colgroup>
              <col className="bw-col-196" />
              <col className="bw-col-64" />
              <col className="bw-col-162" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>{t('admin.import.problems.reason')}</th>
                <th className="r">{t('admin.import.problems.count')}</th>
                <th>{t('admin.import.problems.what')}</th>
                <th>{t('admin.import.problems.examples')}</th>
              </tr>
            </thead>
            <tbody>
              {REASON_ORDER.map((r) => {
                const row = byReason.get(r);
                return (
                  <tr key={r}>
                    <td className="rs">
                      <b>{t(`admin.import.reason.${r}`)}</b>
                      <small>{t(`admin.import.what.${reasonFile(r)}`)}</small>
                    </td>
                    <td className="r">
                      <b>{n(row?.count ?? 0)}</b>
                    </td>
                    <td>{chip(r)}</td>
                    <td className="ex" data-ctl="CTL-OFC-13-09">
                      {(row?.examples ?? []).map((x) => (
                        <div key={`${x.file}-${x.rowNumber}`}>{`${x.example} ${t(`admin.import.words.${r}` as MessageKey)}`}</div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <div className="rcol">
          <section className="panel">
            <div className="ph">
              <h3>{t('admin.import.dup.title')}</h3>
            </div>
            <div className="dup">
              <div className="big">{n(report.duplicates.total)}</div>
              <div className="row">
                <span>{t('admin.import.dup.exact')}</span>
                <b>{n(report.duplicates.exact)}</b>
              </div>
              <div className="row">
                <span>{t('admin.import.dup.listed')}</span>
                <b>{n(report.duplicates.likely)}</b>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="ph">
              <h3>{t('admin.import.run.title')}</h3>
            </div>
            <div className="run">
              {offer.offered ? (
                <button type="button" className="btn accent" data-ctl="CTL-OFC-13-08" onClick={actions.onAsk}>
                  <Icon name="download" />
                  {t('admin.import.runReal')}
                </button>
              ) : (
                <>
                  <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-13-08">
                    {t('admin.import.runReal')}
                  </button>
                  <p className="r1-note bw-n-t6">
                    {offer.why === 'real_done' && data.runs.realRun ? realDoneText(data.runs.realRun, t) : offer.why === 'running' ? t('admin.import.running.reason') : t('admin.import.run.needDry')}
                  </p>
                </>
              )}
              {offer.offered ? (
                <div className="conf">
                  <b>{t('admin.import.run.confirm')}</b>
                  {t('admin.import.run.adds', { customers: n(c.clean + c.flagged), visits: n(v.imported), equipment: n(e.imported), exact: n(report.duplicates.exact), problems: n(report.problems.total) })}
                  <span data-ctl="CTL-OFC-13-11">{t('admin.import.estimate')}</span>
                </div>
              ) : (
                <div className="conf">
                  <span data-ctl="CTL-OFC-13-11">{t('admin.import.estimate')}</span>
                </div>
              )}
              {notice}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function RunDialog({ data, ui, actions = NOOP }: { data: DryRunData; ui: DryRunUi; actions?: DryRunActions }) {
  const t = useT();
  const r = data.run?.report;
  const shown = data.shown;
  if (!r || !shown) return null;
  const n = (x: number) => fmtNumber(x, t.lang);
  const starting = ui.dialog === 'starting';
  return (
    <Dialog
      screen="SCR-OFC-25"
      {...(ui.inline ? { inline: true } : {})}
      title={t('admin.import.dialog.title')}
      closeCtl="CTL-OFC-25-03"
      onClose={starting ? () => {} : actions.onCancel}
      body={
        <div data-ctl="CTL-OFC-25-01">
          <p>{t('admin.import.dialog.adds', { customers: n(r.customers.clean + r.customers.flagged), visits: n(r.visits.imported), equipment: n(r.equipment.imported), date: dayText(shown.startedAt, t), exact: n(r.duplicates.exact) })}</p>
          <p>{t('admin.import.dialog.rest', { problems: n(r.problems.total), estimate: t('admin.import.estimate') })}</p>
          {ui.notice ? <p role="alert">{ui.notice}</p> : null}
        </div>
      }
      foot={
        <>
          <button type="button" className={starting ? 'btn dis' : 'btn'} aria-disabled={starting ? true : undefined} data-initial data-ctl="CTL-OFC-25-03" onClick={starting ? undefined : actions.onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className={starting ? 'btn busy primary' : 'btn primary'} aria-busy={starting ? true : undefined} data-ctl="CTL-OFC-25-02" onClick={starting ? undefined : actions.onConfirm}>
            {starting ? <BusyLabel>{t('admin.import.dialog.starting')}</BusyLabel> : t('admin.import.dialog.start')}
          </button>
        </>
      }
    />
  );
}

/** The page: reads API-82, API-81 and API-85 (the tab's count), follows the running run (EVT-08, with a poll as the net). */
export function DryRunScreen({ runId }: { runId?: string | null }) {
  const t = useT();
  const announce = useAnnounce();
  const [state, setState] = useState<DryRunState>({ kind: 'loading' });
  const [ui, setUi] = useState<DryRunUi>(IDLE_UI);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const runs = await call(importRuns);
    if (!alive.current) return;
    if (!runs.ok) return setState({ kind: 'error' });
    const target = runningRun(runs.data.runs) ?? shownRun(runs.data.runs, runId);
    const [detail, dups] = await Promise.all([
      target ? call(importRun, { runId: target.runId }) : Promise.resolve(null),
      call(likelyDuplicates, { status: 'to_check', limit: 1 }),
    ]);
    if (!alive.current) return;
    if (detail && !detail.ok) return setState({ kind: 'error' });
    setState({ kind: 'ready', data: { runs: runs.data, run: detail?.ok ? detail.data : null, shown: target, dupCount: dups.ok ? dups.data.progress.left : null } });
  }, [runId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const running = state.kind === 'ready' && runningRun(state.data.runs.runs) !== null;
  useEffect(() => {
    if (!running) return;
    const stream = subscribeEvents({
      onEvent: (e) => {
        if (e.name === 'import.run.changed') void load();
      },
      onReconnect: () => void load(),
    });
    const poll = window.setInterval(() => void load(), 3000);
    return () => {
      stream.close();
      window.clearInterval(poll);
    };
  }, [running, load]);

  const actions: DryRunActions = {
    onRetry: async () => {
      setState({ kind: 'loading' });
      await load();
    },
    onDry: async () => {
      setUi((u) => ({ ...u, starting: true, notice: null }));
      const r = await call(startDryRun, { kind: 'dry_run' });
      setUi((u) => ({ ...u, starting: false, notice: r.ok ? null : r.code === 'run_in_progress' ? t('admin.import.busy') : t('admin.import.startFailed') }));
      await load();
    },
    onAsk: () => setUi((u) => ({ ...u, dialog: 'asking', notice: null })),
    onCancel: () => setUi((u) => ({ ...u, dialog: null, notice: null })),
    onConfirm: async () => {
      setUi((u) => ({ ...u, dialog: 'starting', notice: null }));
      const r = await call(startRealRun, { kind: 'real' });
      if (r.ok) {
        setUi({ ...IDLE_UI });
        announce(t('admin.import.started', { estimate: t('admin.import.estimate') }));
      } else if (r.code === 'real_run_exists') {
        setUi({ ...IDLE_UI });
      } else {
        setUi((u) => ({ ...u, dialog: 'asking', notice: r.code === 'run_in_progress' ? t('admin.import.busy') : t('admin.import.startFailed') }));
      }
      await load();
    },
    onDownload: async () => {
      if (state.kind !== 'ready' || !state.data.shown) return;
      const text = await callFile(problemList, { runId: state.data.shown.runId });
      if (text === null) return setUi((u) => ({ ...u, downloadFailed: true }));
      setUi((u) => ({ ...u, downloadFailed: false }));
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'problem-list.csv';
      a.click();
      URL.revokeObjectURL(url);
    },
  };
  return <DryRunView state={state} ui={ui} actions={actions} />;
}
