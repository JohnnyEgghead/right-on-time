// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-05 Customer search, the screen below the office top bar (frame mockups/pages/office-customer-search.html, DK-90; the markup
// of its Results frame and of its Empty, Searching, Preview loading, Preview error, No results and Error tiles). Presentational: the
// container (SearchScreen.tsx) holds the query and runs API-34 and API-35; the harness preview routes hand it fixed data.
import './customers-css.ts';
import type { MessageKey } from '@bw/i18n';
import Link from 'next/link';
import { Fragment, type KeyboardEvent } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import { BRANCHES } from '../shell/branches.ts';
import {
  dateLong, dayShort, equipmentLine, filtersSet, formatPhone, initialsOf, lineWord, markParts, shortName, windowText, type SearchFilters,
} from './model.ts';
import type { CustomerPage, Detail, JobHit, SearchHit } from './types.ts';

export type SearchPhase = 'empty' | 'searching' | 'results' | 'none' | 'error';
/** CTL-OFC-05-15's read (API-133): the jobs found, or that the read failed; null while there is nothing to show. */
export type JobsFound = { kind: 'found'; rows: readonly JobHit[] } | { kind: 'failed' } | null;
export type PreviewState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: Detail } | { kind: 'none' };

export interface SearchViewProps {
  phase: SearchPhase;
  query: string;
  filters: SearchFilters;
  page: CustomerPage | null;
  /** All customers (the unfiltered total): the subtitle's count; null leaves the count out (CTL-OFC-05-19). */
  allTotal: number | null;
  cities: readonly string[];
  selectedId: string | null;
  /** The branch the filter starts on (the top bar's): not counted as a filter that is set (the frame shows Columbus with Clear filters off). */
  homeBranch?: string | null;
  preview: PreviewState;
  moreFailed?: boolean;
  jobs?: JobsFound;
  onQuery: (q: string) => void;
  onFilters: (f: SearchFilters) => void;
  onClear: () => void;
  onClearFilters: () => void;
  onSelect: (id: string) => void;
  onMore: () => void;
  onRetry: () => void;
  onRetryPreview: () => void;
  onNew: () => void;
  onNewJob: (customerId: string) => void;
}

/** CTL-OFC-05-15: "Also found in jobs: Job 24866 - Sean O'Brien, furnace tune-up, Thu, Sep 17." Each Job <n> opens SCR-OFC-03; no match hides the line. */
function AlsoFound({ jobs }: { jobs: JobsFound | undefined }) {
  const t = useT();
  if (!jobs) return null;
  if (jobs.kind === 'failed') return <div className="also" data-ctl="CTL-OFC-05-15" role="alert"><Icon name="note" />{t('customers.also.error')}</div>;
  if (jobs.rows.length === 0) return null;
  return (
    <div className="also" data-ctl="CTL-OFC-05-15">
      <Icon name="note" />
      {/* The frame's line is flex items (icon, text, link, text) at 8 px: the same children here, with ";" between jobs and "." at the end. */}
      {t('customers.also.label')}
      {jobs.rows.map((j, i) => (
        <Fragment key={j.jobNumber}>
          <Link href={`/office/jobs/${j.jobNumber}`}>{t('customers.also.job', { n: j.jobNumber })}</Link>
          {` - ${j.customer}, ${lineWord(serviceWord(t, j.service))}, ${dayShort(t, j.day)}${i < jobs.rows.length - 1 ? ';' : '.'}`}
        </Fragment>
      ))}
    </div>
  );
}

const count = (n: number, lang: string) => n.toLocaleString(lang === 'es' ? 'es-US' : 'en-US');

function serviceWord(t: ClientT, serviceId: string): string {
  return t(`service.${serviceId}.screen` as MessageKey);
}
export function lastVisitText(t: ClientT, v: NonNullable<SearchHit['lastVisit']>): { date: string; service: string } {
  return { date: dateLong(t, v.date), service: v.serviceId ? serviceWord(t, v.serviceId) : v.service };
}
const STATUS_KEY = { scheduled: 'customers.status.scheduled', on_the_way: 'customers.status.on_the_way', on_site: 'customers.status.on_site' } as const;
const STATUS_CLASS = { scheduled: 'sched', on_the_way: 'way', on_site: 'site' } as const;

function Select({ ctl, label, value, text, onChange, options }: {
  ctl: string; label: string; value: string; text: string; onChange: (v: string) => void; options: readonly { value: string; text: string }[];
}) {
  return (
    <span className="sel" data-ctl={ctl}>
      <span className="k">{label}</span>
      <b>{text}</b>
      <Icon name="chevDown" />
      <select className="bw-cu-native" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
      </select>
    </span>
  );
}

