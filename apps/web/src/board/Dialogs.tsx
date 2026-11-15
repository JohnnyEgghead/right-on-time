// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The board's popovers and dialogs (DK-34 dialogs, DK-35 popovers; UI-SPECIFICATION section 6): SCR-OFC-29 job popover,
// SCR-OFC-32 block popover, SCR-OFC-18 reassign, SCR-OFC-19 conflict, SCR-OFC-31 add or change a block, SCR-OFC-33 delete
// a block. Each takes its data and its busy and message states as props, so the screen drives them and the harness
// build shows each state its frame draws. Escape closes; focus goes to the stated control on open and back on close.
import type { MessageKey } from '@bw/i18n';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { useModalFocus } from '../shell/modal-focus.ts';
import type { Preview, Suggested } from './api.ts';
import { conflictWords, spanText, statusKey, timeText, timingKey, windowText, type BoardJob, type Conflict } from './model.ts';

const CLOSE_PATH = 'M6 6l12 12M18 6L6 18';

/**
 * Whether a hosted screen's root carries its own data-screen (the shell's convention: true inside its host page). The
 * harness draws a hosted screen alone in a frame named for it, and then the frame's root is the 1 screen root.
 */
export const HostedScreenAttr = createContext(true);

function useEscape(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
}

/** A busy button (4.1 Busy): the spinner and the busy label; a repeated press is ignored. */
export function Busy({ label, ctl, cls = 'primary' }: { label: string; ctl: string; cls?: string }) {
  const dark = !cls.includes('primary') && !cls.includes('danger');
  return (
    <button type="button" className={`btn busy ${cls}`} aria-busy="true" data-ctl={ctl}>
      <span className={dark ? 'r1-spin dark' : 'r1-spin'} />
      {label}
    </button>
  );
}

/** DK-34: a dialog with its title, close button, body and footer. `inline`: drawn in place (the harness frames' tiles). */
export function Dialog({ title, closeCtl, onClose, children, foot, screen, initialFocus, inline, alert, wide }: {
  title: string; closeCtl: string; onClose: () => void; children: ReactNode; foot: ReactNode; screen: string;
  initialFocus?: string; inline?: boolean; alert?: boolean; wide?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const own = useContext(HostedScreenAttr);
  useEscape(onClose);
  useModalFocus(ref, { active: !inline });
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const first = (initialFocus ? ref.current?.querySelector<HTMLElement>(initialFocus) : null) ?? ref.current?.querySelector<HTMLElement>('input, button.primary, button');
    if (!inline) first?.focus();
    return () => {
      if (!inline) back?.focus?.();
    };
    // Focus moves once, on open.
  }, []);
  return (
    <div className={inline ? 'r1-scrim in' : 'r1-scrim'}>
      <div ref={ref} className={wide ? 'r1-dlg wide' : 'r1-dlg'} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={title} data-screen={own ? screen : undefined}>
        <div className="r1-dlg-h">
          <h2>{title}</h2>
          <button type="button" className="r1-x" aria-label={t('board.close')} data-ctl={closeCtl} onClick={onClose}>
            <i className="ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={CLOSE_PATH} /></svg>
            </i>
          </button>
        </div>
        <div className="r1-dlg-b">{children}</div>
        <div className="r1-dlg-f">{foot}</div>
      </div>
    </div>
  );
}

/** DK-35: a popover beside its block. Escape and Close return focus to the block (NFR-06). */
function Popover({ label, screen, children, acts, onClose, anchor, inline }: {
  label: string; screen: string; children: ReactNode; acts: ReactNode; onClose: () => void; anchor?: HTMLElement | null; inline?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const own = useContext(HostedScreenAttr);
  useEscape(onClose);
  useEffect(() => {
    const el = ref.current;
    if (!el || inline) return;
    if (anchor) {
      const a = anchor.getBoundingClientRect();
      const host = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0 };
      el.style.left = `${Math.max(8, a.left - host.left)}px`;
      el.style.top = `${a.bottom - host.top + 6}px`;
    }
    el.querySelector<HTMLElement>('a, button')?.focus();
    return () => anchor?.focus?.();
  }, [anchor, inline]);
  return (
    <div ref={ref} className={inline ? 'r1-pop in' : 'r1-pop'} role="dialog" aria-label={label} data-screen={own ? screen : undefined}>
      {children}
      <div className="acts">{acts}</div>
    </div>
  );
}

