// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-30 Jobs, the body (frame mockups/pages/office-jobs.html, DK-88): the page header with the Live indicator, Export to spreadsheet and
// New job, the tabs with their counts and the Sort select, the search and the 5 filters, the jobs table with its group rows and the pager.
// It draws what it is given (the live screen and the preview states both pass data), so every state of the frame is one input
// (UI-SPECIFICATION SCR-OFC-30 states: Loading, Success, Empty tab, No results, Exporting, Error, Live row).
// A select is the frame's `.sel` box with a native select laid over it (invisible, the same size), so the box is the frame's and the
// control is the browser's.
import './jobs-css.ts';
import { PAGE_SIZE, type JobTab } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRANCHES, branchById } from '../shell/branches.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { ErrorPanel, LiveIndicator, StatusLabel, type LiveState } from '../shell/Panels.tsx';
import {
  chipOf, clock, countOf, dateOptions, dateValue, dayCell, dayText, detailText, EMPTY_KEY, groupText, initialsOf, pageButtons, sections, subtitle, TAB_BADGE,
  TAB_LABEL, whenKey, windowText, type DatePick, type JobRow, type JobsData, type SortPick, type T,
} from './jobs-model.ts';

export type JobsState = 'loading' | 'ready' | 'error';

interface JobsHandlers {
  tab?: (tab: JobTab) => void;
  query?: (text: string) => void;
  /** Enter in the search box: read now, without the typing pause. */
  search?: () => void;
  date?: (date: DatePick) => void;
  branch?: (branch: string) => void;
  technician?: (id: string) => void;
  status?: (status: string) => void;
  service?: (id: string) => void;
  sort?: (sort: SortPick) => void;
  clear?: () => void;
  page?: (page: number) => void;
  export?: () => void;
  retry?: () => Promise<unknown> | unknown;
  refresh?: () => void;
}

export interface JobsViewProps {
  state: JobsState;
  data: JobsData | null;
  /** The branch the list is for (the Branch select's value). */
  branch: string;
  tab: JobTab;
  query: string;
  date: DatePick;
  technicianId: string;
  status: string;
  serviceId: string;
  sort: SortPick;
  page: number;
  live: LiveState;
  exporting?: boolean;
  exportFailed?: boolean;
  /** A row shown as just changed (the Live row state). */
  changed?: ReadonlySet<number>;
  /** The preview states say a service in the frame's own words (the frame draws services the seed does not have). */
  serviceWords?: Readonly<Record<'en' | 'es', Readonly<Record<string, string>>>>;
  handlers?: JobsHandlers;
}

const STATUSES = ['scheduled', 'on_the_way', 'on_site', 'done', 'no_one_home', 'canceled'] as const;
const STATUS_WORD: Record<(typeof STATUSES)[number], MessageKey> = {
  scheduled: 'status.job.scheduled', on_the_way: 'status.job.onTheWay', on_site: 'status.job.onSite', done: 'status.job.done',
  no_one_home: 'status.job.noOneHome', canceled: 'status.job.canceled',
};

/** The frame's busy button is a primary button (a white spinner on teal). */
const Spinner = () => <span className="r1-spin" />;

/** The frame's `.sel` box with a native select over it. */
function Pick({ ctl, label, valueText, value, onChange, icon, children }: {
  ctl: string; label: string; valueText: string; value: string; onChange?: ((v: string) => void) | undefined; icon?: boolean; children: ReactNode;
}) {
  return (
    <span className="sel" data-ctl={ctl}>
      {icon ? <Icon name="calendar" /> : null}
      <span className="k">{label}</span>
      <b>{valueText}</b>
      <Icon name="chevDown" />
      <select aria-label={label} value={value} onChange={(e) => onChange?.(e.target.value)}>
        {children}
      </select>
    </span>
  );
}

const serviceText = (t: T, id: string, words: JobsViewProps['serviceWords'], lang: 'en' | 'es'): string => words?.[lang][id] ?? t(`service.${id}.screen` as MessageKey);

