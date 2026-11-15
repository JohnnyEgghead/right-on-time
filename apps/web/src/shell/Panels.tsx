// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-12 error panel (CTL-CMP-12-01, CTL-CMP-12-02; DK-28), CMP-13 live updates indicator (CTL-CMP-13-01, CTL-CMP-13-02;
// DK-38), CMP-06 status label (DK-11, word plus color, never color alone: the word is the accessible name).
import type { MessageKey } from '@bw/i18n';
import { useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { useT } from './intl.tsx';

/** CMP-12: replaces a region whose read failed. `title` and `hint` are the region's own catalog text. */
export function ErrorPanel({ title, hint, onRetry, lastTry }: { title: ReactNode; hint: ReactNode; onRetry: () => Promise<unknown> | unknown; lastTry?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div className="r1-errpanel" role="alert" data-ctl="CTL-CMP-12-01" data-cmp="CMP-12">
      <Icon name="alert" />
      <div>
        <b>{title}</b>
        {hint}
        {lastTry ? <> {t('shell.error.lastTry', { time: lastTry })}</> : null}
        <br />
        <button
          type="button"
          className="btn sm"
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

export type LiveState = 'live' | 'reconnecting' | 'paused';

/** CMP-13: the event stream state; Refresh shows only while paused. */
export function LiveIndicator({ state, onRefresh }: { state: LiveState; onRefresh?: () => void }) {
  const t = useT();
  const key: MessageKey = state === 'live' ? 'shell.live.live' : state === 'reconnecting' ? 'shell.live.reconnecting' : 'shell.live.paused';
  return (
    <span className="bw-live" data-cmp="CMP-13">
      <span className={state === 'live' ? 'r1-live' : `r1-live ${state}`} data-ctl="CTL-CMP-13-01" role="status">
        {t(key)}
      </span>
      {state === 'paused' ? (
        <>
          {' '}
          <button type="button" className="btn sm" data-ctl="CTL-CMP-13-02" onClick={onRefresh}>
            <Icon name="refresh" />
            {t('shell.live.refresh')}
          </button>
        </>
      ) : null}
    </span>
  );
}

/** CMP-06 vocabulary shipped with the shell: job status, job timing and clock (section 3.6). Each domain's lane adds its own. */
export const STATUS = {
  unassigned: { key: 'status.job.unassigned', chip: 'unas' },
  scheduled: { key: 'status.job.scheduled', chip: 'sched' },
  on_the_way: { key: 'status.job.onTheWay', chip: 'way' },
  on_site: { key: 'status.job.onSite', chip: 'site' },
  done: { key: 'status.job.done', chip: 'done' },
  no_one_home: { key: 'status.job.noOneHome', chip: 'risk' },
  canceled: { key: 'status.job.canceled', chip: 'sched' },
  at_risk: { key: 'status.timing.atRisk', chip: 'risk' },
  late: { key: 'status.timing.late', chip: 'late' },
  running: { key: 'status.clock.running', chip: 'site' },
  paused: { key: 'status.clock.paused', chip: 'risk' },
  catching_up: { key: 'status.clock.catchingUp', chip: 'way' },
} as const satisfies Record<string, { key: MessageKey; chip: string }>;

export type StatusWord = keyof typeof STATUS;

export function StatusLabel({ status }: { status: StatusWord }) {
  const t = useT();
  const s = STATUS[status];
  return (
    <span className={`chip ${s.chip}`} data-cmp="CMP-06">
      <span className="dot" aria-hidden="true" />
      {t(s.key)}
    </span>
  );
}