/** SCR-OFC-29 (CTL-OFC-29-01 to 04). `job` null: Gone (the job no longer exists after a reset). */
export function JobPopover({ job, technician, onReassign, onClose, anchor, inline, canReassign }: {
  job: BoardJob | null; technician: string | null; onReassign: () => void; onClose: () => void; anchor?: HTMLElement | null; inline?: boolean; canReassign: boolean;
}) {
  const t = useT();
  if (!job) {
    return (
      <Popover label={t('board.pop.gone')} screen="SCR-OFC-29" onClose={onClose} anchor={anchor ?? null} inline={inline ?? false}
        acts={<button type="button" className="btn sm" data-ctl="CTL-OFC-29-04" onClick={onClose}>{t('board.close')}</button>}>
        <p className="bw-m0" data-ctl="CTL-OFC-29-01">{t('board.pop.gone')}</p>
      </Popover>
    );
  }
  const title = t('board.pop.title', { job: job.jobNumber, customer: job.customerName });
  const tk = timingKey(job);
  return (
    <Popover label={title} screen="SCR-OFC-29" onClose={onClose} anchor={anchor ?? null} inline={inline ?? false} acts={(
      <>
        <a className="btn sm" data-ctl="CTL-OFC-29-02" href={`/office/jobs/${job.jobNumber}`}>{t('board.pop.open')}</a>
        {canReassign ? <button type="button" className="btn sm primary" data-ctl="CTL-OFC-29-03" onClick={onReassign}>{t('board.pop.reassign')}</button> : null}
        <button type="button" className="btn sm ghost" data-ctl="CTL-OFC-29-04" onClick={onClose}>{t('board.close')}</button>
      </>
    )}>
      <div data-ctl="CTL-OFC-29-01">
        <h3>{title}</h3>
        <p className="bw-m0">
          {t('board.pop.where', { service: t(job.serviceLabelKey as MessageKey), area: job.area, window: windowText(job.window.start, job.window.end) })}
          <br />
          {t.rich('board.pop.state', {
            technician: technician ?? t('board.pop.noTech'),
            status: tk ? t(tk) : t(statusKey(job)),
            eta: job.eta && job.status !== 'done' && job.status !== 'no_one_home' ? timeText(job.eta) : 'none',
            late: job.lateTextSent ? 'true' : 'false',
          })}
        </p>
      </div>
    </Popover>
  );
}

export interface BlockView { label: string; place: string | null; technician: string; date: string; start: string; end: string }

/** SCR-OFC-32 (CTL-OFC-32-01 to 04). `block` null: Gone (deleted elsewhere). */
export function BlockPopover({ block, onChange, onDelete, onClose, anchor, inline, online }: {
  block: BlockView | null; onChange: () => void; onDelete: () => void; onClose: () => void; anchor?: HTMLElement | null; inline?: boolean; online: boolean;
}) {
  const t = useT();
  if (!block) {
    return (
      <Popover label={t('board.conflict.goneBlock')} screen="SCR-OFC-32" onClose={onClose} anchor={anchor ?? null} inline={inline ?? false}
        acts={<button type="button" className="btn sm" data-ctl="CTL-OFC-32-04" onClick={onClose}>{t('board.close')}</button>}>
        <p className="bw-m0" data-ctl="CTL-OFC-32-01">{t('board.conflict.goneBlock')}</p>
      </Popover>
    );
  }
  return (
    <Popover label={block.label} screen="SCR-OFC-32" onClose={onClose} anchor={anchor ?? null} inline={inline ?? false} acts={(
      <>
        {online ? <button type="button" className="btn sm" data-ctl="CTL-OFC-32-02" onClick={onChange}>{t('board.blockpop.change')}</button> : null}
        {online ? <button type="button" className="btn sm" data-ctl="CTL-OFC-32-03" onClick={onDelete}>{t('board.blockpop.delete')}</button> : null}
        <button type="button" className="btn sm ghost" data-ctl="CTL-OFC-32-04" onClick={onClose}>{t('board.close')}</button>
      </>
    )}>
      <div data-ctl="CTL-OFC-32-01">
        <h3>{block.label}</h3>
        <p className="bw-m0">{t('board.blockpop.where', { place: block.place ?? t('board.block.noPlace'), technician: block.technician, date: block.date, span: spanText(block.start, block.end) })}</p>
      </div>
    </Popover>
  );
}

export type ReassignState =
  | { step: 'loading' }
  | { step: 'error' }
  | { step: 'choosing'; list: Suggested[]; pick: string | null | undefined; preview: Preview | 'failed' | null; saving: boolean; message: string | null };

