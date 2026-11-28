// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-16 Admin: system health at `/office/admin/health` (FR-HLTH-1 to FR-HLTH-4, FR-TEXT-16; UC-06): reads API-70, keeps it live (EVT-03,
// EVT-04, EVT-07, EVT-09: the page re-reads), and calls API-160 Check now, API-161 the alert switches and API-71 the text simulator. The customer
// field of "Fail sends to this customer" searches with API-130 (the top bar's search; the customers page's own search, API-34, is a different read).
import { ApiError, checkNow, createClient, dismissAlert, search, setAlertSwitch, setTextSimulator, subscribeEvents, systemHealth } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openAlertEmail } from '../shell/alert-email.ts';
import { useAnnounce } from '../shell/Announcer.tsx';
import { useT } from '../shell/intl.tsx';
import { useKeyedInFlight } from '../shell/in-flight.ts';
import { useNewestAnswer } from '../shell/newest-answer.ts';
import { useBranch } from '../shell/useBranch.ts';
import { HealthView, IDLE_UI, type HealthState, type HealthUi } from './HealthView.tsx';
import { applyInput, type Health, type Picked, type SimMode } from './model.ts';

// F-1156: alert.dismissed (any close of an open alert, SD-30) re-reads, so an alert closed in another tab shows Resolved here.
const LIVE_EVENTS = new Set(['text.changed', 'alert.created', 'alert.dismissed', 'billing.changed', 'settings.changed']);

/** The pick that matches what is in force, so Apply starts disabled (CTL-OFC-16-02). */
const pickOf = (s: Health['textSimulator']): Picked => ({ mode: s.mode, customerId: s.customerId, n: s.nLeft === null ? '' : String(s.nLeft) });

