// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The Technicians page's 2 dialogs (DK-92; UI-SPECIFICATION SCR-OFC-41 Add technician, SCR-OFC-42 Add time off). Each holds its own form state and
// makes its 1 write through the page's TechApi; a refusal shows its catalog message in the dialog (4.3). The hours of a new technician start as the
// frame's Monday to Friday 8 to 5:30 with no Saturday, drawn as the frame draws them; pressing them opens HoursEditor in place (CTL-OFC-41-06).
import type { MessageKey } from '@bw/i18n';
import { useEffect, useState } from 'react';
import { Busy, Dialog } from '../board/Dialogs.tsx';
import { windowText } from '../board/model.ts';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { BRANCHES } from '../shell/branches.ts';
import type { TechApi } from './api.ts';
import { HoursEditor, opensEditor } from './HoursEditor.tsx';
import { firstName, jobsText, MAX_TIME_OFF_DAYS, skillWord, spanDays, toggleSkill, weekProblem, weekRows, type SkillWords, type TechData, type TechRow, type TechSkill, type WorkWeek } from './model.ts';

/** The workweek a new technician starts with (CTL-OFC-41-06). */
const DEFAULT_WEEK: WorkWeek = { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Refused({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className="r1-fmsg" role="alert"><Icon name="alert" />{text}</div>;
}

/** Harness previews only: the state a dialog opens in (typed values, a busy write, the added line), so each frame state is drawn fixed. */
export interface AddStart { name?: string; email?: string; vanId?: string | null; skills?: TechSkill[]; saving?: boolean; added?: { name: string; email: string; link: string }; used?: boolean; focus?: boolean; hoursOpen?: boolean }
interface TimeOffStart { from?: string; to?: string; note?: string; saving?: boolean }

interface AddProps {
  api: TechApi;
  data: TechData;
  /** The top-bar branch: the Branch select starts there (CTL-OFC-41-03). */
  branch: string;
  words?: SkillWords;
  onClose: () => void;
  /** The technician was added: the page re-reads its list. */
  onAdded?: () => void;
  start?: AddStart;
  inline?: boolean;
}

/** The dialog that adds a new technician to a branch (SCR-OFC-41). */
export function AddTechnicianDialog(p: AddProps) {
  const t = useT();
  const [name, setName] = useState(p.start?.name ?? '');
  const [email, setEmail] = useState(p.start?.email ?? '');
  const [branch, setBranch] = useState(p.branch);
  const [vanId, setVanId] = useState<string | null>(p.start?.vanId ?? null);
  const [skills, setSkills] = useState<TechSkill[]>(p.start?.skills ?? []);
  const [vans, setVans] = useState(p.data.vans);
  const [saving, setSaving] = useState(p.start?.saving ?? false);
  const [added, setAdded] = useState<AddStart['added'] | null>(p.start?.added ?? null);
  const [used, setUsed] = useState(p.start?.used ?? false);
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [week, setWeek] = useState<WorkWeek>(DEFAULT_WEEK);
  const [hoursOpen, setHoursOpen] = useState(p.start?.hoursOpen ?? false);
  // F-768: a field's message shows once the person left it, or pressed Add while it was not ready.
  const [seen, setSeen] = useState<{ name: boolean; email: boolean; skills: boolean }>({ name: false, email: false, skills: false });

  // A new branch brings its own vans (CTL-OFC-41-04 reads API-31).
  useEffect(() => {
    if (branch === p.data.branch) {
      setVans(p.data.vans);
      return;
    }
    let live = true;
    void p.api.list(branch).then((r) => {
      if (live && r.ok) setVans(r.data.vans);
    });
    return () => { live = false; };
  }, [branch]);

  const nameOk = name.trim() !== '';
  const emailOk = EMAIL.test(email.trim());
  const skillsOk = skills.length > 0;
  const valid = nameOk && emailOk && skillsOk && weekProblem(week) === null;
  const notReady = () => setSeen({ name: true, email: true, skills: true });
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setEmailMsg(null);
    setMsg(null);
    const r = await p.api.add({ name: name.trim(), email: email.trim(), branch, vanId, skills, workingHours: week });
    setSaving(false);
    if (r.ok) {
      setAdded({ name: name.trim(), email: email.trim(), link: r.data.emailLink });
      p.onAdded?.();
    } else if (r.code === 'already_a_user') setEmailMsg(t('technicians.add.alreadyUser'));
    else setMsg(t('technicians.write.failed'));
  };

  if (added) {
    return (
      <Dialog title={t('technicians.add.title')} closeCtl="CTL-OFC-41-09" onClose={p.onClose} screen="SCR-OFC-41" inline={p.inline ?? false} initialFocus="[data-ctl='CTL-OFC-41-09']"
        foot={<button type="button" className="btn primary" data-ctl="CTL-OFC-41-09" onClick={p.onClose}>{t('technicians.add.close')}</button>}>
        <p><b>{t('technicians.add.added', { name: added.name })}</b> {t('technicians.add.sent', { email: added.email })}</p>
        {used ? (
          <p className="r1-note" data-ctl="CTL-OFC-41-08">{t('technicians.add.used')}</p>
        ) : (
          <p><a className="r1-link" href={added.link} target="_blank" rel="noopener noreferrer" data-ctl="CTL-OFC-41-08" onClick={() => setUsed(true)}>{t('technicians.add.open')}</a></p>
        )}
      </Dialog>
    );
  }
  return (
    <Dialog title={t('technicians.add.title')} closeCtl="CTL-OFC-41-09" onClose={p.onClose} screen="SCR-OFC-41" inline={p.inline ?? false} initialFocus="#bw-ta-name"
      foot={<>
        {saving ? <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-41-09">{t('common.cancel')}</button> : <button type="button" className="btn" data-ctl="CTL-OFC-41-09" onClick={p.onClose}>{t('common.cancel')}</button>}
        {saving ? <Busy label={t('technicians.add.adding')} ctl="CTL-OFC-41-07" />
          : <button type="button" className={valid ? 'btn primary' : 'btn dis primary'} aria-disabled={!valid || undefined} data-ctl="CTL-OFC-41-07" onClick={() => (valid ? void submit() : notReady())}>{t('technicians.add.submit')}</button>}
      </>}>
      <div className="r1-field" data-ctl="CTL-OFC-41-01">
        <label htmlFor="bw-ta-name">{t('technicians.add.name')}</label>
        <input id="bw-ta-name" className={p.start?.focus ? 'r1-input focus' : 'r1-input'} value={name} maxLength={120} autoComplete="off" disabled={saving} onChange={(e) => setName(e.target.value)} onBlur={() => setSeen((s) => ({ ...s, name: true }))} />
        <Refused text={seen.name && !nameOk ? t('technicians.add.nameEmpty') : null} />
      </div>
      <div className="g2f">
        <div className="r1-field" data-ctl="CTL-OFC-41-02">
          <label htmlFor="bw-ta-email">{t('technicians.add.email')}</label>
          <input id="bw-ta-email" className={emailMsg ? 'r1-input bad' : 'r1-input'} type="email" value={email} maxLength={254} autoComplete="off" disabled={saving} onChange={(e) => { setEmail(e.target.value); setEmailMsg(null); }} />
          <Refused text={emailMsg ?? (seen.email && !emailOk ? t('technicians.add.emailBad') : null)} />
        </div>
        <div className="r1-field" data-ctl="CTL-OFC-41-03">
          <label htmlFor="bw-ta-branch">{t('technicians.filter.branch')}</label>
          <select id="bw-ta-branch" className="r1-input" value={branch} disabled={saving} onChange={(e) => { setBranch(e.target.value); setVanId(null); }}>
            {BRANCHES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      </div>
      <div className="g2f">
        <div className="r1-field" data-ctl="CTL-OFC-41-04">
          <label htmlFor="bw-ta-van">{t('technicians.van.label')}</label>
          <select id="bw-ta-van" className="r1-input" value={vanId ?? ''} disabled={saving} onChange={(e) => setVanId(e.target.value === '' ? null : e.target.value)}>
            <option value="">{t('technicians.noVan')}</option>
            {vans.map((v) => <option key={v.id} value={v.id}>{t('technicians.van', { van: v.number })}</option>)}
          </select>
        </div>
        <div className="r1-field" data-ctl="CTL-OFC-41-05">
          <label id="bw-ta-skills">{t('technicians.col.skills')}</label>
          <div className="cks bw-tc-cks0" role="group" aria-labelledby="bw-ta-skills">
            {p.data.skills.map((s) => (
              <span
                key={s}
                role="checkbox"
                tabIndex={0}
                aria-checked={skills.includes(s)}
                {...(skills.includes(s) ? { className: 'on' } : {})}
                onClick={() => { if (!saving) { setSkills(toggleSkill(p.data.skills, skills, s)); setSeen((v) => ({ ...v, skills: true })); } }}
                onKeyDown={(e) => {
                  if ((e.key === ' ' || e.key === 'Enter') && !saving) {
                    e.preventDefault();
                    setSkills(toggleSkill(p.data.skills, skills, s));
                    setSeen((v) => ({ ...v, skills: true }));
                  }
                }}
              >
                {skillWord(t, s, p.words)}
              </span>
            ))}
          </div>
          <Refused text={seen.skills && !skillsOk ? t('technicians.skills.none') : null} />
        </div>
      </div>
      <div className="r1-field bw-mt-12" data-ctl="CTL-OFC-41-06">
        <label>{t('technicians.col.hours')}</label>
        {hoursOpen ? <HoursEditor week={week} saturday={p.data.saturdayHours} ctl="CTL-OFC-41-06" disabled={saving} onChange={setWeek} /> : (
          <div className="hrs bw-tc-hrs3" {...opensEditor(t('technicians.hours.change'), () => { if (!saving) setHoursOpen(true); })}>
            {weekRows(week, p.data.saturdayHours).slice(0, 6).map((d) => (
              <div key={d.day} {...(d.text === null ? { className: 'off' } : {})}><span>{t(`time.weekday.${d.day}` as MessageKey)}</span><span>{d.text ?? t('technicians.hours.off')}</span></div>
            ))}
          </div>
        )}
      </div>
      <Refused text={msg} />
    </Dialog>
  );
}

interface TimeOffProps {
  api: TechApi;
  row: TechRow;
  onClose: () => void;
  /** Saved: the toast's text (naming any job already booked in the span, GAP-25) and the technician's jobs for the page to re-read. */
  onSaved?: (toast: string) => void;
  start?: TimeOffStart;
  inline?: boolean;
}

/** The dialog that adds time off for a technician (SCR-OFC-42). */
export function AddTimeOffDialog(p: TimeOffProps) {
  const t = useT();
  const [from, setFrom] = useState(p.start?.from ?? '');
  const [to, setTo] = useState(p.start?.to ?? '');
  const [note, setNote] = useState(p.start?.note ?? '');
  const [saving, setSaving] = useState(p.start?.saving ?? false);
  const [msg, setMsg] = useState<string | null>(null);
  const range = from !== '' && to !== '' && to < from;
  const tooLong = !range && spanDays(from, to) > MAX_TIME_OFF_DAYS;
  const valid = from !== '' && to !== '' && !range && !tooLong;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setMsg(null);
    const r = await p.api.addTimeOff(p.row.id, { from, to, note: note.trim() === '' ? null : note.trim() });
    setSaving(false);
    if (r.ok) {
      const jobs = r.data.unassigned;
      const first = firstName(p.row.name);
      p.onSaved?.(jobs.length === 0
        ? t('technicians.timeOff.saved')
        : t('technicians.timeOff.savedJobs', { name: first, count: jobs.length, when: t(from === to ? 'technicians.timeOff.whenDay' : 'technicians.timeOff.whenSpan'), jobs: jobsText(jobs, t, windowText) }));
      return;
    }
    const numbers = r.detail.jobNumbers;
    if (r.code === 'rule_refused' && Array.isArray(numbers)) {
      setMsg(t('technicians.timeOff.refused', { name: firstName(p.row.name), count: numbers.length, jobs: numbers.join(', ') }));
    } else if (r.code === 'validation_failed') setMsg(t(range ? 'technicians.timeOff.badRange' : tooLong ? 'technicians.timeOff.tooLong' : 'technicians.write.failed'));
    else setMsg(t('technicians.write.failed'));
  };

  return (
    <Dialog title={t('technicians.timeOff.dialog', { name: p.row.name })} closeCtl="CTL-OFC-42-04" onClose={p.onClose} screen="SCR-OFC-42" inline={p.inline ?? false} initialFocus="#bw-to-from"
      foot={<>
        {saving ? <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-42-04">{t('common.cancel')}</button> : <button type="button" className="btn" data-ctl="CTL-OFC-42-04" onClick={p.onClose}>{t('common.cancel')}</button>}
        {saving ? <Busy label={t('technicians.saving')} ctl="CTL-OFC-42-03" />
          : <button type="button" className={valid ? 'btn primary' : 'btn dis primary'} aria-disabled={!valid || undefined} data-ctl="CTL-OFC-42-03" onClick={() => void submit()}>{t('common.save')}</button>}
      </>}>
      <div className="g2f bw-tc-first" data-ctl="CTL-OFC-42-01">
        <div className="r1-field">
          <label htmlFor="bw-to-from">{t('technicians.timeOff.from')}</label>
          <input id="bw-to-from" className="r1-input" type="date" value={from} disabled={saving} onChange={(e) => { setFrom(e.target.value); setMsg(null); }} />
        </div>
        <div className="r1-field">
          <label htmlFor="bw-to-to">{t('technicians.timeOff.to')}</label>
          <input id="bw-to-to" className={range || tooLong ? 'r1-input bad' : 'r1-input'} type="date" value={to} disabled={saving} onChange={(e) => { setTo(e.target.value); setMsg(null); }} />
          {range ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('technicians.timeOff.badRange')}</div> : null}
          {tooLong ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t('technicians.timeOff.tooLong')}</div> : null}
        </div>
      </div>
      <div className="r1-field bw-mt-12" data-ctl="CTL-OFC-42-02">
        <label htmlFor="bw-to-note">{t('technicians.timeOff.note')}</label>
        <input id="bw-to-note" className="r1-input" value={note} maxLength={120} placeholder={t('technicians.timeOff.notePh')} autoComplete="off" disabled={saving} onChange={(e) => setNote(e.target.value)} />
      </div>
      <Refused text={msg} />
    </Dialog>
  );
}