/** SCR-OFC-18 (CTL-OFC-18-01 to 04): a radio list of the day's technicians and No technician, the move preview, Reassign. */
export function ReassignDialog({ job, current, state, date, onPick, onSubmit, onClose, inline }: {
  job: BoardJob; current: string | null; state: ReassignState; date: string; onPick: (id: string | null) => void; onSubmit: () => void; onClose: () => void; inline?: boolean;
}) {
  const t = useT();
  const title = t('board.reassign.title', { job: job.jobNumber, customer: job.customerName });
  const win = windowText(job.window.start, job.window.end);
  const cancel = (dis: boolean) => (dis
    ? <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-18-03">{t('common.cancel')}</button>
    : <button type="button" className="btn" data-ctl="CTL-OFC-18-03" onClick={onClose}>{t('common.cancel')}</button>);
  if (state.step !== 'choosing') {
    return (
      <Dialog title={title} closeCtl="CTL-OFC-18-03" onClose={onClose} screen="SCR-OFC-18" inline={inline ?? false}
        foot={<>{cancel(false)}<button type="button" className="btn dis primary" aria-disabled="true" data-ctl="CTL-OFC-18-02">{t('board.reassign.submit')}</button></>}>
        {state.step === 'loading' ? (<><span className="r1-skel bw-w-40" /><span className="r1-skel" /><span className="r1-skel" /><span className="r1-skel" /></>)
          : <div className="r1-errpanel" role="alert"><Icon name="alert" /><div><b>{t('board.reassign.listError')}</b></div></div>}
      </Dialog>
    );
  }
  const others = state.list.filter((x) => x.id !== current);
  const changed = state.pick !== undefined && state.pick !== current;
  const radio = (id: string | null, name: string, sub: string, now: boolean) => {
    const on = state.pick === id;
    return (
      <div key={id ?? 'none'} className={on ? 'rl2 on' : 'rl2'} role="radio" aria-checked={on} tabIndex={on || (state.pick === undefined && now) ? 0 : -1}
        onClick={() => onPick(id)} onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onPick(id); } }}>
        <i className="rd" /><b>{name}</b>{now ? <span className="now">{t('board.reassign.now')}</span> : null}<small>{sub}</small>
      </div>
    );
  };
  const skill = (s: Suggested) => s.skills.map((x) => t(`skill.${x}` as MessageKey)).join(', ');
  const preview = state.preview === 'failed' ? t('board.reassign.noPreview')
    : state.preview && state.preview.arrivesAbout ? t(state.preview.insideWindow ? 'board.reassign.onTime' : 'board.reassign.late', { time: timeText(state.preview.arrivesAbout), window: win }) : null;
  return (
    <Dialog title={title} closeCtl="CTL-OFC-18-03" onClose={onClose} screen="SCR-OFC-18" inline={inline ?? false} foot={(
      <>
        {cancel(state.saving)}
        {state.saving ? <Busy label={t('board.reassign.busy')} ctl="CTL-OFC-18-02" />
          : changed ? <button type="button" className="btn primary" data-ctl="CTL-OFC-18-02" onClick={onSubmit}>{t('board.reassign.submit')}</button>
            : <button type="button" className="btn dis primary" aria-disabled="true" data-ctl="CTL-OFC-18-02">{t('board.reassign.submit')}</button>}
      </>
    )}>
      {others.length === 0 ? <p className="r1-note bw-noothers">{t('board.reassign.noOthers', { date })}</p> : null}
      <div className="rlist" role="radiogroup" aria-label={title} data-ctl="CTL-OFC-18-01">
        {state.list.map((s) => radio(s.id, s.name, s.van
          ? t('board.reassign.sub', { van: s.van, skill: skill(s), jobs: s.load.jobs, capacity: s.load.capacity })
          : t('board.reassign.subNoVan', { skill: skill(s), jobs: s.load.jobs, capacity: s.load.capacity }), s.id === current))}
        {radio(null, t('board.reassign.none'), t('board.reassign.noneSub'), current === null)}
      </div>
      {preview ? <div className="pvw" role="status" data-ctl="CTL-OFC-18-04">{preview}</div> : null}
      {state.message ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{state.message}</div> : null}
    </Dialog>
  );
}

/** What SCR-OFC-19 answers: a job move (to a technician's name or the Unassigned row) or a block move (to a start time). */
export type ConflictSubject = { kind: 'job'; mine: string } | { kind: 'block'; mine: string; theirs: string | null };

