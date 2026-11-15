// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-12 Admin: arrival windows at `/office/admin/windows?branch=<id>&date=<day>` (FR-BOOK-2, FR-BOOK-8, FR-BOOK-17, FR-BOOK-18, UC-13)
// with SCR-OFC-24 Switch a day's windows as its confirm dialog. Reads API-90, keeps it live (EVT-09 and the events that move a day's
// bookings: the page re-reads), and calls API-155 (Save changes) and API-91 (Switch). `?date=` picks a day (the week board's day-mode
// menu, CTL-OFC-34-15, links here, from any upcoming week: past the 2 calendar weeks the page reads that day too, F-748); `?switch=1` with
// it opens the confirm for that day at once, in the direction the day's mode asks.
import { ApiError, bookingSettings, createClient, setDayMode, setWindowLimits, subscribeEvents } from '@bw/api';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnnounce } from '../shell/Announcer.tsx';
import { branchById } from '../shell/branches.ts';
import { useT } from '../shell/intl.tsx';
import { confirmLeave, useLeaveGuard } from '../shell/leave-guard.ts';
import { useBranch } from '../shell/useBranch.ts';
import { dayText, draftOf, draftState, farDay, pickedOf, spanLabel, switchBar, switchRefusal } from './model.ts';
import { WindowsView, IDLE_UI, type WindowsState, type WindowsUi } from './WindowsView.tsx';

