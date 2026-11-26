// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-04 Job at /tech/jobs/{jobNumber} and its SCR-TEC-06 Add photo sheet at /tech/jobs/{jobNumber}/photo (UI-SPECIFICATION
// section 8; DK-110 mockups/pages/tech-job.html; FR-TECH-3, FR-TECH-8, FR-AUTH-4, FR-DISP-27). The job as API-101 answers it
// (useJob.ts), kept on the phone for an open with no signal, with the technician's own waiting notes, photos and status laid
// over it at once (UI-SPECIFICATION 4.5 rule 6). Add note opens SCR-TEC-05; Add photo opens the sheet, which compresses the
// picked photo to the SD-32 JPEG (photo.ts) and enters it through the item engine, which holds it until API-103 answers.
// Moving between the app's screens is a document load (the service worker serves each page with no signal, and each page
// loads only its own frame's sheet). On my way, Arrived and No one home open P5-TWA-TODAY's confirm sheets (SCR-TEC-03, -13,
// -14), which sit on Today: here they open Today.
import '../../shell/css/phone.ts';
import '../../../styles/page-tech-job.css';
import { fromWire, Temporal } from '@bw/time';
import { useEffect, useRef, useState } from 'react';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { CallButton } from '../../shell/CallButton.tsx';
import { dayIn, useDemoClock, type DemoSource, type DemoTime } from '../../shell/demo-day.ts';
import { Icon } from '../../shell/Icon.tsx';
import { useT } from '../../shell/intl.tsx';
import { useModalFocus } from '../../shell/modal-focus.ts';
import type { OutboxState } from '../engine.ts';
import { NoSignalCard } from '../SyncStrip.tsx';
import { TechAppFrame } from '../TechAppFrame.tsx';
import { HeadClock } from './HeadClock.tsx';
import { useOwedSignatures } from './owed.ts';
import type { ClockAnswer } from '../../shell/clock.ts';
import { techOutbox, useOwnOutbox } from '../useOutbox.ts';
import { clockWords, datePast, noteWhen, shownNotes, shownPhotos, shownStatus, windowWords, type JobStatus, type ShownPhoto } from './model.ts';
import { compressPhoto } from './photo.ts';
import { fileSrc, previewFile, thumbSrc } from './files.ts';
import { jobStore, type JobCopy } from './store.ts';
import { go, jobHref, STATUS_WORD, todaySheetHref } from './nav.ts';
import { IDLE, useDriveMinutes, useJob, type JobView } from './useJob.ts';
import { shownAsToday } from './model.ts';

const STATUS_CLASS: Record<JobStatus, string> = { scheduled: '', on_the_way: '', on_site: '', done: ' done', no_one_home: ' noh', canceled: ' can' };
/** The equipment's icon and its tint class (styles/app/tech.css: the frame's inline colors as classes, since the CSP allows no inline style). */
const EQUIPMENT_ICON: Record<string, { icon: 'flame' | 'snow' | 'drop' | 'gauge' | 'wrench'; tint: string }> = {
  furnace: { icon: 'flame', tint: 'bw-eq-warm' }, air_conditioner: { icon: 'snow', tint: 'bw-eq-cool' },
  water_heater: { icon: 'drop', tint: 'bw-eq-cool' }, thermostat: { icon: 'gauge', tint: 'bw-eq-ink' },
};
const firstName = (n: string) => n.split(' ')[0] ?? n;

/** The phone's demo time: the device clock by the last synced offset (FR-DEMO-9). It is read again at each sync, and does not run in between. */
const phoneClock: DemoSource<DemoTime> = async () => {
  const ms = await techOutbox().demoNowMs();
  return ms === null ? null : { at: Temporal.Instant.fromEpochMilliseconds(ms), answer: { paused: true, rate: 1 } };
};