export function JobsView(p: JobsViewProps) {
  const t = useT();
  const h = p.handlers ?? {};
  const { data } = p;
  const ready = p.state === 'ready' && data ? data : null;
  const branchName = branchById(p.branch).name;
  const filtersSet = p.query.trim() !== '' || p.date !== 'upcoming' || p.technicianId !== '' || p.status !== '' || p.serviceId !== '';
  const lang = t.lang;
  const sub = ready ? subtitle(ready, p.date, branchName, clock(ready.asOf, lang), t) : branchName;
  const services = data
    ? [...data.filters.services].sort((a, b) => serviceText(t, a, p.serviceWords, lang).localeCompare(serviceText(t, b, p.serviceWords, lang), lang))
    : [];
  const technicianName = data?.filters.technicians.find((x) => x.id === p.technicianId)?.name;

  return (
    <>
      <div className="pgh">
        <div className="row">
          <div>
            <h1>{t('jobs.title')}</h1>
            <p data-ctl="CTL-OFC-30-18">{sub}</p>
          </div>
          <div className="acts">
            <LiveIndicator state={p.live} {...(h.refresh ? { onRefresh: h.refresh } : {})} />
            {p.exporting ? (
              <button type="button" className="btn busy primary" aria-busy="true" data-ctl="CTL-OFC-30-13">
                <Spinner />
                {t('jobs.export.busy')}
              </button>
            ) : (
              <button type="button" className="btn" data-ctl="CTL-OFC-30-13" disabled={!ready || ready.total === 0} onClick={h.export}>
                <Icon name="sheet" />
                {t('jobs.export')}
              </button>
            )}
            <Link className="btn primary" href="/office/jobs/new" data-ctl="CTL-OFC-30-14">
              <Icon name="plus" />
              {t('jobs.new')}
            </Link>
          </div>
        </div>
        <div className="tabsrow">
          <div className="tabs" role="tablist" aria-label={t('jobs.tabs.label')} data-ctl="CTL-OFC-30-01">
            {(Object.keys(TAB_LABEL) as JobTab[]).map((tab) => (
              <a
                key={tab}
                role="tab"
                href={tab === 'all' ? '/office/jobs' : `/office/jobs?tab=${tab}`}
                aria-selected={p.tab === tab}
                {...(p.tab === tab ? { className: 'on' } : {})}
                onClick={(e) => {
                  e.preventDefault();
                  h.tab?.(tab);
                }}
              >
                {t(TAB_LABEL[tab])}
                {data ? (
                  <>
                    {' '}
                    <span className={TAB_BADGE[tab] ? `n ${TAB_BADGE[tab]}` : 'n'}>{countOf(data, tab)}</span>
                  </>
                ) : null}
              </a>
            ))}
          </div>
          <span className="sortb">
            <span className="cnt" data-ctl="CTL-OFC-30-08">
              {t(p.sort === 'window' ? 'jobs.sort.note.window' : 'jobs.sort.note.attention')}
            </span>
            <Pick
              ctl="CTL-OFC-30-19"
              label={t('jobs.sort.k')}
              valueText={t(p.sort === 'window' ? 'jobs.sort.window' : 'jobs.sort.attention')}
              value={p.sort}
              onChange={(v) => h.sort?.(v === 'window' ? 'window' : 'attention')}
            >
              <option value="attention">{t('jobs.sort.attention')}</option>
              <option value="window">{t('jobs.sort.window')}</option>
            </Pick>
          </span>
        </div>
      </div>

      <div className="filters">
        <div className="sbox" data-ctl="CTL-OFC-30-02">
          <Icon name="search" />
          <input
            type="text"
            aria-label={t('jobs.search.label')}
            placeholder={t('jobs.search.placeholder')}
            value={p.query}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => h.query?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') h.search?.();
            }}
          />
        </div>
        <Pick ctl="CTL-OFC-30-03" label={t('jobs.filter.date')} valueText={dateValue(p.date, t)} value={p.date} icon onChange={h.date}>
          <option value="upcoming">{t('jobs.date.upcoming')}</option>
          <option value="today">{t('jobs.date.today')}</option>
          {data ? dateOptions(data.today, p.date).map((d) => <option key={d} value={d}>{dayText(d, t)}</option>) : null}
        </Pick>
        <Pick
          ctl="CTL-OFC-30-04"
          label={t('jobs.filter.branch')}
          valueText={branchName}
          value={p.branch}
          onChange={h.branch}
        >
          {BRANCHES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Pick>
        <Pick
          ctl="CTL-OFC-30-05"
          label={t('jobs.filter.technician')}
          valueText={technicianName ?? t('jobs.filter.all')}
          value={p.technicianId}
          onChange={h.technician}
        >
          <option value="">{t('jobs.filter.all')}</option>
          {data?.filters.technicians.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Pick>
        <Pick
          ctl="CTL-OFC-30-06"
          label={t('jobs.filter.status')}
          valueText={p.status === '' ? t('jobs.filter.all') : t(STATUS_WORD[p.status as (typeof STATUSES)[number]])}
          value={p.status}
          onChange={h.status}
        >
          <option value="">{t('jobs.filter.all')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_WORD[s])}</option>)}
        </Pick>
        <Pick
          ctl="CTL-OFC-30-07"
          label={t('jobs.filter.service')}
          valueText={p.serviceId === '' ? t('jobs.filter.all') : serviceText(t, p.serviceId, p.serviceWords, lang)}
          value={p.serviceId}
          onChange={h.service}
        >
          <option value="">{t('jobs.filter.all')}</option>
          {services.map((s) => <option key={s} value={s}>{serviceText(t, s, p.serviceWords, lang)}</option>)}
        </Pick>
        {filtersSet ? (
          <button type="button" className="btn sm" data-ctl="CTL-OFC-30-09" onClick={h.clear}>
            {t('jobs.clear')}
          </button>
        ) : null}
      </div>

      {p.exportFailed ? (
        <div className="r1-fmsg bw-jb-msg" role="alert">
          <Icon name="alert" />
          {t('jobs.export.failed')}
        </div>
      ) : null}

      {p.state === 'error' ? (
        <div className="bw-jb-state">
          <ErrorPanel title={t('jobs.error.title')} hint={t('shell.error.checkConnection')} onRetry={h.retry ?? (() => undefined)} />
        </div>
      ) : null}
      {p.state === 'loading' ? (
        <div className="bw-jb-state" aria-busy="true">
          <div className="bw-jb-skel">
            <span className="r1-skel bw-jb-w30" />
            <span className="r1-skel" />
            <span className="r1-skel" />
            <span className="r1-skel" />
            <span className="r1-skel" />
          </div>
        </div>
      ) : null}
      {ready ? <Body p={p} data={ready} filtersSet={filtersSet} /> : null}
    </>
  );
}

