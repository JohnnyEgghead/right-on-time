// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The confirm sheets on Today (DK-109 mockups/pages/tech-on-my-way-confirm.html): SCR-TEC-03 On my way, SCR-TEC-13 Arrived and
// SCR-TEC-14 No one home. Cancel holds the first focus and saves nothing; the primary button saves the item on the phone at
// once (the page's item engine) and sends it when online. Only Send makes the on-the-way text (FR-TECH-2).
import { fromWire, formatTime } from '@bw/time';
import { useEffect, useRef } from 'react';
import { windowWords as windowLabel } from '../../inbox/api.ts';
import { Icon } from '../../shell/Icon.tsx';
import type { IconName } from '../../shell/icon-paths.ts';
import { useT } from '../../shell/intl.tsx';
import { useModalFocus } from '../../shell/modal-focus.ts';
import { firstName, PREVIEW_LINK, type LocalJob } from './model.ts';
import { press, type SheetKind } from './TodayView.tsx';

export const SHEET_SCREEN: Record<SheetKind, string> = { omw: 'SCR-TEC-03', arrived: 'SCR-TEC-13', noh: 'SCR-TEC-14' };

interface Spec {
  title: string;
  msgCtl: string;
  cancel: string;
  go: string;
  icon?: IconName;
  label: string;
  teal: boolean;
  fine: string;
}

export function ConfirmSheet({ kind, job, zone, online, onCancel, onConfirm }: { kind: SheetKind; job: LocalJob; zone: string; online: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  const cancelRef = useRef<HTMLSpanElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(sheetRef);
  useEffect(() => {
    cancelRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onCancel]);
  const name = job.customer.name;
  const first = firstName(name);
  const preview = job.onMyWayPreview;
  const spec: Spec = kind === 'omw'
    ? { title: t('tech.omw.title', { name: first }), msgCtl: 'CTL-TEC-03-01', cancel: 'CTL-TEC-03-03', go: 'CTL-TEC-03-02', icon: 'send', label: t('tech.omw.send'), teal: false, fine: t('tech.omw.fine') }
    : kind === 'arrived'
      ? { title: t('tech.arrived.title', { name }), msgCtl: 'CTL-TEC-13-01', cancel: 'CTL-TEC-13-03', go: 'CTL-TEC-13-02', icon: 'pin', label: t('tech.today.arrived'), teal: true, fine: t('tech.arrived.fine') }
      : { title: t('tech.noh.title', { name }), msgCtl: 'CTL-TEC-14-01', cancel: 'CTL-TEC-14-03', go: 'CTL-TEC-14-02', label: t('tech.today.noOneHome'), teal: true, fine: t('tech.noh.fine') };
  const lang = t(job.customer.language === 'es' ? 'language.name.es' : 'language.name.en');
  const arrival = preview ? fromWire(preview.arrival).toInstant() : null;
  const inside = preview ? preview.arrival >= job.window.start && preview.arrival <= job.window.end : null;
  const win = windowLabel(job.window.start, job.window.end);
  const bubble = preview?.text.split(PREVIEW_LINK) ?? [];
  return (
    <div className="bw-sheet-host" data-dialog={SHEET_SCREEN[kind]}>
      <div className="dim" onClick={onCancel} />
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-label={spec.title}>
        <div className="grab" />
        <h2 data-ctl={spec.msgCtl}>{spec.title}</h2>
        {kind === 'omw' && online && preview && arrival ? (
          <>
            <div className="eta" data-ctl="CTL-TEC-03-05">
              <Icon name="truck" sw={2.1} />
              <div><b>{t('tech.omw.arriving', { time: formatTime(arrival, zone, t.lang) })}</b><small>{t(inside ? 'tech.omw.inside' : 'tech.omw.outside', { window: win })}</small></div>
            </div>
            <div data-ctl="CTL-TEC-03-04">
              <div className="lab"><Icon name="message" />{t('tech.omw.gets', { name: first })}<span className="lang">{t('tech.omw.language', { language: lang })}</span></div>
              <div className="bubble">{bubble[0]}<u translate="no">{PREVIEW_LINK}</u>{bubble[1]}</div>
            </div>
            <div className="priv"><Icon name="lock" /><div>{t('tech.omw.priv', { name: first })}</div></div>
          </>
        ) : null}
        {kind === 'omw' && !(online && preview) ? <div className="msg">{t('tech.omw.msg', { name: first, language: lang })}</div> : null}
        {kind === 'omw' && !online ? <div className="nosigl" data-ctl={spec.msgCtl}><Icon name="signal" /><div>{t('tech.omw.offline')}</div></div> : null}
        {kind === 'arrived' ? <div className="msg">{t('tech.arrived.msg', { name: first })}</div> : null}
        {kind === 'noh' ? <div className="msg">{t('tech.noh.msg', { name: first })}</div> : null}
        {kind === 'noh' && !online ? <div className="nosigl" data-ctl={spec.msgCtl}><Icon name="signal" /><div>{t('tech.noh.offline')}</div></div> : null}
        <div className="btns">
          <span className="cancel" ref={cancelRef} role="button" tabIndex={0} data-ctl={spec.cancel} {...press(onCancel)}>{t('common.cancel')}</span>
          <span className={`send${spec.teal ? ' teal' : ''}`} role="button" tabIndex={0} data-ctl={spec.go} {...press(onConfirm)}>
            {spec.icon ? <Icon name={spec.icon} /> : null}
            {spec.label}
          </span>
        </div>
        <div className="fine">{spec.fine}</div>
      </div>
    </div>
  );
}