/** The CTL-OFC-19-01 message: who, what and when, in the page's language (FR-DISP-6, FR-DISP-34; owner ruling 8ef38e83). */
export function useConflictText() {
  const t = useT();
  return (c: Conflict, s: ConflictSubject, again = false): string => {
    const w = conflictWords(c);
    const by = 'name' in w.who ? w.who.name : t(w.who.key);
    if (w.at === null) return t('board.conflict.unknown');
    const first = again ? 'false' : 'true';
    if (s.kind === 'block') return t('board.conflict.block', { by, start: s.theirs ?? '', at: w.at, mine: s.mine, first });
    return t('board.conflict.job', { by, change: w.change, to: c.technician ?? t('board.conflict.unassignedRow'), at: w.at, mine: s.mine, first });
  };
}

/** SCR-OFC-19 (CTL-OFC-19-01 to 03). `message` null: Gone. Focus starts on Keep their change. The Anyway label follows the action (default: a move). */
export function ConflictDialog({ subject, message, again, resending, onAnyway, onKeep, inline, anywayLabel, busyLabel }: {
  subject: 'job' | 'block'; message: string | null; again: boolean; resending: boolean; onAnyway: () => void; onKeep: () => void; inline?: boolean;
  anywayLabel?: string; busyLabel?: string;
}) {
  const t = useT();
  const title = t(subject === 'job' ? 'board.conflict.titleJob' : 'board.conflict.titleBlock');
  if (message === null) {
    return (
      <Dialog title={title} closeCtl="CTL-OFC-19-03" onClose={onKeep} screen="SCR-OFC-19" inline={inline ?? false} alert
        foot={<button type="button" className="btn primary" data-ctl="CTL-OFC-19-03" onClick={onKeep}>{t('board.close')}</button>}>
        <p data-ctl="CTL-OFC-19-01" role="alert">{t(subject === 'job' ? 'board.conflict.goneJob' : 'board.conflict.goneBlock')}</p>
      </Dialog>
    );
  }
  return (
    <Dialog title={title} closeCtl="CTL-OFC-19-03" onClose={onKeep} screen="SCR-OFC-19" inline={inline ?? false} alert initialFocus='button[data-keep="1"]' foot={(
      <>
        {resending ? <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-19-03">{t('board.conflict.keep')}</button>
          : <button type="button" className="btn" data-ctl="CTL-OFC-19-03" data-keep="1" onClick={onKeep}>{t('board.conflict.keep')}</button>}
        {resending ? <Busy label={busyLabel ?? t('board.conflict.busy')} ctl="CTL-OFC-19-02" />
          : <button type="button" className="btn primary" data-ctl="CTL-OFC-19-02" onClick={onAnyway}>{anywayLabel ?? t('board.conflict.anyway')}</button>}
      </>
    )}>
      <div className="r1-fmsg bw-conflict" role="alert" data-ctl="CTL-OFC-19-01">
        <Icon name="alert" />
        {again ? t('board.conflict.again', { message }) : message}
      </div>
    </Dialog>
  );
}

export interface BlockForm { technicianId: string; label: string; place: string; start: string; end: string }
export type BlockErrors = Partial<Record<'label' | 'place' | 'end', MessageKey>>;

