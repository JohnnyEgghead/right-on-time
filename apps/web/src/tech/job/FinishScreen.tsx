// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-TEC-07 Finish job at /tech/jobs/{jobNumber}/finish (UI-SPECIFICATION section 8; DK-112 mockups/pages/tech-finish.html;
// FR-TECH-14, FR-BILL-3's technician path, FR-TECH-3, FR-TECH-4, invariant 10). Every entry (part rows from the phone's copy of
// the fixed parts list with quantities, or No parts used; labor; the editable work-done lines; the customer's signature) is
// kept on the phone at once (store.ts finish), with no signal too, until the job is finished. Finish job checks parts or No
// parts used (FR-BILL-3) and opens the confirm step; Finish and send to billing enters the Finished item (parts, labor and
// the work-done lines, which go to billing) and the signature as its own photo-like item (never sent to billing, FR-TECH-14)
// through the item engine. The server's own check (finishLines, parts_required) answers a finish that got past this one.
import '../../shell/css/phone.ts';
import '../../../styles/page-tech-finish.css';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { realNow } from '@bw/time';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { useT } from '../../shell/intl.tsx';
import { useModalFocus } from '../../shell/modal-focus.ts';
import type { OutboxState } from '../engine.ts';
import { NoSignalCard } from '../SyncStrip.tsx';
import { TechAppFrame } from '../TechAppFrame.tsx';
import { HeadClock } from './HeadClock.tsx';
import type { ClockAnswer } from '../../shell/clock.ts';
import { FinishLeave, signatureOwed } from '../engine.ts';
import { techOutbox, useOwnOutbox } from '../useOutbox.ts';
import {
  addPart, checkFinish, clockWords, demoWire, draftFromRefused, emptyFinish, findParts, finishWaits, laborFrom, laborMinutes, laborWords, refusedFinish,
  shownNotes, shownPhotos, stepQuantity, type ShownPhoto,
} from './model.ts';
import { go, jobHref } from './nav.ts';
import { SignaturePad } from './SignaturePad.tsx';
import { previewFile, thumbSrc } from './files.ts';
import { jobStore, type FinishDraft, type Part } from './store.ts';
import { IDLE, useJob, useParts, type JobView } from './useJob.ts';

const XICON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>;

function Thumb({ p }: { p: ShownPhoto }) {
  const [src, setSrc] = useState<string | null>(previewFile(p.key) ?? (p.waiting ? null : thumbSrc(p.key)));
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
  if (failed || !src) return <span className="bw-th bw-ph-none"><Icon name="camera" /></span>;
  return <img className="bw-th" src={src} alt="" onError={() => setFailed(true)} />;
}

export interface FinishScreenProps {
  jobNumber: number;
  fixed?: {
    view: JobView; outbox?: OutboxState; draft?: FinishDraft; parts?: Part[] | null; find?: string; msg?: 'parts' | 'labor' | 'server' | 'sig' | null;
    confirming?: boolean; restored?: boolean; demoNowMs?: number; me?: string; clock?: ClockAnswer; mini?: boolean; focusLine?: number;
  };
}