export function HealthScreen() {
  const t = useT();
  const announce = useAnnounce();
  const client = useMemo(() => createClient({ baseUrl: typeof window === 'undefined' ? '' : window.location.origin }), []);
  const branch = useBranch();
  const [state, setState] = useState<HealthState>({ kind: 'loading' });
  const [ui, setUi] = useState<HealthUi>(IDLE_UI);
  const say = useRef({ t, announce });
  say.current = { t, announce };
  const picked = useRef(false);

  const newest = useNewestAnswer();
  // K-05: events, a change made here and the first read all read; the newest read's answer is the one shown, however late an earlier one lands.
  const load = useCallback(async () => {
    await newest.run(() => client.call(systemHealth, {}).then((answer) => answer, () => null), (answer) => {
      if (answer === null) {
        setState((s) => (s.kind === 'ready' ? s : { kind: 'error' }));
        return;
      }
      setState({ kind: 'ready', data: answer.data });
      // The first landing sets the pick to what is in force; a later re-read keeps a pick the manager is making.
      if (!picked.current) {
        picked.current = true;
        setUi((u) => ({ ...u, pick: pickOf(answer.data.textSimulator), customerText: answer.data.textSimulator.customerName ?? '' }));
      }
    });
  }, [client, newest]);

  useEffect(() => {
    void load();
  }, [load]);

  // API-70 answers for the caller's own branch whatever the top bar shows, so the page follows that branch's events (F-663).
  const answerBranch = state.kind === 'ready' ? state.data.branch : null;
  useEffect(() => {
    if (answerBranch === null) return;
    let timer: number | null = null;
    const handle = subscribeEvents({
      branch: answerBranch,
      onEvent: (e) => {
        if (!LIVE_EVENTS.has(e.name)) return;
        if (timer === null) timer = window.setTimeout(() => { timer = null; void load(); }, 150);
      },
      onReconnect: () => void load(),
    });
    return () => {
      handle.close();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [answerBranch, load]);

  const patch = (p: Partial<HealthUi>) => setUi((u) => ({ ...u, ...p }));
  const lastQuery = useRef('');

  const onCheck = async () => {
    if (ui.checking) return;
    patch({ checking: true, message: null });
    try {
      await client.call(checkNow, {});
      await load();
      patch({ checking: false });
    } catch {
      patch({ checking: false, message: { where: 'check', text: say.current.t('health.checkFailed') } });
    }
  };

  const onApply = async () => {
    const a = applyInput(ui.pick);
    if (!a.ok) {
      patch({ fieldMsg: a.field });
      return;
    }
    patch({ applying: true, message: null, fieldMsg: null });
    try {
      const r = await client.call(setTextSimulator, a.body);
      await load();
      const s = r.data.textSimulator;
      const word = s.mode === 'fail_customer' ? say.current.t('health.sim.now.fail_customer', { customer: s.customerName ?? '' }) : s.mode === 'fail_next_n' ? say.current.t('health.sim.now.fail_next_n', { n: s.nLeft ?? 0 }) : say.current.t(`health.sim.mode.${s.mode}` as MessageKey);
      say.current.announce(say.current.t('health.sim.applied', { mode: word }));
      patch({ applying: false, pick: pickOf(s) });
    } catch (e) {
      const field = e instanceof ApiError && e.problem.code === 'validation_failed' ? (ui.pick.mode === 'fail_customer' ? 'customer' : 'n') : null;
      patch({ applying: false, fieldMsg: field, message: field ? null : { where: 'apply', text: say.current.t('health.sim.failed') } });
    }
  };

  // K-01: 1 write per press-run, per control (F-2079). A press on a switch or a Dismiss row whose own write is in flight does nothing; a press on
  // another row goes on. A control lets go when its answer and the re-read have landed, so it shows the saved position (a switch) or no button (a
  // Dismiss) before the next press (F-2077, F-2084). A held control shows its busy look (`ui.busy`).
  const guard = useKeyedInFlight();
  const onSwitch = async (type: string, which: 'bell' | 'managersEmail', value: boolean) => {
    const key = `switch:${type}:${which}`;
    if (!guard.begin(key)) return;
    try {
      patch({ message: null });
      try {
        await client.call(setAlertSwitch, { alertType: type, [which]: value });
      } catch {
        patch({ message: { where: 'switch', text: say.current.t('health.alerts.notSaved') } });
      }
      // The switch shows the saved position: after a failure the read returns it to where it was.
      await load();
    } finally {
      guard.end(key);
    }
  };

  /** API-176 (CTL-OFC-16-28): Dismiss; the list re-reads either way, and a refusal says the alert can no longer be dismissed (CMP-11). */
  const onDismiss = async (alertId: string) => {
    const key = `dismiss:${alertId}`;
    if (!guard.begin(key)) return;
    try {
      let ok = true;
      try {
        await client.call(dismissAlert, { alertId });
      } catch {
        ok = false;
      }
      await load();
      say.current.announce(say.current.t(ok ? 'health.alerts.dismissed' : 'health.alerts.dismissRefused'), ok ? 'check' : 'alert');
    } finally {
      guard.end(key);
    }
  };

  const onCustomerText = (text: string) => {
    patch({ customerText: text, pick: { ...ui.pick, customerId: null }, fieldMsg: null });
    lastQuery.current = text;
    if (text.trim().length < 2 || branch === null) {
      patch({ matches: [] });
      return;
    }
    void client.call(search, { query: text.trim(), branch }).then(
      (r) => {
        if (lastQuery.current === text) patch({ matches: r.data.customers.slice(0, 6).map((c) => ({ id: c.id, name: c.name })) });
      },
      () => patch({ matches: [] }),
    );
  };

  return (
    <HealthView
      state={state}
      ui={{ ...ui, busy: guard.busy }}
      on={{
        onCheck: () => void onCheck(),
        onRetry: () => load(),
        onPickMode: (mode: SimMode) => patch({ pick: { ...ui.pick, mode }, fieldMsg: null }),
        onCustomerText,
        onPickCustomer: (c) => patch({ pick: { ...ui.pick, customerId: c.id }, customerText: c.name, matches: [], fieldMsg: null }),
        onN: (n) => patch({ pick: { ...ui.pick, n }, fieldMsg: null }),
        onApply: () => void onApply(),
        onTable: () => patch({ delayAsTable: !ui.delayAsTable }),
        onShow: (show) => patch({ show }),
        onSwitch: (type, which, value) => void onSwitch(type, which, value),
        onEmail: (alertId) => void openAlertEmail(alertId, () => void load()),
        onDismiss: (alertId) => void onDismiss(alertId),
      }}
    />
  );
}
