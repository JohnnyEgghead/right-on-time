// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-03 Job detail at `/office/jobs/{jobNumber}` (DK-87; UI-SPECIFICATION SCR-OFC-03): reads API-23, and API-135 on its interval
// while the job is On the way (GAP-7), re-reads on EVT-01 for this job (CMP-11 "This job changed. Showing the latest."), quietly on
// EVT-03 and EVT-07 for this job (a text's status word, the billing chip: F-702), and hosts the 7 dialogs. A dialog gets the job as it
// opened: a re-read behind it moves the page, never the version it will send (F-697). The office may change a job that is not Done,
// No one home or Canceled (CTL-OFC-03-04 to -08; F-505); each role-gated control shows only for a role whose API-07 keys hold its
// contract ID (F-565).
// The office kit slices first: the page's own sheet comes after them, as its frame's does.
import '../shell/css/office.ts';
import '../../styles/page-office-job.css';
import '../../styles/app/job.css';
import { subscribeEvents, type OnTheWayAnswer } from '@bw/api';
import { shortName, type MessageKey } from '@bw/i18n';
import { notFound } from 'next/navigation';
import { HistoryVisit } from './HistoryVisit';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { timeText, windowText } from '../board/model.ts';
import { formatPhone, US_ZONES } from '../customers/model.ts';
import type { BranchId } from '../map/map-model.ts';
import { MapView } from '../map/MapView.tsx';
import { useAnnounce } from '../shell/Announcer.tsx';
import { CallButton } from '../shell/CallButton.tsx';
import type { FrameData } from '../shell/frame-data.ts';
import { OfficeFrame } from '../shell/Frames.tsx';
import { Icon } from '../shell/Icon.tsx';
import type { IconName } from '../shell/icon-paths.ts';
import { useT } from '../shell/intl.tsx';
import { useMeRead } from '../shell/me.ts';
import type { Me } from '../shell/OfficeTopBar.tsx';
import { ErrorPanel, LiveIndicator, type LiveState } from '../shell/Panels.tsx';
import { jobApi, type JobApi } from './api.ts';
import { CancelDialog, EditDetailsDialog, EquipmentDialog, NoteDialog, ReassignJobDialog, TextDialog } from './Dialogs.tsx';
import { FinishDialog } from './FinishDialog.tsx';
import { PhotoViewer, StoredImage, thumbSrc } from './PhotoViewer.tsx';
import { RescheduleJobDialog } from './RescheduleJobDialog.tsx';
import { DoneTrail } from '../newjob/DoneTrail.tsx';
import { takeHandoff } from '../newjob/model.ts';
import { actionsOpen, can, chipClass, closedKey, CONTROL_CONTRACT, equipmentWord, feedKey, notesOf, statusKey, textStatusKey, type Job, type Shown } from './model.ts';

export type JobModal =
  | { kind: 'reassign' } | { kind: 'reschedule' } | { kind: 'cancel' } | { kind: 'edit' } | { kind: 'finish' } | { kind: 'text' } | { kind: 'note' }
  | { kind: 'equipment'; id: string };

