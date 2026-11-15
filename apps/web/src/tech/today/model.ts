// SPDX-License-Identifier: AGPL-3.0-or-later
// The Today screen's pure rules (SCR-TEC-02; FR-TECH-1, FR-TECH-12, UI-SPECIFICATION 4.5 rule 6): the day's jobs with the phone's
// waiting items applied, the header's progress, the next job, and the Sent badge's time. No React in here. The day's read, its saved copy and the day-changed notice are the shared ones (../data.ts, ../local.ts, ../DayNotices.tsx; F-1018).
import type { TodayJob } from '@bw/api';
import type { AnsweredItem, QueuedItem } from '@bw/outbox/src/items/index.ts';
import { isRefusedFinish } from '../job/model.ts';

export type JobStatus = TodayJob['status'];
/** A job as the screen shows it: the server's status with the phone's own waiting status items applied. */
export interface LocalJob extends TodayJob {
  /** A status item for this job still waits to send (the row shows "Waiting to send"). */
  pending: boolean;
  /** The server has answered a status item for this job (the engine's lastSent) and none waits any more: the row shows the Sent badge (DK-109). */
  sent: boolean;
  /** The demo time of the waiting item that ended the visit on this phone, until the server's ended time arrives. */
  localAt: string | null;
}

/** The link slot of the on-the-way text preview (API-100): the link is made only when the text is sent. */
export const PREVIEW_LINK = 'bw.j7l.io/m/...';

export const ENDED: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'no_one_home']);

const AFTER: Partial<Record<QueuedItem['kind'], JobStatus>> = { on_my_way: 'on_the_way', arrived: 'on_site', no_one_home: 'no_one_home', finished: 'done' };

/** Section 4.5 rule 6: each waiting status item moves its job at once, in the order the items were entered. `sent` is the engine's lastSent: the items the last send round got answers for. */
export function applyWaiting(jobs: readonly TodayJob[], waiting: readonly QueuedItem[], sent: readonly Pick<AnsweredItem, 'kind' | 'jobNumber'>[] = []): LocalJob[] {
  const order = [...waiting].sort((a, b) => a.enteredRealMs - b.enteredRealMs);
  return jobs.map((j) => {
    let status = j.status;
    let pending = false;
    let localAt: string | null = null;
    for (const it of order) {
      const next = AFTER[it.kind];
      // F-1025: a finish the server refused for parts is not Done: the job stays as it was, with its Finish link (UI-SPECIFICATION 4.5 rule 10).
      if (it.jobNumber !== j.jobNumber || !next) continue;
      // F-1045: the refused finish still waits on the phone, so the job reads Waiting to send (never the Sent badge) while its status stays.
      pending = true;
      if (isRefusedFinish(it)) continue;
      status = next;
      if (next === 'done' || next === 'no_one_home') localAt = it.demoTime || null;
    }
    return { ...j, status, pending, sent: !pending && sent.some((a) => a.jobNumber === j.jobNumber && a.kind in AFTER), localAt };
  });
}

/** FR-TECH-12: jobs done of the day's jobs; a No one home visit is over like a finished one. */
export function progress(jobs: readonly { status: JobStatus }[]): { done: number; total: number } {
  return { done: jobs.filter((j) => ENDED.has(j.status)).length, total: jobs.length };
}

/** CTL-TEC-02-02: the first job that is not Done or No one home. */
export function nextJob<T extends { status: JobStatus }>(jobs: readonly T[]): T | null {
  return jobs.find((j) => !ENDED.has(j.status)) ?? null;
}

/** The family name, for the compact rows ("Whitaker - Worthington"). */
export function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** CTL-TEC-02-04 is enabled when the next job is Scheduled and no other job is On the way or On site. */
export function canStartWay(jobs: readonly { status: JobStatus; jobNumber: number }[], job: { jobNumber: number; status: JobStatus }): boolean {
  return job.status === 'scheduled' && !jobs.some((j) => j.jobNumber !== job.jobNumber && (j.status === 'on_the_way' || j.status === 'on_site'));
}

/** CTL-TEC-04-13, -14, -17: the job screen's On my way, Arrived or No one home opens this page asking for that sheet (?sheet=omw&job=24830). */
export function askedSheet(search: string): { kind: 'omw' | 'arrived' | 'noh'; jobNumber: number } | null {
  const q = new URLSearchParams(search);
  const kind = q.get('sheet');
  const jobNumber = Number(q.get('job'));
  if ((kind !== 'omw' && kind !== 'arrived' && kind !== 'noh') || !Number.isInteger(jobNumber) || jobNumber <= 0) return null;
  return { kind, jobNumber };
}

/**
 * CTL-TEC-02-03 (CTL-TEC-08-03): the Directions button's minutes are API-104's drive time for the next job from the van, read with signal.
 * None offline (no call is made), none when the read fails, and none for an approximate route (a leg with no baked track shows no minutes).
 */
export async function directionsMinutes(
  read: (toJob: number) => Promise<{ leg: { track: unknown; minutes: number } }>,
  nextNo: number | null,
  online: boolean,
): Promise<{ job: number; minutes: number | null } | null> {
  if (nextNo === null || !online) return null;
  try {
    const r = await read(nextNo);
    return { job: nextNo, minutes: r.leg.track !== null ? r.leg.minutes : null };
  } catch {
    return null;
  }
}

/**
 * SCR-TEC-02 New day (UI-SPECIFICATION 8, F-1135): the clock passed midnight and a read answers a later date than the list shown. Until the
 * next read of that date answers, the list is drawn as the new day's section heading over its jobs as Later rows and a skeleton row.
 */
export interface NewDayTrack { date: string | null; readAt: string | null; newDayAt: string | null }

export const NO_NEW_DAY: NewDayTrack = { date: null, readAt: null, newDayAt: null };

/** The track after the list shown has date `date`, read at `readAt`: a later date than the one before starts New day, a later read ends it. */
export function trackNewDay(prev: NewDayTrack, date: string | null, readAt: string | null): NewDayTrack {
  if (date === null) return prev;
  if (prev.date !== null && date > prev.date) return { date, readAt, newDayAt: readAt ?? '' };
  if (prev.newDayAt !== null && readAt !== prev.newDayAt && readAt !== null) return { date, readAt, newDayAt: null };
  return { ...prev, date, readAt };
}