export function SearchView(p: SearchViewProps) {
  const t = useT();
  const f = p.filters;
  const set = (patch: Partial<SearchFilters>) => p.onFilters({ ...f, ...patch });
  const all = t('customers.filter.all');
  const hasFilter = filtersSet({ ...f, branch: f.branch === (p.homeBranch ?? null) ? null : f.branch });
  const branchText = f.branch ? (BRANCHES.find((b) => b.id === f.branch)?.name ?? f.branch) : t('customers.filter.allBranches');
  const sub = p.allTotal === null ? '' : t('customers.search.subtitle', { count: count(p.allTotal, t.lang) });
  const q = p.query.trim();
  const hitsFor = (name: string) => markParts(name, q).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>));
  const onKey = (e: KeyboardEvent) => {
    if (!p.page || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const ids = p.page.customers.map((c) => c.id);
    const at = Math.max(0, ids.indexOf(p.selectedId ?? ''));
    const next = ids[e.key === 'ArrowDown' ? Math.min(ids.length - 1, at + 1) : Math.max(0, at - 1)];
    if (next) {
      e.preventDefault();
      p.onSelect(next);
    }
  };

  return (
    <>
      <div className="pgh">
        <div className="row">
          <div>
            <h1>{t('customers.search.title')}</h1>
            {sub ? <p data-ctl="CTL-OFC-05-19">{sub}</p> : <p data-ctl="CTL-OFC-05-19" />}
          </div>
          <div className="acts">
            <button type="button" className="btn primary" data-ctl="CTL-OFC-05-12" onClick={p.onNew}><Icon name="plus" />{t('customers.search.new')}</button>
          </div>
        </div>
        <div className="qrow">
          <div className="q" data-ctl="CTL-OFC-05-01">
            <Icon name="search" />
            <input
              type="search" className="bw-cu-q" value={p.query} placeholder={t('customers.search.placeholder')} aria-label={t('customers.search.label')}
              autoComplete="off" spellCheck={false} onChange={(e) => p.onQuery(e.target.value)}
            />
            {p.query !== '' ? <button type="button" className="clr" data-ctl="CTL-OFC-05-02" onClick={p.onClear}>{t('customers.search.clear')}</button> : null}
          </div>
          <Select
            ctl="CTL-OFC-05-06" label={t('customers.filter.branch')} value={f.branch ?? ''} text={branchText} onChange={(v) => set({ branch: v || null, city: null })}
            options={[{ value: '', text: t('customers.filter.allBranches') }, ...BRANCHES.map((b) => ({ value: b.id, text: b.name }))]}
          />
          <Select
            ctl="CTL-OFC-05-07" label={t('customers.filter.city')} value={f.city ?? ''} text={f.city ?? all} onChange={(v) => set({ city: v || null })}
            options={[{ value: '', text: all }, ...p.cities.map((c) => ({ value: c, text: c }))]}
          />
          <Select
            ctl="CTL-OFC-05-08" label={t('customers.filter.plan')} value={f.plan ?? ''}
            text={f.plan === 'comfort_club' ? t('customers.filter.planClub') : f.plan === 'none' ? t('customers.plan.none') : all} onChange={(v) => set({ plan: (v || null) as SearchFilters['plan'] })}
            options={[{ value: '', text: all }, { value: 'comfort_club', text: t('customers.filter.planClub') }, { value: 'none', text: t('customers.plan.none') }]}
          />
          <Select
            ctl="CTL-OFC-05-09" label={t('customers.filter.language')} value={f.textLanguage ?? ''}
            text={f.textLanguage ? t(`customers.language.${f.textLanguage}`) : all} onChange={(v) => set({ textLanguage: (v || null) as SearchFilters['textLanguage'] })}
            options={[{ value: '', text: all }, { value: 'en', text: t('customers.language.en') }, { value: 'es', text: t('customers.language.es') }]}
          />
          <Select
            ctl="CTL-OFC-05-10" label={t('customers.filter.upcoming')} value={f.upcomingVisit === null ? '' : f.upcomingVisit ? 'yes' : 'no'}
            text={f.upcomingVisit === null ? all : f.upcomingVisit ? t('customers.filter.upcomingYes') : t('customers.filter.upcomingNo')}
            onChange={(v) => set({ upcomingVisit: v === '' ? null : v === 'yes' })}
            options={[{ value: '', text: all }, { value: 'yes', text: t('customers.filter.upcomingYes') }, { value: 'no', text: t('customers.filter.upcomingNo') }]}
          />
          <button type="button" className={`btn sm${hasFilter ? '' : ' dis'}`} aria-disabled={!hasFilter || undefined} data-ctl="CTL-OFC-05-11" onClick={() => hasFilter && p.onClearFilters()}>
            {t('customers.filter.clear')}
          </button>
        </div>
        <div className="hint"><Icon name="info" />{t('customers.search.hint')}</div>
      </div>

      <div className="body">
        <div className="left">
          {p.phase === 'empty' ? <p className="r1-note bw-cu-note">{p.allTotal === null ? t('customers.search.emptyNoCount') : t('customers.search.empty', { count: count(p.allTotal, t.lang) })}</p> : null}
          {p.phase === 'searching' ? <div className="bw-cu-skel"><SkeletonRows n={4} /></div> : null}
          {p.phase === 'error' ? <ErrorPanel title={t('customers.search.errorTitle')} hint={t('customers.error.hint')} onRetry={p.onRetry} /> : null}
          {p.phase === 'none' ? (
            <div>
              <p className="r1-note bw-cu-note">{q === '' ? t('customers.search.noneFilters') : t('customers.search.none', { query: q })}</p>
              {hasFilter ? <button type="button" className="btn sm bw-cu-mt10" data-ctl="CTL-OFC-05-11" onClick={p.onClearFilters}>{t('customers.filter.clear')}</button> : null}
            </div>
          ) : null}
          {p.phase === 'results' && p.page ? (
            <section className="card">
              <div className="card-h">
                <h3>{q === '' ? t('customers.search.matchesAll', { count: count(p.page.total, t.lang) }) : t('customers.search.matches', { count: count(p.page.total, t.lang), query: q })}</h3>
                <span>{t('customers.search.sorted')}</span>
                <button
                  type="button" className={`btn sm bw-cu-ml8${p.page.next ? '' : ' dis'}`} aria-disabled={!p.page.next || undefined} data-ctl="CTL-OFC-05-05"
                  onClick={() => p.page?.next && p.onMore()}
                >
                  {t('customers.search.more')}
                </button>
                {p.moreFailed ? <span className="r1-fmsg bw-cu-inline" role="alert">{t('customers.search.moreFailed')}</span> : null}
              </div>
              <div onKeyDown={onKey} role="presentation">
                <table data-ctl="CTL-OFC-05-03">
                  <thead>
                    <tr>
                      <th>{t('customers.col.name')}</th><th>{t('customers.col.address')}</th><th>{t('customers.col.mobile')}</th><th>{t('customers.col.texts')}</th>
                      <th>{t('customers.col.plan')}</th><th>{t('customers.col.last')}</th><th>{t('customers.col.next')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.page.customers.map((c) => {
                      const on = c.id === p.selectedId;
                      const last = c.lastVisit ? lastVisitText(t, c.lastVisit) : null;
                      return (
                        <tr key={c.id} className={on ? 'pick' : undefined} aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => p.onSelect(c.id)}>
                          <td>
                            <div className="two">
                              <Link className="nm" href={`/office/customers/${c.id}`} data-ctl="CTL-OFC-05-04" onClick={(e) => e.stopPropagation()}><b>{hitsFor(c.name)}</b></Link>
                              <small data-ctl="CTL-OFC-05-18">{t('customers.search.since', { year: c.customerSince.slice(0, 4) })}</small>
                            </div>
                          </td>
                          <td data-ctl="CTL-OFC-05-20"><div className="two">{c.address.houseNumber} {c.address.street}<small>{t('customers.address.cityLine', { city: c.address.city, zip: c.address.zip })}</small></div></td>
                          <td>{c.mobile ? formatPhone(c.mobile) : <span className="muted">{t('customers.none')}</span>}</td>
                          <td data-ctl="CTL-OFC-05-20">{t(c.textsOn ? 'customers.search.textsOn' : 'customers.search.textsOff', { language: t(`customers.language.${c.language}`) })}</td>
                          <td>{c.plan ? <span className="chip club">{t('customers.plan.clubMember')}</span> : <span className="muted">{t('customers.plan.none')}</span>}</td>
                          <td data-ctl="CTL-OFC-05-17">{last ? <div className="two">{last.date}<small>{last.service}</small></div> : <span className="muted">{t('customers.none')}</span>}</td>
                          <td>
                            {c.nextVisit
                              ? <div className="two"><b>{dayShort(t, c.nextVisit.day)}</b><small>{windowText(c.nextVisit.window.start, c.nextVisit.window.end)}</small></div>
                              : <span className="muted">{t('customers.search.noneBooked')}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <AlsoFound jobs={p.jobs} />
            </section>
          ) : null}
          {p.phase === 'none' ? <AlsoFound jobs={p.jobs} /> : null}
        </div>
        <Preview {...p} />
      </div>
    </>
  );
}

function SkeletonRows({ n, first = 40 }: { n: number; first?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => <span key={i} className={`r1-skel${i === 0 ? ` bw-w-${first}` : ''}`} />)}
    </>
  );
}

function Preview(p: SearchViewProps) {
  const t = useT();
  if (p.phase === 'empty' || p.phase === 'searching' || p.phase === 'none' || p.phase === 'error') {
    if (p.preview.kind !== 'loading' && p.preview.kind !== 'error') return <aside className="card pv bw-cu-pv-idle" data-ctl="CTL-OFC-05-16" aria-hidden="true" />;
  }
  if (p.preview.kind === 'loading') {
    return (
      <aside className="card pv bw-cu-pv-pad" data-ctl="CTL-OFC-05-16" aria-busy="true">
        <SkeletonRows n={6} first={45} />
        <div className="acts bw-cu-acts0">
          <button type="button" className="btn primary dis" aria-disabled="true" data-ctl="CTL-OFC-05-13">{t('customers.preview.open')}</button>
          <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-05-14">{t('customers.preview.newJob')}</button>
        </div>
      </aside>
    );
  }
  if (p.preview.kind === 'error') {
    return (
      <aside className="card pv bw-cu-pv-pad" data-ctl="CTL-OFC-05-16">
        <ErrorPanel title={t('customers.preview.errorTitle')} hint={t('customers.error.hint')} onRetry={p.onRetryPreview} />
      </aside>
    );
  }
  if (p.preview.kind === 'none') return <aside className="card pv bw-cu-pv-idle" data-ctl="CTL-OFC-05-16" aria-hidden="true" />;
  const d = p.preview.data;
  const next = d.upcoming[0];
  const note = d.notes[0];
  const eq = d.equipment.map((e) => equipmentLine(t, e)).join(', ');
  return (
    <aside className="card pv" data-ctl="CTL-OFC-05-16">
      <div className="top">
        <span className="av">{initialsOf(d.name)}</span>
        <div>
          <b>{d.name}</b>
          <span className="s">{t('customers.preview.area', { area: d.area, year: d.customerSince.slice(0, 4) })}</span>
        </div>
        {d.membership ? <span className="chip club bw-ml-auto">{t('customers.plan.club')}</span> : null}
      </div>
      <dl className="kv">
        <dt>{t('customers.col.mobile')}</dt>
        <dd>{d.contact.mobile ? t('customers.preview.mobile', { phone: formatPhone(d.contact.mobile), state: d.contact.textsOn ? t('customers.on') : t('customers.off') }) : t('customers.preview.noMobile')}</dd>
        <dt>{t('customers.preview.language')}</dt><dd>{t(`customers.language.${d.language}`)}</dd>
        <dt>{t('customers.col.address')}</dt><dd>{t('customers.address.oneLine', { house: d.address.houseNumber, street: d.address.street, city: d.address.city, zip: d.address.zip })}</dd>
        <dt>{t('customers.preview.equipment')}</dt><dd>{eq || t('customers.equipment.none')}</dd>
      </dl>
      <h4>{t('customers.preview.next')}</h4>
      {next ? (
        <div className="nx">
          <b>{dayShort(t, next.day)}, {windowText(next.window.start, next.window.end)}</b><br />
          {serviceWord(t, next.serviceId)}{next.technician ? ` - ${next.technician.name}` : ''}{' '}
          <span className={`chip ${STATUS_CLASS[next.status]} sm bw-ml4`}><span className="dot" />{t(STATUS_KEY[next.status])}</span>
        </div>
      ) : <div className="nx"><span className="muted">{t('customers.noVisit')}</span></div>}
      <h4>{t('customers.preview.history')}</h4>
      <div className="hist">
        {d.history.slice(0, 3).map((h, i) => (
          <div className="h" key={i}><span className="d">{dateLong(t, h.date)}</span><span className="t">{h.serviceId ? serviceWord(t, h.serviceId) : h.service}</span></div>
        ))}
        {d.history.length === 0 ? <div className="h"><span className="t muted">{t('customers.history.none')}</span></div> : null}
      </div>
      <h4>{t('customers.preview.notes')}</h4>
      {note ? (
        <div className="nx bw-cu-note-card">
          {note.text}
          <div className="muted small bw-cu-mt4">{t(note.authorKind === 'office' ? 'customers.note.office' : 'customers.note.technician', { name: note.authorKind === 'office' ? shortName(note.author) : note.author, date: dateLong(t, note.at.slice(0, 10)) })}</div>
        </div>
      ) : <div className="nx"><span className="muted">{t('customers.notes.none')}</span></div>}
      <div className="acts">
        <Link className="btn primary" href={`/office/customers/${d.id}`} data-ctl="CTL-OFC-05-13"><Icon name="user" />{t('customers.preview.open')}</Link>
        <button type="button" className="btn" data-ctl="CTL-OFC-05-14" onClick={() => p.onNewJob(d.id)}><Icon name="plus" />{t('customers.preview.newJob')}</button>
      </div>
    </aside>
  );
}
