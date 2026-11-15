// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-10 Sync strip (UI-SPECIFICATION 3.10; FR-TECH-4, FR-TECH-7; frames: DK-111 mockups/pages/tech-offline.html, and
// the Today frames of DK-107 mockups/pages/tech-today.html), read from the page's item engine (useOutbox.ts):
//   CTL-CMP-10-01  No signal: DK-111 draws it as the strip under the header with the waiting count inside (.banner,
//                  NoSignalBanner); DK-107's Today frames draw it as a card in the list (.r1p-nosig, NoSignalCard). Each
//                  screen uses the one its own frame draws.
//   CTL-CMP-10-02  The waiting count, "3 waiting", or "All synced" at 0 (OA-70); opens SCR-TEC-09 (/tech/waiting).
//   CTL-CMP-10-03  The 24-hour banner, while any item has waited over 24 hours of the device's real time.
//   CTL-CMP-10-04  The sent announcement, a polite live region: each completed send ("3 items sent") and each item the
//                  office was told about (the server's message, UI-SPECIFICATION 4.5 rule 2).
// Every piece takes an optional fixed state (a preview's); the screens leave it unset.
import { fromWire, formatTime } from '@bw/time';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { TOAST_MS } from '../shell/Announcer.tsx';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import type { AnsweredItem } from '@bw/outbox/src/items/index.ts';
import type { OutboxState } from './engine.ts';
import { useOutbox } from './useOutbox.ts';

export const WAITING_HREF = '/tech/waiting';

/**
 * CTL-CMP-10-02 in a screen header. DK-111's job header draws a link with the clock icon while items wait and the cloud at
 * 0; DK-107's Today header draws a role-link span with the cloud in every state (variant "today"), in the header's color.
 */
export function WaitingCount({ fixed, variant = 'job' }: { fixed?: OutboxState; variant?: 'job' | 'today' }) {
  const t = useT();
  const router = useRouter();
  const s = useOutbox(fixed);
  const n = s.waiting.length;
  const words = n > 0 ? t('tech.sync.waiting', { n }) : t('tech.sync.allSynced');
  if (variant === 'today') {
    return (
      <span className="synct" role="link" tabIndex={0} data-ctl="CTL-CMP-10-02" data-waiting={n}
        onClick={() => router.push(WAITING_HREF)} onKeyDown={(e) => { if (e.key === 'Enter') router.push(WAITING_HREF); }}>
        <span className="sync">
          <Icon name="cloud" />
          {words}
        </span>
      </span>
    );
  }
  return (
    <a className="sync" href={WAITING_HREF} data-ctl="CTL-CMP-10-02" data-waiting={n}>
      <Icon name={n > 0 ? 'clock' : 'cloud'} />
      {words}
    </a>
  );
}

/** CTL-CMP-10-01 as DK-111 draws it: the strip under the header, the waiting count inside it while items wait. */
export function NoSignalBanner({ fixed }: { fixed?: OutboxState }) {
  const t = useT();
  const s = useOutbox(fixed);
  if (s.online) return null;
  const n = s.waiting.length;
  return (
    <div className="banner" role="status" data-ctl="CTL-CMP-10-01">
      <span className="bi"><Icon name="signal" sw={2.2} /></span>
      <div>
        <b>
          {t('tech.sync.noSignal')}
          {n > 0 ? <> <a className="bsync" href={WAITING_HREF} data-ctl="CTL-CMP-10-02" data-waiting={n}><Icon name="clock" />{t('tech.sync.waiting', { n })}</a></> : null}
        </b>
        <small>{t('tech.sync.keepWorking')}</small>
      </div>
    </div>
  );
}

/** CTL-CMP-10-01 as DK-107's Today frames draw it: a card in the list (the count stays in the header). */
export function NoSignalCard({ fixed }: { fixed?: OutboxState }) {
  const t = useT();
  const s = useOutbox(fixed);
  if (s.online) return null;
  return (
    <div className="r1p-nosig" role="status" data-ctl="CTL-CMP-10-01">
      <Icon name="signal" sw={2.2} />
      <span><b>{t('tech.sync.noSignal')}</b>{t('tech.sync.keepWorking')}</span>
    </div>
  );
}

/** CTL-CMP-10-03: shown while any item has waited over 24 hours of device real time; the demo clock never moves it (FR-TECH-7). */
export function OldItemsBanner({ fixed }: { fixed?: OutboxState }) {
  const t = useT();
  const s = useOutbox(fixed);
  const n = s.oldCount;
  if (n === 0) return null;
  return (
    <div className="r1p-old" role="status" data-ctl="CTL-CMP-10-03">
      <Icon name="alert" />
      <span>{t('tech.sync.old', { n })} <a href={WAITING_HREF}>{t('tech.sync.oldLink', { n })}</a></span>
    </div>
  );
}

/** The server's message for an answered item, with its wire times shown as the screens show times (UD-15). */
export function answerText(t: ClientT, a: AnsweredItem): string | null {
  if (!a.messageKey) return null;
  const values: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(a.values ?? {})) {
    if (v === null) continue;
    if (typeof v === 'string' && v.includes('[')) {
      try {
        const z = fromWire(v);
        values[k] = formatTime(z.toInstant(), z.timeZoneId, t.lang);
        continue;
      } catch {
        // not a wire time: shown as given
      }
    }
    values[k] = v;
  }
  return t(a.messageKey as MessageKey, values);
}

/** CTL-CMP-10-04: a polite live region, always in the page; each send's notices show for the toast's 6 seconds. */
export function SentAnnouncer({ fixed }: { fixed?: OutboxState }) {
  const t = useT();
  const s = useOutbox(fixed);
  const [shown, setShown] = useState<AnsweredItem[]>(fixed?.lastSent ?? []);
  useEffect(() => {
    if (fixed) return;
    setShown(s.lastSent);
    if (s.lastSent.length === 0) return;
    const h = window.setTimeout(() => setShown([]), TOAST_MS);
    return () => window.clearTimeout(h);
  }, [s.lastSent, fixed]);
  const told = shown.filter((a) => a.result === 'flagged' || a.result === 'world_reset' || a.result === 'history_only' || (a.result === 'duplicate' && a.messageKey));
  return (
    <div className="bw-tech-sent" aria-live="polite">
      {shown.length > 0 ? (
        <div className="r1p-notice ok" role="status" data-ctl="CTL-CMP-10-04">
          <Icon name="check" sw={2.6} />
          <span>{t('tech.sync.sent', { n: shown.length })}</span>
        </div>
      ) : null}
      {told.map((a) => (
        <div key={a.key} className="r1p-notice" role="status" data-ctl="CTL-CMP-10-04" data-result={a.result}>
          <Icon name="bell" />
          <span>{answerText(t, a)}</span>
        </div>
      ))}
    </div>
  );
}