const PANEL_MS = 30_000;
/** How long after this page's own write a change event for the job counts as that write's echo. */
const OWN_WRITE_MS = 5_000;
const WRITES = ['assign', 'reschedule', 'cancel', 'edit', 'finish', 'correct', 'text', 'note', 'equipment'] as const;
/** The page's calls, with each write counted while it runs and stamped when it ends. */
function tracked(api: JobApi, own: { pending: number; last: number }): JobApi {
  const out = { ...api };
  for (const k of WRITES) {
    const call = api[k] as (...a: unknown[]) => Promise<unknown>;
    (out as Record<string, unknown>)[k] = async (...a: unknown[]) => {
      own.pending++;
      try {
        return await call(...a);
      } finally {
        own.pending--;
        own.last = performance.now();
      }
    };
  }
  return out;
}
/** CTL-OFC-03-19: the billing state's chip (DK-87 Done: In billing; Finish visit Done: Retrying every 15 minutes). */
const BILL_CHIP: Record<string, string> = { in_billing: 'site', retrying: 'retry', waiting_person: 'late', marked_fixed: 'done', sending: 'sched', not_sent: 'sched' };
/** The feed's icon per timeline kind (DK-87: booked online, the technician's trip, office changes). */
const FEED_ICON: Record<string, IconName> = { created: 'globe', confirmed: 'message', assigned: 'user', rescheduled: 'calendar', canceled: 'alert', status_set: 'check', note_added: 'note' };
const dateLong = (date: string, lang: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dateShort = (wire: string, lang: string) => new Date(`${wire.slice(0, 10)}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** A date with its year and no weekday (DK-87: "Oct 14, 2025", on a past visit and on a note of another year than the job's). */
const datePast = (wire: string, lang: string) => new Date(`${wire.slice(0, 10)}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** A note's date (DK-87: "Thu, Sep 10", and "Oct 14, 2025" for a note of another year than the job's). */
const noteDate = (wire: string, jobDate: string, lang: string) => (wire.slice(0, 4) === jobDate.slice(0, 4) ? dateShort(wire, lang) : datePast(wire, lang));
const firstName = (n: string) => n.split(' ')[0] ?? n;
const lengthText = (minutes: number, t: ReturnType<typeof useT>) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? t('job.length.min', { m }) : m === 0 ? t('job.length.hr', { h }) : t('job.length.hrMin', { h, m });
};

export interface JobScreenProps {
  jobNumber: number;
  /** Previews and tests: a stand-in for the calls, a fixed signed-in person, a modal open, no live stream. */
  api?: JobApi;
  me?: Me;
  fixed?: { job: Job | 'loading' | 'error' | 'not_found'; onTheWay?: OnTheWayAnswer | null | 'failed'; modal?: JobModal | null; live?: LiveState; extra?: React.ReactNode; frame?: Omit<FrameData, 'screen' | 'children'>; screen?: string };
}

/** The customer's time zone as the customer page words it (Eastern, Central), the zone id when it is not one of the 7 offered. */
const zoneWord = (t: ReturnType<typeof useT>, id: string): string => {
  const z = US_ZONES.find((x) => x.id === id);
  return z ? t(z.key as MessageKey) : id;
};

/** CTL-OFC-03-15: a photo's thumbnail opens the viewer; one whose file does not load is the words "Photo could not load", not a button (CTL-OFC-03-14; F-707). */
function PhotoThumb({ photo, label, failedWords, onOpen }: { photo: { key: string }; label: string; failedWords: string; onOpen: () => void }) {
  const [bad, setBad] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // the file may have failed before the page hydrated, so onError never ran: look at the image once mounted
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setBad(true);
  }, []);
  if (bad) return <span className="th fail" data-photo={photo.key}>{failedWords}</span>;
  return (
    <button type="button" className="th bw-btn-reset" data-ctl="CTL-OFC-03-15" data-photo={photo.key} aria-label={label} onClick={onOpen}>
      <img ref={img} className="bw-th-img" src={thumbSrc(photo.key)} alt="" onError={() => setBad(true)} />
    </button>
  );
}

