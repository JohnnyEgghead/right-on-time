// SPDX-License-Identifier: AGPL-3.0-or-later
// The job screens' state for React (data.ts through the app's 1 controller): the job view, read when the screen comes into focus and
// again after each send (what the server now holds replaces the phone's waiting copy), the signed-in technician's name, the parts list
// and the demo time now.
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nativeApp } from '../../boot.ts';
import type { AppState } from '../../core.ts';
import { useMapMe } from '../mapme/use-mapme.ts';
import { JobData, type JobView } from './data.ts';
import type { Part } from './model.ts';

let data: JobData | null = null;
/** The app's 1 job data layer, over the app's own job copies (boot.ts gives NativeApp the bw-jobs directory). */
export function jobData(): JobData {
  data ??= new JobData(nativeApp());
  return data;
}

export function useJob(jobNumber: number, state: AppState): { view: JobView; me: string | null; reload: () => void } {
  const [view, setView] = useState<JobView>({ kind: 'loading' });
  const [me, setMe] = useState<string | null>(() => jobData().copies.me()?.name ?? null);
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    const d = jobData();
    void d.job(jobNumber, (v) => {
      if (n === seq.current) setView((old) => (v.kind === 'job' && v.fromPhone && old.kind === 'job' && !old.fromPhone ? old : v));
    }).then(() => {
      if (n === seq.current) setMe(d.copies.me()?.name ?? null);
    }, () => undefined);
  }, [jobNumber]);
  useFocusEffect(useCallback(() => {
    load();
  }, [load]));
  const sent = state.outbox.lastSent;
  useEffect(() => {
    if (sent.length > 0) load();
  }, [sent, load]);
  return { view, me, reload: load };
}

export function useParts(): { parts: Part[] | null; failed: boolean } {
  const [read, setRead] = useState<{ parts: Part[] | null; failed: boolean }>(() => ({ parts: jobData().copies.parts(), failed: false }));
  useEffect(() => {
    let live = true;
    void jobData().partsRead().then((r) => { if (live) setRead(r); }, () => undefined);
    return () => {
      live = false;
    };
  }, []);
  return read;
}

/** The demo time now (null until the store holds a clock offset); read again when the waiting items change. */
export function useDemoNow(state: AppState): number | null {
  const [now, setNow] = useState<number | null>(null);
  const waiting = state.outbox.waiting;
  useEffect(() => {
    let live = true;
    void jobData().app.demoNowMs().then((v) => { if (live) setNow(v); }, () => undefined);
    return () => {
      live = false;
    };
  }, [waiting]);
  return now;
}

export function useDriveMinutes(toJob: number | null): number | null {
  const [minutes, setMinutes] = useState<number | null>(null);
  // F-1311: the session's reads keep this route as the destination's last read (rule 11).
  const { reads } = useMapMe();
  useEffect(() => {
    if (toJob === null) return;
    let live = true;
    void jobData().driveMinutes(toJob, reads).then((m) => { if (live) setMinutes(m); }, () => undefined);
    return () => {
      live = false;
    };
  }, [toJob, reads]);
  return minutes;
}