function Body({ p, data, filtersSet }: { p: JobsViewProps; data: JobsData; filtersSet: boolean }) {
  const t = useT();
  const h = p.handlers ?? {};
  if (data.rows.length === 0) {
    const text = filtersSet
      ? p.query.trim() !== '' ? t('jobs.noResults.query', { query: p.query.trim() }) : t('jobs.noResults.filters')
      : p.tab === 'not-in-billing' ? t(EMPTY_KEY[p.tab]) : t(EMPTY_KEY[p.tab], { when: t(whenKey(p.date)) });
    return (
      <div className="bw-jb-state">
        <p className={filtersSet ? 'r1-note bw-jb-note nr' : 'r1-note bw-jb-note'}>{text}</p>
        {p.tab === 'not-in-billing' ? <BillingLink branch={p.branch} /> : null}
      </div>
    );
  }
  const { sections: groups, showGroups } = sections(data.rows, data.today, p.sort);
  const from = (p.page - 1) * PAGE_SIZE + 1;
  const to = from + data.rows.length - 1;
  return (
    <>
      <div className="tbl">
        <table data-ctl="CTL-OFC-30-10">
          <thead>
            <tr>
              <th>{t('jobs.col.job')}</th>
              <th>{t('jobs.col.customer')}</th>
              <th>{t('jobs.col.service')}</th>
              <th>{t('jobs.col.window')}</th>
              <th>{t('jobs.col.technician')}</th>
              <th>{t('jobs.col.status')}</th>
              <th>{t('jobs.col.bookedBy')}</th>
              <th>{t('jobs.col.billing')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => [
              showGroups ? (
                <tr key={`g-${g.group}-${g.rows[0]!.jobNumber}`} className="day" data-ctl="CTL-OFC-30-17">
                  <td colSpan={8}>{groupText(g.group, data.today, t)}</td>
                </tr>
              ) : null,
              ...g.rows.map((r) => <JobLine key={r.jobNumber} r={r} p={p} today={data.today} live={p.changed?.has(r.jobNumber) ?? false} />),
            ])}
          </tbody>
        </table>
      </div>
      {p.tab === 'not-in-billing' ? <BillingLink branch={p.branch} /> : null}
      <div className="pager" data-ctl="CTL-OFC-30-12">
        <span>{t('jobs.pager.showing', { from, to, total: data.total })}</span>
        {data.pages > 1 ? (
          <div className="pp" role="group" aria-label={t('jobs.pager.label')}>
            <PageButton label={t('jobs.pager.prev')} disabled={p.page <= 1} onPress={() => h.page?.(p.page - 1)}>
              <Icon name="chevLeft" />
            </PageButton>
            {pageButtons(p.page, data.pages).map((n, i) =>
              n === 'gap' ? (
                <span key={`gap-${i}`}>...</span>
              ) : (
                <PageButton key={n} label={t('jobs.pager.page', { n })} current={n === p.page} onPress={() => h.page?.(n)}>
                  {n}
                </PageButton>
              ),
            )}
            <PageButton label={t('jobs.pager.next')} disabled={p.page >= data.pages} onPress={() => h.page?.(p.page + 1)}>
              <Icon name="chevRight" />
            </PageButton>
          </div>
        ) : null}
      </div>
    </>
  );
}