export function FinishScreen({ jobNumber, fixed }: FinishScreenProps) {
  const t = useT();
  const { view, me: liveMe } = useJob(jobNumber, fixed?.view);
  const outbox = useOwnOutbox(fixed ? (fixed.outbox ?? IDLE) : undefined);
  const parts = useParts(fixed ? (fixed.parts ?? null) : undefined);
  const me = fixed?.me ?? liveMe;
  const [d, setD] = useState<FinishDraft>(fixed?.draft ?? emptyFinish(jobNumber));
  const [loaded, setLoaded] = useState(Boolean(fixed));
  const [restored, setRestored] = useState(fixed?.restored ?? false);
  const [find, setFind] = useState(fixed?.find ?? '');
  const [msg, setMsg] = useState<'parts' | 'labor' | 'server' | 'sig' | null>(fixed?.msg ?? null);
  const [confirming, setConfirming] = useState(fixed?.confirming ?? false);
  const [saving, setSaving] = useState(false);
  // F-1932: what of this screen's own finish is kept, for the retry after an entry that was not.
  const [leaving] = useState(() => new FinishLeave({ enter: (i) => techOutbox().enter(i), correctFinish: (k, p) => techOutbox().correctFinish(k, p) }));
  const cstep = useRef<HTMLDivElement>(null);
  const finBtn = useRef<HTMLButtonElement>(null);
  useModalFocus(cstep, { active: confirming, returnTo: finBtn, onEscape: () => { if (!saving) setConfirming(false); } });
  const [demoNow, setDemoNow] = useState<number | null>(fixed?.demoNowMs ?? null);
  const qty = useRef(new Map<string, HTMLElement>());
  const lines = useRef<(HTMLInputElement | null)[]>([]);
  const focusLine = useRef<number | null>(null);
  const [focused, setFocused] = useState<number | null>(fixed?.focusLine ?? null);

  useEffect(() => {
    if (fixed) return;
    void techOutbox().demoNowMs().then(setDemoNow, () => undefined);
    void jobStore().finish(jobNumber).then((kept) => {
      if (kept) {
        setD(kept);
        setRestored(true);
      }
      setLoaded(true);
    }, () => setLoaded(true));
  }, [jobNumber, fixed]);
  // The server refused a finish the phone sent (parts_required): the screen reopens with the message (CTL-TEC-07-08) and, when no
  // entries are kept, with what was sent, so the technician adds the parts and finishes again (F-1025: the correction replaces it).
  const refused = fixed ? null : refusedFinish(jobNumber, outbox.waiting);
  const prefilled = useRef(false);
  useEffect(() => {
    if (!refused) return;
    setMsg('server');
    if (loaded && !restored && !prefilled.current && parts !== null) {
      prefilled.current = true;
      setD(draftFromRefused(jobNumber, refused.payload, parts));
    }
  }, [refused, loaded, restored, parts, jobNumber]);
  useEffect(() => {
    if (focusLine.current !== null) {
      lines.current[focusLine.current]?.focus();
      focusLine.current = null;
    }
  });

  // A screen opened again after its finish was kept and its signature was not (F-1976) still owes the signature: the finish is not entered twice.
  // It waits for the kept draft and the outbox before it decides, or it would close before the draft says a signature is owed.
  const settled = loaded && outbox.ready;
  const owedAgain = !fixed && settled && refused === null && signatureOwed(outbox.waiting, jobNumber, d.signature !== null);
  useEffect(() => {
    if (owedAgain) leaving.resume();
  }, [owedAgain, leaving]);

  /** Every change is kept on the phone at once (CTL-TEC-07-10, -11, -14); a failed write says so on the signature. */
  const keep = useCallback((draft: FinishDraft) => {
    const next = leaving.entriesOf(d, draft, refused !== null);
    setD(next);
    if (fixed || !loaded) return;
    void jobStore().saveFinish(next).catch(() => setMsg('sig'));
  }, [fixed, loaded, leaving, refused, d]);

  const fixedOut = fixed ? (fixed.outbox ?? IDLE) : undefined;
  const frame = (header: React.ReactNode, body: React.ReactNode, bottom?: React.ReactNode, after?: React.ReactNode) => (
    <TechAppFrame screen="SCR-TEC-07" tab="today" header={header} clockInHeader mini={fixed?.mini ?? false} {...(fixedOut ? { fixed: fixedOut, reader: false as const, clock: null } : {})}>
      <div className={`body${confirming ? ' bw-dimmed' : ''}`}>{body}</div>
      {bottom}
      {after}
    </TechAppFrame>
  );
  const back = () => go(jobHref(jobNumber));
  const head = (name: string, line: string) => (
    <div className="apphead">
      <div className="nav">
        <span role="link" tabIndex={0} data-ctl="CTL-TEC-07-10" onClick={back} onKeyDown={(e) => { if (e.key === 'Enter') back(); }}><Icon name="back" />{t('tech.finish.backToJob')}</span>
        <span className="mid">{t('tech.job.number', { job: jobNumber })}</span>
        <span className="bw-w44" />
      </div>
      <h1>{name}</h1>
      <div className="d" translate="no">{line}</div>
      <HeadClock online={outbox.online} {...(fixed ? { fixed: fixed.clock } : {})} />
    </div>
  );

  const labor = useMemo(() => {
    if (d.hours !== null && d.minutes !== null) return { hours: d.hours, minutes: d.minutes };
    const arrived = view.kind === 'job' ? view.job.job.arrivedAt : null;
    return demoNow === null ? { hours: '', minutes: '' } : laborFrom(arrived, demoNow);
  }, [d.hours, d.minutes, view, demoNow]);

  if (view.kind !== 'job') {
    return frame(head(t('tech.finish.title'), ''), view.kind === 'loading' ? <div className="card"><span className="r1-skel" /></div>
      : <div className="r1p-empty"><Icon name="signal" /><span>{t(view.kind === 'not_yours' ? 'tech.job.notYours' : 'tech.job.notOnPhone')}</span></div>);
  }
  const job = view.job;
  const service = t(job.job.serviceLabelKey as MessageKey);
  // A finish already waiting on the phone closes the screen to the job; never while this screen's own finish is leaving (saving) or its
  // signature is not kept yet (owed).
  if (finishWaits(jobNumber, outbox.waiting) && !refused && msg !== 'server' && !fixed && !saving && !leaving.owed && !owedAgain) {
    if (!settled) return frame(head(t('tech.finish.title'), ''), <div className="card"><span className="r1-skel" /></div>);
    go(jobHref(jobNumber));
    return null;
  }
  const hasParts = d.parts.length > 0;
  const results = parts ? findParts(parts, find) : [];
  const techNotes = shownNotes(job, outbox.waiting, me).filter((n) => n.kind === 'technician');
  const photos = shownPhotos(job, outbox.waiting, me);

  const pick = (p: Part) => {
    const r = addPart(d.parts, p);
    keep({ ...d, parts: r.rows, noPartsUsed: false });
    setFind('');
    setMsg(null);
    if (!r.added) window.setTimeout(() => qty.current.get(p.partId)?.focus(), 0);
  };
  const tryFinish = () => {
    const c = checkFinish(d, labor);
    if (!c.ok) {
      setMsg(c.on);
      return;
    }
    setMsg(null);
    setConfirming(true);
  };
  const confirm = async () => {
    const c = checkFinish(d, labor);
    if (!c.ok || fixed) return;
    setSaving(true);
    try {
      await leaving.leave({ jobNumber, baseVersion: job.job.version, payload: c.payload, refusedKey: refused?.key ?? null, signature: d.signature?.png ?? null });
      await jobStore().forgetFinish(jobNumber).catch(() => undefined);
      go(jobHref(jobNumber, '?finished=1'));
    } catch {
      setSaving(false);
      setConfirming(false);
      setMsg('sig');
    }
  };

  const minutes = laborMinutes(labor.hours, labor.minutes);
  const lw = laborWords(minutes ?? 0);
  const workLines = d.workDone.map((l) => l.trim()).filter((l) => l !== '');
  const offline = !outbox.online;

  const body = (
    <>
      {offline ? (fixedOut ? <NoSignalCard fixed={fixedOut} /> : <NoSignalCard />) : null}
      {restored ? <div className="r1p-notice ok" role="status" aria-live="polite" data-ctl="CTL-CMP-11-01"><Icon name="check" sw={2.6} /><span>{t('tech.finish.restored')}</span></div> : null}
      {msg === 'server' ? <div className="fmsg" role="alert" data-ctl="CTL-TEC-07-08"><Icon name="alert" />{t('tech.finish.partsRequiredServer')}</div> : null}
      <div className="card">
        <div className="ch"><h3>{t('tech.finish.workDone')}</h3></div>
        <div data-ctl="CTL-TEC-07-11">
          {d.workDone.map((l, k) => (
            <div key={k} className="wl">
              <input ref={(el) => { lines.current[k] = el; }} className={`in bw-in${focused === k ? ' focus' : ''}`} value={l}
                onFocus={() => setFocused(k)} onBlur={() => setFocused((f) => (f === k ? null : f))} aria-label={t('tech.finish.lineLabel', { n: k + 1 })}
                onChange={(e) => keep({ ...d, workDone: d.workDone.map((x, i) => (i === k ? e.target.value : x)) })} />
              <button type="button" className="x bw-btn-reset" aria-label={t('tech.finish.removeLine', { n: k + 1 })} data-ctl="CTL-TEC-07-13"
                onClick={() => keep({ ...d, workDone: d.workDone.filter((_, i) => i !== k) })}>{XICON}</button>
            </div>
          ))}
        </div>
        <button type="button" className="addl bw-btn-reset" data-ctl="CTL-TEC-07-12" onClick={() => { focusLine.current = d.workDone.length; keep({ ...d, workDone: [...d.workDone, ''] }); }}>
          <Icon name="plus" sw={2.4} />{t('tech.finish.addLine')}
        </button>
      </div>
      <div className="card">
        <div className="ch"><h3>{hasParts ? t('tech.finish.partsN', { n: d.parts.length }) : t('tech.finish.parts')}</h3></div>
        <div data-ctl="CTL-TEC-07-01">
          {d.parts.map((p) => (
            <div key={p.partId} className="pt" data-part={p.code}>
              <span className="n">{p.name}<code translate="no">{p.code}</code></span>
              <span className="step" data-ctl="CTL-TEC-07-04" role="spinbutton" tabIndex={0} aria-valuemin={1} aria-valuenow={p.quantity} aria-label={t('tech.finish.quantity', { part: p.name })}
                ref={(el) => { if (el) qty.current.set(p.partId, el); else qty.current.delete(p.partId); }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') { e.preventDefault(); keep({ ...d, parts: stepQuantity(d.parts, p.partId, 1) }); }
                  if (e.key === 'ArrowDown') { e.preventDefault(); keep({ ...d, parts: stepQuantity(d.parts, p.partId, -1) }); }
                }}>
                <button type="button" className="bw-btn-reset" aria-label={t('tech.finish.less')} tabIndex={-1} onClick={() => keep({ ...d, parts: stepQuantity(d.parts, p.partId, -1) })}>-</button>
                <b>{p.quantity}</b>
                <button type="button" className="bw-btn-reset" aria-label={t('tech.finish.more')} tabIndex={-1} onClick={() => keep({ ...d, parts: stepQuantity(d.parts, p.partId, 1) })}>+</button>
              </span>
              <button type="button" className="x bw-btn-reset" aria-label={t('tech.finish.remove', { part: p.name })} data-ctl="CTL-TEC-07-03"
                onClick={() => keep({ ...d, parts: d.parts.filter((x) => x.partId !== p.partId) })}>{XICON}</button>
            </div>
          ))}
          {hasParts ? null : <p className="r1-note bw-np">{t(d.noPartsUsed ? 'tech.finish.noneUsed' : 'tech.finish.noneYet')}</p>}
        </div>
        {msg === 'parts' ? <div className="fmsg" role="alert" data-msg="parts"><Icon name="alert" />{t('tech.finish.needParts')}</div> : null}
        <label className={`find${find ? ' focus' : ''}${d.noPartsUsed ? ' dis' : ''}`} data-ctl="CTL-TEC-07-02">
          <Icon name="search" />
          <input className="bw-search-input" type="search" role="combobox" aria-expanded={results.length > 0} aria-controls="bw-part-res" aria-autocomplete="list"
            aria-label={t('tech.finish.find')} placeholder={t('tech.finish.find')} value={find} disabled={d.noPartsUsed} onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) { e.preventDefault(); pick(results[0]); } }} />
        </label>
        {find.trim() !== '' && !d.noPartsUsed ? (
          parts === null ? <div className="fmsg" role="alert"><Icon name="cloud" />{t('tech.finish.noCopy')}</div>
            : results.length === 0 ? <div className="fmsg" role="status"><Icon name="search" />{t('tech.finish.noMatch', { text: find.trim() })}</div>
              : (
                <div className="res" id="bw-part-res" role="listbox" aria-label={t('tech.finish.find')}>
                  {results.map((p) => (
                    <div key={p.partId} role="option" aria-selected="false" tabIndex={0} data-part={p.code} onClick={() => pick(p)} onKeyDown={(e) => { if (e.key === 'Enter') pick(p); }}>
                      <span>{p.name}</span><code translate="no">{p.code}</code>
                    </div>
                  ))}
                </div>
              )
        ) : null}
        <label className={`nop${hasParts ? ' dis' : ''}`} data-ctl="CTL-TEC-07-05">
          <input type="checkbox" className="bw-cb" checked={d.noPartsUsed} disabled={hasParts}
            onChange={(e) => { keep({ ...d, noPartsUsed: e.target.checked }); setMsg(null); setFind(''); }} />
          <span className={`bx${d.noPartsUsed ? ' on' : ''}`} aria-hidden="true">{d.noPartsUsed ? <Icon name="check" sw={3} /> : null}</span>
          {t('tech.finish.noPartsUsed')}{hasParts ? <> <small>{t('tech.finish.removeFirst')}</small></> : null}
        </label>
      </div>
      <div className="two">
        <div className="card labor">
          <div className="ch"><h3>{t('tech.finish.labor')}</h3></div>
          <div className="lab2" data-ctl="CTL-TEC-07-07">
            <input className="in bw-in" inputMode="numeric" aria-label={t('tech.finish.hours')} value={labor.hours} onChange={(e) => keep({ ...d, hours: e.target.value.replace(/\D/g, '').slice(0, 2), minutes: labor.minutes })} />{t('tech.finish.hr')}
            <input className="in bw-in" inputMode="numeric" aria-label={t('tech.finish.minutes')} value={labor.minutes} onChange={(e) => keep({ ...d, minutes: e.target.value.replace(/\D/g, '').slice(0, 2), hours: labor.hours })} />{t('tech.finish.min')}
          </div>
          {msg === 'labor' ? <div className="fmsg" role="alert"><Icon name="alert" />{t('tech.finish.needLabor')}</div> : null}
          <small>{job.job.arrivedAt ? t('tech.finish.fromArrived', { time: clockWords(job.job.arrivedAt) }) : t('tech.finish.typeLabor')}</small>
        </div>
        <div className="card" data-ctl="CTL-TEC-07-16">
          <div className="ch"><h3>{t('tech.finish.photos', { n: photos.length })}</h3></div>
          <div className="phs">{photos.slice(0, 4).map((p) => <Thumb key={p.key} p={p} />)}</div>
        </div>
      </div>
      <div className="card">
        <div className="ch"><h3>{t('tech.finish.notes', { n: techNotes.length })}</h3>
          <a className="edit" href={jobHref(jobNumber, '/note')} data-ctl="CTL-TEC-07-18"><Icon name="plus" sw={2.4} />{t('tech.job.addNote')}</a>
        </div>
        <div className="notes" data-ctl="CTL-TEC-07-17">
          {techNotes.length === 0 ? <div>{t('tech.finish.noNotes')}</div> : techNotes.map((n) => (
            <div key={n.key}>{n.body} <span>{clockWords(n.at)}</span>{n.waiting ? <> <span className="r1p-wait"><Icon name="clock" sw={2.2} />{t('tech.job.waitingToSend')}</span></> : null}</div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="ch"><h3>{t('tech.finish.signature')}</h3></div>
        <SignaturePad
          png={d.signature?.png ?? null}
          signedLine={d.signature ? t('tech.finish.signed', { name: job.customer.name, time: clockWords(d.signature.at) }) : null}
          onSigned={(png) => keep({ ...d, signature: { png, at: demoWire(demoNow ?? realNow('device_stamp').epochMilliseconds, job.job.zone) } })}
          onClear={() => keep({ ...d, signature: null })}
        />
        {msg === 'sig' ? <div className="fmsg" role="alert" data-ctl="CTL-TEC-07-14"><Icon name="alert" />{t('tech.finish.sigFailed')}</div> : null}
      </div>
    </>
  );
  const bottom = confirming ? null : (
    <div className="bottom">
      <button ref={finBtn} type="button" className="fin bw-btn-reset" data-ctl="CTL-TEC-07-06" aria-describedby="bw-finnote" onClick={tryFinish}><Icon name="check" sw={2.6} />{t('tech.finish.finish')}</button>
      <div className="finnote" id="bw-finnote">{t('tech.finish.finishNote')}</div>
      <a className="cancel" href={jobHref(jobNumber)} data-ctl="CTL-TEC-07-10">{t('common.cancel')}</a>
    </div>
  );
  const after = confirming ? (
    <div ref={cstep} className="cstep" role="alertdialog" aria-modal="true" aria-labelledby="bw-cstep-h">
      <h2 id="bw-cstep-h">{t('tech.finish.confirmTitle')}</h2>
      <ul>
        <li>{t('tech.finish.confirmLines', { n: workLines.length })}</li>
        <li>{d.noPartsUsed || !hasParts ? t('tech.finish.confirmNoParts') : t('tech.finish.confirmParts', { n: d.parts.length, list: d.parts.map((p) => `${p.code} x ${p.quantity}`).join(', ') })}</li>
        <li>{t('tech.finish.confirmLabor', { h: lw.h, m: lw.m })}</li>
        {d.signature ? <li>{t('tech.finish.confirmSignature')}</li> : null}
      </ul>
      <div className="warn">{t('tech.finish.cannotChange')}</div>
      <button type="button" className="fin bw-btn-reset" data-ctl="CTL-TEC-07-08" aria-busy={saving || undefined} disabled={saving} onClick={() => void confirm()}><Icon name="check" sw={2.6} />{t('tech.finish.confirm')}</button>
      <button type="button" className="back2 bw-btn-reset" autoFocus data-ctl="CTL-TEC-07-09" onClick={() => setConfirming(false)}>{t('tech.finish.goBack')}</button>
    </div>
  ) : null;
  return frame(head(t('tech.finish.title'), `${job.customer.name} - ${service}`), body, bottom, after);
}
