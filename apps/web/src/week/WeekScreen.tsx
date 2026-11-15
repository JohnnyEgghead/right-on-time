// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-34 Week board at `/office/board/week?branch&week` (UI-SPECIFICATION 2.3; FR-DISP-23, UC-15): reads API-132 for the
// shown branch and week, re-reads it in place on the events the screen lists (EVT-01, EVT-02, EVT-05, EVT-06, EVT-09, EVT-10) and,
// after each such re-read, posts API-172 once with the event's seq (OI-48, SD-43). The one write is the day's mode menu (CTL-OFC-34-15):
// it opens SCR-OFC-24 on this screen and switches the day with API-91; the grid re-reads on EVT-09 (F-781).
import { ApiError, boardDelaySample, boardWeek, bookingSettings, createClient, createResourceCache, readClock, setDayMode, subscribeEvents, type ResourceCache, type z } from '@bw/api';
import { formatTime, fromWire, type Language } from '@bw/time';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnnounce } from '../shell/Announcer.tsx';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useT } from '../shell/intl.tsx';
import type { LiveState } from '../shell/Panels.tsx';
import { useBranch } from '../shell/useBranch.ts';
import { postDelaySamples } from '../board/delay-samples.ts';
import { dayText as windowsDayText, switchBar, switchRefusal } from '../windows/model.ts';
import { SwitchDialog, type DialogUi } from '../windows/WindowsView.tsx';
import { WeekView, type WeekState } from './WeekView.tsx';
import { addDays, changedCells, eventIsForBranch, mondayOf, WEEK_EVENTS, weekParamMonday, type WeekData } from './week-model.ts';

type Settings = z.infer<typeof bookingSettings.response>;

