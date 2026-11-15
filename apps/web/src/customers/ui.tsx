// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The customer screens' shared pieces: the typed client call, the dialog shell (DK-34: role dialog, modal, Escape closes, Tab stays
// inside, focus returns to the control that opened it), a text field and a busy button.
import { ApiError, createClient, type ContractRow, type z } from '@bw/api';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { useModalFocus } from '../shell/modal-focus.ts';

const client = createClient({ baseUrl: '' });

export type CallOutcome<R extends z.ZodType> = { ok: true; data: z.output<R> } | { ok: false; code: string; status: number };

/** One call through the typed client; a Problem or a network failure is a value, never a throw. */
export async function call<Q extends z.ZodType, R extends z.ZodType>(row: ContractRow<Q, R>, input?: z.input<Q>): Promise<CallOutcome<R>> {
  try {
    return { ok: true, data: (await client.call(row, input)).data };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, code: e.problem.code, status: e.status };
    return { ok: false, code: 'network', status: 0 };
  }
}

export interface DialogProps {
  screen: string;
  title: string;
  closeCtl: string;
  onClose: () => void;
  /** Drawn inside its host (the look comparator's tiles) instead of over the page. */
  inline?: boolean;
  wide?: boolean;
  /** false when the dialog is drawn alone in a frame named for it (the page walkers' host-page rows): the frame carries the screen root. */
  hosted?: boolean;
  body: ReactNode;
  foot: ReactNode;
}

export function Dialog({ screen, title, closeCtl, onClose, inline, wide, hosted = true, body, foot }: DialogProps) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  // The first focus goes to the dialog's own initial control; the Tab ring and the focus return are useModalFocus's (F-1464), whose effect runs after this one.
  useEffect(() => {
    (root.current?.querySelector<HTMLElement>('[data-initial]') ?? root.current?.querySelector<HTMLElement>('.r1-dlg'))?.focus();
  }, []);
  useModalFocus(root);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className={inline ? 'r1-scrim in' : 'r1-scrim bw-modal'} onKeyDown={onKey} ref={root}>
      <div className={`r1-dlg${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} {...(hosted ? { 'data-screen': screen } : {})} tabIndex={-1}>
        <div className="r1-dlg-h">
          <h2>{title}</h2>
          <button type="button" className="r1-x" aria-label={t('customers.dialog.close')} data-ctl={closeCtl} onClick={onClose}>
            <i className="ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </i>
          </button>
        </div>
        <div className="r1-dlg-b">{body}</div>
        <div className="r1-dlg-f">{foot}</div>
      </div>
    </div>
  );
}

/** A busy primary button (the kit's Saving state): the spinner and the label, a repeated press ignored. */
export function Busy({ label, ctl, small }: { label: string; ctl: string; small?: boolean }) {
  return (
    <button type="button" className={`btn busy primary${small ? ' sm' : ''}`} aria-busy="true" data-ctl={ctl}>
      <span className="r1-spin" />
      {label}
    </button>
  );
}

export interface FieldProps {
  id: string;
  ctl?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  inputMode?: 'text' | 'tel' | 'numeric' | undefined;
  autoComplete?: string | undefined;
  hint?: string | undefined;
  /** The picked street's list, drawn under the field (CTL-OFC-38-03). */
  children?: ReactNode;
  /** CTL id of the control itself when the field's wrapper carries another (the street field is inside CTL-OFC-39-03). */
  initial?: boolean | undefined;
}

export function TextField(p: FieldProps) {
  const [focus, setFocus] = useState(false);
  return (
    <div className="r1-field" {...(p.ctl ? { 'data-ctl': p.ctl } : {})}>
      <label htmlFor={p.id}>{p.label}</label>
      <div className={`r1-input${p.error ? ' bad' : focus ? ' focus' : ''}`}>
        <input
          id={p.id} type="text" className="bw-field-input" value={p.value} disabled={p.disabled} placeholder={p.placeholder} spellCheck={false}
          inputMode={p.inputMode} autoComplete={p.autoComplete ?? 'off'} aria-invalid={p.error ? true : undefined}
          aria-describedby={p.error ? `${p.id}-msg` : p.hint ? `${p.id}-hint` : undefined} {...(p.initial ? { 'data-initial': true } : {})}
          onChange={(e) => p.onChange(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        />
      </div>
      {p.children}
      {p.error ? <div className="r1-fmsg" role="alert" id={`${p.id}-msg`}><Icon name="alert" />{p.error}</div> : null}
      {p.hint && !p.error ? <div className="r1-hint" id={`${p.id}-hint`}>{p.hint}</div> : null}
    </div>
  );
}

/** A native select inside the kit's input box: the box shows the picked word, the select lies over it. */
export function SelectField({ id, ctl, label, value, onChange, options, disabled }: {
  id: string; ctl: string; label: string; value: string; onChange: (v: string) => void; options: readonly { value: string; text: string }[]; disabled?: boolean;
}) {
  return (
    <div className="r1-field" data-ctl={ctl}>
      <label htmlFor={id}>{label}</label>
      <div className="r1-input bw-cu-select">
        <span>{options.find((o) => o.value === value)?.text ?? ''}</span>
        <select id={id} className="bw-cu-native" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
        </select>
        <Icon name="chevDown" />
      </div>
    </div>
  );
}
