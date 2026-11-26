// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The job page's dialogs (DK-87; UI-SPECIFICATION SCR-OFC-20, -21, -23, -35, -36, -37). Each holds its own form state and makes its
// 1 write through the page's JobApi; a refusal shows its catalog message in the dialog (4.3; rule_refused names its rule, F-506), and
// version_conflict replaces the dialog with SCR-OFC-19 (conflict.tsx). The `job` a dialog gets is the job as it opened, not the page's
// live re-read (F-697): its form's starting values and the version it sends stay what the person opened.
import '../../styles/app/reschedule.css';
import { useEffect, useState } from 'react';
import type { AvailabilityAnswer, ServicesAnswer } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { formatTime, fromWire, zoneAbbreviation } from '@bw/time';
import { Busy, Dialog, ReassignDialog, type ReassignState } from '../board/Dialogs.tsx';
import type { BoardJob } from '../board/model.ts';
import { spanText, windowText } from '../board/model.ts';
import { formatPhone } from '../customers/model.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import type { JobApi } from './api.ts';
import { useVersionedWrite } from './conflict.tsx';
import { editRefusalShown, equipmentSuggestions, equipmentTypeSent, equipmentWord, refusalShown, rescheduleDone, textCount, type Job, type Refusal, type Shown } from './model.ts';

type Done = (toast: Shown) => void;
/** onKeep: Keep their change, in the Someone else changed this job dialog (SCR-OFC-19), which closes and re-reads (default: onClose). */
interface Common { job: Job; api: JobApi; onClose: () => void; onDone: Done; onKeep?: () => void; inline?: boolean }
/**
 * The 3 dialogs the customer page hosts (F-671, D-19): SCR-OFC-35 Text, SCR-OFC-36 Add note and SCR-OFC-37 Add or edit equipment take a job (the job
 * page) or a customer (the customer page, no job): the text then names no job, the note is the customer's own, the equipment is the customer's list.
 */
export interface DialogCustomer { id: string; name: string; mobile: string | null; language: string; zone: string; officeZone: string; equipment: Job['equipment'] }
type Who = { job: Job; customer?: undefined } | { job?: undefined; customer: DialogCustomer };
type Hosted = Omit<Common, 'job'> & Who;
const whoOf = (p: Who): DialogCustomer => p.customer ?? {
  id: p.job.customer.id, name: p.job.customer.name, mobile: p.job.customer.mobile, language: p.job.customer.language, zone: p.job.customer.zone, officeZone: p.job.job.zone, equipment: p.job.equipment,
};
/** Harness previews only: the state a dialog opens in (a typed text, a pick, a busy write), so each frame state is drawn fixed. */
export interface DialogStart { body?: string; saving?: boolean; shown?: Shown | null; day?: string; win?: string; serviceId?: string }

