// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-22 Finish visit (office), DK-87: 2 modes (UI-SPECIFICATION SCR-OFC-22). Finish opens from CTL-OFC-03-08 on the job page and
// calls API-26. Correction opens from CTL-OFC-10-06 on the billing list (SCR-OFC-10, OA-61; F-597: a dialog there, no route), prefilled
// from API-23 with the lines billing receives, and calls API-62 (Save and send again). Both require parts or No parts used (FR-BILL-3).
import { useEffect, useMemo, useState } from 'react';
import type { MessageKey } from '@bw/i18n';
import { Busy, Dialog } from '../board/Dialogs.tsx';
import { spanText } from '../board/model.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import type { JobApi, Part } from './api.ts';
import { useVersionedWrite } from './conflict.tsx';
import { findParts, laborMinutes, linesDiffer, linesOf, needsParts, refusalShown, type Job, type Lines } from './model.ts';

export interface FinishDialogProps {
  mode: 'finish' | 'correction';
  jobNumber: number;
  api: JobApi;
  /** Finish mode: the job as the page read it (its version). Correction mode reads its own (API-23). */
  job?: Job | null;
  onClose: () => void;
  /** SCR-OFC-19's Keep their change: closes and re-reads (default: onClose). */
  onKeep?: () => void;
  /** After the write succeeded: the page re-reads (finish) or the billing list re-reads and says so (correction). */
  onDone: (how: 'finished' | 'sentAgain' | 'noLongerWaiting') => void;
  inline?: boolean;
  /** Harness previews only: the state the dialog opens in (lines, a search, a message, a busy write). */
  start?: { lines?: Lines; find?: string; msg?: { on: 'parts' | 'labor' | 'form'; key: string } | null; saving?: boolean };
}

const EMPTY: Lines = { parts: [], noPartsUsed: false, hours: '1', minutes: '00' };

