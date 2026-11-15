// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-04 New job as DK-89 draws it (mockups/pages/office-new-job.html; UI-SPECIFICATION SCR-OFC-04): the header, the 4 steps (customer,
// service, day and window, suggested technicians) and the Schedule card. Pure drawing: the page (NewJobScreen.tsx) holds the state and
// the calls; a preview draws each state the frame shows with fixed values. Every shown word is a catalog key.
import type { ServicesAnswer } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import Link from 'next/link';
import { useEffect, useRef, type ReactNode } from 'react';
import { dayShort, equipmentLine, firstName, formatPhone, initialsOf, windowText } from '../customers/model.ts';
import type { CustomerPage, Detail, SearchHit } from '../customers/types.ts';
import type { Shown } from '../job/model.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import {
  canSchedule, confirmationKey, listed, noOpenWindow, noTexts, offeredDays, reasonLine, roomFill, serviceIcon, standout, visitOfDetail, visitOfHit,
  type Day, type Picks, type Tech, type Visit,
} from './model.ts';

export type CustomerState = { kind: 'none' } | { kind: 'loading' } | { kind: 'error' } | { kind: 'picked'; detail: Detail };
export type SearchState = { kind: 'idle' } | { kind: 'searching' } | { kind: 'hits'; page: CustomerPage } | { kind: 'none' } | { kind: 'error' };
export type TechState = { kind: 'waiting' } | { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; technicians: Tech[]; serviceSkill: string };

export interface ViewProps {
  query: string;
  search: SearchState;
  customer: CustomerState;
  services: ServicesAnswer['services'] | 'loading' | 'error';
  picks: Picks;
  /** API-29's days (a Closed day is dropped here); null until a service is picked. */
  days: Day[] | 'loading' | 'error' | null;
  techs: TechState;
  saving: boolean;
  /** An error from Schedule (every field keeps its value), or the leave-page words. */
  shown: Shown | null;
  /** The branch's name (CTL-OFC-04-14). */
  branchName: string;
  /** The demo clock's day (API-10), null until it is read: a visit on it reads today, and it gets no reminder the evening before. */
  today: string | null;
  on: {
    query(q: string): void;
    pickHit(id: string): void;
    retrySearch(): void;
    retryCustomer(): void;
    newCustomer(): void;
    change(): void;
    service(id: string): void;
    equipment(id: string | null): void;
    problem(text: string): void;
    day(date: string): void;
    window(id: string): void;
    technician(id: string | null): void;
    retryDays(): void;
    retryTechs(): void;
    retryServices(): void;
    schedule(): void;
    /** Cancel and the Jobs crumb: the page asks "Leave without saving this job?" first when it holds input (CTL-OFC-04-10, -12). */
    leave(): void;
  };
}

const Skel = ({ n = 3 }: { n?: number }) => <>{Array.from({ length: n }, (_, i) => <span key={i} className="r1-skel" />)}</>;

/** The language word of a customer's texts and the phone, as the existing-visit line shows them (CTL-OFC-04-13). */
function lineOf(t: ClientT, c: { address: { houseNumber: number; street: string; city: string; zip: string }; mobile: string | null; textsOn: boolean; language: 'en' | 'es' }): string {
  const a = t('customers.address.oneLine', { house: c.address.houseNumber, street: c.address.street, city: c.address.city, zip: c.address.zip });
  const texts = !c.mobile ? t('newjob.customer.noMobile') : !c.textsOn ? t('newjob.customer.textsOff') : t('newjob.customer.textsIn', { language: t(`newjob.language.${c.language}` as MessageKey) });
  return [a, c.mobile ? formatPhone(c.mobile) : null, texts].filter((x) => x !== null).join(' - ');
}