export interface JobScreenProps {
  jobNumber: number;
  /** /tech/jobs/{n}/photo opens the Add photo sheet over the job. */
  photo?: boolean;
  /** Previews: the job, the engine state, who is signed in and what is open; pages leave it unset. */
  fixed?: { view: JobView; outbox?: OutboxState; me?: string; sheet?: 'none' | 'preview'; viewer?: string; menu?: boolean; draft?: string; finished?: boolean; minutes?: number | null; clock?: ClockAnswer; mini?: boolean; photoSaved?: boolean };
}

/**
 * A thumbnail: the server's small copy (API-175 size thumb, UD-55), or with `full` the whole file (the viewer only), or the phone's
 * own unsent bytes; a file that fails shows the placeholder.
 */
function Thumb({ p, className, alt, full = false }: { p: ShownPhoto; className: string; alt: string; full?: boolean }) {
  const [src, setSrc] = useState<string | null>(previewFile(p.key) ?? (p.waiting ? null : full ? fileSrc(p.key) : thumbSrc(p.key)));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!p.waiting || previewFile(p.key)) return;
    let url: string | null = null;
    void techOutbox().blob(p.key).then((b) => {
      if (!b) return setFailed(true);
      url = URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/jpeg' }));
      setSrc(url);
    }, () => setFailed(true));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [p.key, p.waiting]);
  if (failed || !src) return <span className={`${className} bw-ph-none`}><Icon name="camera" /></span>;
  return <img className={className} src={src} alt={alt} onError={() => setFailed(true)} />;
}