function BillingLink({ branch }: { branch: string }) {
  const t = useT();
  return (
    <p className="bw-jb-linkp">
      <Link className="r1-link" href={`/office/billing?${new URLSearchParams({ branch }).toString()}`} data-ctl="CTL-OFC-30-15">
        {t('jobs.billingLink')}
      </Link>
    </p>
  );
}

function PageButton({ label, current, disabled, onPress, children }: { label: string; current?: boolean; disabled?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <span
      className={current ? 'b on' : 'b'}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      {...(disabled ? { 'aria-disabled': true } : {})}
      onClick={() => {
        if (!disabled && !current) onPress();
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled && !current) {
          e.preventDefault();
          onPress();
        }
      }}
    >
      {children}
    </span>
  );
}

function bookedBy(r: JobRow, t: T): { icon: 'globe' | 'phone' | 'clock'; text: string } {
  if (r.bookedVia === 'online') return { icon: 'globe', text: t('jobs.by.online') };
  if (r.bookedVia === 'office') return { icon: 'phone', text: r.bookedBy ? t('jobs.by.officePerson', { who: shortWho(r.bookedBy) }) : t('jobs.by.office') };
  return { icon: 'clock', text: t('jobs.by.seed') };
}

/** "Keisha Thompson" -> "Keisha T." */
function shortWho(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length < 2 ? name.trim() : `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

function Billing({ r }: { r: JobRow }) {
  const t = useT();
  const lang = t.lang;
  if (r.billingState === 'retrying' || r.billingState === 'waiting_person') {
    return (
      <span className="st">
        <span className="chip bill">
          <Icon name="alert" className="bw-jb-ic13" />
          {t('jobs.billing.notIn')}
        </span>
        <small>{r.billingState === 'retrying' ? t('jobs.billing.retrying', { tries: r.billingTries }) : t('jobs.billing.waiting_person')}</small>
      </span>
    );
  }
  if ((r.billingState === 'in_billing' || r.billingState === 'marked_fixed') && r.billedAt) {
    return (
      <span className="bl ok">
        <Icon name="check" />
        {t(r.billingState === 'in_billing' ? 'jobs.billing.in_billing' : 'jobs.billing.marked_fixed', { time: clock(r.billedAt, lang) })}
      </span>
    );
  }
  if (r.status === 'canceled') return <span className="bl">-</span>;
  const word: MessageKey = r.billingState === 'sending' ? 'jobs.billing.sending' : r.billingState === 'in_billing' ? 'jobs.csv.billing.in_billing'
    : r.billingState === 'marked_fixed' ? 'jobs.csv.billing.marked_fixed' : 'jobs.billing.not_sent';
  return <span className="bl">{t(word)}</span>;
}

/** F-1652: the job's own problem words when it has them (1 line, cut with an ellipsis, the full words as the title and name), else the catalog word. */
const serviceCell = (r: JobRow, catalog: string): ReactNode =>
  r.problem !== null && r.problem.trim() !== '' ? <span className="bw-jb-svc" title={r.problem} aria-label={r.problem}>{r.problem}</span> : catalog;

function JobLine({ r, p, today, live }: { r: JobRow; p: JobsViewProps; today: string; live: boolean }) {
  const t = useT();
  const by = bookedBy(r, t);
  const detail = detailText(r, t, t.lang);
  return (
    <tr {...(live ? { className: 'live' } : {})}>
      <td className="jn">
        <Link className="jl" href={`/office/jobs/${r.jobNumber}`} data-ctl="CTL-OFC-30-11">
          {r.jobNumber}
        </Link>
      </td>
      <td>
        <div className="two">
          <b>{r.customer}</b>
          <small>{r.area}</small>
        </div>
      </td>
      <td>{serviceCell(r, serviceText(t, r.service, p.serviceWords, t.lang))}</td>
      <td>
        <div className="two">
          <b>{windowText(r)}</b>
          <small>{dayCell(r, today, t)}</small>
        </div>
      </td>
      <td>
        {r.technician ? (
          <span className="who">
            <span className="av">{initialsOf(r.technician)}</span>
            {r.technician}
          </span>
        ) : (
          <span className="who none">
            <span className="av">?</span>
            {t('jobs.noTechnician')}
          </span>
        )}
      </td>
      <td>
        <span className="st">
          <StatusLabel status={chipOf(r)} />
          {detail ? <small data-ctl="CTL-OFC-30-16">{detail}</small> : null}
        </span>
      </td>
      <td>
        <span className="by" data-ctl="CTL-OFC-30-20">
          <Icon name={by.icon} />
          {by.text}
        </span>
      </td>
      <td>
        <Billing r={r} />
      </td>
    </tr>
  );
}
