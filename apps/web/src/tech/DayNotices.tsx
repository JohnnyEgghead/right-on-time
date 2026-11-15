// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CTL-TEC-02-14 Day changed notice (UI-SPECIFICATION UD-43, OI-34): the in-app notice a re-read of the day raises when a job was added, moved
// away, canceled or given a new window ("Your day changed: job 24830 was added."). A visible toast and a polite live region, on every
// technician screen, because the phone compares the day wherever the technician is (data.ts). The Notifications switch on the Me screen
// governs only these: with it off data.ts raises none. No push service is used.
import { useEffect } from 'react';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import { TOAST_MS } from '../shell/Announcer.tsx';
import { Icon } from '../shell/Icon.tsx';
import { useT, type ClientT } from '../shell/intl.tsx';
import { techReads, type Notice, type TechData } from './data.ts';
import type { DayChange } from './model.ts';

const KEY: Record<DayChange['kind'], MessageKey> = {
  added: 'tech.notice.added',
  removed: 'tech.notice.removed',
  window: 'tech.notice.window',
};

export const noticeText = (t: ClientT, n: Pick<Notice, 'change' | 'n'>): string =>
  n.change ? t(KEY[n.change.kind], { job: n.change.job }) : t('tech.notice.several', { n: n.n });

/** The live region: always in the page; each notice shows for the toast's 6 seconds, then leaves. */
export function DayNotices({ data, fixed = false }: { data: Pick<TechData, 'notices'>; fixed?: boolean }) {
  const t = useT();
  const notices = data.notices;
  useEffect(() => {
    if (fixed || notices.length === 0) return;
    const timers = notices.map((n) => window.setTimeout(() => techReads().dismiss(n.id), TOAST_MS));
    return () => timers.forEach((h) => window.clearTimeout(h));
  }, [notices, fixed]);
  return (
    <div className="bw-tech-sent bw-tech-notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className="r1p-notice" role="status" data-ctl="CTL-TEC-02-14">
          <Icon name="bell" />
          <span>{noticeText(t, n)}</span>
        </div>
      ))}
    </div>
  );
}