export function JobScreen({ jobNumber, photo = false, fixed }: JobScreenProps) {
  const t = useT();
  const { view, me: liveMe, reload } = useJob(jobNumber, fixed?.view);
  const outbox = useOwnOutbox(fixed ? (fixed.outbox ?? IDLE) : undefined);
  const me = fixed?.me ?? liveMe;
  const owesSignature = useOwedSignatures(outbox.waiting);
  const clk = <HeadClock online={outbox.online} {...(fixed ? { fixed: fixed.clock } : {})} />;
  // The phone's demo time (FR-DEMO-9): this app has no event stream, so each sync that ends (it saves the clock's offset) reads it again.
  const { now: demoAt, readClock } = useDemoClock(fixed ? null : phoneClock);
  const demoNow = demoAt?.epochMilliseconds ?? null;
  useEffect(() => {
    void readClock();
  }, [outbox.waiting, readClock]);
  // Another demo day: the server says today of its read's own day (FR-AUTH-4), so the job is read again, once.
  const demoDay = view.kind === 'job' && demoAt ? dayIn(demoAt, fromWire(view.job.job.window.start).timeZoneId) : null;
  const jobDay = useRef<string | null>(null);
  useEffect(() => {
    if (demoDay === null) return;
    const was = jobDay.current;
    jobDay.current = demoDay;
    if (was !== null && was !== demoDay) reload();
  }, [demoDay, reload]);
  // CTL-TEC-04-04 (F-1369, owner answer fa9c9833): Directions is the drive from the van to THIS job; hidden once the job is On site or ended.
  const driveStatus = view.kind === 'job' ? shownStatus(view.job, outbox.waiting).status : null;
  const driveTo = view.kind === 'job' && view.job.job.today && (driveStatus === 'scheduled' || driveStatus === 'on_the_way') ? jobNumber : null;
  const minutes = useDriveMinutes(driveTo, fixed ? (fixed.minutes ?? null) : undefined);
  const [menu, setMenu] = useState(fixed?.menu ?? false);
  const [viewer, setViewer] = useState<string | null>(fixed?.viewer ?? null);
  const [draft, setDraft] = useState<string | null>(fixed?.draft ?? null);
  // SCR-TEC-07 Saved: the finish screen closes to the job with ?finished=1 (the job shows Done with Waiting to send or Sent).
  const [finished, setFinished] = useState(fixed?.finished ?? false);
  // SCR-TEC-06 Saved: Save photo closes the sheet to the job with ?photo=saved (the new thumbnail shows Waiting to send).
  const [photoSaved, setPhotoSaved] = useState(fixed?.photoSaved ?? false);
  useEffect(() => {
    if (fixed) return;
    const q = new URLSearchParams(window.location.search);
    if (q.get('finished') === '1') setFinished(true);
    if (q.get('photo') === 'saved') setPhotoSaved(true);
  }, [fixed]);
  useEffect(() => {
    if (fixed) return;
    void jobStore().draft(jobNumber).then(setDraft, () => undefined);
  }, [jobNumber, fixed]);

  const frame = (header: React.ReactNode, body: React.ReactNode, bottom?: React.ReactNode) => (
    <TechAppFrame screen={photo ? 'SCR-TEC-06' : 'SCR-TEC-04'} tab="today" header={header} clockInHeader mini={fixed?.mini ?? false}
      {...(fixed ? { fixed: fixed.outbox ?? IDLE, reader: false as const, clock: null } : {})}>
      <div className="body">{body}</div>
      {bottom}
    </TechAppFrame>
  );
  const nav = (mid: string, more?: React.ReactNode) => (
    <div className="nav">
      <span role="link" tabIndex={0} data-ctl="CTL-TEC-04-01" onClick={() => go('/tech')} onKeyDown={(e) => { if (e.key === 'Enter') go('/tech'); }}>
        <Icon name="back" />{t('tech.job.back')}
      </span>
      <span className="mid" data-ctl="CTL-TEC-04-19">{mid}</span>
      {more ?? <span />}
    </div>
  );

  if (view.kind === 'loading') {
    return frame(
      <div className="apphead">{nav(t('tech.job.number', { job: jobNumber }))}<span className="r1-skel bw-skel-title" /><span className="r1-skel bw-skel-line" />{clk}</div>,
      <>
        {[0, 1, 2].map((i) => <div key={i} className="card" aria-hidden="true"><span className="r1-skel bw-skel-40" /><span className="r1-skel" /><span className="r1-skel bw-skel-70" /></div>)}
      </>,
    );
  }
  if (view.kind === 'not_on_phone') {
    return frame(
      <div className="apphead">{nav(t('tech.job.number', { job: jobNumber }))}{clk}</div>,
      <>
        <NoSignalCard fixed={fixed ? { ...(fixed.outbox ?? IDLE), online: false } : { ...outbox, online: false }} />
        <div className="r1p-empty" data-state="not_on_phone"><Icon name="signal" /><span>{t('tech.job.notOnPhone')}</span></div>
      </>,
    );
  }
  if (view.kind === 'not_yours') {
    return frame(
      <div className="apphead">{nav(t('tech.job.number', { job: jobNumber }))}{clk}</div>,
      <>
        <div className="stmsg" data-state="not_yours"><Icon name="user" /><span>{t('tech.job.notYours')}</span></div>
        <p className="r1-note bw-m0">{t('tech.job.notYoursNote')}</p>
        <a className="r1p-btn pri" href="/tech" data-ctl="CTL-TEC-04-01"><Icon name="back" />{t('tech.job.backToToday')}</a>
      </>,
    );
  }

  const job = view.job;
  // F-1034: a kept copy opened on a later demo day does not offer the number (CTL-TEC-04-03 says why instead).
  const todayNow = fixed ? job.job.today : shownAsToday(job, demoNow, view.fromPhone);
  const phone = todayNow ? job.customer.phone : null;
  const st = shownStatus(job, outbox.waiting);
  const notes = shownNotes(job, outbox.waiting, me);
  const photos = shownPhotos(job, outbox.waiting, me);
  const open = st.status !== 'canceled';
  const ended = st.status === 'done' || st.status === 'no_one_home' || st.status === 'canceled';
  const service = t(job.job.serviceLabelKey as MessageKey);
  const mid = job.job.position ? t('tech.job.position', { index: job.job.position.index, of: job.job.position.of, job: jobNumber }) : t('tech.job.number', { job: jobNumber });
  const lang = t.lang;

  const header = (
    <div className="apphead">
      {nav(mid, (
        <span className="r" role="button" tabIndex={0} aria-label={t('tech.job.more')} aria-haspopup="menu" aria-expanded={menu} data-ctl="CTL-TEC-04-18"
          onClick={() => setMenu((m) => !m)} onKeyDown={(e) => { if (e.key === 'Enter') setMenu((m) => !m); }}>
          <Icon name="more" />
        </span>
      ))}
      {menu ? (
        <div className="r1-menu in bw-tech-menu" role="menu" aria-label={t('tech.job.more')} data-ctl="CTL-TEC-04-18">
          {phone ? <a role="menuitem" href={`tel:${phone.replace(/[^\d+]/g, '')}`}><Icon name="phone" />{t('tech.job.call')}</a> : null}
          {driveTo !== null ? <a role="menuitem" href={`/tech/jobs/${driveTo}/directions`}><Icon name="nav" />{t('tech.job.directions')}</a> : null}
          {open ? <a role="menuitem" href={jobHref(jobNumber, '/note')}><Icon name="note" />{t('tech.job.addNote')}</a> : null}
          {open ? <a role="menuitem" href={jobHref(jobNumber, '/photo')}><Icon name="camera" />{t('tech.job.addPhoto')}</a> : null}
        </div>
      ) : null}
      <div data-ctl="CTL-TEC-04-02">
        <h1 translate="no">{job.customer.name}</h1>
        <div className="addr">{job.customer.address}</div>
        <div className="when">
          <span className={`tag st${STATUS_CLASS[st.status]}`} data-status={st.status}><span className="dot" />{t(STATUS_WORD[st.status])}</span>
          <span><b>{windowWords(job)}</b> - {service}</span>
        </div>
      </div>
      {clk}
      {ended ? null : (
        <div className="acts">
          {driveTo !== null ? (
            <a className="abtn" href={`/tech/jobs/${driveTo}/directions`} data-ctl="CTL-TEC-04-04" data-minutes={minutes ?? ''}>
              <Icon name="nav" />{t('tech.job.directions')}{minutes !== null ? <> <small>{t('tech.job.minutes', { n: minutes })}</small></> : null}
            </a>
          ) : null}
          {phone ? (
            <CallButton name={firstName(job.customer.name)} fullName={job.customer.name} number={phone} className="abtn call bw-btn-reset">
              <Icon name="phone" />{t('tech.job.call')}
            </CallButton>
          ) : null}
        </div>
      )}
    </div>
  );

  const endedLine = st.status === 'done' ? t('tech.job.doneAt', { time: clockWords(st.at ?? job.job.endedAt ?? job.job.window.end) })
    : st.status === 'no_one_home' ? t('tech.job.noOneHomeAt', { time: clockWords(st.at ?? job.job.endedAt ?? job.job.window.end) })
      : st.status === 'canceled' ? t('tech.job.canceled') : null;

  const eq = job.equipment;
  const first = eq[0];
  const fi = first ? (EQUIPMENT_ICON[first.type] ?? { icon: 'wrench' as const, tint: 'bw-eq-ink' }) : null;
  // The equipment's name in the page's language by its type; a type the catalog has no word for, by the first words of its details.
  const eqName = (x: (typeof eq)[number]) => (EQUIPMENT_ICON[x.type] ? t(`tech.equipment.${x.type}` as MessageKey) : (x.details?.split('.')[0]?.split(',')[0] ?? x.type));

  const body = (
    <>
      {fixed ? (outbox.online ? null : <NoSignalCard fixed={outbox} />) : <NoSignalCard />}
      {finished ? <div className="r1p-notice ok" role="status" aria-live="polite" data-ctl="CTL-CMP-11-01"><Icon name="check" sw={2.6} /><span>{t('tech.job.finished')}</span></div> : null}
      {endedLine ? <div className={`stmsg${st.status === 'canceled' ? '' : ''}`}><Icon name={st.status === 'canceled' ? 'alert' : 'check'} /><span>{endedLine}</span></div> : null}
      {!todayNow ? <p className="r1-note bw-m0" data-ctl="CTL-TEC-04-03">{t('tech.job.phoneLater')}</p> : null}
      <div className="notebox" data-ctl="CTL-TEC-04-05">
        <Icon name="info" />
        <div><b>{t('tech.job.customerNote')}</b>{job.customer.gettingIn ?? job.customer.notes[0]?.body ?? t('tech.job.noCustomerNotes')}</div>
      </div>
      <div className="card" data-ctl="CTL-TEC-04-06">
        <div className="ch"><h3>{t('tech.job.equipment')}</h3>{eq.length > 1 ? <span className="more">{t('tech.job.alsoEquipment', { list: eq.slice(1, 2).map((x) => `${eqName(x)}${x.year ? `, ${x.year}` : ''}`).join('; ') })}</span> : null}</div>
        {first && fi ? (
          <div className="eq">
            <span className={`ico ${fi.tint}`}><Icon name={fi.icon} /></span>
            <div><b>{eqName(first)}{first.year ? `, ${first.year}` : ''}</b>{first.location ? ` - ${first.location}` : ''}</div>
          </div>
        ) : <p className="r1-note bw-m0">{t('tech.job.noEquipment')}</p>}
      </div>
      <div className="card" data-ctl="CTL-TEC-04-07">
        <div className="ch"><h3>{t('tech.job.history')}</h3></div>
        {job.history.length > 0 ? (
          <div className="hist">
            {job.history.map((h) => (
              <div key={`${h.date}-${h.what ?? h.serviceLabelKey}`} className="hrow">
                <span className="dt">{datePast(h.date, lang)}</span>
                <span className="tx"><b>{h.what ?? (h.serviceLabelKey ? t(h.serviceLabelKey as MessageKey) : '')}</b>{h.technician ? ` - ${h.technician}` : ''}</span>
              </div>
            ))}
          </div>
        ) : <p className="r1-note bw-m0">{t('tech.job.noHistory')}</p>}
      </div>
      <div className="card" data-ctl="CTL-TEC-04-08">
        <div className="ch">
          <h3>{t('tech.job.notes', { n: notes.length })}</h3>
          {open ? <a className="addbtn" href={jobHref(jobNumber, '/note')} data-ctl="CTL-TEC-04-09"><Icon name="plus" sw={2.4} />{t('tech.job.addNote')}</a> : null}
        </div>
        {notes.map((n) => (
          <div key={n.key} className="note" data-note={n.key} data-kind={n.kind}>
            {n.body}
            {n.waiting ? <> <span className="r1p-wait"><Icon name="clock" sw={2.2} />{t('tech.job.waitingToSend')}</span></> : null}
            <div className="by">{n.kind === 'office' ? t('tech.job.byOffice', { author: n.author ?? '', at: noteWhen(n.at, job.job.date, lang) }) : t('tech.job.byTech', { author: n.author ?? '', at: noteWhen(n.at, job.job.date, lang) })}</div>
          </div>
        ))}
        {draft && open ? <a className="r1-link" href={jobHref(jobNumber, '/note')} data-ctl="CTL-TEC-04-16">{t('tech.job.draft', { text: draft.length > 40 ? `${draft.slice(0, 40)}...` : draft })}</a> : null}
      </div>
      <div className="card" data-ctl="CTL-TEC-04-10">
        <div className="ch"><h3>{t('tech.job.photos', { n: photos.length })}</h3></div>
        <div className="photos">
          {open ? <a className="ph add" href={jobHref(jobNumber, '/photo')} data-ctl="CTL-TEC-04-12"><Icon name="camera" />{t('tech.job.addPhoto')}</a> : null}
          {photos.map((p) => (
            <button key={p.key} type="button" className="ph bw-btn-reset" data-ctl="CTL-TEC-04-11" data-photo={p.key} data-waiting={p.waiting ? '1' : '0'}
              aria-label={t('tech.job.photoAlt', { by: p.by ?? '', at: noteWhen(p.at, job.job.date, lang) })} onClick={() => setViewer(p.key)}>
              <Thumb p={p} className="bw-ph-img" alt="" />
              {p.waiting ? <span>{t('tech.job.waitingToSend')}</span> : null}
            </button>
          ))}
        </div>
      </div>
      {photoSaved ? <div className="r1p-notice ok" role="status" aria-live="polite" data-ctl="CTL-CMP-11-01"><Icon name="check" sw={2.6} /><span>{t('tech.job.photoSaved')}</span></div> : null}
    </>
  );

  // A finish that waits for its signature reads Done, and the person who left its screen has no other way back to it (the finish screen enters only the signature).
  const bottom = ended ? (owesSignature.has(jobNumber) ? (
    <div className="bottom">
      <div className="acts3">
        <a className="pri" href={jobHref(jobNumber, '/finish')} data-ctl="CTL-TEC-04-15"><Icon name="check" sw={2.6} />{t('tech.job.finish')}</a>
      </div>
    </div>
  ) : null) : (
    <div className="bottom">
      {st.status === 'scheduled' ? <a className="omw" href={todaySheetHref('omw', jobNumber)} data-ctl="CTL-TEC-04-13"><Icon name="truck" sw={2.2} />{t('tech.job.onMyWay')}</a> : null}
      <div className="acts3">
        {st.status === 'on_site'
          ? <a className="pri" href={jobHref(jobNumber, '/finish')} data-ctl="CTL-TEC-04-15"><Icon name="check" sw={2.6} />{t('tech.job.finish')}</a>
          : <a href={todaySheetHref('arrived', jobNumber)} data-ctl="CTL-TEC-04-14"><Icon name="pin" />{t('tech.job.arrived')}</a>}
        {st.status === 'on_site'
          ? <a href={todaySheetHref('noh', jobNumber)} data-ctl="CTL-TEC-04-17">{t('tech.job.noOneHome')}</a>
          : <span className="dis" aria-disabled="true" aria-describedby="bw-why3" data-ctl="CTL-TEC-04-17">{t('tech.job.noOneHome')}</span>}
        {st.status === 'on_site' ? null : <span className="dis" aria-disabled="true" aria-describedby="bw-why3" data-ctl="CTL-TEC-04-15">{t('tech.job.finish')}</span>}
      </div>
      {st.status === 'on_site' ? null : <div className="why3" id="bw-why3">{t('tech.job.why3')}</div>}
    </div>
  );

  const shown = viewer ? photos.find((p) => p.key === viewer) : null;
  return (
    <>
      {frame(header, body, bottom)}
      {shown ? <PhotoViewer p={shown} jobDate={job.job.date} onClose={() => setViewer(null)} /> : null}
      {photo && open ? <PhotoSheet job={job} {...(fixed ? { fixed: { state: fixed.sheet ?? 'none' } } : {})} /> : null}
    </>
  );
}