/** CTL-OFC-04-13's booked visit: the day and window, then the service and who is on it. */
function VisitText({ t, v, today }: { t: ClientT; v: Visit; today: string | null }) {
  const service = t(`service.${v.serviceId}.screen` as MessageKey);
  const key = v.technician === null ? 'newjob.visit.unassigned' : (`newjob.visit.${v.status}` as MessageKey);
  return (
    <>
      {v.day === today
        ? t('newjob.visit.today', { window: windowText(v.window.start, v.window.end) })
        : t('newjob.visit.when', { day: dayShort(t, v.day), window: windowText(v.window.start, v.window.end) })}
      <br />
      <b>{t(key, { service, tech: v.technician === null ? '' : firstName(v.technician) })}</b>
    </>
  );
}

/** CTL-OFC-04-01, FR-DISP-32: a member's chip. The picked customer's chip is DK-89's ("Comfort Club"); a result's, which DK-89 does not draw, is the spec's ("Comfort Club member"). */
function ClubChip({ t, member }: { t: ClientT; member?: boolean }) {
  return <span className="chip club">{t(member ? 'customers.plan.clubMember' : 'customers.plan.club')}</span>;
}

function Step({ n, done }: { n: number; done?: boolean }) {
  return done ? <span className="stepn ok"><Icon name="check" sw={2.6} /></span> : <span className="stepn">{n}</span>;
}

