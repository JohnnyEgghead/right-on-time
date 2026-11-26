// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-07 Technicians, the body (frame mockups/pages/office-technicians.html, DK-92): the page header with Add time off and Add technician,
// the search and the 4 filters, the technician table with its load bars and phone apps, the phone app note and the side panel. It draws what it is
// given (the live screen and the preview states both pass data), so every state of the frame is one input (UI-SPECIFICATION SCR-OFC-07 states:
// Loading, Success, Empty, No match, Checking, Problem, Saved, Time off removed, App offline). A select is the frame's `.sel` box with a native
// select laid over it (invisible, the same size), so the box is the frame's and the control is the browser's.
import './technicians-css.ts';
import type { MessageKey } from '@bw/i18n';
import type { KeyboardEvent, ReactNode } from 'react';
import { clock } from '../jobs/jobs-model.ts';
import { BRANCHES, branchById } from '../shell/branches.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import { Panel, type PanelHandlers } from './Panel.tsx';
import {
  APP_PICKS, appWord, filterRows, hoursLine, initials, isFull, loadStep, rightNowChip, saturdayNote, shownApp, skillTags, skillWord, subtitle, WORKING_PICKS,
  type DraftEdit, type Filters, type NameCheckState, type SkillWords, type TechData, type TechRow,
} from './model.ts';

export type TechState = 'loading' | 'ready' | 'error';

interface TechHandlers extends PanelHandlers {
  query?: (text: string) => void;
  branch?: (id: string) => void;
  filterSkill?: (id: string) => void;
  working?: (v: string) => void;
  app?: (v: string) => void;
  select?: (id: string) => void;
  addTechnician?: () => void;
  retry?: () => Promise<unknown> | unknown;
}

export interface TechViewProps {
  state: TechState;
  data: TechData | null;
  /** The branch the list is for (the Branch select's value). */
  branch: string;
  filters: Filters;
  /** The technician open in the panel; null: no panel. */
  selectedId: string | null;
  draft: DraftEdit | null;
  check: NameCheckState;
  saving?: boolean;
  removing?: string | null;
  notice?: string | null;
  words?: SkillWords;
  /** A dialog or toast the screen hosts (the live page's open dialog; the preview's hosted state). */
  extra?: ReactNode;
  handlers?: TechHandlers;
}

/** The frame's `.sel` box with a native select over it. */
function Pick({ ctl, label, valueText, value, onChange, children }: {
  ctl: string; label: string; valueText: string; value: string; onChange?: ((v: string) => void) | undefined; children: ReactNode;
}) {
  return (
    <span className="sel" data-ctl={ctl}>
      <span className="k">{label}</span>
      <b>{valueText}</b>
      <Icon name="chevDown" />
      <select aria-label={label} value={value} onChange={(e) => onChange?.(e.target.value)}>
        {children}
      </select>
    </span>
  );
}

/** One row's Phone app cell (CTL-OFC-07-01): the report of the app with items waiting, else the latest; kept while the app is offline. */
function AppCell({ row }: { row: TechRow }) {
  const t = useT();
  const s = shownApp(row);
  if (!s) {
    return (
      <span className="app">
        <span>{t('technicians.app.none')}<small>{t(row.userStatus === 'invited' ? 'technicians.app.noInvite' : 'technicians.app.noReport')}</small></span>
      </span>
    );
  }
  const time = clock(s.report.lastSyncAt, t.lang);
  if (s.report.waitingCount > 0) {
    return (
      <span className="app wait">
        <Icon name="cloud" />
        <span>{t('technicians.app.waiting', { n: s.report.waitingCount })}<small>{t('technicians.app.noSignal', { time })}</small></span>
      </span>
    );
  }
  return (
    <span className="app ok">
      <Icon name="check" />
      <span>{t('technicians.app.synced', { app: t(appWord(s.kind)), time })}<small>{t('technicians.app.nothing')}</small></span>
    </span>
  );
}

