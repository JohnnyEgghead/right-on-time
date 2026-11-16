// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-12 for the technician app's panels (F-1777): the shared panel's last-try time (CTL-CMP-12-01) and busy state (CTL-CMP-12-02, 4.1 Busy),
// in the markup each tech screen already draws, so the approved looks stay. A panel with no failed time yet draws no last-try words.
import { formatTime, Temporal } from '@bw/time';
import { useState, type ReactNode } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';

/** The wall time of a failed read, in the day's zone (the browser's own when no day is kept). */
export function lastTryOf(failedAt: number | null | undefined, zone: string | undefined, lang: 'en' | 'es'): string | undefined {
  if (failedAt === null || failedAt === undefined) return undefined;
  return formatTime(Temporal.Instant.fromEpochMilliseconds(failedAt), zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, lang);
}

export function TechErrorPanel({ title, hint, onRetry, lastTry, btn = 'btn sm', cmp = true }: {
  title: ReactNode; hint?: ReactNode; onRetry: () => Promise<unknown> | unknown; lastTry?: string | undefined; btn?: string; cmp?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div className="r1-errpanel" role="alert" data-ctl="CTL-CMP-12-01" {...(cmp ? { 'data-cmp': 'CMP-12' } : {})}>
      <Icon name="alert" />
      <div>
        <b>{title}</b>
        {hint}
        {lastTry ? <> {t('shell.error.lastTry', { time: lastTry })}</> : null}
        <br />
        <button
          type="button"
          className={btn}
          data-ctl="CTL-CMP-12-02"
          aria-busy={busy || undefined}
          onClick={async () => {
            if (busy) return; // 4.1 Busy: a repeated press is ignored
            setBusy(true);
            try {
              await onRetry();
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('shell.error.tryAgain')}
        </button>
      </div>
    </div>
  );
}