/** SCR-OFC-31 (CTL-OFC-31-01 to 06), add or change mode. */
export function BlockDialog({ mode, form, technicians, dateText, errors, overlap, saving, changed, onChange, onSave, onClose, inline, focus }: {
  mode: 'add' | 'change'; form: BlockForm; technicians: readonly { id: string; name: string }[]; dateText: string; errors: BlockErrors;
  overlap: string | null; saving: boolean; changed: boolean; onChange: (f: BlockForm) => void; onSave: () => void; onClose: () => void; inline?: boolean;
  /** The field drawn focused (the kit's .r1-input.focus); the harness shows the Adding frame's focused Label. */
  focus?: string;
}) {
  const t = useT();
  const [focused, setFocused] = useState<string | null>(focus ?? null);
  const box = (key: string, bad: boolean, extra = '') => `r1-input${extra}${bad ? ' bad' : focused === key ? ' focus' : ''}`;
  const track = (key: string) => ({ onFocus: () => setFocused(key), onBlur: () => setFocused((f) => (f === key ? null : f)) });
  const valid = form.label.trim() !== '' && form.place.trim() !== '' && form.start < form.end && form.technicianId !== '';
  const ready = valid && (mode === 'add' || changed);
  const label = t(mode === 'add' ? 'board.blockdlg.add' : 'board.blockdlg.save');
  const field = (key: 'label' | 'place', ctl: string, ph: MessageKey, list?: string) => (
    <div className="r1-field" data-ctl={ctl}>
      <label htmlFor={`blk-${key}`}>{t(key === 'label' ? 'board.blockdlg.label' : 'board.blockdlg.place')}</label>
      <div className={box(key, errors[key] !== undefined)}>
        <input id={`blk-${key}`} className="bw-field-input" value={form[key]} placeholder={t(ph)} list={list} aria-invalid={errors[key] ? true : undefined} {...track(key)}
          onChange={(e) => onChange({ ...form, [key]: e.target.value })} />
      </div>
      {errors[key] ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t(errors[key] as MessageKey)}</div> : null}
    </div>
  );
  const time = (key: 'start' | 'end') => (
    <div className="r1-field">
      <label htmlFor={`blk-${key}`}>{t(key === 'start' ? 'board.blockdlg.start' : 'board.blockdlg.end')}</label>
      <div className={box(key, key === 'end' && errors.end !== undefined)}>
        <input id={`blk-${key}`} type="time" step={300} className="bw-field-input" value={form[key]} aria-description={dateText} {...track(key)}
          onChange={(e) => onChange({ ...form, [key]: e.target.value })} />
      </div>
      {key === 'end' && errors.end ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{t(errors.end)}</div> : null}
    </div>
  );
  return (
    <Dialog title={t(mode === 'add' ? 'board.blockdlg.add' : 'board.blockdlg.change')} closeCtl="CTL-OFC-31-06" onClose={onClose} screen="SCR-OFC-31" inline={inline ?? false}
      initialFocus={mode === 'add' ? '#blk-label' : '#blk-start'} foot={(
      <>
        {saving ? <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-31-06">{t('common.cancel')}</button>
          : <button type="button" className="btn" data-ctl="CTL-OFC-31-06" onClick={onClose}>{t('common.cancel')}</button>}
        {saving ? <Busy label={t('board.blockdlg.saving')} ctl="CTL-OFC-31-05" />
          : ready ? <button type="button" className="btn primary" data-ctl="CTL-OFC-31-05" onClick={onSave}>{label}</button>
            : <button type="button" className="btn dis primary" aria-disabled="true" data-ctl="CTL-OFC-31-05" onClick={onSave}>{label}</button>}
      </>
    )}>
      <div className="r1-field" data-ctl="CTL-OFC-31-01">
        <label htmlFor="blk-tech">{t('board.blockdlg.technician')}</label>
        <div className={box('tech', false, ' bw-overlay')}>
          {technicians.find((x) => x.id === form.technicianId)?.name ?? ''}
          <select id="blk-tech" {...track('tech')} value={form.technicianId} onChange={(e) => onChange({ ...form, technicianId: e.target.value })}>
            {technicians.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
      </div>
      <datalist id="blk-labels"><option value={t('board.blockdlg.suggestPickup')} /><option value={t('board.blockdlg.suggestSupply')} /></datalist>
      <div className="g2f">
        {field('label', 'CTL-OFC-31-02', 'board.blockdlg.labelPh', 'blk-labels')}
        {field('place', 'CTL-OFC-31-03', 'board.blockdlg.placePh')}
      </div>
      <div className="g2f" data-ctl="CTL-OFC-31-04">
        {time('start')}
        {time('end')}
      </div>
      {overlap ? <div className="r1-fmsg" role="alert"><Icon name="alert" />{overlap}</div> : null}
    </Dialog>
  );
}

/** SCR-OFC-33 (CTL-OFC-33-01 to 03): Cancel has the first focus (UIS.FR-FLOW-1). */
export function DeleteBlockDialog({ block, deleting, onConfirm, onClose, inline }: {
  block: BlockView; deleting: boolean; onConfirm: () => void; onClose: () => void; inline?: boolean;
}) {
  const t = useT();
  return (
    <Dialog title={t('board.delete.title')} closeCtl="CTL-OFC-33-03" onClose={onClose} screen="SCR-OFC-33" inline={inline ?? false} initialFocus='button[data-cancel="1"]' foot={(
      <>
        {deleting ? <button type="button" className="btn dis" aria-disabled="true" data-ctl="CTL-OFC-33-03">{t('common.cancel')}</button>
          : <button type="button" className="btn" data-ctl="CTL-OFC-33-03" data-cancel="1" onClick={onClose}>{t('common.cancel')}</button>}
        {deleting ? <Busy label={t('board.delete.busy')} ctl="CTL-OFC-33-02" cls="danger" />
          : <button type="button" className="btn danger" data-ctl="CTL-OFC-33-02" onClick={onConfirm}>{t('board.delete.confirm')}</button>}
      </>
    )}>
      <p data-ctl="CTL-OFC-33-01">{t('board.delete.message', { label: block.label, technician: block.technician, date: block.date, span: spanText(block.start, block.end) })}</p>
    </Dialog>
  );
}