export function WeekScreen() {
  const t = useT();
  const announce = useAnnounce();
  const params = useSearchParams();
  const branch = useBranch();
  const weekRaw = params.get('week');
  const weekParam = weekParamMonday(weekRaw);
  const dateParam = params.get('date') ?? weekRaw;
  const [week, setWeek] = useState<string | null>(weekParam);
  const [data, setData] = useState<WeekData | null>(null);
  const [state, setState] = useState<WeekState>('loading');
  const [live, setLive] = useState<LiveState>('reconnecting');
  const [liveTime, setLiveTime] = useState<string | null>(null);
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set());
  const client = useMemo(() => (typeof window === 'undefined' ? null : createClient({ baseUrl: window.location.origin })), []);
  const cache = useRef<ResourceCache | null>(null);
  if (client && !cache.current) cache.current = createResourceCache(client);
  const dataRef = useRef<WeekData | null>(null);
  const [switchDlg, setSwitchDlg] = useState<{ settings: Settings; dlg: DialogUi } | null>(null);

  // The week: the URL's, else the one that holds the demo clock's today (API-10, FR-DEMO-2).
  useEffect(() => {
    if (weekParam) {
      setWeek(weekParam);
      return;
    }
    if (!client) return;
    let alive = true;
    void client.call(readClock, {}).then((r) => {
      if (alive) setWeek(mondayOf(fromWire(r.data.demoNow).toPlainDate().toString()));
    }).catch(() => {
      if (alive) setState('error');
    });
    return () => {
      alive = false;
    };
  }, [weekParam, client]);

  const read = useCallback(async (): Promise<boolean> => {
    if (!client || !cache.current || !branch || !week) return false;
    try {
      const answer = await client.call(boardWeek, { branch, week });
      cache.current.seed(boardWeek, { branch, week }, answer.data, answer.envelope?.meta.worldEpoch ?? 0);
      setChanged(changedCells(dataRef.current, answer.data));
      dataRef.current = answer.data;
      setData(answer.data);
      setState(answer.data.technicians.length === 0 ? 'empty' : 'ready');
      const demo = answer.envelope?.meta.demoNow;
      if (demo) {
        const z = fromWire(demo);
        setLiveTime(formatTime(z.toInstant(), z.timeZoneId, t.lang as Language));
      }
      return true;
    } catch {
      setState('error');
      return false;
    }
  }, [client, branch, week, t.lang]);

  // The first read of a branch and week.
  useEffect(() => {
    if (!branch || !week) return;
    dataRef.current = null;
    setChanged(new Set());
    setState('loading');
    void read();
  }, [branch, week, read]);

  // The event stream: each event for this branch re-reads the week, and the finished re-read posts its seq (API-172).
  useEffect(() => {
    if (!client || !branch || !week) return;
    let pending: number[] = [];
    let running = false;
    const drain = async () => {
      if (running) return;
      running = true;
      while (pending.length > 0) {
        // 1 sample per seq the re-read covers (F-606), so a burst's slowest event is sampled.
        const seqs = pending;
        pending = [];
        if (await read()) {
          await postDelaySamples(seqs, (seq) => client.call(boardDelaySample, { seq }));
        }
      }
      running = false;
    };
    const handle = subscribeEvents({
      onEvent: (e) => {
        if (!WEEK_EVENTS.includes(e.name)) return;
        if (e.name === 'world.reset') cache.current?.observeEpoch(Number(e.ids.worldEpoch));
        else if (!eventIsForBranch(e, branch)) return;
        pending.push(e.seq);
        void drain();
      },
      onReconnect: () => void read(),
      onState: (s) => setLive(s === 'live' ? 'live' : s === 'closed' ? 'paused' : 'reconnecting'),
    });
    return () => handle.close();
  }, [client, branch, week, read]);

  // CTL-OFC-34-15 opens SCR-OFC-24 for the day (UI-SPECIFICATION CTL-OFC-34-15): API-90 for that 1 day gives the dialog its windows and its kept count.
  const openSwitch = useCallback(async (date: string) => {
    if (!client || !branch) return;
    try {
      const a = await client.call(bookingSettings, { branchId: branch, from: date, to: date });
      const day = a.data.days.find((d) => d.date === date);
      if (!day || switchBar(day, a.data.today) !== null) return;
      setSwitchDlg({ settings: a.data, dlg: { mode: day.mode === 'four_hour' ? 'two_hour' : 'four_hour', date, reason: '', touched: false, switching: false, message: null } });
    } catch {
      setState('error');
    }
  }, [client, branch]);
  const patchDlg = (p: Partial<DialogUi>) => setSwitchDlg((s) => (s ? { ...s, dlg: { ...s.dlg, ...p } } : s));
  const doSwitch = async () => {
    if (!client || !switchDlg || switchDlg.dlg.switching) return;
    const { settings, dlg } = switchDlg;
    if (dlg.mode === 'four_hour' && dlg.reason.trim() === '') {
      patchDlg({ touched: true });
      return;
    }
    patchDlg({ switching: true, message: null });
    try {
      await client.call(setDayMode, { branchId: settings.branch, date: dlg.date, mode: dlg.mode, ...(dlg.mode === 'four_hour' ? { reason: dlg.reason.trim() } : {}) });
      setSwitchDlg(null);
      announce(t(dlg.mode === 'four_hour' ? 'windows.toast.four' : 'windows.toast.two', { day: windowsDayText(t, dlg.date) }));
      await read();
    } catch (e) {
      patchDlg({ switching: false, message: t(switchRefusal(e instanceof ApiError ? e.problem.code : 'network')) });
    }
  };

  const shownWeek = week ?? '';
  const dayFrom = dateParam && week && dateParam >= week && dateParam <= addDays(week, 5) ? dateParam : shownWeek;
  return (
    <OfficeFrame screen="SCR-OFC-34">
      <WeekView
        state={week && branch ? state : 'loading'}
        data={data}
        branch={branch ?? 'columbus'}
        week={shownWeek}
        liveState={live}
        liveTime={liveTime}
        changed={changed}
        dayFrom={dayFrom}
        onRetry={read}
        onRefresh={() => void read()}
        onSwitchDay={(date) => void openSwitch(date)}
      />
      {switchDlg ? (
        <SwitchDialog
          data={switchDlg.settings}
          dlg={switchDlg.dlg}
          on={{
            onDialogReason: (text) => patchDlg({ reason: text, touched: true, message: null }),
            onCancel: () => setSwitchDlg(null),
            onSwitch: () => void doSwitch(),
          }}
        />
      ) : null}
    </OfficeFrame>
  );
}
