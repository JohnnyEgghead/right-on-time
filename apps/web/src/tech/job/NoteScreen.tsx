// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-05 Add note at /tech/jobs/{jobNumber}/note (UI-SPECIFICATION section 8; DK-111 mockups/pages/tech-offline.html;
// FR-TECH-3, FR-TECH-4, invariant 1). Every change to the note is written to the phone's store as a draft at once
// (CTL-TEC-05-01, store.ts), so nothing typed is lost if the app closes; Save note turns the draft into a note item through
// the item engine, whose enter() resolves only once the store has committed the item (I1), and only then does the screen
// close to the job, where the note shows at once with Waiting to send (Saved). Discard asks first, then deletes the draft.
import '../../shell/css/phone.ts';
import '../../../styles/page-tech-offline.css';
import { NOTE_MAX_CHARS } from '@bw/api';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { useT } from '../../shell/intl.tsx';
import { useModalFocus } from '../../shell/modal-focus.ts';
import type { OutboxState } from '../engine.ts';
import { WaitingCount } from '../SyncStrip.tsx';
import { TechAppFrame } from '../TechAppFrame.tsx';
import { HeadClock } from './HeadClock.tsx';
import type { ClockAnswer } from '../../shell/clock.ts';
import { techOutbox, useOwnOutbox } from '../useOutbox.ts';
import { go, jobHref, STATUS_WORD } from './nav.ts';
import { clockWords, shownStatus, windowWords, type JobStatus } from './model.ts';
import { jobStore, type JobCopy } from './store.ts';
import { IDLE, useJob, type JobView } from './useJob.ts';

const CHIP: Record<JobStatus, string> = { scheduled: 'sched', on_the_way: 'way', on_site: 'site', done: 'done', no_one_home: 'done', canceled: 'done' };
/** DK-111's job header on the note and waiting screens: back to the job, the customer, the status chip and the service line. */
function NoteHeader({ job, outbox, fixed, clock }: { job: JobCopy; outbox: OutboxState; fixed?: OutboxState; clock?: ClockAnswer }) {
  const t = useT();
  const st = shownStatus(job, outbox.waiting);
  const service = t(job.job.serviceLabelKey as MessageKey);
  const line = st.status === 'on_site' && job.job.arrivedAt
    ? t('tech.note.onSiteSince', { service, time: clockWords(job.job.arrivedAt) })
    : `${service} - ${windowWords(job)}`;
  const back = () => go(jobHref(job.job.jobNumber));
  return (
    <div className="apphead">
      <div className="hrow">
        <span className="bk" role="link" tabIndex={0} aria-label={t('tech.note.backToJob')} data-ctl="CTL-TEC-04-01" onClick={back} onKeyDown={(e) => { if (e.key === 'Enter') back(); }}><Icon name="back" /></span>
        <h1 translate="no">{job.customer.name}</h1>
        <span className={`chip ${CHIP[st.status]}`}><span className="dot" />{t(STATUS_WORD[st.status])}</span>
      </div>
      <div className="addr">{line}</div>
      <div className="clkrow">
        <HeadClock online={outbox.online} {...(fixed ? { fixed: clock } : {})} />
        {outbox.online ? <WaitingCount {...(fixed ? { fixed } : {})} /> : null}
      </div>
    </div>
  );
}

export interface NoteScreenProps {
  jobNumber: number;
  fixed?: { view: JobView; outbox?: OutboxState; text?: string; restored?: boolean; asking?: boolean; failed?: boolean; clock?: ClockAnswer; mini?: boolean };
}