const LIVE_EVENTS = new Set(['settings.changed', 'job.changed', 'board.refresh', 'world.reset', 'clock.changed']);
/** A real YYYY-MM-DD from the address, or null: 2026-02-30 is no day, and API-90 is not asked for it. */
const asDate = (v: string | null): string | null => {
  if (v === null || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : null;
};

export function WindowsScreen() {
  const t = useT();
  const announce = useAnnounce();
  const router = useRouter();
  const params = useSearchParams();
  const client = useMemo(() => createClient({ baseUrl: typeof window === 'undefined' ? '' : window.location.origin }), []);
  const branch = useBranch();
  const [state, setState] = useState<WindowsState>({ kind: 'loading' });
  const [ui, setUi] = useState<WindowsUi>(IDLE_UI);
  const say = useRef({ t, announce });
  say.current = { t, announce };
  const live = useRef({ state, ui });
  live.current = { state, ui };
  const asked = asDate(params.get('date'));
  const askedDay = useRef(asked);
  askedDay.current = asked;
  const wantSwitch = params.get('switch') === '1';
  const opened = useRef(false);

  const load = useCallback(async (opts: { resetDraft?: boolean } = {}) => {
    if (branch === null) return;
    try {
      const a = await client.call(bookingSettings, { branchId: branch });
      // F-748: a failed read of the far day fails the load, as a failed read of the calendar does: the error state says so, never a silent today.
      const far = farDay(a.data.days, askedDay.current, a.data.today);
      const extra = far === null ? [] : (await client.call(bookingSettings, { branchId: branch, from: far, to: far })).data.days;
      const prev = live.current.state;
      setState({ kind: 'ready', data: { ...a.data, days: [...a.data.days, ...extra] } });
      // A re-read replaces the typed numbers only when none is being edited: a manager's typing survives another person's change.
      const dirty = opts.resetDraft !== true && prev.kind === 'ready' && draftState(prev.data.windows, live.current.ui.draft).changed;
      setUi((u) => ({ ...u, draft: dirty ? u.draft : draftOf(a.data.windows) }));
    } catch {
      setState((s) => (s.kind === 'ready' ? s : { kind: 'error' }));
    }
  }, [client, branch]);

  // A new branch is a new page: its own numbers, its own picked day.
  useEffect(() => {
    if (branch === null) return;
    opened.current = false;
    setState({ kind: 'loading' });
    setUi({ ...IDLE_UI, picked: asked });
    void load();
    // The address's date only seeds the pick of a freshly opened branch, so it is not a dependency.
  }, [branch, load]);

  useEffect(() => {
    if (branch === null) return;
    let timer: number | null = null;
    const handle = subscribeEvents({
      branch,
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
  }, [branch, load]);

  const dirty = state.kind === 'ready' && draftState(state.data.windows, ui.draft).changed;
  // F-752: 1 shared guard; the top bar's branch choice asks through it as the page's own tabs do.
  useLeaveGuard(dirty ? t('windows.leave') : null);

  // CTL-OFC-34-15: the week board's menu opens the confirm for the day it names, once, when the day can be switched.
  useEffect(() => {
    if (opened.current || !wantSwitch || state.kind !== 'ready' || asked === null) return;
    opened.current = true;
    const day = state.data.days.find((d) => d.date === asked);
    if (day && switchBar(day, state.data.today) === null) {
      setUi((u) => ({ ...u, picked: day.date, dialog: { mode: day.mode === 'four_hour' ? 'two_hour' : 'four_hour', date: day.date, reason: '', touched: false, switching: false, message: null } }));
    }
  }, [wantSwitch, state, asked]);

  const patch = (p: Partial<WindowsUi>) => setUi((u) => ({ ...u, ...p }));
  const ready = state.kind === 'ready' ? state.data : null;

  const onSave = async () => {
    if (!ready || ui.saving) return;
    const d = draftState(ready.windows, ui.draft);
    if (!d.canSave) return;
    patch({ saving: true, refused: null, saveMessage: null });
    try {
      await client.call(setWindowLimits, { branchId: ready.branch, limits: d.limits });
      await load({ resetDraft: true });
      patch({ saving: false });
      say.current.announce(say.current.t('windows.saved'));
    } catch (e) {
      if (e instanceof ApiError && e.problem.code === 'capacity_below_bookings') {
        const p = e.problem as unknown as { windowId: string; start: string; end: string; date: string; bookings: number };
        patch({
          saving: false,
          refused: {
            windowId: p.windowId,
            text: say.current.t('windows.refused', {
              branch: branchById(ready.branch).name, window: spanLabel(p), bookings: p.bookings, day: dayText(say.current.t, p.date),
            }),
          },
        });
      } else {
        patch({ saving: false, saveMessage: say.current.t('windows.save.failed') });
      }
    }
  };

  const onSwitch = async () => {
    const dlg = ui.dialog;
    if (!ready || !dlg || dlg.switching) return;
    if (dlg.mode === 'four_hour' && dlg.reason.trim() === '') {
      patch({ dialog: { ...dlg, touched: true } });
      return;
    }
    patch({ dialog: { ...dlg, switching: true, message: null } });
    try {
      await client.call(setDayMode, { branchId: ready.branch, date: dlg.date, mode: dlg.mode, ...(dlg.mode === 'four_hour' ? { reason: dlg.reason.trim() } : {}) });
      patch({ dialog: null, reason: '' });
      say.current.announce(say.current.t(dlg.mode === 'four_hour' ? 'windows.toast.four' : 'windows.toast.two', { day: dayText(say.current.t, dlg.date) }));
      await load();
    } catch (e) {
      const code = e instanceof ApiError ? e.problem.code : 'network';
      patch({ dialog: { ...dlg, switching: false, message: say.current.t(switchRefusal(code)) } });
      void load();
    }
  };

  return (
    <WindowsView
      state={state}
      ui={ui}
      branch={branch ?? 'columbus'}
      on={{
        onBranch: (id) => {
          if (!confirmLeave()) return;
          router.push(`/office/admin/windows?branch=${encodeURIComponent(id)}`);
        },
        onLimit: (windowId, text) => setUi((u) => ({ ...u, draft: { ...u.draft, [windowId]: text }, refused: u.refused?.windowId === windowId ? null : u.refused, saveMessage: null })),
        onSave: () => void onSave(),
        onDiscard: () => ready && patch({ draft: draftOf(ready.windows), refused: null, saveMessage: null }),
        onPick: (date) => patch({ picked: date }),
        onReason: (text) => patch({ reason: text }),
        onAsk: (mode) => {
          const day = ready ? pickedOf(ready.days, ui.picked, ready.today) : null;
          if (day) patch({ dialog: { mode, date: day.date, reason: mode === 'four_hour' ? ui.reason : '', touched: false, switching: false, message: null } });
        },
        onDialogReason: (text) => setUi((u) => (u.dialog ? { ...u, dialog: { ...u.dialog, reason: text, touched: true, message: null } } : u)),
        onCancel: () => patch({ dialog: null }),
        onSwitch: () => void onSwitch(),
        onRetry: () => load(),
      }}
    />
  );
}
