// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-16 Admin: system health at `/office/admin/health` (FR-HLTH-1 to FR-HLTH-4, FR-TEXT-16; UC-06): reads API-70, keeps it live (EVT-03,
// EVT-04, EVT-07, EVT-09: the page re-reads), and calls API-160 Check now, API-161 the alert switches and API-71 the text simulator. The customer
// field of "Fail sends to this customer" searches with API-130 (the customer search, API-34, is not built yet).
import { ApiError, checkNow, createClient, dismissAlert, search, setAlertSwitch, setTextSimulator, subscribeEvents, systemHealth } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openAlertEmail } from '../shell/alert-email.ts';
import { useAnnounce } from '../shell/Announcer.tsx';
import { useT } from '../shell/intl.tsx';
import { useBranch } from '../shell/useBranch.ts';
import { HealthView, IDLE_UI, type HealthState, type HealthUi } from './HealthView.tsx';
import { applyInput, type Health, type Picked, type SimMode } from './model.ts';

const LIVE_EVENTS = new Set(['text.changed', 'alert.created', 'billing.changed', 'settings.changed']);

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

  const load = useCallback(async () => {
    try {
      const answer = await client.call(systemHealth, {});
      setState({ kind: 'ready', data: answer.data });
      // The first landing sets the pick to what is in force; a later re-read keeps a pick the manager is making.
      if (!picked.current) {
        picked.current = true;
        setUi((u) => ({ ...u, pick: pickOf(answer.data.textSimulator), customerText: answer.data.textSimulator.customerName ?? '' }));
      }
    } catch {
      setState((s) => (s.kind === 'ready' ? s : { kind: 'error' }));
    }
  }, [client]);

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

  const onSwitch = async (type: string, which: 'bell' | 'managersEmail', value: boolean) => {
    patch({ message: null });
    try {
      await client.call(setAlertSwitch, { alertType: type, [which]: value });
    } catch {
      patch({ message: { where: 'switch', text: say.current.t('health.alerts.notSaved') } });
    }
    // The switch shows the saved position: after a failure the read returns it to where it was.
    await load();
  };

  /** API-176 (CTL-OFC-16-28): Dismiss; the list re-reads either way, and a refusal says the alert can no longer be dismissed (CMP-11). */
  const onDismiss = async (alertId: string) => {
    let ok = true;
    try {
      await client.call(dismissAlert, { alertId });
    } catch {
      ok = false;
    }
    await load();
    say.current.announce(say.current.t(ok ? 'health.alerts.dismissed' : 'health.alerts.dismissRefused'), ok ? 'check' : 'alert');
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
      ui={ui}
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