export function NoteScreen({ jobNumber, fixed }: NoteScreenProps) {
  const t = useT();
  const { view } = useJob(jobNumber, fixed?.view);
  const outbox = useOwnOutbox(fixed ? (fixed.outbox ?? IDLE) : undefined);
  const [text, setText] = useState(fixed?.text ?? '');
  const [restored, setRestored] = useState(fixed?.restored ?? false);
  const [asking, setAsking] = useState(fixed?.asking ?? false);
  const [failed, setFailed] = useState(fixed?.failed ?? false);
  const [saving, setSaving] = useState(false);
  const disc = useRef<HTMLDivElement>(null);
  useModalFocus(disc, { active: asking, onEscape: () => setAsking(false) });
  const [why, setWhy] = useState(false);
  const loaded = useRef(Boolean(fixed));
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (fixed) return;
    void jobStore().draft(jobNumber).then((d) => {
      loaded.current = true;
      if (d) {
        setText(d);
        setRestored(true);
      }
    }, () => {
      loaded.current = true;
    });
  }, [jobNumber, fixed]);

  // CTL-TEC-05-01: each change is kept at once; a failed write says so and keeps the text on the screen.
  const change = (v: string) => {
    const next = v.slice(0, NOTE_MAX_CHARS);
    setText(next);
    setWhy(false);
    if (fixed || !loaded.current) return;
    void jobStore().saveDraft(jobNumber, next).then(() => setFailed(false), () => setFailed(true));
  };

  const fixedOut = fixed ? (fixed.outbox ?? IDLE) : undefined;
  const frame = (header: React.ReactNode, body: React.ReactNode) => (
    <TechAppFrame screen="SCR-TEC-05" tab="today" header={header} noSignalStrip clockInHeader mini={fixed?.mini ?? false}
      {...(fixedOut ? { fixed: fixedOut, reader: false as const, clock: null } : {})}>
      <div className="body">{body}</div>
    </TechAppFrame>
  );
  if (view.kind !== 'job') {
    return frame(<div className="apphead"><div className="hrow"><a className="bk" href={jobHref(jobNumber)} aria-label={t('tech.note.backToJob')} data-ctl="CTL-TEC-04-01"><Icon name="back" /></a><h1>{t('tech.job.number', { job: jobNumber })}</h1></div><HeadClock online={outbox.online} {...(fixed ? { fixed: fixed.clock } : {})} /></div>,
      view.kind === 'loading' ? <div className="card"><span className="r1-skel" /></div> : <div className="r1p-empty"><Icon name="signal" /><span>{t(view.kind === 'not_yours' ? 'tech.job.notYours' : 'tech.job.notOnPhone')}</span></div>);
  }
  const job = view.job;
  const has = text.trim() !== '';

  const save = async () => {
    if (!has) {
      setWhy(true);
      box.current?.focus();
      return;
    }
    if (fixed) return;
    setSaving(true);
    try {
      // I1: enter() resolves only after the store committed the note; only then is the draft dropped and the sheet closed.
      await techOutbox().enter({ jobNumber, baseVersion: job.job.version, body: { kind: 'note', payload: { text: text.trim() } } });
      await jobStore().saveDraft(jobNumber, '').catch(() => undefined);
      go(jobHref(jobNumber));
    } catch {
      setSaving(false);
      setFailed(true);
    }
  };
  const discard = async () => {
    setAsking(false);
    setText('');
    setRestored(false);
    if (!fixed) await jobStore().saveDraft(jobNumber, '').catch(() => setFailed(true));
    box.current?.focus();
  };

  const mine = outbox.waiting.filter((i) => i.jobNumber === jobNumber);
  const body = (
    <>
      {mine.length > 0 && !outbox.online ? (
        <div className="card saved" data-ctl="CTL-TEC-04-08">
          <h3>{t('tech.note.savedOnPhone', { n: mine.length })}<small>{t('tech.note.savedSmall', { notes: mine.filter((i) => i.kind === 'note').length, photos: mine.filter((i) => i.kind === 'photo').length })}</small></h3>
          {mine.slice(-3).map((i) => (
            <div key={i.key} className="item">
              <span className="ico"><Icon name={i.kind === 'photo' ? 'camera' : 'note'} /></span>
              <div className="tx"><b>{i.kind === 'note' ? i.payload.text : t(`tech.waiting.kind.${i.kind}` as MessageKey)}</b><small>{t(`tech.waiting.kindAt.${i.kind}` as MessageKey, { time: clockWords(i.demoTime) })}</small></div>
              <span className="wait"><Icon name="clock" sw={2.2} />{t('tech.job.waitingToSend')}</span>
            </div>
          ))}
        </div>
      ) : null}
      {restored ? <div className="r1p-notice ok" role="status" aria-live="polite" data-ctl="CTL-CMP-11-01"><Icon name="check" sw={2.6} /><span>{t('tech.note.restored')}</span></div> : null}
      {failed ? <div className="r1p-old" role="alert" data-ctl="CTL-TEC-05-01"><Icon name="alert" /><span>{t('tech.note.storeFailed')}</span></div> : null}
      <div className="card compose">
        <div className="top"><h3 id="bw-note-h">{t('tech.note.title')}</h3></div>
        <textarea id="bw-note" aria-labelledby="bw-note-h" ref={box} className={`ta${has ? '' : ' empty'}`} rows={2} value={text} maxLength={NOTE_MAX_CHARS}
          placeholder={t('tech.note.placeholder')} data-ctl="CTL-TEC-05-01" aria-describedby={has ? undefined : 'why5'} onChange={(e) => change(e.target.value)} />
        <div className="row">
          {has ? <span className="kept" data-ctl="CTL-TEC-05-04"><Icon name="check" sw={2.6} />{t('tech.note.kept')}</span> : <span className="kept" />}
          {has ? <button type="button" className="disc bw-btn-reset" data-ctl="CTL-TEC-05-03" onClick={() => setAsking(true)}>{t('tech.note.discard')}</button> : null}
          <button type="button" className={`savebtn bw-btn-reset${has ? '' : ' dis'}`} aria-disabled={has ? undefined : true} aria-describedby={has ? undefined : 'why5'}
            aria-busy={saving || undefined} data-ctl="CTL-TEC-05-02" onClick={() => void save()}>{t('tech.note.save')}</button>
        </div>
        {has ? null : <div className="why" id="why5" role={why ? 'alert' : undefined}>{t('tech.note.typeFirst')}</div>}
      </div>
      {asking ? (
        <div ref={disc} className="cdlg" role="alertdialog" aria-modal="true" aria-labelledby="bw-disc-h" aria-describedby="bw-disc-p">
          <h2 id="bw-disc-h">{t('tech.note.discardAsk')}</h2>
          <p id="bw-disc-p">{t('tech.note.discardWhy')}</p>
          <div className="row">
            <button type="button" className="k bw-btn-reset" autoFocus data-ctl="CTL-TEC-05-03" onClick={() => setAsking(false)}>{t('tech.note.keepWriting')}</button>
            <button type="button" className="x bw-btn-reset" data-ctl="CTL-TEC-05-03" onClick={() => void discard()}>{t('tech.note.discard')}</button>
          </div>
        </div>
      ) : null}
    </>
  );
  return frame(<NoteHeader job={job} outbox={outbox} {...(fixedOut ? { fixed: fixedOut } : {})} {...(fixed?.clock ? { clock: fixed.clock } : {})} />, body);
}
