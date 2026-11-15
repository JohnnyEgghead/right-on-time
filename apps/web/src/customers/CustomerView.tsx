// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-06 Customer page, the screen below the office top bar (frame mockups/pages/office-customer.html, DK-91; the markup of its
// Success frame and of its Loading, Editing zone, Saving zone, Zone saved, Changed and Not found tiles). Presentational: the container
// (CustomerScreen.tsx) reads API-35, saves the time zone (API-36) and opens the dialogs.
import './customer-css.ts';
import type { MessageKey } from '@bw/i18n';
import Link from 'next/link';
import { HistoryVisit } from '../job/HistoryVisit';
import { Fragment } from 'react';
import { CallButton } from '../shell/CallButton.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { ErrorPanel } from '../shell/Panels.tsx';
import { branchById } from '../shell/branches.ts';
import {
  clockText, dateLong, dayShort, noteWhen, equipmentIcon, equipmentLine, formatPhone, initialsOf, monthYear, shortName, US_ZONES, windowText, zoneText,
} from './model.ts';
import type { Detail } from './types.ts';
import { Busy } from './ui.tsx';
import { can } from '../job/model.ts';
import { CONTROL_CONTRACT } from './model.ts';

export type CustomerState = 'loading' | 'ready' | 'error';
export type ZoneUi = { kind: 'idle' } | { kind: 'editing'; pick: string } | { kind: 'saving'; pick: string };

export interface CustomerViewProps {
  state: CustomerState;
  data: Detail | null;
  zone: ZoneUi;
  zoneFailed?: boolean;
  onRetry: () => void;
  onEditZone: () => void;
  onPickZone: (id: string) => void;
  onSaveZone: () => void;
  onCancelZone: () => void;
  onEdit: () => void;
  onMap: () => void;
  onNewJob: () => void;
  /** API-07's permission keys: each control below reads its API entry's contract ID (CONTROL_CONTRACT); null until the read answers. */
  perms: readonly string[] | null;
  onText: () => void;
  onAddEquipment: () => void;
  onEditEquipment: (id: string) => void;
  onAddNote: () => void;
  /** CTL-OFC-06-02: opens API-37's URL in a new tab; `inboxError` shows the inline message when that read failed. */
  onInbox: () => void;
  inboxError: boolean;
}

const serviceWord = (t: ClientT, id: string) => t(`service.${id}.screen` as MessageKey);
const STATUS_WORD = { scheduled: 'customers.visit.scheduled', on_the_way: 'customers.visit.on_the_way', on_site: 'customers.visit.on_site' } as const;
const TEXT_KIND = (t: ClientT, kind: string, direction: 'out' | 'in', name: string): string => {
  if (direction === 'in') return t('customers.text.reply', { name });
  const key = `customers.text.${kind}` as MessageKey;
  return t(key, { name });
};
const ICON_BG = { orange: 'bw-ico-orange', teal: 'bw-ico-teal', blue: 'bw-ico-blue', ink: 'bw-ico-ink' } as const;

function Skeleton() {
  return (
    <div className="body">
      <div className="col bw-cu-skel-col">{[40, 0, 0, 0, 0, 0].map((w, i) => <span key={i} className={`r1-skel${w ? ` bw-w-${w}` : ''}`} />)}</div>
    </div>
  );
}

