// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-02 Today, live (UI-SPECIFICATION 8; FR-TECH-1, FR-TECH-2, FR-TECH-9, FR-TECH-12): the day is the app's one read of API-100
// (mapme/reads.ts, shared with the Map, Parts and Me screens: read on open, when the app comes back to the foreground, when a send ends and
// every 60 s, the last good answer kept on the phone for an open with no signal, "Last updated"), with the phone's waiting items applied to
// the list at once (section 4.5 rule 6). The card's status buttons open the app's confirm sheet (Sheets.tsx), whose primary button enters
// the item through the app's item engine (core.ts enter(): saved on the phone at once, sent when online); nothing here calls a write itself.
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { waitingTotal, type AppState, type NativeApp } from '../../core.ts';
import { useT } from '../../ui/intl.tsx';
import { dumpLook, LOOK_ON } from '../../ui/look.ts';
import { openWaiting, type StatusKind } from '../job/nav.ts';
import { openDirections } from '../mapme/index.tsx';
import { useMapMe } from '../mapme/use-mapme.ts';
import { applyWaiting, directionsMinutes, ENDED, nextJob, todayState, type Drive, type LocalJob, type TodayState } from './model.ts';
import type { StatusSheetParams } from './Sheets.tsx';
import { TodayView, type SheetKind } from './TodayView.tsx';

/** CMP-10-04 and the day-changed notices show for the toast's 6 seconds. */
const TOAST_MS = 6_000;

const KIND: Record<SheetKind, StatusKind> = { omw: 'on_my_way', arrived: 'arrived', noh: 'no_one_home' };

const DUMP: Record<Exclude<TodayState, 'success'>, string> = {
  loading: 'today-loading', new_day: 'today-new-day', offline_saved: 'today-offline-saved', offline_none: 'today-offline-none', no_jobs: 'today-no-jobs', all_done: 'today-all-done',
};

export function TodayScreen(props: { app: NativeApp; state: AppState }) {
  const { state } = props;
  const t = useT();
  const nav = useNavigation<NavigationProp<ParamListBase>>();
  const { reads, data } = useMapMe();
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((cur) => (cur === text ? null : cur)), TOAST_MS);
  }, []);

  const refresh = useCallback(async () => {
    if (!reads) return;
    setRefreshing(true);
    await reads.refresh();
    setRefreshing(false);
  }, [reads]);

  // Each day-changed notice (CTL-TEC-02-14; the reads raise none while the Me screen's switch is off) shows for 6 seconds, then leaves.
  const notices = data.notices;
  useEffect(() => {
    if (!reads || notices.length === 0) return;
    const timers = notices.map((n) => setTimeout(() => reads.dismiss(n.id), TOAST_MS));
    return () => timers.forEach((h) => clearTimeout(h));
  }, [reads, notices]);

  // A send that just finished changed the server's side of the day: read it again; the engine's answered items are the "N items sent" toast.
  const outbox = state.outbox;
  const sending = useRef(outbox.sending);
  useEffect(() => {
    if (sending.current && !outbox.sending) void reads?.refresh();
    sending.current = outbox.sending;
  }, [outbox.sending, reads]);
  const sentKey = outbox.lastSent.map((a) => a.key).join(',');
  const shownSent = useRef('');
  useEffect(() => {
    if (sentKey !== '' && sentKey !== shownSent.current && outbox.waiting.length === 0) {
      shownSent.current = sentKey;
      flash(t('tech.sync.sent', { n: outbox.lastSent.length }));
    }
  }, [sentKey, outbox.waiting.length, outbox.lastSent.length, flash, t]);

  const day = data.day?.data ?? null;
  const jobs: LocalJob[] = applyWaiting(day?.jobs ?? [], outbox.waiting, outbox.lastSent);
  const online = data.online && outbox.online;
  const tState = todayState({ hasDay: day !== null, settled: data.settled, online, jobs, newDay: data.newDay });
  const next = nextJob(jobs);
  const zone = day?.zone ?? 'America/New_York';

  // CTL-TEC-02-03 and CTL-TEC-03-05: API-104's drive time and distance for the next job from the van's position (FR-TECH-13), read with
  // signal and again with each read of the day; none offline, none for an approximate route. The Directions button shows the minutes, the
  // On my way sheet the minutes and the miles.
  const nextNo = next?.jobNumber ?? null;
  const readAt = data.day?.at ?? null;
  const [drive, setDrive] = useState<({ job: number } & Drive) | null>(null);
  useEffect(() => {
    let live = true;
    const r = reads;
    void directionsMinutes(async (toJob) => {
      const got = r ? await r.leg(toJob) : null;
      if (!got || got.kind !== 'leg') throw new Error('no leg');
      return { leg: got.leg };
    }, nextNo, online && r !== null).then((d) => live && setDrive(d));
    return () => {
      live = false;
    };
  }, [nextNo, readAt, online, reads]);

  const dump = tState === 'success'
    ? (next && next.pending ? (next.status === 'on_the_way' ? 'today-pending' : null) : next && next.status === 'scheduled' && !next.lateText && jobs.filter((j) => ENDED.has(j.status)).length > 0 && jobs.filter((j) => !ENDED.has(j.status)).length > 2 ? 'today' : null)
    // the Offline, saved frame draws the waiting count in the saved line: an offline list with nothing waiting is not that state's dump
    : tState === 'offline_saved' && outbox.waiting.length === 0 ? null : DUMP[tState];
  // The look dump of the state on screen (ci/look-values/native-today-cases.ts), written again when what the state draws changes (a done row
  // or the waiting count arrives after the state name was already on screen): the last write of a name is the frame's state.
  const shape = `${jobs.filter((j) => ENDED.has(j.status)).length}/${jobs.length}/${outbox.waiting.length}/${next?.jobNumber ?? 0}/${next?.status ?? ''}`;
  useEffect(() => {
    if (!LOOK_ON || dump === null) return;
    const h = setTimeout(() => void dumpLook(dump), 900);
    return () => clearTimeout(h);
  }, [dump, shape]);

  // The confirm sheet (SCR-TEC-03, -13, -14): Today hands it what it knows of the job for the On my way lines.
  const confirm = (kind: SheetKind, job: LocalJob) => {
    const params: StatusSheetParams = {
      jobNumber: job.jobNumber, version: job.version, kind: KIND[kind], name: job.customer.name, online,
      omw: {
        language: job.customer.language, window: job.window, preview: job.onMyWayPreview, zone,
        drive: drive && drive.job === job.jobNumber ? { minutes: drive.minutes, distanceMeters: drive.distanceMeters } : null,
      },
    };
    nav.navigate('JobStatus', params);
  };

  return (
    <TodayView
      state={tState} day={day} jobs={jobs} lang={state.language} online={online} savedAt={data.day?.at ?? null} failed={data.failed}
      waiting={waitingTotal(state)} ready={outbox.ready} oldCount={outbox.oldCount} notices={data.notices} toast={toast} refreshing={refreshing}
      driveMinutes={drive && drive.job === nextNo ? drive.minutes : null}
      onRefresh={() => void refresh()}
      onWaiting={() => openWaiting(nav)}
      onOpenSheet={confirm}
      onJob={(job, history) => nav.navigate('Job', { jobNumber: job.jobNumber, ...(history ? { history: true } : {}) })}
      onDirections={(job) => openDirections(nav, job.jobNumber)}
      onFinish={(job) => nav.navigate('Finish', { jobNumber: job.jobNumber })}
      onCall={(phone) => void Linking.openURL(`tel:${phone}`)}
    />
  );
}
