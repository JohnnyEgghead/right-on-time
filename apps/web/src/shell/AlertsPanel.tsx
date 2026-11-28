// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-28 Office alerts (frame mockups/pages/office-board.html, "SCR-OFC-28 Office alerts: ..."; UI-SPECIFICATION 2.3) and the bell's
// count (CTL-CMP-07-06; FR-DISP-12): the list the notification bell opens, today's alerts of the types whose bell switch is on, newest
// first (API-43). `useBell` keeps the count current from EVT-04 alert.created and alert.dismissed and the alert_settings notice of EVT-09, and announces a
// new alert. The panel is the top bar's: every office page has it.
import './css/alerts.ts';
import { subscribeEvents } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clockText } from '../billing/format.ts';
import { openAlertEmail } from './alert-email.ts';
import { alertOpenLabel, alertText } from './alert-words.ts';
import { createBellSeen } from './bell-seen.ts';
import { createKeyedInFlight } from './in-flight.ts';
import { useAnnounce } from './Announcer.tsx';
import { useT } from './intl.tsx';
import type { Reader } from './reads.ts';

export interface BellAlert {
  id: string;
  at: string;
  type: string;
  state: 'open' | 'resolved' | 'info';
  messageKey: string;
  messageValues: Record<string, string | number>;
  link: string;
  emailed: boolean;
  emailWaiting: boolean;
  emailOpened: boolean;
  /** An open text-gave-up alert for an office text about no visit (SD-30): it offers Dismiss (API-176, CTL-OFC-28-05). */
  dismissible: boolean;
}

export type PanelState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; alerts: BellAlert[]; fresh?: string };

