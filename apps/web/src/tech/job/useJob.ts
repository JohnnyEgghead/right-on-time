// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The job screens' reads (SCR-TEC-04, SCR-TEC-05 to SCR-TEC-07): API-101 with signal, kept on the phone (store.ts) for an
// open with no signal (SCR-TEC-04 Offline, saved), and read again after each send so what the server now holds replaces the
// phone's own waiting copy. The parts list is the app's one read loop's (data.ts TechReads, API-107 kept as bw.tech.parts, UD-35).
// A 403 or 404 is SCR-TEC-04's No longer yours: the kept copy is dropped, and any waiting item for the job still sends.
// The copies are 1 person's: with signal, API-07 is read beside API-101, and a different person than the copies' clears them
// (local.ts personSignedIn) before this read's answer is shown or saved.
import { ApiError, createClient, myJob, whoAmI, type ApiClient } from '@bw/api';
import { realNow } from '@bw/time';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_DATA, techReads, useTechData, type TechReads } from '../data.ts';
import type { OutboxState } from '../engine.ts';
import { personSignedIn } from '../local.ts';
import { useOwnOutbox } from '../useOutbox.ts';
import { jobStore, type JobCopy, type Part } from './store.ts';

export type JobView =
  | { kind: 'loading' }
  | { kind: 'job'; job: JobCopy; fromPhone: boolean }
  | { kind: 'not_on_phone' }
  | { kind: 'not_yours' };

/** A preview's engine state: nothing waiting, nothing sent (the engine never starts). */
export const IDLE: OutboxState = { ready: true, waiting: [], online: true, sending: false, oldCount: 0, lastSent: [], signedOut: false };

let client: ApiClient | null = null;
const api = (): ApiClient => (client ??= createClient({ baseUrl: window.location.origin }));

/** The fixed state of a preview, or the live read. */
export function useJob(jobNumber: number, fixed?: JobView): { view: JobView; me: string | null; reload: () => void } {
  const [view, setView] = useState<JobView>(fixed ?? { kind: 'loading' });
  const [me, setMe] = useState<string | null>(null);
  const outbox = useOwnOutbox(fixed ? IDLE : undefined);
  const sent = outbox.lastSent;
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (fixed) return;
    const n = ++seq.current;
    const store = jobStore();
    const kept = await store.job(jobNumber).catch(() => null);
    const name = await store.me().catch(() => null);
    if (n !== seq.current) return;
    if (name) setMe(name);
    if (kept) setView((v) => (v.kind === 'job' && !v.fromPhone ? v : { kind: 'job', job: kept, fromPhone: true }));
    const jobRead = api().call(myJob, { jobNumber });
    jobRead.catch(() => undefined); // read below
    try {
      const who = await api().call(whoAmI, {});
      if (await personSignedIn(who.data.userId)) {
        // Another person's copies were on the phone and are gone: none of them stays on the screen.
        if (n !== seq.current) return;
        setMe(null);
        setView({ kind: 'loading' });
      }
      if (n !== seq.current) return;
      setMe(who.data.name);
      await store.saveMe(who.data.name).catch(() => undefined);
    } catch {
      // no signal: the kept copies are the person's who last read with signal (the sign-in cleared any other's)
    }
    try {
      const r = await jobRead;
      if (n !== seq.current) return;
      setView({ kind: 'job', job: r.data, fromPhone: false });
      await store.saveJob(r.data, realNow('record_stamp').epochMilliseconds).catch(() => undefined);
    } catch (e) {
      if (n !== seq.current) return;
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        await store.forgetJob(jobNumber).catch(() => undefined);
        setView({ kind: 'not_yours' });
        return;
      }
      // No signal (or the server failed): the kept copy, or the message that the job is not on this phone.
      if (!kept) setView({ kind: 'not_on_phone' });
    }
  }, [jobNumber, fixed]);

  useEffect(() => {
    void load();
  }, [load]);
  // After each send the server holds what was sent: read again so it shows as the server's.
  useEffect(() => {
    if (sent.length > 0) void load();
  }, [sent, load]);
  return { view: fixed ?? view, me, reload: () => void load() };
}

/** The parts list for the finish screen: the app's one read loop's copy (data.ts TechReads; bw.tech.parts with no signal, UD-35). */
export function useParts(fixed?: Part[] | null): Part[] | null {
  const data = useTechData(fixed !== undefined ? EMPTY_DATA : undefined);
  return fixed !== undefined ? fixed : (data.parts?.data ?? null);
}

/** F-1333: the drive minutes of the leg into `toJob`, read through leg() so the answer is kept (rule 11); null for no route or no baked track. */
export async function driveMinutes(reads: Pick<TechReads, 'leg'>, toJob: number): Promise<number | null> {
  try {
    const r = await reads.leg(toJob);
    return r.kind === 'leg' && r.leg.track ? r.leg.minutes : null;
  } catch {
    return null;
  }
}

/**
 * CTL-TEC-04-04 (FR-TECH-13): the drive minutes of the route from the van to this job (F-1369), from API-104 (GET /tech/route?toJob, no fromJob,
 * P5-TWA-MAP-ME's row, read through the app's route reader). Null while unknown, with no signal, or for an approximate
 * route (no baked track): the button then reads Directions with no minutes.
 */
export function useDriveMinutes(toJob: number | null, fixed?: number | null): number | null {
  const [minutes, setMinutes] = useState<number | null>(fixed ?? null);
  useEffect(() => {
    if (fixed !== undefined || toJob === null) return;
    let live = true;
    // F-1333: through techReads().leg(), which keeps the answer as this destination's last route read (rule 11); none without a baked track.
    void driveMinutes(techReads(), toJob).then((m) => {
      if (live && m !== null) setMinutes(m);
    });
    return () => {
      live = false;
    };
  }, [toJob, fixed]);
  return minutes;
}