function CustomerCard({ p }: { p: ViewProps }) {
  const t = useT();
  const picked = p.customer.kind === 'picked' ? p.customer.detail : null;
  const head = (
    <div className="card-h">
      <Step n={1} done={picked !== null} />
      <h3>{t('newjob.step.customer')}</h3>
      {picked
        ? <button type="button" className="btn sm bw-ml-auto" data-ctl="CTL-OFC-04-02" onClick={p.on.change}>{t('newjob.customer.change')}</button>
        : <button type="button" className="btn sm bw-ml-auto" data-ctl="CTL-OFC-04-11" onClick={p.on.newCustomer} disabled={p.customer.kind === 'loading'}><Icon name="plus" />{t('newjob.customer.new')}</button>}
    </div>
  );
  if (p.customer.kind === 'loading') return <section className="card">{head}<div className="in"><Skel n={2} /></div></section>;
  if (p.customer.kind === 'error') {
    return <section className="card">{head}<div className="in"><ErrorPanel title={t('newjob.customer.loadError')} hint={t('newjob.customer.loadErrorHint')} onRetry={p.on.retryCustomer} /></div></section>;
  }
  if (picked) {
    const v = visitOfDetail(picked);
    return (
      <section className="card">
        {head}
        <div className="in">
          <div className="cust">
            <span className="av">{initialsOf(picked.name)}</span>
            <div>
              <div className="nm">{picked.name}{picked.membership ? <> <ClubChip t={t} /></> : null}</div>
              <div className="d" data-ctl="CTL-OFC-04-13">{lineOf(t, { address: picked.address, mobile: picked.contact.mobile, textsOn: picked.contact.textsOn, language: picked.language })}</div>
            </div>
            {v ? <div className="side" data-ctl="CTL-OFC-04-13"><VisitText t={t} v={v} today={p.today} /></div> : null}
          </div>
        </div>
      </section>
    );
  }
  const s = p.search;
  const q = p.query.trim();
  return (
    <>
    <section className="card">
      {head}
      <div className="in">
        <div className="find" data-ctl="CTL-OFC-04-01">
          <Icon name="search" />
          <input
            type="text" className="bw-nj-find" value={p.query} placeholder={t('newjob.customer.placeholder')} aria-label={t('newjob.step.customer')}
            autoComplete="off" spellCheck={false} maxLength={100} onChange={(e) => p.on.query(e.target.value)} data-initial
          />
          {s.kind === 'none' ? <span className="x">{t('newjob.customer.matches', { n: 0 })}</span> : null}
        </div>
        {s.kind === 'searching' ? <div className="bw-nj-hits"><Skel n={2} /></div> : null}
        {s.kind === 'error' ? <ErrorPanel title={t('newjob.customer.searchError')} hint={t('newjob.customer.loadErrorHint')} onRetry={p.on.retrySearch} /> : null}
        {s.kind === 'hits' ? (
          <ul className="bw-nj-hits" aria-label={t('newjob.step.customer')}>
            {s.page.customers.map((h: SearchHit) => {
              const v = visitOfHit(h);
              return (
                <li key={h.id}>
                  <button type="button" className="cust hit" data-ctl="CTL-OFC-04-01" onClick={() => p.on.pickHit(h.id)}>
                    <span className="av">{initialsOf(h.name)}</span>
                    <span className="bw-nj-hitbody">
                      <span className="nm">{h.name}{h.plan ? <> <ClubChip t={t} member /></> : null}</span>
                      <span className="d" data-ctl="CTL-OFC-04-13">{lineOf(t, h)}</span>
                    </span>
                    {v ? <span className="side" data-ctl="CTL-OFC-04-13"><VisitText t={t} v={v} today={p.today} /></span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
    {s.kind === 'none' ? <p className="r1-note bw-nj-note">{t('newjob.customer.noMatch', { query: q })}</p> : null}
    </>
  );
}

function ServiceCard({ p, detail }: { p: ViewProps; detail: Detail | null }) {
  const t = useT();
  const off = detail === null;
  const choose = (list: ServicesAnswer['services']) => (
    <div className="svcs" role="radiogroup" data-ctl="CTL-OFC-04-03" aria-label={t('newjob.step.service')}>
      {list.map((s) => (
        <button type="button" key={s.serviceId} role="radio" aria-checked={p.picks.serviceId === s.serviceId} className={`svc${p.picks.serviceId === s.serviceId ? ' sel' : ''}`}
          disabled={off} onClick={() => p.on.service(s.serviceId)}>
          <span className="ico"><Icon name={serviceIcon(s.serviceId)} /></span>{t(s.screenLabelKey as MessageKey)}
        </button>
      ))}
    </div>
  );
  const equipment = detail?.equipment ?? [];
  const picked = equipment.find((e) => e.id === p.picks.equipmentId) ?? null;
  const equipText = picked ? [equipmentLine(t, picked), picked.location].filter(Boolean).join(' - ') : t('newjob.equipment.none');
  return (
    <section className="card">
      <div className="card-h"><Step n={2} done={p.picks.serviceId !== null} /><h3>{t('newjob.step.service')}</h3></div>
      <div className="in">
        {p.services === 'loading' ? <div className="svcs"><Skel n={3} /></div>
          : p.services === 'error' ? <ErrorPanel title={t('newjob.services.loadError')} hint={t('newjob.customer.loadErrorHint')} onRetry={p.on.retryServices} />
          : choose(p.services)}
        <div className="twof">
          <div data-ctl="CTL-OFC-04-04">
            <div className="lbl" id="nj-equipment-l">{t('newjob.equipment.label')}</div>
            <div className="fld bw-nj-fld bw-nj-selfld">
              <span>{equipText}</span>
              <Icon name="chevDown" />
              <select id="nj-equipment" aria-labelledby="nj-equipment-l" className="bw-nj-over" disabled={off} value={p.picks.equipmentId ?? ''} onChange={(e) => p.on.equipment(e.target.value === '' ? null : e.target.value)}>
                <option value="">{t('newjob.equipment.none')}</option>
                {equipment.map((e) => <option key={e.id} value={e.id}>{[equipmentLine(t, e), e.location].filter(Boolean).join(' - ')}</option>)}
              </select>
            </div>
          </div>
          <div data-ctl="CTL-OFC-04-05">
            <div className="lbl" id="nj-problem-l">{t('newjob.problem.label')}</div>
            <div className="fld bw-nj-fld">
              <textarea id="nj-problem" aria-labelledby="nj-problem-l" className="bw-nj-text" rows={1} maxLength={500} disabled={off} value={p.picks.problem} onChange={(e) => p.on.problem(e.target.value)} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The most days DK-89 draws: a longer list scrolls inside its own box (app/new-job.css), so the windows and Schedule stay beside the pick (F-802). */
const DAYS_DRAWN = 6;

function DayWindowCard({ p, serviceName }: { p: ViewProps; serviceName: string | null }) {
  const t = useT();
  const days = Array.isArray(p.days) ? p.days : null;
  const day = days?.find((d) => d.date === p.picks.day) ?? null;
  // A day picked before the list drew (the date the board sent) scrolls into the box; the page itself does not move.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const b = box.current;
    const row = b?.querySelector('[aria-checked="true"]');
    if (!b || !row || b.scrollHeight <= b.clientHeight) return;
    const [r, o] = [row.getBoundingClientRect(), b.getBoundingClientRect()];
    if (r.top < o.top) b.scrollTop -= o.top - r.top;
    else if (r.bottom > o.bottom) b.scrollTop += r.bottom - o.bottom;
  }, [p.picks.day, days]);
  return (
    <section className="card">
      <div className="card-h">
        <Step n={3} />
        <h3>{t('newjob.step.day')}</h3>
        {serviceName ? <span className="muted" data-ctl="CTL-OFC-04-14">{t('newjob.room.heading', { service: serviceName, branch: p.branchName })}</span> : null}
      </div>
      <div className={Array.isArray(p.days) ? 'in dw' : 'in'}>
        {p.days === null ? <p className="r1-note bw-nj-note">{t('newjob.day.pickService')}</p>
          : p.days === 'loading' ? <Skel n={4} />
          : p.days === 'error' ? <ErrorPanel title={t('newjob.day.loadError')} hint={t('newjob.customer.loadErrorHint')} onRetry={p.on.retryDays} />
          : (
            <>
              <div ref={box} className={`days${p.days.length > DAYS_DRAWN ? ' bw-nj-long' : ''}`} data-ctl="CTL-OFC-04-06" role="radiogroup" aria-label={t('newjob.step.day')}>
                {p.days.map((d) => {
                  const full = d.state === 'full';
                  return (
                    <button type="button" key={d.date} data-date={d.date} role="radio" aria-checked={d.date === p.picks.day} aria-disabled={full || undefined}
                      className={`dy${d.date === p.picks.day ? ' sel' : ''}${full ? ' bw-opa-6' : ''}`} onClick={() => { if (!full) p.on.day(d.date); }}>
                      {dayShort(t, d.date)}{d.mode === 'four_hour' ? <> <span className="pk">{t('newjob.day.fourHour')}</span></> : null}
                      <span className="r" data-ctl="CTL-OFC-04-14">{full ? t('newjob.full') : t('newjob.left', { n: d.left })}</span>
                    </button>
                  );
                })}
              </div>
              <div>
                {day && noOpenWindow(day)
                  ? <div className="wins" data-ctl="CTL-OFC-04-07"><p className="r1-note bw-m-0">{t('newjob.window.none', { day: dayShort(t, day.date) })}</p></div>
                  : day ? (
                    <>
                      <div className="wins" role="radiogroup" data-ctl="CTL-OFC-04-07" aria-label={t('newjob.window.label')}>
                        {day.windows.map((w) => {
                          const full = w.state === 'full';
                          const on = w.windowId === p.picks.windowId;
                          return (
                            <button type="button" key={w.windowId} data-window-id={w.windowId} role="radio" aria-checked={on} aria-disabled={full || undefined} className={`win${on ? ' sel' : ''}${full ? ' full' : ''}`}
                              onClick={() => { if (!full) p.on.window(w.windowId); }}>
                              <span className="radio" />{windowText(w.start, w.end)}
                              <span className="cap" data-ctl="CTL-OFC-04-15">
                                <span className="bar"><i className={`bw-fill-${roomFill(w.left, full)}`} /></span>
                                {full ? <span className="tag">{t('newjob.full')}</span> : on ? t('newjob.window.leftSelected', { n: w.left }) : t('newjob.left', { n: w.left })}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="winnote" data-ctl="CTL-OFC-04-16">{t('newjob.window.note')}</div>
                    </>
                  ) : <p className="r1-note bw-nj-note">{t('newjob.window.pickDay')}</p>}
              </div>
            </>
          )}
      </div>
    </section>
  );
}

function TechCard({ p }: { p: ViewProps }) {
  const t = useT();
  const days = Array.isArray(p.days) ? p.days : null;
  const day = days?.find((d) => d.date === p.picks.day) ?? null;
  const win = day?.windows.find((w) => w.windowId === p.picks.windowId) ?? null;
  const picked = (id: string | null) => p.picks.technicianId === id;
  const pickCtl = (id: string | null) => (picked(id)
    ? <span className="chip site pick"><span className="dot" />{t('newjob.tech.picked')}</span>
    : <button type="button" className="btn sm pick" onClick={() => p.on.technician(id)}>{t('newjob.tech.pick')}</button>);
  const body = ((): ReactNode => {
    if (p.techs.kind === 'waiting') return <p className="r1-note bw-nj-tnote">{t('newjob.tech.waiting')}</p>;
    if (p.techs.kind === 'loading') return <div className="bw-nj-tskel"><Skel n={3} /></div>;
    if (p.techs.kind === 'error') return <div className="bw-nj-tskel"><ErrorPanel title={t('newjob.tech.loadError')} hint={t('newjob.customer.loadErrorHint')} onRetry={p.on.retryTechs} /></div>;
    const { suggested, notSuggested } = listed(p.techs.technicians);
    const skill = p.techs.serviceSkill;
    const row = (x: Tech, rank: number | null) => (
      <div className={`tc${picked(x.id) ? ' top' : ''}`} key={x.id}>
        <div className="h">
          {rank !== null ? <span className="rank">{rank}</span> : null}
          <span className="av">{initialsOf(x.name)}</span>
          <div className="nm">{x.name}<small>{[x.van ? t('newjob.tech.van', { van: x.van }) : null, x.skills.length > 0 ? x.skills.map((s) => t(`skill.${s}` as MessageKey)).join(', ') : null].filter(Boolean).join(' - ')}</small></div>
          {pickCtl(x.id)}
        </div>
        <div className="why" data-ctl="CTL-OFC-04-17">{x.suggested ? '' : `${t('newjob.tech.notSuggested')}. `}{reasonLine(t, x, skill, standout(suggested, x.id))}</div>
        {x.suggested ? (
          <div className="fac">
            <div className="f"><div className="v">{t('newjob.tech.distance')}<b>{t('newjob.tech.minutes', { n: x.minutesFromStopBefore })}</b></div></div>
            <div className="f"><div className="v">{t('newjob.tech.load')}<b>{t('newjob.tech.loadOf', { jobs: x.load.jobs, capacity: x.load.capacity })}</b></div></div>
          </div>
        ) : null}
      </div>
    );
    return (
      <>
        {suggested.length === 0 && notSuggested.length === 0 ? <p className="r1-note bw-nj-tnote">{t('newjob.tech.empty')}</p> : null}
        {suggested.map((x, i) => row(x, i + 1))}
        {notSuggested.map((x) => row(x, null))}
      </>
    );
  })();
  return (
    <section className="card sug" role="radiogroup" data-ctl="CTL-OFC-04-08" aria-label={t('newjob.step.technician')}>
      <div className="card-h"><Step n={4} /><h3>{t('newjob.step.technician')}</h3></div>
      {day && win ? <div className="sub">{t('newjob.tech.sub', { day: dayShort(t, day.date), window: windowText(win.start, win.end) })}</div> : null}
      {body}
      <div className={`tc no${picked(null) && p.picks.windowId !== null ? ' top' : ''}`}>
        <div className="h">
          <span className="av bw-nj-q">?</span>
          <div className="nm">{t('newjob.tech.none')}<small>{t('newjob.tech.noneHint')}</small></div>
          {pickCtl(null)}
        </div>
      </div>
    </section>
  );
}

function GoCard({ p }: { p: ViewProps }) {
  const t = useT();
  const c = p.customer.kind === 'picked' ? p.customer.detail : null;
  const ready = canSchedule(c, p.picks);
  const days = Array.isArray(p.days) ? p.days : null;
  const day = days?.find((d) => d.date === p.picks.day) ?? null;
  const win = day?.windows.find((w) => w.windowId === p.picks.windowId) ?? null;
  const service = p.services !== 'loading' && p.services !== 'error' ? p.services.find((s) => s.serviceId === p.picks.serviceId) : undefined;
  const tech = p.techs.kind === 'ready' ? p.techs.technicians.find((x) => x.id === p.picks.technicianId) : undefined;
  const techWord = p.picks.technicianId === null ? t('newjob.summary.noTech') : t('newjob.summary.withTech', { name: tech?.name ?? '' });
  return (
    <section className="card go">
      {ready && c && service && day && win ? (
        <div className="sum" data-ctl="CTL-OFC-04-18">
          <b>{t('newjob.summary.visit', { service: t(service.screenLabelKey as MessageKey), name: c.name })}</b><br />
          {t('newjob.summary.when', { day: dayShort(t, day.date), window: windowText(win.start, win.end), tech: techWord })}
        </div>
      ) : null}
      {p.shown ? <div className="msgb" role="alert"><Icon name="alert" /><span>{t(p.shown.key as MessageKey, p.shown.values)}</span></div> : null}
      <div className="bb">
        {p.saving
          ? <button type="button" className="btn busy primary" aria-busy="true" data-ctl="CTL-OFC-04-09"><span className="r1-spin" />{t('newjob.scheduling')}</button>
          : <button type="button" className={`btn primary${ready ? '' : ' dis'}`} aria-disabled={!ready || undefined} data-ctl="CTL-OFC-04-09" onClick={() => { if (ready) p.on.schedule(); }}><Icon name="calendar" />{t('newjob.schedule')}</button>}
      </div>
      {c ? (
        <div className="tx" data-ctl="CTL-OFC-04-19">
          <Icon name="message" />
          <div>{noTexts(c.contact)
            ? t('newjob.notice.noTexts', { name: firstName(c.name) })
            : t(p.picks.day !== null && p.picks.day === p.today ? 'newjob.notice.textsToday' : 'newjob.notice.texts', { name: firstName(c.name), language: t(`newjob.language.${c.language}` as MessageKey) })}</div>
        </div>
      ) : null}
    </section>
  );
}

export function NewJobView(p: ViewProps) {
  const t = useT();
  const detail = p.customer.kind === 'picked' ? p.customer.detail : null;
  const list = p.services !== 'loading' && p.services !== 'error' ? p.services : null;
  const serviceName = list?.find((s) => s.serviceId === p.picks.serviceId) ? t(`service.${p.picks.serviceId}.text` as MessageKey) : null;
  return (
    <>
      <div className="jh">
        <div>
          <div className="crumbs" data-ctl="CTL-OFC-04-12">
            <Link href="/office/jobs" onClick={(e) => { e.preventDefault(); p.on.leave(); }}>{t('newjob.crumb.jobs')}</Link>
            <Icon name="chevRight" />
            <span>{t('newjob.title')}</span>
          </div>
          <h1>{t('newjob.title')}</h1>
        </div>
        <div className="acts">
          <Link className={`btn ghost${p.saving ? ' dis' : ''}`} href="/office/jobs" data-ctl="CTL-OFC-04-10" aria-disabled={p.saving || undefined} onClick={(e) => { e.preventDefault(); if (!p.saving) p.on.leave(); }}>{t('newjob.cancel')}</Link>
        </div>
      </div>
      <div className="body">
        <div className="left">
          <CustomerCard p={p} />
          <ServiceCard p={p} detail={detail} />
          <DayWindowCard p={p} serviceName={serviceName} />
        </div>
        <div className="right">
          <TechCard p={p} />
          <GoCard p={p} />
        </div>
      </div>
    </>
  );
}

/** The words CMP-11 shows after Schedule (the toast the job page that opens carries). */
export function doneWords(t: ClientT, c: Pick<Detail, 'name'>, jobNumber: number, answer: { status: string } | null): string {
  return t(confirmationKey(answer), { n: jobNumber, name: firstName(c.name) });
}
// `offeredDays` is applied by the page when it reads API-29; re-exported so a preview builds its days the same way.
export { offeredDays };