/** The panel's rows: time and sentence, the link named for its target, and the manager's email link or its used note. `onEmail`: the click (API-174). */
export function AlertsPanelView({ state, onClose, onEmail, onDismiss, manager = false, inline = false }: { state: PanelState; onClose?: () => void; onEmail?: (alertId: string) => void; onDismiss?: (alertId: string) => void; manager?: boolean; inline?: boolean }) {
  const t = useT();
  const count = state.kind === 'ready' && state.alerts.length > 0 ? state.alerts.length : null;
  return (
    <div className={inline ? 'r1-alerts in' : 'r1-alerts'} role="dialog" aria-label={t('bell.label')} data-cmp="SCR-OFC-28">
      <div className="ah2">
        <h2>{t('bell.title')}</h2>
        {count !== null ? <span className="chip neutral">{count}</span> : null}
        <button type="button" className="btn sm ghost" data-ctl="CTL-OFC-28-03" onClick={onClose}>
          {t('bell.close')}
        </button>
      </div>
      {state.kind === 'loading' ? (
        <div className="bw-alerts-skel" role="status" aria-label={t('health.loading')}>
          <span className="r1-skel" />
          <span className="r1-skel" />
          <span className="r1-skel" />
        </div>
      ) : state.kind === 'error' ? (
        <p className="r1-note bw-alerts-note" role="alert" data-ctl="CTL-OFC-28-01">
          {t('bell.error')}
        </p>
      ) : state.alerts.length === 0 ? (
        <p className="r1-note bw-alerts-note" data-ctl="CTL-OFC-28-01">
          {t('bell.empty')}
        </p>
      ) : (
        <ul data-ctl="CTL-OFC-28-01">
          {state.alerts.map((a) => (
            <li key={a.id} className={state.fresh === a.id ? 'new' : undefined}>
              <time>{clockText(a.at, t.lang)}</time>
              {alertText(t, a)}
              {a.state === 'resolved' ? (
                <>
                  {' '}
                  <span className="chip done">
                    <span className="dot" />
                    {t('health.alerts.resolved')}
                  </span>
                </>
              ) : null}
              <br />
              <a href={a.link} data-ctl="CTL-OFC-28-02">
                {alertOpenLabel(t, a)}
              </a>
              {manager && a.emailWaiting ? (
                <a href="#" role="button" data-ctl="CTL-OFC-28-04" onClick={(ev) => (ev.preventDefault(), onEmail?.(a.id))}>
                  {t('health.alerts.email')}
                </a>
              ) : null}
              {manager && a.emailOpened ? (
                <span className="used" data-ctl="CTL-OFC-28-04">
                  {t('health.alerts.emailUsed')}
                </span>
              ) : null}
              {a.dismissible && a.state === 'open' ? (
                <button type="button" className="btn sm" data-ctl="CTL-OFC-28-05" onClick={() => onDismiss?.(a.id)}>
                  {t('health.alerts.dismiss')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface Bell {
  /** The count of today's alerts; null until the first read lands, or when it failed (the bell then shows no count). */
  count: number | null;
  open: boolean;
  state: PanelState;
  toggle: () => void;
  close: () => void;
  /** Open this manager's copy of an alert's email (F-660). */
  email: (alertId: string) => void;
  /** Dismiss an alert (API-176, CTL-OFC-28-05): the list re-reads and the screen reader hears the result (CMP-11). */
  dismiss: (alertId: string) => void;
}

/**
 * The live bell of a top bar. `enabled` false (a preview, a page with a fixed count, a branch not known yet) reads nothing and subscribes
 * to nothing. Its events come through the tab's 1 connection (F-710), for the top bar's branch.
 */
export function useBell({ enabled, branch, reader }: { enabled: boolean; branch: string; reader: () => Reader }): Bell {
  const t = useT();
  const announce = useAnnounce();
  const [alerts, setAlerts] = useState<BellAlert[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const words = useRef({ t, announce });
  words.current = { t, announce };
  const seen = useRef(createBellSeen<BellAlert>());

  const load = useCallback(
    async (announceNew: boolean) => {
      // F-1809: the announcement is owed while an alert.created read is out, and whichever read lands with the new alert pays it.
      const land = seen.current.begin(announceNew);
      const r = await reader().read<{ alerts: BellAlert[] }>('API-43', { branch });
      if (!r.ok) {
        land(null);
        setFailed(true);
        return;
      }
      const next = r.data.alerts;
      const { added, announce: say, stale } = land(next);
      if (stale) return; // F-1812: an answer for another world, or older than the list drawn, draws nothing
      setFailed(false);
      if (added) {
        setFresh(added.id);
        if (say) {
          const w = words.current;
          w.announce(w.t('bell.new' as MessageKey, { text: alertText(w.t, added) }), 'alert');
        }
      }
      setAlerts(next);
    },
    [reader, branch],
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return;
    seen.current.reset();
    setAlerts(null);
    void loadRef.current(false);
    const handle = subscribeEvents({
      branch,
      onEvent: (e) => {
        const settings = e.name === 'settings.changed' && e.ids['kind'] === 'alert_settings';
        // F-1156: alert.dismissed (any close, SD-30) re-reads too, so an alert closed in another tab shows Resolved here; no announcement.
        if (e.name === 'alert.created' || e.name === 'alert.dismissed' || settings) void loadRef.current(e.name === 'alert.created');
      },
      onReconnect: () => void loadRef.current(false),
    });
    return () => handle.close();
  }, [enabled, branch]);

  const toggle = () => {
    if (!open) void loadRef.current(false);
    setOpen((o) => !o);
  };
  const state: PanelState = failed && alerts === null ? { kind: 'error' } : alerts === null ? { kind: 'loading' } : { kind: 'ready', alerts, ...(fresh ? { fresh } : {}) };
  const email = (alertId: string) => void openAlertEmail(alertId, () => void loadRef.current(false), reader());
  // F-2077, F-2084: 1 Dismiss per alert for as long as its button can be pressed. A 2nd press sends no 2nd API-176 (it would answer 409 and the person
  // would hear "dismissed", then "refused"). The guard holds across the re-read that removes the button and ends after it, or when the write fails.
  const dismissing = useRef(createKeyedInFlight());
  const dismiss = (alertId: string) => {
    if (!dismissing.current.begin(alertId)) return;
    void (async () => {
      try {
        const r = await reader().read('API-176', { alertId });
        await loadRef.current(false);
        const w = words.current;
        w.announce(w.t(r.ok ? 'health.alerts.dismissed' : 'health.alerts.dismissRefused'), r.ok ? 'check' : 'alert');
      } finally {
        dismissing.current.end(alertId);
      }
    })();
  };
  return { count: alerts === null ? null : alerts.length, open, state, toggle, close: () => setOpen(false), email, dismiss };
}