function Refused({ shown }: { shown: Shown | null }) {
  const t = useT();
  if (!shown) return null;
  return <div className="r1-fmsg" role="alert"><Icon name="alert" />{t(shown.key as MessageKey, shown.values)}</div>;
}
const shownOf = (r: Refusal) => refusalShown(r, spanText);
const dateText = (date: string, lang: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** SCR-OFC-18 on the job page: the suggested technicians (API-30), then API-22 against the version the dialog opened on. */
export function ReassignJobDialog(p: Common) {
  const t = useT();
  const j = p.job;
  const [state, setState] = useState<ReassignState>({ step: 'loading' });
  useEffect(() => {
    void p.api.suggest({ branch: j.job.branch, date: j.job.date, windowId: j.job.windowId, serviceId: j.job.serviceId, jobNumber: j.job.jobNumber })
      .then((r) => setState(r.ok ? { step: 'choosing', list: r.data.technicians, pick: undefined, preview: null, saving: false, message: null } : { step: 'error' }));
  }, []);
  const w = useVersionedWrite({
    action: 'reassign', version: j.job.version, onKeep: p.onKeep ?? p.onClose,
    send: (version) => p.api.assign(j.job.jobNumber, state.step === 'choosing' ? state.pick ?? null : null, version),
    onSent: () => p.onDone({ key: 'job.reassign.done' }),
    onRefused: (r) => {
      const name = state.step === 'choosing' ? state.list.find((x) => x.id === state.pick)?.name ?? '' : '';
      const shown = refusalShown(r, windowText, { name, window: windowText(j.job.window.start, j.job.window.end) });
      setState((s) => (s.step === 'choosing' ? { ...s, message: t(shown.key as MessageKey, shown.values) } : s));
    },
  });
  const submit = async () => {
    if (state.step !== 'choosing' || state.pick === undefined) return;
    setState({ ...state, saving: true, message: null });
    await w.write();
    setState((s) => (s.step === 'choosing' ? { ...s, saving: false } : s));
  };
  if (w.conflict) return w.conflict;
  return (
    <ReassignDialog
      job={{ jobNumber: j.job.jobNumber, customerName: j.customer.name, window: j.job.window, serviceId: j.job.serviceId, technicianId: j.job.technician?.id ?? null } as unknown as BoardJob}
      current={j.job.technician?.id ?? null} state={state} date={j.job.date}
      onPick={(id) => {
        if (state.step !== 'choosing') return;
        setState({ ...state, pick: id, preview: null, message: null });
        // CTL-OFC-18-04: the move preview for the pick (API-131); a failed read says so and Reassign stays possible.
        void p.api.preview(j.job.jobNumber, id).then((r) => setState((s) => (s.step === 'choosing' && s.pick === id ? { ...s, preview: r.ok ? r.data : 'failed' } : s)));
      }}
      onSubmit={() => void submit()} onClose={p.onClose} />
  );
}

/** SCR-OFC-21 Cancel visit: Keep the visit has the first focus (CTL-OFC-21-03). */
export function CancelDialog(p: Common & { start?: DialogStart }) {
  const t = useT();
  const [saving, setSaving] = useState(p.start?.saving ?? false);
  const [shown, setShown] = useState<Shown | null>(p.start?.shown ?? null);
  const j = p.job;
  const w = useVersionedWrite({
    action: 'cancel', version: j.job.version, onKeep: p.onKeep ?? p.onClose,
    send: (version) => p.api.cancel(j.job.jobNumber, version),
    onSent: () => p.onDone({ key: 'job.cancel.done' }),
    onRefused: (r) => setShown(shownOf(r)),
  });
  const go = async () => {
    setSaving(true);
    await w.write();
    setSaving(false);
  };
  if (w.conflict) return w.conflict;
  return (
    <Dialog title={t('job.cancel.title')} closeCtl="CTL-OFC-21-03" onClose={p.onClose} screen="SCR-OFC-21" inline={p.inline ?? false} initialFocus="[data-ctl='CTL-OFC-21-03']"
      foot={<><button type="button" className={saving ? 'btn dis' : 'btn'} aria-disabled={saving || undefined} data-ctl="CTL-OFC-21-03" onClick={() => { if (!saving) p.onClose(); }}>{t('job.cancel.keep')}</button>
        {saving ? <Busy label={t('job.cancel.canceling')} ctl="CTL-OFC-21-02" cls="danger" /> : <button type="button" className="btn danger" data-ctl="CTL-OFC-21-02" onClick={() => void go()}>{t('job.cancel.submit')}</button>}</>}>
      <p data-ctl="CTL-OFC-21-01">{t('job.cancel.msg', { service: t(j.job.serviceLabelKey as MessageKey), customer: j.customer.name, date: dateText(j.job.date, t.lang), window: windowText(j.job.window.start, j.job.window.end) })}</p>
      <Refused shown={shown} />
    </Dialog>
  );
}

/** SCR-OFC-20 Reschedule job: days from demo today to the horizon (API-29, office channel), then a window; API-24. */
/** API-24's answer: the moved job's outcome (GAP-10: the technician kept or not, a text sent or not). */
export type RescheduleAnswer = { outcome: { technicianKept: boolean; textSent: boolean } };

export function RescheduleDialog(p: Common & { today: string; horizon: string; start?: DialogStart; onRescheduled?: (answer: RescheduleAnswer) => void }) {
  const t = useT();
  const j = p.job;
  const [days, setDays] = useState<AvailabilityAnswer['days'] | 'error' | null>(null);
  const [day, setDay] = useState<string | null>(p.start?.day ?? null);
  const [win, setWin] = useState<string | null>(p.start?.win ?? null);
  const [saving, setSaving] = useState(p.start?.saving ?? false);
  const [shown, setShown] = useState<Shown | null>(p.start?.shown ?? null);
  const load = () => {
    setDays(null);
    void p.api.availability({ branch: j.job.branch, serviceId: j.job.serviceId, from: p.today, to: p.horizon, jobNumber: j.job.jobNumber })
      .then((r) => setDays(r.ok ? r.data.days : 'error'));
  };
  useEffect(load, []);
  const picked = days && days !== 'error' ? days.find((d) => d.date === day) ?? null : null;
  const changed = day !== null && win !== null && (day !== j.job.date || win !== j.job.windowId);
  const w = useVersionedWrite({
    action: 'reschedule', version: j.job.version, onKeep: p.onKeep ?? p.onClose,
    send: (version) => p.api.reschedule(j.job.jobNumber, day as string, win as string, version),
    onSent: (data) => {
      p.onRescheduled?.(data);
      // SCR-OFC-20 Done: the toast names the new day and window as well as the technician's answer.
      const chosen = picked?.windows.find((x) => x.windowId === win);
      p.onDone(rescheduleDone(data.outcome, dateText(day as string, t.lang), chosen ? windowText(chosen.start, chosen.end) : ''));
    },
    onRefused: (r) => {
      if (r.code === 'window_full' && days && days !== 'error') {
        setDays(days.map((d) => (d.date === day ? { ...d, windows: d.windows.map((x) => (x.windowId === win ? { ...x, state: 'full' as const, left: 0 } : x)) } : d)));
        setWin(null);
      }
      setShown(shownOf(r));
    },
  });
  const go = async () => {
    if (!changed || saving || !day || !win) return;
    setSaving(true);
    await w.write();
    setSaving(false);
  };
  const open = days && days !== 'error' ? days.filter((d) => d.state !== 'closed') : [];
  if (w.conflict) return w.conflict;
  return (
    <Dialog title={t('job.reschedule.title', { customer: j.customer.name, service: t(j.job.serviceLabelKey as MessageKey) })} closeCtl="CTL-OFC-20-04" onClose={p.onClose} screen="SCR-OFC-20" inline={p.inline ?? false} wide
      foot={<><button type="button" className={saving ? 'btn dis' : 'btn'} aria-disabled={saving || undefined} data-ctl="CTL-OFC-20-04" onClick={() => { if (!saving) p.onClose(); }}>{t('common.cancel')}</button>
        {saving ? <Busy label={t('job.reschedule.saving')} ctl="CTL-OFC-20-03" />
          : <button type="button" className={`btn primary${changed ? '' : ' dis'}`} aria-disabled={!changed || undefined} data-ctl="CTL-OFC-20-03" onClick={() => void go()}>{t('job.reschedule.submit')}</button>}</>}>
      {days === null ? <><span className="r1-skel bw-w-30" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /></>
        : days === 'error' ? <div className="r1-errpanel" role="alert"><Icon name="alert" /><div><b>{t('job.reschedule.loadError')}</b><button type="button" className="btn sm" onClick={load}>{t('job.tryAgain')}</button></div></div>
        : open.every((d) => d.state === 'full') ? <div data-ctl="CTL-OFC-20-01"><p className="r1-note bw-m-0 bw-rs-note">{t('job.reschedule.noRoom', { last: dateText(days[days.length - 1]?.date ?? p.horizon, t.lang) })}</p></div>
        : (
          <div className="g2f bw-mt-0 bw-rs">
            <div className="days" data-ctl="CTL-OFC-20-01" role="radiogroup" aria-label={t('job.reschedule.day')}>
              {open.map((d) => (
                <button type="button" key={d.date} role="radio" aria-checked={d.date === day} aria-disabled={d.state === 'full' || undefined}
                  className={`dy${d.date === day ? ' sel' : ''}`} onClick={() => { if (d.state !== 'full') { setDay(d.date); setWin(null); setShown(null); } }}>
                  {dateText(d.date, t.lang)}{d.mode === 'four_hour' ? <> <span className="pk">{t('job.reschedule.fourHour')}</span></> : null}
                  <span className="r">{d.state === 'full' ? t('job.reschedule.full') : t('job.reschedule.left', { n: d.left })}</span>
                </button>
              ))}
            </div>
            {picked ? (
              <div className="wins" role="radiogroup" data-ctl="CTL-OFC-20-02" aria-label={t('job.reschedule.window')}>
                {picked.windows.map((x) => (
                  <button type="button" key={x.windowId} role="radio" aria-checked={x.windowId === win} aria-disabled={x.state === 'full' || undefined}
                    className={`win${x.windowId === win ? ' sel' : ''}${x.state === 'full' ? ' full' : ''}`} onClick={() => { if (x.state !== 'full') { setWin(x.windowId); setShown(null); } }}>
                    <span className="radio" />{windowText(x.start, x.end)}
                    <span className="cap">{x.state === 'full' ? <span className="tag">{t('job.reschedule.full')}</span> : t('job.reschedule.left', { n: x.left })}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      <Refused shown={shown} />
    </Dialog>
  );
}

/** SCR-OFC-23 Edit job details: service (API-110), equipment (API-23) and the problem; API-27 shows time_overlap and window_full (F-565, F-507). */
export function EditDetailsDialog(p: Common & { start?: DialogStart }) {
  const t = useT();
  const j = p.job;
  const [services, setServices] = useState<ServicesAnswer['services'] | null>(null);
  const [form, setForm] = useState({ serviceId: p.start?.serviceId ?? j.job.serviceId, equipmentId: j.job.equipmentId, problem: j.job.problem ?? '' });
  const [saving, setSaving] = useState(p.start?.saving ?? false);
  const [shown, setShown] = useState<Shown | null>(p.start?.shown ?? null);
  // API-110 failing keeps the job's own service in the select and says so, with Try again (a failed read is not a quiet empty list).
  const [servicesFailed, setServicesFailed] = useState(false);
  const loadServices = () => { setServicesFailed(false); void p.api.services().then((r) => { if (r.ok) setServices(r.data.services); else setServicesFailed(true); }); };
  useEffect(loadServices, []);
  const changed = form.serviceId !== j.job.serviceId || form.equipmentId !== j.job.equipmentId || form.problem.trim() !== (j.job.problem ?? '');
  const w = useVersionedWrite({
    action: 'edit', version: j.job.version, onKeep: p.onKeep ?? p.onClose,
    send: (version) => p.api.edit(j.job.jobNumber, { serviceId: form.serviceId, equipmentId: form.equipmentId, problem: form.problem.trim() === '' ? null : form.problem.trim(), baseVersion: version }),
    onSent: () => p.onDone({ key: 'job.edit.done' }),
    onRefused: (r) => setShown(editRefusalShown(r, spanText)),
  });
  const go = async () => {
    if (!changed || saving) return;
    setSaving(true);
    await w.write();
    setSaving(false);
  };
  const eqText = (e: Job['equipment'][number]) => [equipmentWord(t, e.type), e.year, e.location].filter((x) => x !== null && x !== '').join(', ');
  if (w.conflict) return w.conflict;
  return (
    <Dialog title={t('job.edit.title')} closeCtl="CTL-OFC-23-05" onClose={p.onClose} screen="SCR-OFC-23" inline={p.inline ?? false}
      foot={<><button type="button" className={saving ? 'btn dis' : 'btn'} aria-disabled={saving || undefined} data-ctl="CTL-OFC-23-05" onClick={() => { if (!saving) p.onClose(); }}>{t('common.cancel')}</button>
        {saving ? <Busy label={t('job.saving')} ctl="CTL-OFC-23-04" /> : <button type="button" className={`btn primary${changed ? '' : ' dis'}`} aria-disabled={!changed || undefined} data-ctl="CTL-OFC-23-04" onClick={() => void go()}>{t('common.save')}</button>}</>}>
      <div className="r1-field" data-ctl="CTL-OFC-23-01">
        <label htmlFor="bw-ed-svc">{t('job.edit.service')}</label>
        <select id="bw-ed-svc" className="r1-input" value={form.serviceId} onChange={(e) => { setShown(null); setForm({ ...form, serviceId: e.target.value }); }}>
          {(services ?? [{ serviceId: j.job.serviceId, screenLabelKey: j.job.serviceLabelKey }]).map((s) => <option key={s.serviceId} value={s.serviceId}>{t(s.screenLabelKey as MessageKey)}</option>)}
        </select>
        {servicesFailed ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('job.edit.servicesError')}<button type="button" className="btn sm" onClick={loadServices}>{t('job.tryAgain')}</button></div> : null}
      </div>
      <div className="r1-field bw-mt-12" data-ctl="CTL-OFC-23-02">
        <label htmlFor="bw-ed-eq">{t('job.edit.equipment')}</label>
        <select id="bw-ed-eq" className="r1-input" value={form.equipmentId ?? ''} onChange={(e) => setForm({ ...form, equipmentId: e.target.value === '' ? null : e.target.value })}>
          <option value="">{t('job.edit.none')}</option>
          {j.equipment.map((e) => <option key={e.id} value={e.id}>{eqText(e)}</option>)}
        </select>
      </div>
      <div className="r1-field bw-mt-12" data-ctl="CTL-OFC-23-03">
        <label htmlFor="bw-ed-pr">{t('job.edit.problem')}</label>
        <input id="bw-ed-pr" className="r1-input" maxLength={500} value={form.problem} onChange={(e) => setForm({ ...form, problem: e.target.value })} />
      </div>
      <Refused shown={shown} />
    </Dialog>
  );
}

/**
 * CTL-OFC-35-04: "Held until 8:00 AM Pacific (11:00 AM EDT)": API-143's held-until time in the customer's zone, and in the office's zone
 * when that differs. With no time in the answer, the plain words.
 */
function heldToast(t: ReturnType<typeof useT>, heldUntil: string | null, customerZone: string, officeZone: string): Shown {
  if (heldUntil === null) return { key: 'job.text.held' };
  const at = fromWire(heldUntil).toInstant();
  const lang = t.lang === 'es' ? 'es' : 'en';
  const key = `msg.zone.${customerZone}` as MessageKey;
  let zone = zoneAbbreviation(at, customerZone);
  try {
    const word = t(key);
    if (word !== key) zone = word;
  } catch {
    // no word for this zone: its abbreviation stands
  }
  const time = formatTime(at, customerZone, lang);
  if (customerZone === officeZone) return { key: 'job.text.heldSame', values: { time, zone } };
  return { key: 'job.text.heldAt', values: { time, zone, office: `${formatTime(at, officeZone, lang)} ${zoneAbbreviation(at, officeZone)}` } };
}

/** SCR-OFC-35 Text customer: free text held to 1 message by the shared counter (D12), and to quiet hours (FR-TEXT-7); API-143. */
export function TextDialog(p: Hosted & { start?: DialogStart }) {
  const t = useT();
  const j = whoOf(p);
  const [body, setBody] = useState(p.start?.body ?? '');
  const [saving, setSaving] = useState(p.start?.saving ?? false);
  const [shown, setShown] = useState<Shown | null>(p.start?.shown ?? null);
  const [asking, setAsking] = useState(false);
  const c = textCount(body);
  // A refusal that the text cannot fix (texts off, no mobile) keeps Send off (DK-87 Text customer: Refused).
  const barred = shown?.key === 'job.text.textsOff' || shown?.key === 'job.text.noMobile';
  const ready = body.trim() !== '' && c.fits && !saving && !barred;
  const left = body === '' ? t('job.text.leftEmpty', { n: c.limit })
    : !c.fits ? t('job.text.tooLong') : c.left === 0 ? t('job.text.zeroLeft') : t('job.text.left', { n: c.left });
  const go = async () => {
    if (!ready) return;
    setSaving(true);
    const r = await p.api.text(j.id, body.trim(), p.job?.job.jobNumber ?? null);
    setSaving(false);
    if (r.ok) return p.onDone(r.data.text.status === 'held' ? heldToast(t, r.data.text.heldUntil, j.zone, j.officeZone) : { key: 'job.text.sent' });
    setShown(shownOf(r));
  };
  const close = () => { if (body.trim() !== '' && !asking) setAsking(true); else p.onClose(); };
  const lang = j.language === 'es' ? t('job.text.inSpanish') : t('job.text.inEnglish');
  return (
    <Dialog title={t('job.text.title')} closeCtl="CTL-OFC-35-05" onClose={close} screen="SCR-OFC-35" inline={p.inline ?? false} initialFocus="textarea"
      foot={asking
        ? <><span className="r1-note">{t('job.text.discard')}</span><button type="button" className="btn" onClick={() => setAsking(false)}>{t('job.keepWriting')}</button><button type="button" className="btn danger" onClick={p.onClose}>{t('job.discard')}</button></>
        : <><button type="button" className={saving ? 'btn dis' : 'btn'} aria-disabled={saving || undefined} data-ctl="CTL-OFC-35-05" onClick={() => { if (!saving) close(); }}>{t('common.cancel')}</button>
          {saving ? <Busy label={t('job.text.sending')} ctl="CTL-OFC-35-04" />
            : <button type="button" className={`btn primary${ready ? '' : ' dis'}`} aria-disabled={!ready || undefined} data-ctl="CTL-OFC-35-04"
              title={!c.fits ? t('job.text.tooLongWhy') : undefined} onClick={() => void go()}>{t('job.text.send')}</button>}
          {!c.fits && !saving ? <span className="r1-note bw-foot-note">{t('job.text.tooLongWhy')}</span> : null}</>}>
      <p className="to" data-ctl="CTL-OFC-35-01"><b>{t('job.text.to')}</b> {`${j.name}, ${formatPhone(j.mobile)}. ${lang}`}</p>
      <div className="r1-field" data-ctl="CTL-OFC-35-02">
        <label htmlFor="bw-tx">{t('job.text.message')}</label>
        <textarea id="bw-tx" className={`tbox-in${c.fits ? '' : ' bad'}`} value={body} maxLength={1000} placeholder={t('job.text.ph', { name: j.name.split(' ')[0] ?? '' })}
          aria-describedby="bw-tx-cnt" onChange={(e) => { setShown(null); setBody(e.target.value); }} />
      </div>
      <p id="bw-tx-cnt" className={`cnt${c.fits ? '' : ' bad'}`} role="status" aria-live="polite" data-ctl="CTL-OFC-35-03">
        {left}{c.outside && c.fits ? ` ${t('job.text.outside', { ch: c.outside })}` : ''}
      </p>
      <p className="r1-hint" data-ctl="CTL-OFC-35-06">{t('job.text.quiet')}</p>
      <Refused shown={shown} />
    </Dialog>
  );
}

/** SCR-OFC-36 Add note: append-only (D14); API-140. */
export function NoteDialog(p: Hosted & { start?: DialogStart }) {
  const t = useT();
  const [body, setBody] = useState(p.start?.body ?? '');
  const [saving, setSaving] = useState(p.start?.saving ?? false);
  const [shown, setShown] = useState<Shown | null>(p.start?.shown ?? null);
  const [asking, setAsking] = useState(false);
  const ready = body.trim() !== '' && !saving;
  const go = async () => {
    if (!ready) return;
    setSaving(true);
    const r = await p.api.note(p.job ? { jobNumber: p.job.job.jobNumber } : { customerId: p.customer.id }, body.trim());
    setSaving(false);
    if (r.ok) return p.onDone({ key: 'job.note.saved' });
    setShown(shownOf(r));
  };
  const close = () => { if (body.trim() !== '' && !asking) setAsking(true); else p.onClose(); };
  return (
    <Dialog title={t('job.note.title')} closeCtl="CTL-OFC-36-03" onClose={close} screen="SCR-OFC-36" inline={p.inline ?? false} initialFocus="textarea"
      foot={asking
        ? <><span className="r1-note">{t('job.note.discard')}</span><button type="button" className="btn" onClick={() => setAsking(false)}>{t('job.keepWriting')}</button><button type="button" className="btn danger" onClick={p.onClose}>{t('job.discard')}</button></>
        : <><button type="button" className={saving ? 'btn dis' : 'btn'} aria-disabled={saving || undefined} data-ctl="CTL-OFC-36-03" onClick={() => { if (!saving) close(); }}>{t('common.cancel')}</button>
          {saving ? <Busy label={t('job.saving')} ctl="CTL-OFC-36-02" />
            : <button type="button" className={`btn primary${ready ? '' : ' dis'}`} aria-disabled={!ready || undefined} title={ready ? undefined : t('job.note.typeFirst')} data-ctl="CTL-OFC-36-02" onClick={() => void go()}>{t('job.note.save')}</button>}
          {body.trim() === '' && !saving ? <span className="r1-note bw-foot-note">{t('job.note.typeFirst')}</span> : null}</>}>
      <div className="r1-field" data-ctl="CTL-OFC-36-01">
        <label htmlFor="bw-nt">{t('job.note.label')}</label>
        <textarea id="bw-nt" className="tbox-in" value={body} maxLength={2000} placeholder={t('job.note.ph')} onChange={(e) => setBody(e.target.value)} />
      </div>
      <p className="r1-hint" data-ctl="CTL-OFC-36-04">{t('job.note.appendOnly')}</p>
      <Refused shown={shown} />
    </Dialog>
  );
}

/**
 * SCR-OFC-37 in edit mode (an equipmentId): Save changes once a field changed; API-142 (not_found: the equipment is gone). In add mode (no
 * equipmentId, the customer page's Add equipment): empty fields, Add equipment once the type is filled; API-141.
 */
export function EquipmentDialog(p: Hosted & { equipmentId?: string; start?: DialogStart & { details?: string } }) {
  const t = useT();
  const who = whoOf(p);
  const adding = p.equipmentId === undefined;
  const e0 = adding ? null : (who.equipment.find((e) => e.id === p.equipmentId) ?? who.equipment[0]!);
  // The field holds the type's word in the page's language; an untouched Type is not sent, so the stored code stays (F-698).
  const type0 = e0 ? equipmentWord(t, e0.type) : '';
  const year0 = e0?.year == null ? '' : String(e0.year);
  const [f, setF] = useState({ type: type0, year: year0, location: e0?.location ?? '', details: p.start?.details ?? e0?.details ?? '' });
  const [saving, setSaving] = useState(p.start?.saving ?? false);
  const [shown, setShown] = useState<Shown | null>(p.start?.shown ?? null);
  const yearBad = f.year.trim() !== '' && !/^(19|20)\d{2}$/.test(f.year.trim());
  const changed = adding || f.type !== type0 || f.year !== year0 || f.location !== (e0?.location ?? '') || f.details !== (e0?.details ?? '');
  const ready = f.type.trim() !== '' && !yearBad && changed && !saving;
  const go = async () => {
    if (!ready) return;
    setSaving(true);
    const fields = { year: f.year.trim() === '' ? null : Number(f.year), location: f.location.trim() || null, details: f.details.trim() || null };
    const r = e0
      ? await p.api.equipment({ equipmentId: e0.id, ...(f.type === type0 ? {} : { type: equipmentTypeSent(t, f.type) }), ...fields })
      : await p.api.addEquipment({ customerId: who.id, type: equipmentTypeSent(t, f.type), ...fields });
    setSaving(false);
    if (r.ok) return p.onDone({ key: 'job.equipment.saved' });
    setShown(r.code === 'not_found' && !adding ? { key: 'job.equipment.gone' } : shownOf(r));
  };
  const field = (k: 'type' | 'year' | 'location', label: MessageKey, ctl: string) => (
    <div className="r1-field" data-ctl={ctl}>
      <label htmlFor={`bw-eq-${k}`}>{t(label)}</label>
      <input id={`bw-eq-${k}`} className={`r1-input${k === 'year' && yearBad ? ' bad' : ''}`} value={f[k]} list={k === 'type' ? 'bw-eq-types' : undefined} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      {k === 'type' ? <datalist id="bw-eq-types">{equipmentSuggestions(t).map((s) => <option key={s.code} value={s.word} />)}</datalist> : null}
      {k === 'type' && !adding && f.type.trim() === '' ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('job.equipment.typeRequired')}</div> : null}
      {k === 'year' && yearBad ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('job.equipment.yearBad')}</div> : null}
    </div>
  );
  return (
    <Dialog title={t(adding ? 'job.equipment.addTitle' : 'job.equipment.title')} closeCtl="CTL-OFC-37-06" onClose={p.onClose} screen="SCR-OFC-37" inline={p.inline ?? false}
      foot={<><button type="button" className={saving ? 'btn dis' : 'btn'} aria-disabled={saving || undefined} data-ctl="CTL-OFC-37-06" onClick={() => { if (!saving) p.onClose(); }}>{t('common.cancel')}</button>
        {saving ? <Busy label={t('job.saving')} ctl="CTL-OFC-37-05" /> : <button type="button" className={`btn primary${ready ? '' : ' dis'}`} aria-disabled={!ready || undefined} data-ctl="CTL-OFC-37-05" onClick={() => void go()}>{t(adding ? 'job.equipment.add' : 'job.equipment.save')}</button>}</>}>
      {field('type', 'job.equipment.type', 'CTL-OFC-37-01')}
      <div className="g2f">{field('year', 'job.equipment.year', 'CTL-OFC-37-02')}{field('location', 'job.equipment.location', 'CTL-OFC-37-03')}</div>
      <div className="r1-field bw-mt-12" data-ctl="CTL-OFC-37-04">
        <label htmlFor="bw-eq-details">{t('job.equipment.details')}</label>
        <input id="bw-eq-details" className="r1-input" value={f.details} maxLength={500} onChange={(e) => setF({ ...f, details: e.target.value })} />
      </div>
      <Refused shown={shown} />
    </Dialog>
  );
}