function RowView({ row, picked, words, onPick }: { row: TechRow; picked: boolean; words: SkillWords | undefined; onPick?: ((id: string) => void) | undefined }) {
  const t = useT();
  const chip = rightNowChip(row);
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick?.(row.id);
    }
  };
  return (
    <tr role="button" tabIndex={0} aria-pressed={picked} data-ctl="CTL-OFC-07-02" {...(picked ? { className: 'pick' } : {})} onClick={() => onPick?.(row.id)} onKeyDown={key}>
      <td>
        <span className="who">
          <span className="av">{initials(row.name)}</span>
          <span className="two">
            <b>{row.name}</b>
            <small>
              {t(row.van ? 'technicians.van' : 'technicians.noVan', { van: row.van?.number ?? '' })} -{' '}
              <span className={row.userStatus === 'invited' ? 'us inv' : row.userStatus === 'turned_off' ? 'us off' : 'us'}>{t(`technicians.status.${row.userStatus}` as MessageKey)}</span>
            </small>
          </span>
        </span>
      </td>
      <td><span className="tags">{skillTags(row, t, words).map((s, i) => <span key={i} className="tag">{s}</span>)}</span></td>
      <td>{branchById(row.branch).name}</td>
      <td><span className="two">{hoursLine(row, t)}<small>{t(saturdayNote(row))}</small></span></td>
      <td>
        <span className="load">
          <span className="n">{t('technicians.load', { n: row.todayLoad, capacity: row.capacity })}</span>
          <span className="bar"><i className={isFull(row) ? `full bw-tc-w${loadStep(row.todayLoad, row.capacity)}` : `bw-tc-w${loadStep(row.todayLoad, row.capacity)}`} /></span>
          {chip ? (
            <>
              <span className={`chip ${chip.cls}`} data-ctl="CTL-OFC-07-22"><span className="dot" />{t(chip.key)}</span>
              {chip.timing ? <span className={`chip ${chip.timing}`}><span className="dot" />{t(chip.timing === 'late' ? 'status.timing.late' : 'status.timing.atRisk')}</span> : null}
            </>
          ) : null}
        </span>
      </td>
      <td><AppCell row={row} /></td>
    </tr>
  );
}