export function JobScreen({ jobNumber, api: given, me: givenMe, fixed }: JobScreenProps) {
  const t = useT();
  const announce = useAnnounce();
  // This page's own writes, so their EVT-01 echo re-reads quietly: one may arrive before the write's own answer.
  const own = useRef({ pending: 0, last: -Infinity });
  const api = useMemo(() => tracked(given ?? jobApi(), own.current), [given]);
  const { me, failed: meFailed, retry: retryMe } = useMeRead(fixed ? false : undefined, givenMe);
  const [job, setJob] = useState<Job | 'loading' | 'error' | 'not_found'>(fixed?.job ?? 'loading');
  const [way, setWay] = useState<OnTheWayAnswer | null | 'failed'>(fixed?.onTheWay ?? null);
  // CTL-OFC-03-15, -16: the photo the viewer shows, by its place in the job's photos (F-707).
  const [viewer, setViewer] = useState<number | null>(null);
  const [modal, setModal] = useState<JobModal | null>(fixed?.modal ?? null);
  // The job as the open dialog opened on it (F-697).
  const [opened, setOpened] = useState<Job | null>(null);
  const [live, setLive] = useState<LiveState>(fixed?.live ?? 'live');
  const [inboxError, setInboxError] = useState(false);
  // The job SCR-OFC-04's Schedule opened this page on (CTL-OFC-03-01): the handoff is read once, so any other way here keeps the Board trail.
  const [scheduled, setScheduled] = useState<number | null>(null);

  // Reads overlap when events come close together (queued, sending, delivered): only the newest read's answer is shown.
  const newest = useRef(0);
  const read = useCallback(async (changed = false) => {
    const mine = ++newest.current;
    const r = await api.job(jobNumber);
    if (mine !== newest.current) return;
    if (!r.ok) return setJob(r.code === 'not_found' ? 'not_found' : (prev) => (typeof prev === 'object' ? prev : 'error'));
    setJob(r.data);
    if (changed) announce(t('job.changed'), 'info');
    // SCR-OFC-04's Schedule opened this page: CMP-11 states the server's answer about the confirmation text (GAP-10), once.
    const handed = fixed ? null : takeHandoff(jobNumber);
    if (handed) {
      setScheduled(jobNumber);
      announce(t(handed.key, handed.values), 'check');
    }
  }, [api, jobNumber]);
  useEffect(() => { if (!fixed) void read(); }, [read]);

  const status = typeof job === 'object' ? job.job.status : null;
  // CTL-OFC-03-25: the panel re-reads API-135 on its interval while On the way; at arrival the panel goes away (NFR-04).
  useEffect(() => {
    if (fixed || status !== 'on_the_way') { if (!fixed) setWay(null); return; }
    let on = true;
    const tick = async () => {
      const r = await api.onTheWay(jobNumber);
      // API-135 answers 410 gone once the technician has arrived: the panel goes away, it is not a failed read (F-868).
      if (on) setWay(r.ok ? r.data : r.code === 'gone' ? null : 'failed');
    };
    void tick();
    const id = window.setInterval(() => void tick(), PANEL_MS);
    return () => { on = false; window.clearInterval(id); };
  }, [status, api, jobNumber]);

  const branch = typeof job === 'object' ? job.job.branch : null;
  const onLive = useRef(read);
  onLive.current = read;
  useEffect(() => {
    if (fixed || !branch) return;
    const h = subscribeEvents({
      branch,
      onEvent: (e) => {
        // This page's own write comes back as EVT-01 too: it re-reads quietly, so the write's own toast stays (CMP-11).
        if (e.name === 'job.changed' && Number(e.ids['jobNumber']) === jobNumber) void onLive.current(own.current.pending === 0 && performance.now() - own.current.last > OWN_WRITE_MS);
        // A text's status and the billing state are this page's too (SCR-OFC-03 Live: EVT-03, EVT-07); they re-read quietly, as CMP-11 is for the job's own changes.
        if ((e.name === 'text.changed' || e.name === 'billing.changed') && Number(e.ids['jobNumber']) === jobNumber) void onLive.current();
        if (e.name === 'world.reset' || e.name === 'clock.changed') void onLive.current();
      },
      onReconnect: () => void onLive.current(),
      onState: (s) => setLive(s === 'live' ? 'live' : s === 'closed' ? 'paused' : 'reconnecting'),
    });
    return () => h.close();
  }, [branch, jobNumber]);

  const done = (shown: Shown) => {
    setModal(null);
    announce(t(shown.key as MessageKey, shown.values), 'check');
    void read();
  };
  // SCR-OFC-19's Keep their change: closes and re-reads (CTL-OFC-19-03), with or without a live stream.
  const keep = () => {
    setModal(null);
    void read();
  };

  const perms = me?.permissions ?? null;
  const frame = (body: React.ReactNode) => <OfficeFrame screen={fixed?.screen ?? 'SCR-OFC-03'} {...(me ? { me } : {})} {...(fixed?.frame ?? {})} bar={{ currentPath: '/office/board' }}>{body}</OfficeFrame>;
  if (job === 'loading') return frame(<div className="jh"><div className="bw-job-state"><span className="r1-skel bw-w-40" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /></div></div>);
  if (job === 'error') return frame(<ErrorPanel title={t('job.loadError')} hint={t('job.loadErrorHint')} onRetry={() => read()} />);
  // An unknown job number opens the Page not found page (SCR-SHR-02; DK-87 Not found).
  if (job === 'not_found') notFound();

  const j = job;
  const show = (m: JobModal) => {
    setOpened(j);
    setModal(m);
  };
  const base = opened ?? j;
  const open = actionsOpen(j.job.status);
  const why = closedKey(j.job.status);
  const service = t(j.job.serviceLabelKey as MessageKey);
  const win = windowText(j.job.window.start, j.job.window.end);
  const gate = (k: keyof typeof CONTROL_CONTRACT) => can(perms, CONTROL_CONTRACT[k]);
  const act = (k: keyof typeof CONTROL_CONTRACT, ctl: string, label: string, onClick: () => void, cls = 'btn sm', icon?: IconName) => {
    if (!gate(k)) return null;
    const off = !open && k !== 'note' && k !== 'text' && k !== 'equipment';
    // A closed job's actions are drawn plain and off (DK-87 Canceled, Done, No one home), the primary Finish visit too.
    return off
      ? <button type="button" className={`${cls.replace(' primary', '')} dis`} aria-disabled="true" data-ctl={ctl} title={why ? t(why) : undefined} key={ctl}>{icon ? <Icon name={icon} /> : null}{label}</button>
      : <button type="button" className={cls} data-ctl={ctl} onClick={onClick} key={ctl}>{icon ? <Icon name={icon} /> : null}{label}</button>;
  };
  const chip = (() => {
    const s = t(statusKey(j.job));
    const arr = j.job.status === 'on_the_way' && way && way !== 'failed' && way.eta ? `, ${t('job.chip.arriving', { time: timeText(way.eta) })}` : '';
    const site = j.job.status === 'on_site' && j.job.arrivedAt ? ` ${t('job.chip.since', { time: timeText(j.job.arrivedAt) })}` : '';
    const noh = j.job.noOneHome ? ` - ${t('job.chip.noOneHome', { by: j.job.noOneHome.by ?? '', time: timeText(j.job.noOneHome.at) })}` : '';
    return `${s}${arr}${site}${noh}${j.job.confirmed ? `. ${t('job.chip.confirmed')}` : ''}`;
  })();
  const textOff = !j.customer.mobile ? 'job.text.noMobile' : !j.customer.textsOn ? 'job.text.textsOff' : null;
  const hasPhone = j.customer.phone !== null;
  const panel = j.job.status === 'on_the_way' && way !== null;
  const notes = notesOf(j);
  // CTL-OFC-03-17: the timeline entries and the texts in 1 list, in time order (the newest last, marked while the job is On the way).
  const feed = [
    ...j.timeline.map((e, i) => ({ key: `${e.kind}-${i}`, at: e.at, kind: e.kind, by: e.by, words: feedKey(e), text: null })),
    ...j.texts.map((x) => ({ key: x.id, at: x.at, kind: 'text', by: null, words: null, text: x })),
  ].sort((a, b) => Date.parse(a.at.replace(/\[.*\]$/, '')) - Date.parse(b.at.replace(/\[.*\]$/, '')));

  return frame(
    <>
      <div className="jh">
        {scheduled === jobNumber ? <DoneTrail jobNumber={jobNumber} /> : (
          <div className="crumbs" data-ctl="CTL-OFC-03-01">
            <a href={`/office/board?branch=${j.job.branch}`}>{t('job.crumb.board')}</a><Icon name="chevRight" />
            <a href={`/office/board?branch=${j.job.branch}&date=${j.job.date}`}>{dateShort(j.job.date, t.lang)}</a><Icon name="chevRight" />
            <span>{t('job.crumb.job', { job: j.job.jobNumber })}</span>
          </div>
        )}
        <LiveIndicator state={live} />
        <div className="row">
          <h1>{service} <span>{`- ${j.customer.name}`}</span></h1>
          <span className={`chip ${chipClass(j.job.status)} big`} data-ctl="CTL-OFC-03-09"><span className="dot" />{chip}</span>
          <div className="acts">
            {meFailed ? <ErrorPanel title={t('job.actionsError')} hint={null} onRetry={retryMe} /> : null}
            {gate('text') ? (textOff
              ? <button type="button" className="btn dis" aria-disabled="true" title={t(textOff)} data-ctl="CTL-OFC-03-21"><Icon name="message" />{t('job.act.text')}</button>
              : <button type="button" className="btn" data-ctl="CTL-OFC-03-21" onClick={() => show({ kind: 'text' })}><Icon name="message" />{t('job.act.text')}</button>) : null}
            {hasPhone ? <span data-ctl="CTL-OFC-03-22"><CallButton className="btn" name={firstName(j.customer.name)} fullName={j.customer.name} number={j.customer.phone as string}><Icon name="phone" />{t('job.act.call', { name: firstName(j.customer.name) })}</CallButton></span> : null}
            {act('reassign', 'CTL-OFC-03-04', t('job.act.reassign'), () => show({ kind: 'reassign' }), 'btn', 'user')}
            {act('note', 'CTL-OFC-03-23', t('job.act.note'), () => show({ kind: 'note' }), 'btn primary', 'note')}
          </div>
        </div>
        <div className="meta">
          <span className="jline" data-ctl="CTL-OFC-03-20">
            <span><Icon name="calendar" />{dateLong(j.job.date, t.lang)}</span>
            <span><Icon name="clock" />{t('job.meta.window', { window: win })}</span>
            <span><Icon name="pin" />{j.customer.area}</span>
            <span><Icon name="wrench" />{`${t(`job.type.${j.job.jobType}` as MessageKey)}, ${t('job.meta.about', { length: lengthText(j.job.expectedMinutes, t) })}`}</span>
            <span><Icon name="globe" />{t(j.job.bookedVia === 'online' ? 'job.meta.bookedOnline' : 'job.meta.bookedOffice', { date: dateShort(j.job.bookedAt, t.lang) })}</span>
          </span>
          <span className="acts2">
            {act('reschedule', 'CTL-OFC-03-05', t('job.act.reschedule'), () => show({ kind: 'reschedule' }))}
            {act('edit', 'CTL-OFC-03-06', t('job.act.edit'), () => show({ kind: 'edit' }))}
            {act('cancel', 'CTL-OFC-03-07', t('job.act.cancel'), () => show({ kind: 'cancel' }))}
            {act('finish', 'CTL-OFC-03-08', t('job.act.finish'), () => show({ kind: 'finish' }), 'btn sm primary')}
          </span>
        </div>
        {why ? <p className="r1-note">{t(why)}</p> : null}
      </div>

      <div className="body">
        <div className="left">
          <section className="card">
            <div className="card-h"><h3>{t('job.customer.title')}</h3><a className="lnk" href={`/office/customers/${j.customer.id}`} data-ctl="CTL-OFC-03-02">{t('job.customer.open')}</a></div>
            <dl className="kv" data-ctl="CTL-OFC-03-10">
              <dt>{t('job.customer.name')}</dt><dd>{j.customer.name}</dd>
              <dt>{t('job.customer.mobile')}</dt><dd>{j.customer.mobile ? `${formatPhone(j.customer.mobile)} - ${t(j.customer.textsOn ? 'job.customer.textsOn' : 'job.customer.textsOff')}` : t('job.customer.noMobile')}</dd>
              <dt>{t('job.customer.address')}</dt><dd>{j.customer.address}</dd>
              <dt>{t('job.customer.textsIn')}</dt><dd>{t('job.customer.textsInValue', { language: t(j.customer.language === 'es' ? 'language.name.es' : 'language.name.en'), zone: zoneWord(t, j.customer.zone) })}</dd>
              <dt>{t('job.customer.since')}</dt><dd>{t('job.customer.sinceValue', { since: new Date(`${j.customer.customerSince}T12:00:00Z`).toLocaleDateString(t.lang === 'es' ? 'es-US' : 'en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), n: j.customer.pastVisitCount })}</dd>
              <dt>{t('job.customer.plan')}</dt><dd>{t(j.customer.plan ? 'job.customer.club' : 'job.customer.noPlan')}</dd>
            </dl>
          </section>

          <section className="card">
            <div className="card-h"><h3>{t('job.equipment.heading')}</h3>
              {gate('equipment') && j.equipment[0] ? <button type="button" className="lnk" data-ctl="CTL-OFC-03-24" onClick={() => show({ kind: 'equipment', id: j.equipment[0]!.id })}>{t('job.equipment.edit')}</button> : null}</div>
            <div data-ctl="CTL-OFC-03-11">
              {j.equipment.length === 0 ? <p className="r1-note bw-in-card">{t('job.equipment.none')}</p> : j.equipment.map((e) => (
                <div className="eq" key={e.id}>
                  <span className="ico"><Icon name="gauge" /></span>
                  <div><b>{[equipmentWord(t, e.type), e.year].filter((x) => x !== null).join(' - ')}</b><div className="d">{[e.details, e.location].filter(Boolean).join(', ')}</div></div>
                  {gate('equipment') ? <button type="button" className="lnk" data-ctl="CTL-OFC-03-24" onClick={() => show({ kind: 'equipment', id: e.id })}>{t('job.equipment.edit')}</button> : null}
                </div>
              ))}
            </div>
          </section>

          <section className="card span2 bw-pb-4">
            <div className="card-h"><h3>{t('job.history.title')}</h3>
              <span className="muted small">{t(j.history.fromOldSystem ? 'job.history.countOld' : 'job.history.count', { n: j.history.count })}</span>
              {j.history.count > 3 ? <a className="lnk" href={`/office/customers/${j.customer.id}#history`} data-ctl="CTL-OFC-03-13">{t('job.history.all')}</a> : null}
            </div>
            {j.history.count === 0 ? <p className="r1-note bw-in-card">{t('job.history.none')}</p> : (
              <table className="hist" data-ctl="CTL-OFC-03-12">
                <thead><tr><th>{t('job.history.date')}</th><th>{t('job.history.visit')}</th><th>{t('job.history.tech')}</th><th>{t('job.history.what')}</th></tr></thead>
                <tbody>
                  {j.history.visits.map((v, i) => (
                    <tr key={`${v.date}-${i}`}><td className="w">{datePast(v.date, t.lang)}</td><td><HistoryVisit jobNumber={v.jobNumber}>{v.serviceLabelKey ? t(v.serviceLabelKey as MessageKey) : (v.what ?? '')}</HistoryVisit></td><td>{v.technician ?? ''}</td><td>{v.workDone.length > 0 ? v.workDone.map((line, k) => <Fragment key={k}>{k > 0 ? <br /> : null}{line}</Fragment>) : t(v.oldSystem ? 'job.history.oldSystem' : 'customers.history.notRecorded')}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card span2">
            <div className="card-h"><h3>{t('job.notes.title')}</h3>{gate('note') ? <button type="button" className="lnk" data-ctl="CTL-OFC-03-23" onClick={() => show({ kind: 'note' })}>{t('job.notes.add')}</button> : null}</div>
            <div className="notes" data-ctl="CTL-OFC-03-14">
              {notes.length === 0 ? <p className="r1-note bw-in-card">{t('job.notes.none')}</p> : notes.map((n) => (
                <div className={`note${n.kind === 'technician' ? ' tn' : ''}`} key={n.id}>{n.body}
                  <div className="by">{t(n.kind === 'office' ? 'job.notes.office' : 'job.notes.tech', { by: n.kind === 'office' && n.author ? shortName(n.author) : (n.author ?? ''), at: `${noteDate(n.at, j.job.date, t.lang)}, ${timeText(n.at)}` })}
                    {n.enteredOffline ? ` ${t('job.notes.offline', { at: timeText(n.at), sent: timeText(n.sentAt) })}` : ''}</div>
                </div>
              ))}
              {j.photos.length > 0 ? (
                <div className="thumbs">
                  {j.photos.map((p, i) => (
                    <PhotoThumb key={p.key} photo={p} label={t('job.photo.alt', { by: p.by ?? '', at: timeText(p.at) })} failedWords={t('job.photo.failed')} onOpen={() => setViewer(i)} />
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <div className="right">
          {panel ? (
            <section className="card arrive" data-ctl="CTL-OFC-03-25">
              {way === 'failed' ? <p className="r1-note bw-in-card" role="status">{t('job.way.failed')}</p> : way ? (
                <>
                  <div className="top">
                    <div className="s"><span className="pulse" />{t('status.job.onTheWay')}</div>
                    {way.eta ? <div className="big">{t('job.way.arriving', { time: timeText(way.eta) })}</div> : null}
                    {way.minutesAway !== null ? <div className="sub">{t(way.insideWindow ? 'job.way.insideWindow' : 'job.way.outsideWindow', { n: way.minutesAway, window: win })}</div> : null}
                  </div>
                  <div className="mapm">
                    <MapView branch={j.job.branch as BranchId} variant="card" fit markers={[
                      ...(way.van ? [{ id: 'van', kind: 'van' as const, state: 'way' as const, at: [way.van.lon, way.van.lat] as const, text: way.minutesAway !== null ? t('job.length.min', { m: way.minutesAway }) : (way.technician?.initials ?? ''), words: t('job.way.vanWords', { name: way.technician?.name ?? '' }) }] : []),
                      ...(way.destination ? [{ id: 'dest', kind: 'house' as const, at: [way.destination.lon, way.destination.lat] as const, words: t('job.way.destWords', { customer: j.customer.name }) }] : []),
                    ]} />
                  </div>
                  {way.technician ? (
                    <div className="tech" data-ctl="CTL-OFC-03-26"><span className="av">{way.technician.initials}</span>
                      <div><b>{way.technician.name}</b><span className="s">{[way.technician.van ? t('job.way.van', { van: way.technician.van }) : null, t(`skill.${way.technician.skill}` as MessageKey)].filter(Boolean).join(', ')}</span></div>
                      <span data-ctl="CTL-OFC-03-27"><CallButton name={firstName(way.technician.name)} fullName={way.technician.name} number={way.technician.phone}><Icon name="phone" />{t('job.act.call', { name: firstName(way.technician.name) })}</CallButton></span>
                      {act('reassign', 'CTL-OFC-03-28', t('job.act.reassign'), () => show({ kind: 'reassign' }))}
                    </div>
                  ) : null}
                  {way.linkSentAt ? <div className="linkbox" data-ctl="CTL-OFC-03-29"><Icon name="lock" /><div>{t('job.way.link', { time: timeText(way.linkSentAt), name: firstName(way.technician?.name ?? '') })}</div></div> : null}
                </>
              ) : null}
            </section>
          ) : null}

          <section className="card">
            <div className="card-h"><h3>{t('job.feed.title')}</h3><span className="muted small">{t('job.feed.zone')}</span>
              <button type="button" className="lnk" data-ctl="CTL-OFC-03-03" onClick={() => void api.inboxLink(j.customer.id).then((r) => {
                if (r.ok) { setInboxError(false); window.open(r.data.url, '_blank', 'noopener'); } else setInboxError(true);
              })}>{t('job.feed.inbox')}</button>
            </div>
            {inboxError ? <p className="r1-note bw-in-card" role="alert">{t('job.feed.inboxError')}</p> : null}
            <div className="feed" data-ctl="CTL-OFC-03-17">
              {feed.map((e, i) => {
                const now = i === feed.length - 1 && j.job.status === 'on_the_way';
                return e.text ? (
                  <div className={now ? 'ev now' : 'ev'} key={e.key}><span className="dot"><Icon name={e.text.kind === 'on_the_way' ? 'truck' : 'message'} /></span>
                    <div className="t">{t('job.feed.text', { kind: t(`job.feed.textKind.${e.text.kind}` as MessageKey), status: t(textStatusKey(e.text.status)) })}<small>{`${dateShort(e.at, t.lang)}, ${timeText(e.at)} - `}<a className="r1-link" href={`/office/messages?text=${e.text.id}`} data-ctl="CTL-OFC-03-18">{t('job.feed.openMessages')}</a></small></div></div>
                ) : (
                  <div className={now ? 'ev now' : 'ev'} key={e.key}><span className="dot"><Icon name={FEED_ICON[e.kind] ?? 'clock'} /></span>
                    <div className="t">{t(e.words as MessageKey, { by: e.by ?? '' })}<small>{`${dateShort(e.at, t.lang)}, ${timeText(e.at)}`}</small></div></div>
                );
              })}
            </div>
          </section>

          {j.job.status === 'done' ? (
            <section className="card">
              <div className="card-h"><h3>{t('job.done.title')}</h3></div>
              <div className="wd bw-in-card" data-ctl="CTL-OFC-03-30">
                {j.finish && j.finish.workDone.length > 0 ? <ul>{j.finish.workDone.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
                <p>{j.signature ? t('job.done.signed', { name: j.signature.signedBy, time: timeText(j.signature.at) }) : t('job.done.notSigned')}</p>
                {j.signature?.key ? <StoredImage fileKey={j.signature.key} className="bw-sig-img" alt={t('job.done.signed', { name: j.signature.signedBy, time: timeText(j.signature.at) })} failed={<p className="r1-note" role="status">{t('job.done.sigFailed')}</p>} /> : null}
              </div>
              <p className="bill bw-in-card" data-ctl="CTL-OFC-03-19">{t('job.billing.label')}
                <span className={`chip ${BILL_CHIP[j.billing.state] ?? 'sched'}`}><span className="dot" />{t(`job.billing.${j.billing.state}` as MessageKey)}</span>
                <a className="r1-link" href={`/office/billing?branch=${j.job.branch}`}>{t('job.billing.open')}</a></p>
            </section>
          ) : null}
        </div>
      </div>
      {fixed?.extra ?? null}

      {modal?.kind === 'reassign' ? <ReassignJobDialog job={base} api={api} onClose={() => setModal(null)} onKeep={keep} onDone={done} /> : null}
      {modal?.kind === 'reschedule' ? <RescheduleJobDialog jobNumber={j.job.jobNumber} api={api} onClose={() => setModal(null)} onKeep={keep} onDone={(_answer, toast) => done(toast)} /> : null}
      {modal?.kind === 'cancel' ? <CancelDialog job={base} api={api} onClose={() => setModal(null)} onKeep={keep} onDone={done} /> : null}
      {modal?.kind === 'edit' ? <EditDetailsDialog job={base} api={api} onClose={() => setModal(null)} onKeep={keep} onDone={done} /> : null}
      {modal?.kind === 'text' ? <TextDialog job={base} api={api} onClose={() => setModal(null)} onDone={done} /> : null}
      {viewer !== null ? <PhotoViewer photos={j.photos} at={viewer} onMove={setViewer} onClose={() => setViewer(null)} /> : null}
      {modal?.kind === 'note' ? <NoteDialog job={base} api={api} onClose={() => setModal(null)} onDone={done} /> : null}
      {modal?.kind === 'equipment' ? <EquipmentDialog job={base} api={api} equipmentId={modal.id} onClose={() => setModal(null)} onDone={done} /> : null}
      {modal?.kind === 'finish' ? (
        <FinishDialog mode="finish" jobNumber={j.job.jobNumber} job={base} api={api} onClose={() => setModal(null)} onKeep={keep}
          onDone={() => done({ key: 'job.finish.done' })} />
      ) : null}
    </>,
  );
}
