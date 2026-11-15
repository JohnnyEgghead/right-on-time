// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-47 Mark fixed (frame office-billing, DK-34, DK-95): the dialog over the billing list. Cancel has the first focus and Escape
// cancels (CTL-OFC-47-04); the Reason field (CTL-OFC-47-02) is required before Mark fixed (CTL-OFC-47-03) is on. The page's write call
// is the caller's: this draws the dialog and holds the typed reason.
import { useEffect, useRef } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { useModalFocus } from '../shell/modal-focus.ts';
import { Spinner } from './BillingBody.tsx';

export interface MarkFixedDialogProps {
  jobNumber: number;
  reason: string;
  saving: boolean;
  error: string | null;
  onReason: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

const MAX = 500;

export function MarkFixedDialog(p: MarkFixedDialogProps) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(box);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  const ready = p.reason.trim() !== '' && !p.saving;
  const title = t('billing.fix.title', { job: p.jobNumber });
  return (
    <div className="r1-scrim in">
      <div
        ref={box}
        className="r1-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-screen="SCR-OFC-47"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !p.saving) p.onCancel();
        }}
      >
        <div className="r1-dlg-h">
          <h2>{title}</h2>
          <button type="button" className="r1-x" aria-label={t('common.cancel')} data-ctl="CTL-OFC-47-04" disabled={p.saving} onClick={p.onCancel}>
            <i className="ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </i>
          </button>
        </div>
        <div className="r1-dlg-b">
          <p data-ctl="CTL-OFC-47-01">{`${title} ${t('billing.fix.msg')}`}</p>
          <div className="r1-field" data-ctl="CTL-OFC-47-02">
            <label htmlFor="bw-fix-reason">{t('billing.fix.reason')}</label>
            <input
              id="bw-fix-reason"
              className="r1-input bw-field-input"
              type="text"
              value={p.reason}
              maxLength={MAX}
              placeholder={t('billing.fix.placeholder')}
              disabled={p.saving}
              onChange={(e) => p.onReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ready) p.onConfirm();
              }}
            />
            {p.error ? (
              <div className="r1-fmsg" role="alert">
                <Icon name="alert" />
                {p.error}
              </div>
            ) : null}
          </div>
        </div>
        <div className="r1-dlg-f">
          <button ref={cancel} type="button" className={`btn${p.saving ? ' dis' : ''}`} aria-disabled={p.saving || undefined} data-ctl="CTL-OFC-47-04" onClick={() => !p.saving && p.onCancel()}>
            {t('common.cancel')}
          </button>
          {p.saving ? (
            <button type="button" className="btn busy primary" aria-busy="true" data-ctl="CTL-OFC-47-03">
              <Spinner />
              {t('billing.fix.saving')}
            </button>
          ) : (
            <button type="button" className={`btn primary${ready ? '' : ' dis'}`} aria-disabled={!ready || undefined} data-ctl="CTL-OFC-47-03" onClick={() => ready && p.onConfirm()}>
              {t('billing.fix.confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