/** CTL-TEC-04-11: the photo viewer sheet (full image, alt text, Close). */
function PhotoViewer({ p, jobDate, onClose }: { p: ShownPhoto; jobDate: string; onClose: () => void }) {
  const t = useT();
  const close = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useModalFocus(sheet);
  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const alt = t('tech.job.photoAlt', { by: p.by ?? '', at: noteWhen(p.at, jobDate, t.lang) });
  return (
    <div className="bw-tech-overlay" data-screen-of="SCR-TEC-04">
      <div className="r1-dim" onClick={onClose} />
      <div ref={sheet} className="r1-sheet" role="dialog" aria-modal="true" aria-label={t('tech.job.photoTitle')} data-ctl="CTL-TEC-04-11">
        <div className="grab" />
        <h2>{t('tech.job.photoTitle')}</h2>
        <div className="pv"><Thumb p={p} className="bw-ph-img" alt={alt} full /></div>
        <p className="alt">{alt}</p>
        <div className="sbtns"><button ref={close} type="button" className="sec bw-btn-reset" onClick={onClose}>{t('tech.job.close')}</button></div>
      </div>
    </div>
  );
}

type SheetState = 'none' | 'preview' | 'saving' | 'full' | 'failed';

/** SCR-TEC-06 Add photo: take or choose, preview, Save photo (into the item store), Retake, Cancel. */
function PhotoSheet({ job, fixed }: { job: JobCopy; fixed?: { state: 'none' | 'preview' } }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<SheetState>(fixed?.state ?? 'none');
  const [picked, setPicked] = useState<{ url: string | null; bytes: Uint8Array } | null>(null);
  const n = job.job.jobNumber;
  useEffect(() => () => {
    if (picked?.url) URL.revokeObjectURL(picked.url);
  }, [picked]);
  const choose = () => input.current?.click();
  const onFile = async (f: File | undefined) => {
    if (!f) return; // canceled by the user: nothing changes
    const c = await compressPhoto(f);
    const url = c.ok ? URL.createObjectURL(new Blob([c.bytes as BlobPart], { type: 'image/jpeg' })) : null;
    setPicked({ url, bytes: c.bytes });
    setState('preview');
  };
  const save = async () => {
    if (!picked) return;
    setState('saving');
    try {
      await techOutbox().enter({ jobNumber: n, baseVersion: null, body: { kind: 'photo', contentType: 'image/jpeg' }, blob: picked.bytes });
      go(jobHref(n, '?photo=saved'));
    } catch (e) {
      setState((e as Error).name === 'StoreWriteError' && /Quota/i.test(String((e as Error).message)) ? 'full' : 'failed');
    }
  };
  const cancel = () => go(jobHref(n));
  const sheet = useRef<HTMLDivElement>(null);
  useModalFocus(sheet, { onEscape: cancel });
  const label = t('tech.photo.title');
  const preview = state !== 'none';
  return (
    <div className="bw-tech-overlay" data-screen-of="SCR-TEC-06">
      <div className="r1-dim" onClick={cancel} />
      <div ref={sheet} className="r1-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <div className="grab" />
        <h2>{label}</h2>
        <input ref={input} type="file" accept="image/*" capture="environment" className="bw-sr-file" tabIndex={-1} aria-hidden="true" aria-label={t('tech.photo.take')}
          onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        {preview ? (
          <div className="pv" role="img" aria-label={t('tech.photo.previewLabel')} data-ctl="CTL-TEC-06-02">
            {picked?.url ? <img className="bw-ph-img" src={picked.url} alt="" /> : fixed ? <span className="bw-ph-fixed" /> : <span className="bw-ph-none"><Icon name="camera" /></span>}
          </div>
        ) : <p className="alt">{t('tech.photo.lead', { job: n, name: job.customer.name })}</p>}
        {state === 'full' ? <div className="stmsg bad" role="alert" data-ctl="CTL-TEC-06-03"><Icon name="alert" /><span>{t('tech.photo.full')}</span></div> : null}
        {state === 'failed' ? <div className="stmsg bad" role="alert" data-ctl="CTL-TEC-06-03"><Icon name="alert" /><span>{t('tech.photo.failed')}</span></div> : null}
        {preview ? (
          <>
            <div className="sbtns">
              <button type="button" className="sec bw-btn-reset" data-ctl="CTL-TEC-06-04" onClick={choose}><Icon name="camera" />{t('tech.photo.retake')}</button>
              <button type="button" className="pri bw-btn-reset" data-ctl="CTL-TEC-06-03" aria-busy={state === 'saving'} disabled={state === 'saving'} onClick={() => void save()}><Icon name="check" sw={2.6} />{t('tech.photo.save')}</button>
            </div>
            <div className="r1p-why bw-mt8"><a className="r1-link" role="button" tabIndex={0} data-ctl="CTL-TEC-06-05" onClick={cancel} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cancel(); } }}>{t('common.cancel')}</a></div>
          </>
        ) : (
          <div className="sbtns col">
            <button type="button" className="pri bw-btn-reset" data-ctl="CTL-TEC-06-01" onClick={choose}><Icon name="camera" />{t('tech.photo.take')}</button>
            <button type="button" className="sec bw-btn-reset" data-ctl="CTL-TEC-06-05" onClick={cancel}>{t('common.cancel')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