export function CustomerView(p: CustomerViewProps) {
  const t = useT();
  if (p.state === 'loading' || !p.data) {
    return p.state === 'error' ? (
      <div className="body"><div className="col"><ErrorPanel title={t('customers.page.errorTitle')} hint={t('customers.error.hint')} onRetry={p.onRetry} /></div></div>
    ) : <Skeleton />;
  }
  const d = p.data;
  const first = d.name.trim().split(/\s+/)[0] ?? d.name;
  const next = d.upcoming[0];
  const canText = d.contact.mobile !== null && d.contact.textsOn;
  const callNumber = d.contact.mobile ?? d.contact.homePhone;
  const branchName = branchById(d.branch).name;
  const origin = d.source === 'import' ? (d.importedAt ? t('customers.origin.import', { date: dateLong(t, d.importedAt.slice(0, 10)) }) : t('customers.origin.importNoDate')) : d.source === 'online' ? t('customers.origin.online') : t('customers.origin.office');
  const today = d.upcoming.length > 0 && next?.eta !== null;
  const nextLine = next
    ? (today ? t('customers.meta.nextToday', { window: windowText(next.window.start, next.window.end) }) : t('customers.meta.next', { day: dayShort(t, next.day), window: windowText(next.window.start, next.window.end) }))
    : t('customers.noVisit');
  const oldHistory = d.history.filter((h) => h.old);
  const span = d.history.length > 0 ? `${monthYear(t, (d.history[d.history.length - 1] as Detail['history'][number]).date)} - ${monthYear(t, (d.history[0] as Detail['history'][number]).date)}` : '';
  const zoneLabel = zoneText(t, d.zone);
  // The year a note's date needs no year in (the job page's rule: the visit's year): the newest year among the notes and the upcoming visits.
  const noteYear = Math.max(...d.notes.map((n) => Number(n.at.slice(0, 4))), ...d.upcoming.map((u) => Number(u.day.slice(0, 4))));
  const gate = (k: keyof typeof CONTROL_CONTRACT) => can(p.perms, CONTROL_CONTRACT[k]);
  const editing = p.zone.kind !== 'idle';
  const saving = p.zone.kind === 'saving';

  return (
    <>
      <div className="jh">
        <div className="crumbs" data-ctl="CTL-OFC-06-23">
          <Link href="/office/customers">{t('customers.search.title')}</Link>
          <Icon name="chevRight" />
          <span>{d.name}</span>
        </div>
        <div className="row">
          <h1>{d.name}</h1>
          {d.membership ? <span className="chip club" data-ctl="CTL-OFC-06-24"><Icon name="star" />{t('customers.plan.clubMember')}</span> : null}
          <div className="acts">
            {gate('text') ? (
              <button
                type="button" className={`btn${canText ? '' : ' dis'}`} aria-disabled={!canText || undefined} data-ctl="CTL-OFC-06-14"
                title={canText ? undefined : (d.contact.mobile === null ? t('customers.text.noMobile') : t('customers.text.off'))}
                onClick={() => canText && p.onText()}
              >
                <Icon name="message" />{t('customers.page.text')}
              </button>
            ) : null}
            {/* CMP-16 (F-669; FR-DISP-20): a phone opens the dialer, a computer shows the number and starts no call. The mobile, else the home phone. */}
            {callNumber ? (
              <span className="bw-cu-call" data-ctl="CTL-OFC-06-15">
                <CallButton name={first} fullName={d.name} number={formatPhone(callNumber)} className="btn"><Icon name="phone" />{t('customers.page.call', { name: first })}</CallButton>
              </span>
            ) : (
              <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-06-15"><Icon name="phone" />{t('customers.page.call', { name: first })}</button>
            )}
            <button type="button" className="btn" data-ctl="CTL-OFC-06-16" onClick={p.onEdit}>{t('customers.page.edit')}</button>
            <button type="button" className="btn primary" data-ctl="CTL-OFC-06-01" onClick={p.onNewJob}><Icon name="plus" />{t('customers.page.newJob')}</button>
          </div>
        </div>
        <div className="meta" data-ctl="CTL-OFC-06-24">
          <span><Icon name="pin" />{t('customers.meta.area', { area: d.area, branch: branchName })}</span>
          <span><Icon name="user" />{t('customers.meta.since', { date: monthYear(t, d.customerSince) })}</span>
          <span><Icon name="download" />{origin}</span>
          <span><Icon name="calendar" />{nextLine}</span>
        </div>
      </div>

      <div className="body">
        <div className="col">
          <section className="card">
            <div className="card-h"><h3>{t('customers.contact.title')}</h3></div>
            <dl className="kv" data-ctl="CTL-OFC-06-03">
              <dt>{t('customers.col.mobile')}</dt>
              <dd>{d.contact.mobile ? t('customers.contact.mobile', { phone: formatPhone(d.contact.mobile), state: d.contact.textsOn ? t('customers.on') : t('customers.off') }) : t('customers.contact.noMobile')}</dd>
              <dt>{t('customers.contact.language')}</dt><dd>{t(`customers.language.${d.language}`)}</dd>
              <dt>{t('customers.contact.since')}</dt><dd>{monthYear(t, d.customerSince)}</dd>
              <dt>{t('customers.contact.home')}</dt>
              <dd data-ctl="CTL-OFC-06-25" className={d.contact.homePhone ? undefined : 'muted'}>{d.contact.homePhone ? t('customers.contact.homeNoTexts', { phone: formatPhone(d.contact.homePhone) }) : t('customers.contact.noneOnFile')}</dd>
              <dt>{t('customers.contact.email')}</dt>
              <dd data-ctl="CTL-OFC-06-26" className={d.contact.email ? undefined : 'muted'}>{d.contact.email ?? t('customers.contact.noneOnFile')}</dd>
            </dl>
            {editing ? (
              <div className="kv tz bw-block">
                <div className="bw-mb6 bw-kvk">{t('customers.zone.title')}</div>
                <div className="tzrow">
                  <label className="tzsel" data-ctl="CTL-OFC-06-06">
                    <span>{zoneText(t, p.zone.kind === 'idle' ? d.zone : p.zone.pick)}</span>
                    <Icon name="chevDown" />
                    <select className="bw-cu-native" aria-label={t('customers.zone.title')} value={p.zone.kind === 'idle' ? d.zone : p.zone.pick} disabled={saving} onChange={(e) => p.onPickZone(e.target.value)}>
                      {US_ZONES.map((z) => <option key={z.id} value={z.id}>{zoneText(t, z.id)}</option>)}
                    </select>
                  </label>
                  {saving ? <Busy label={t('customers.form.saving')} ctl="CTL-OFC-06-07" small /> : (
                    <button type="button" className={`btn primary sm${p.zone.kind === 'editing' && p.zone.pick !== d.zone ? '' : ' dis'}`} aria-disabled={p.zone.kind !== 'editing' || p.zone.pick === d.zone || undefined} data-ctl="CTL-OFC-06-07" onClick={p.onSaveZone}>{t('customers.zone.save')}</button>
                  )}
                  <button type="button" className={`btn sm${saving ? ' dis' : ''}`} aria-disabled={saving || undefined} data-ctl="CTL-OFC-06-08" onClick={() => !saving && p.onCancelZone()}>{t('customers.dialog.cancel')}</button>
                </div>
                <p className="r1-hint">{t('customers.zone.note')}</p>
                {p.zoneFailed ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('customers.form.failed')}</div> : null}
              </div>
            ) : (
              <dl className="kv tz">
                <dt>{t('customers.zone.title')}</dt>
                <dd><span data-ctl="CTL-OFC-06-04">{zoneLabel}</span>{' '}<button type="button" className="lnk bw-lnkbtn" data-ctl="CTL-OFC-06-05" onClick={p.onEditZone}>{t('customers.zone.edit')}</button></dd>
              </dl>
            )}
          </section>

          <section className="card">
            <div className="card-h"><h3>{t('customers.address.title')}</h3><button type="button" className="lnk bw-lnkbtn" data-ctl="CTL-OFC-06-20" onClick={p.onMap}>{t('customers.address.map')}</button></div>
            <dl className="kv" data-ctl="CTL-OFC-06-09">
              <dt>{t('customers.address.street')}</dt>
              <dd>{d.address.houseNumber} {d.address.street}<br />{t('customers.address.cityLine', { city: d.address.city, zip: d.address.zip })}</dd>
              {d.address.homeType ? <><dt>{t('customers.address.home')}</dt><dd data-ctl="CTL-OFC-06-27">{d.address.homeType}</dd></> : null}
              {d.address.gettingIn ? <><dt>{t('customers.address.gettingIn')}</dt><dd data-ctl="CTL-OFC-06-27">{d.address.gettingIn}</dd></> : null}
            </dl>
          </section>

          <section className="card club" data-ctl="CTL-OFC-06-21">
            <div className="card-h"><h3>{t('customers.plan.club')}</h3>{d.membership ? <span className="muted">{t('customers.club.since', { date: monthYear(t, d.membership.since) })}</span> : null}</div>
            {d.membership ? (
              <>
                <ul><li>{t('customers.club.b1')}</li><li>{t('customers.club.b2')}</li><li>{t('customers.club.b3')}</li></ul>
                <div className="ren">{t('customers.club.renews', { date: dateLong(t, d.membership.renews) })}</div>
              </>
            ) : <div className="ren">{t('customers.plan.none')}</div>}
          </section>
        </div>

        <div className="col">
          <section className="card">
            <div className="card-h"><h3>{t('customers.equipment.title')}</h3>{gate('addEquipment') ? <button type="button" className="lnk bw-lnkbtn" data-ctl="CTL-OFC-06-17" onClick={p.onAddEquipment}>{t('customers.equipment.add')}</button> : null}</div>
            {d.equipment.length === 0 ? <p className="r1-note bw-cu-pad">{t('customers.equipment.none')}</p> : (
              <div className="eqg" data-ctl="CTL-OFC-06-10">
                {d.equipment.map((e) => {
                  const ic = equipmentIcon(e.type);
                  return (
                    <div className="eq" key={e.id}>
                      <span className={`ico ${ICON_BG[ic.tone]}`}><Icon name={ic.icon} /></span>
                      <div>
                        <b>{equipmentLine(t, e)}</b>
                        {e.location || e.details ? <div className="d">{[e.details, e.location].filter(Boolean).join(', ')}</div> : null}
                      </div>
                      {gate('editEquipment') ? <button type="button" className="lnk eqe bw-lnkbtn" data-ctl="CTL-OFC-06-18" onClick={() => p.onEditEquipment(e.id)}>{t('customers.page.edit')}</button> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card bw-pb4">
            <div className="card-h"><h3>{t('customers.history.title')}</h3>{d.history.length > 0 ? <span className="muted" data-ctl="CTL-OFC-06-28">{t('customers.history.count', { count: d.history.length, span })}</span> : null}</div>
            {d.history.length === 0 ? <p className="r1-note bw-cu-pad">{t('customers.history.none')}</p> : (
              <>
                {oldHistory.length > 0 && d.source === 'import' ? (
                  <div className="imp" data-ctl="CTL-OFC-06-28"><Icon name="download" />{d.importedAt ? t('customers.history.imported', { date: dateLong(t, d.importedAt.slice(0, 10)) }) : t('customers.history.importedNoDate')}</div>
                ) : null}
                <table className="hist" data-ctl="CTL-OFC-06-12">
                  <thead><tr><th>{t('customers.history.date')}</th><th>{t('customers.history.visit')}</th><th>{t('customers.history.technician')}</th><th>{t('customers.history.done')}</th></tr></thead>
                  <tbody>
                    {d.history.map((h, i) => (
                      <tr key={i}>
                        <td className="w">{dateLong(t, h.date)}{h.old ? <small className="src2">{t('customers.history.old')}</small> : null}</td>
                        <td className="n"><HistoryVisit jobNumber={h.jobNumber}>{h.serviceId ? serviceWord(t, h.serviceId) : h.service}</HistoryVisit></td>
                        <td className={`n${h.technician ? '' : ' muted'}`}>{h.technician ?? t('customers.history.notRecorded')}</td>
                        {h.workDone.length > 0
                          ? <td>{h.workDone.map((line, j) => <Fragment key={j}>{j > 0 ? <br /> : null}{line}</Fragment>)}</td>
                          : <td className="muted">{t('customers.history.notRecorded')}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </div>

        <div className="col">
          <div data-ctl="CTL-OFC-06-11">
            {next ? (
              <section className="card up" data-ctl="CTL-OFC-06-29">
                <div className="top">
                  <div className="s">{next.status === 'on_the_way' ? <span className="pulse" /> : null}{t('customers.visit.upcoming', { status: t(STATUS_WORD[next.status]) })}</div>
                  <div className="big">{dayShort(t, next.day)}, {windowText(next.window.start, next.window.end)}</div>
                  <div className="sub">
                    {next.eta ? t('customers.visit.subEta', { service: serviceWord(t, next.serviceId), job: next.jobNumber, eta: clockText(next.eta) }) : t('customers.visit.sub', { service: serviceWord(t, next.serviceId), job: next.jobNumber })}
                  </div>
                </div>
                <div className="tech">
                  {next.technician ? (
                    <>
                      <span className="av">{next.technician.initials}</span>
                      <div><b>{next.technician.name}</b><span className="s">{[next.technician.van ? t('customers.visit.van', { van: next.technician.van }) : null, t(`skill.${next.technician.skill}` as MessageKey)].filter(Boolean).join(' - ')}</span></div>
                    </>
                  ) : <div><b>{t('customers.visit.noTech')}</b></div>}
                  <Link className="btn sm" href={`/office/jobs/${next.jobNumber}`} data-ctl="CTL-OFC-06-30">{t('customers.visit.open')}</Link>
                </div>
              </section>
            ) : <section className="card"><div className="card-h"><h3>{t('customers.visit.title')}</h3></div><p className="r1-note bw-cu-pad">{t('customers.noVisit')}</p></section>}
            {d.upcoming.length > 1 ? (
              <ul className="bw-cu-more">
                {d.upcoming.slice(1).map((j) => (
                  <li key={j.jobNumber}><Link href={`/office/jobs/${j.jobNumber}`}>{t('customers.visit.line', { day: dayShort(t, j.day), window: windowText(j.window.start, j.window.end), service: serviceWord(t, j.serviceId), job: j.jobNumber })}</Link></li>
                ))}
              </ul>
            ) : null}
          </div>

          <section className="card">
            <div className="card-h"><h3>{t('customers.notes.title')}</h3>{gate('note') ? <button type="button" className="lnk bw-lnkbtn" data-ctl="CTL-OFC-06-19" onClick={p.onAddNote}>{t('customers.notes.add')}</button> : null}</div>
            <div data-ctl="CTL-OFC-06-22">
              {d.notes.length === 0 ? <p className="r1-note bw-cu-pad">{t('customers.notes.none')}</p> : d.notes.map((n) => (
                <div className={`note${n.authorKind === 'technician' ? ' tn' : ''}`} key={n.id}>
                  {n.text}
                  <div className="by">{t(n.authorKind === 'office' ? 'customers.note.office' : 'customers.note.technician', { name: n.authorKind === 'office' ? shortName(n.author) : n.author, date: noteWhen(t, n.at, noteYear) })}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-h"><h3>{t('customers.texts.title')}</h3>{gate('inbox') ? <button type="button" className="lnk bw-lnkbtn" data-ctl="CTL-OFC-06-02" onClick={p.onInbox}>{t('customers.texts.inbox')}</button> : null}</div>
            {p.inboxError ? <p className="r1-note bw-cu-in" role="alert">{t('job.feed.inboxError')}</p> : null}
            <div className="feed" data-ctl="CTL-OFC-06-13">
              {d.recentTexts.length === 0 ? <p className="r1-note">{t('customers.texts.none')}</p> : [...d.recentTexts].reverse().map((x, i) => (
                <div className={`ev${x.kind === 'on_the_way' && x.direction === 'out' && i === d.recentTexts.length - 1 ? ' now' : ''}`} key={i}>
                  <span className="dot"><Icon name={x.kind === 'on_the_way' ? 'truck' : 'message'} /></span>
                  <div className="t">{TEXT_KIND(t, x.kind, x.direction, first)}<small>{dayShort(t, x.at.slice(0, 10))}, {clockText(x.at)}</small></div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

export { initialsOf };