export function TechniciansView(p: TechViewProps) {
  const t = useT();
  const h = p.handlers ?? {};
  const { data } = p;
  const ready = p.state === 'ready' && data ? data : null;
  const branchName = branchById(p.branch).name;
  const rows = ready ? filterRows(ready.technicians, p.filters) : [];
  const selected = ready && p.selectedId ? ready.technicians.find((r) => r.id === p.selectedId) ?? null : null;
  const sub = ready ? subtitle(ready, branchName, clock(ready.readAt, t.lang), t) : branchName;
  const none = ready && ready.technicians.length === 0;
  const skillText = p.filters.skill === '' ? t('technicians.all') : skillWord(t, p.filters.skill, p.words);

  return (
    <>
      <div className="pgh">
        <div>
          <h1>{t('technicians.title')}</h1>
          <p data-ctl="CTL-OFC-07-25">{sub}</p>
        </div>
        <div className="acts">
          <button type="button" className={selected ? 'btn' : 'btn dis'} aria-disabled={!selected || undefined} data-ctl="CTL-OFC-07-12" onClick={() => { if (selected) h.addTimeOff?.(); }}>
            <Icon name="calendar" />
            {t('technicians.addTimeOff')}
          </button>
          <button type="button" className="btn primary" data-ctl="CTL-OFC-07-13" onClick={h.addTechnician}>
            <Icon name="plus" />
            {t('technicians.add')}
          </button>
        </div>
      </div>

      <div className="filters">
        <div className="sbox" data-ctl="CTL-OFC-07-14">
          <Icon name="search" />
          <input type="text" aria-label={t('technicians.search')} placeholder={t('technicians.search')} value={p.filters.query} autoComplete="off" spellCheck={false} onChange={(e) => h.query?.(e.target.value)} />
        </div>
        <Pick ctl="CTL-OFC-07-21" label={t('technicians.filter.branch')} valueText={branchName} value={p.branch} onChange={h.branch}>
          {BRANCHES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Pick>
        <Pick ctl="CTL-OFC-07-15" label={t('technicians.filter.skill')} valueText={skillText} value={p.filters.skill} onChange={h.filterSkill}>
          <option value="">{t('technicians.all')}</option>
          {(data?.skills ?? []).map((s) => <option key={s} value={s}>{skillWord(t, s, p.words)}</option>)}
        </Pick>
        <Pick ctl="CTL-OFC-07-16" label={t('technicians.filter.working')} valueText={t(`technicians.working.${p.filters.working || 'all'}` as MessageKey)} value={p.filters.working} onChange={h.working}>
          {WORKING_PICKS.map((w) => <option key={w} value={w}>{t(`technicians.working.${w || 'all'}` as MessageKey)}</option>)}
        </Pick>
        <Pick ctl="CTL-OFC-07-17" label={t('technicians.filter.app')} valueText={t(`technicians.appPick.${p.filters.app || 'all'}` as MessageKey)} value={p.filters.app} onChange={h.app}>
          {APP_PICKS.map((a) => <option key={a} value={a}>{t(`technicians.appPick.${a || 'all'}` as MessageKey)}</option>)}
        </Pick>
      </div>

      {p.state === 'error' ? (
        <div className="bw-tc-state">
          <ErrorPanel title={t('technicians.error.title')} hint={t('shell.error.checkConnection')} onRetry={h.retry ?? (() => undefined)} />
        </div>
      ) : p.state === 'loading' || !ready ? (
        <div className="bw-tc-state" aria-busy="true">
          <span className="r1-skel bw-tc-w30" />
          <span className="r1-skel" />
          <span className="r1-skel" />
          <span className="r1-skel" />
          <span className="r1-skel" />
          <span className="r1-skel" />
        </div>
      ) : none ? (
        <div className="bw-tc-state">
          <p className="r1-note">{t('technicians.empty', { branch: branchName })}</p>
          <button type="button" className="btn primary bw-tc-addempty" data-ctl="CTL-OFC-07-13" onClick={h.addTechnician}>
            <Icon name="plus" />
            {t('technicians.add')}
          </button>
        </div>
      ) : (
        <div className={selected ? 'body' : 'body bw-tc-nopanel'}>
          <div className="lcol">
            {rows.length === 0 ? (
              <div className="bw-tc-state"><p className="r1-note">{t('technicians.noMatch')}</p></div>
            ) : (
              <div className="tbl">
                <table data-ctl="CTL-OFC-07-01">
                  <thead>
                    <tr>
                      <th>{t('technicians.col.tech')}</th><th>{t('technicians.col.skills')}</th><th>{t('technicians.col.branch')}</th><th>{t('technicians.col.hours')}</th>
                      <th>{t('technicians.col.today')}</th><th>{t('technicians.col.app')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => <RowView key={r.id} row={r} picked={r.id === p.selectedId} words={p.words} onPick={h.select} />)}
                  </tbody>
                </table>
              </div>
            )}
            <div className="foot" data-ctl="CTL-OFC-07-23">
              <Icon name="cloud" />
              <div>{t.rich('technicians.foot', { b: (c) => <b>{c}</b> })}</div>
            </div>
          </div>
          {selected && p.draft ? (
            <Panel row={selected} data={ready} draft={p.draft} check={p.check} {...(p.saving !== undefined ? { saving: p.saving } : {})}
              removing={p.removing ?? null} notice={p.notice ?? null} {...(p.words ? { words: p.words } : {})} handlers={h} />
          ) : null}
        </div>
      )}
      {p.extra}
    </>
  );
}