export function FinishDialog(p: FinishDialogProps) {
  const t = useT();
  const correction = p.mode === 'correction';
  const [job, setJob] = useState<Job | null | 'error'>(correction ? null : (p.job ?? null));
  const [lines, setLines] = useState<Lines>(p.start?.lines ?? EMPTY);
  const [parts, setParts] = useState<Part[] | 'error' | null>(null);
  const [find, setFind] = useState(p.start?.find ?? '');
  const [msg, setMsg] = useState<{ on: 'parts' | 'labor' | 'form'; key: string } | null>(p.start?.msg ?? null);
  const [saving, setSaving] = useState(p.start?.saving ?? false);

  const loadJob = () => {
    setJob(null);
    void p.api.job(p.jobNumber).then((r) => {
      if (!r.ok) return setJob('error');
      setJob(r.data);
      setLines(linesOf(r.data));
    });
  };
  const loadParts = () => {
    setParts(null);
    void p.api.parts().then((r) => setParts(r.ok ? r.data.parts : 'error'));
  };
  useEffect(() => {
    if (correction) loadJob();
    loadParts();
    // Each read runs once, on open.
  }, []);

  const billed = useMemo(() => (job && job !== 'error' ? linesOf(job) : null), [job]);
  const found = parts && parts !== 'error' ? findParts(parts, find) : [];
  const ready = correction ? job !== null && job !== 'error' : true;
  const unchanged = correction && billed !== null && !linesDiffer(lines, billed);

  const title = t('job.finish.title', { job: p.jobNumber });
  const w = useVersionedWrite({
    action: correction ? 'correct' : 'finish', version: (job && job !== 'error' ? job : p.job)?.job.version ?? 1, onKeep: p.onKeep ?? p.onClose,
    send: (baseVersion) => {
      const body = { parts: lines.parts.map((x) => ({ partId: x.partId, quantity: x.quantity })), noPartsUsed: lines.noPartsUsed, laborMinutes: laborMinutes(lines) as number, baseVersion };
      return correction ? p.api.correct(p.jobNumber, body) : p.api.finish(p.jobNumber, body);
    },
    onSent: () => p.onDone(correction ? 'sentAgain' : 'finished'),
    onRefused: (r) => {
      if (r.code === 'not_waiting_for_person') return p.onDone('noLongerWaiting');
      const shown = refusalShown(r, spanText);
      setMsg({ on: r.code === 'parts_required' ? 'parts' : 'form', key: shown.key });
    },
  });
  const submit = async () => {
    if (saving || !ready) return;
    if (needsParts(lines)) return setMsg({ on: 'parts', key: 'job.finish.partsRequired' });
    if (laborMinutes(lines) === null) return setMsg({ on: 'labor', key: 'job.finish.laborRequired' });
    if (unchanged) return;
    setSaving(true);
    setMsg(null);
    await w.write();
    setSaving(false);
  };

  const add = (part: Part) => {
    setFind('');
    setMsg(null);
    if (lines.parts.some((x) => x.partId === part.partId)) {
      document.getElementById(`bw-qty-${part.partId}`)?.focus();
      return;
    }
    setLines({ ...lines, parts: [...lines.parts, { partId: part.partId, name: part.name, code: part.code, quantity: 1 }] });
  };
  const fieldsOff = saving || !ready;

  // The reason is billing's own words (pbs's data error, stored as said: FR-BILL-12), not a catalog key, so it is printed as stored.
  const reasonKey = job && job !== 'error' ? job.billing.reasonKey : null;
  const body = correction && job === 'error' ? (
    <div className="r1-errpanel" role="alert"><Icon name="alert" /><div><b>{t('job.finish.loadError')}</b>
      <button type="button" className="btn sm" onClick={loadJob}>{t('job.tryAgain')}</button></div></div>
  ) : correction && job === null ? (
    <><span className="r1-skel bw-w-40" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /></>
  ) : (
    <>
      {correction ? (
        <div className="r1-fin-why" role="note" data-ctl="CTL-OFC-22-10">
          {t('job.finish.reason', { reason: reasonKey ?? t('job.finish.reasonUnknown') })}
        </div>
      ) : null}
      <div className="r1-field">
        <label id="bw-parts-l">{t('job.finish.parts')}</label>
        <div className="r1-fin-parts" data-ctl="CTL-OFC-22-01" aria-labelledby="bw-parts-l" aria-disabled={lines.noPartsUsed || undefined}>
          {lines.parts.length === 0 ? <p className="r1-note bw-m-6-10">{t('job.finish.noParts')}</p> : lines.parts.map((x) => (
            <div className="pr" key={x.partId}>
              <span className="pn"><b>{x.name}</b><code translate="no">{x.code}</code></span>
              <span className="qty" data-ctl="CTL-OFC-22-04">
                <input id={`bw-qty-${x.partId}`} className="r1-input" type="number" min={1} step={1} value={x.quantity} disabled={fieldsOff}
                  aria-label={t('job.finish.quantity', { part: x.name })}
                  onChange={(e) => setLines({ ...lines, parts: lines.parts.map((y) => (y.partId === x.partId ? { ...y, quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) } : y)) })} />
              </span>
              <button type="button" className="btn sm ghost" data-ctl="CTL-OFC-22-03" disabled={fieldsOff}
                onClick={() => setLines({ ...lines, parts: lines.parts.filter((y) => y.partId !== x.partId) })}>{t('job.finish.remove')}</button>
            </div>
          ))}
        </div>
        {msg?.on === 'parts' ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t(msg.key as MessageKey)}</div> : null}
      </div>
      <div className="r1-field bw-mt-10" data-ctl="CTL-OFC-22-02">
        <label htmlFor="bw-find">{t('job.finish.find')}</label>
        <input id="bw-find" className="r1-input" type="search" value={find} placeholder={t('job.finish.findPh')} disabled={fieldsOff || lines.noPartsUsed}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) add(found[0]); }} />
        {parts === 'error' ? (
          <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('job.finish.partsError')} <button type="button" className="btn sm" onClick={loadParts}>{t('job.tryAgain')}</button></div>
        ) : find.trim() !== '' && found.length === 0 ? (
          <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('job.finish.noMatch', { text: find.trim() })}</div>
        ) : found.length > 0 ? (
          <ul className="r1-results" role="listbox" aria-label={t('job.finish.find')}>
            {found.map((x) => <li key={x.partId} role="option" aria-selected="false"><button type="button" className="btn ghost sm" onClick={() => add(x)}>{x.name} <code translate="no">{x.code}</code></button></li>)}
          </ul>
        ) : null}
      </div>
      <div className="r1-fin-row">
        <label className="r1-fin-ck" data-ctl="CTL-OFC-22-05">
          <input type="checkbox" checked={lines.noPartsUsed} disabled={fieldsOff || lines.parts.length > 0}
            onChange={(e) => { setMsg(null); setLines({ ...lines, noPartsUsed: e.target.checked }); }} />
          {t('job.finish.noPartsUsed')}
        </label>
        <span className="r1-fin-lab" data-ctl="CTL-OFC-22-06">
          <span className="k">{t('job.finish.labor')}</span>
          <input className="r1-input" inputMode="numeric" aria-label={t('job.finish.hours')} value={lines.hours} disabled={fieldsOff} onChange={(e) => setLines({ ...lines, hours: e.target.value })} /> {t('job.finish.hr')}
          <input className="r1-input" inputMode="numeric" aria-label={t('job.finish.minutes')} value={lines.minutes} disabled={fieldsOff} onChange={(e) => setLines({ ...lines, minutes: e.target.value })} /> {t('job.finish.min')}
        </span>
      </div>
      {msg?.on === 'labor' ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('job.finish.laborRequired')}</div> : null}
      {msg?.on === 'form' ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t(msg.key as MessageKey)}</div> : null}
      {unchanged ? <p className="r1-note" data-ctl="CTL-OFC-22-09">{t('job.finish.nothingChanged')}</p> : null}
    </>
  );

  if (w.conflict) return w.conflict;
  const primary = correction
    ? (saving ? <Busy label={t('job.finish.sendingAgain')} ctl="CTL-OFC-22-09" />
      : <button type="button" className={`btn primary${!ready || unchanged ? ' dis' : ''}`} aria-disabled={!ready || unchanged || undefined} data-ctl="CTL-OFC-22-09" onClick={() => void submit()}>{t('job.finish.saveSend')}</button>)
    : (saving ? <Busy label={t('job.finish.finishing')} ctl="CTL-OFC-22-07" />
      : <button type="button" className="btn primary" data-ctl="CTL-OFC-22-07" onClick={() => void submit()}>{t('job.finish.submit')}</button>);
  return (
    <Dialog title={title} closeCtl="CTL-OFC-22-08" onClose={() => { if (!saving) p.onClose(); }} screen="SCR-OFC-22" inline={p.inline ?? false}
      foot={<><button type="button" className="btn" data-ctl="CTL-OFC-22-08" onClick={() => { if (!saving) p.onClose(); }}>{t('common.cancel')}</button>{primary}</>}>
      {body}
    </Dialog>
  );
}
