// SPDX-License-Identifier: AGPL-3.0-or-later
// The native Today screen's pure rules (SCR-TEC-02; FR-TECH-1, FR-TECH-12, UI-SPECIFICATION 4.5 rule 6): the day's jobs with the phone's
// waiting items applied, the header's progress, the next job, the labels. The same rules as the web app's apps/web/src/tech/today/model.ts
// (the native app imports no web code, SD-2); no React in here, so the unit tests run it on node.
import type { TodayJob } from '@bw/api';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';
import type { Language } from '@bw/i18n/src/language.ts';
import type { AnsweredItem, QueuedItem } from '@bw/outbox/src/items/native.ts';
import { formatTime, fromWire } from '@bw/time';
import type { T } from '../../ui/intl.tsx';

export type JobStatus = TodayJob['status'];
/** A job as the screen shows it: the server's status with the phone's own waiting status items applied. */
export interface LocalJob extends TodayJob {
  /** A status item for this job still waits to send (the card shows "Waiting to send"). */
  pending: boolean;
  /** The server has answered a status item for this job (the engine's lastSent) and none waits any more: the Sent badge (DK-109). */
  sent: boolean;
  /** The demo time of the waiting item that ended the visit on this phone, until the server's ended time arrives. */
  localAt: string | null;
}

export const ENDED: ReadonlySet<JobStatus> = new Set<JobStatus>(['done', 'no_one_home']);

/** The link slot of the on-the-way text preview (API-100): the link is made only when the text is sent. */
export const PREVIEW_LINK = 'bw.j7l.io/m/...';

const AFTER: Partial<Record<QueuedItem['kind'], JobStatus>> = { on_my_way: 'on_the_way', arrived: 'on_site', no_one_home: 'no_one_home', finished: 'done' };

/** F-1025: a finish the server refused for want of parts is not Done: the job stays as it was, with its Finish link (UI-SPECIFICATION 4.5 rule 10). */
const isRefusedFinish = (i: QueuedItem): boolean => i.kind === 'finished' && i.lastTry?.outcome === 'refused' && i.lastTry.code === 'parts_required';

/** Section 4.5 rule 6: each waiting status item moves its job at once, in the order the items were entered. `sent` is the engine's lastSent. */
export function applyWaiting(jobs: readonly TodayJob[], waiting: readonly QueuedItem[], sent: readonly Pick<AnsweredItem, 'kind' | 'jobNumber'>[] = []): LocalJob[] {
  const order = [...waiting].sort((a, b) => a.enteredRealMs - b.enteredRealMs);
  return jobs.map((j) => {
    let status = j.status;
    let pending = false;
    let localAt: string | null = null;
    for (const it of order) {
      const next = AFTER[it.kind];
      if (it.jobNumber !== j.jobNumber || !next || isRefusedFinish(it)) continue;
      pending = true;
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
export function nextJob<J extends { status: JobStatus }>(jobs: readonly J[]): J | null {
  return jobs.find((j) => !ENDED.has(j.status)) ?? null;
}

export const surname = (name: string): string => name.trim().split(/\s+/).pop() ?? name;
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** CTL-TEC-02-04 is enabled when the next job is Scheduled and no other job is On the way or On site. */
export function canStartWay(jobs: readonly { status: JobStatus; jobNumber: number }[], job: { jobNumber: number; status: JobStatus }): boolean {
  return job.status === 'scheduled' && !jobs.some((j) => j.jobNumber !== job.jobNumber && (j.status === 'on_the_way' || j.status === 'on_site'));
}

/** API-104's drive from the van to the next job: minutes and meters, both null when the drive time is not known (an approximate route). */
export interface Drive {
  minutes: number | null;
  distanceMeters: number | null;
}

/**
 * CTL-TEC-02-03 and CTL-TEC-03-05: API-104's drive time and distance for the next job from the van, read with signal. None offline, none
 * when the read fails, and none for an approximate route (a leg with no baked track shows no minutes and no miles).
 */
export async function directionsMinutes(
  read: (toJob: number) => Promise<{ leg: { track: unknown; minutes: number; distanceMeters?: number | null } }>,
  nextNo: number | null,
  online: boolean,
): Promise<({ job: number } & Drive) | null> {
  if (nextNo === null || !online) return null;
  try {
    const r = await read(nextNo);
    const baked = r.leg.track !== null;
    return { job: nextNo, minutes: baked ? r.leg.minutes : null, distanceMeters: baked ? (r.leg.distanceMeters ?? null) : null };
  } catch {
    return null;
  }
}

/** Meters as the frames' miles, 1 decimal ("5.8"). */
const miles = (m: number): string => (m / 1609.344).toFixed(1);

/**
 * CTL-TEC-03-05, the On my way sheet's line under "Arriving about": the drive minutes and miles from the van (API-104) and whether the
 * estimate falls inside the window ("12 min drive, 5.8 mi - inside the 10 AM-12 PM window"); with the drive time not known, the window's
 * verdict alone.
 */
export function arrivalSmall(drive: Drive | null, inside: boolean, window: string, t: (k: MessageKey, v?: Record<string, string | number>) => string): string {
  if (drive && drive.minutes !== null && drive.distanceMeters !== null) {
    return t(inside ? 'tech.omw.driveInside' : 'tech.omw.driveOutside', { n: drive.minutes, mi: miles(drive.distanceMeters), window });
  }
  return t(inside ? 'tech.omw.inside' : 'tech.omw.outside', { window });
}

/**
 * CTL-TEC-02-02 "arrival estimate when online": the card's "Arrive about 10:40 AM if you leave now", API-100's estimate for a job not yet
 * on the way (its on-the-way preview's arrival, the same time the On my way sheet shows); none offline, none once the job is under way.
 */
export function leaveNowLine(
  job: Pick<TodayJob, 'status' | 'onMyWayPreview'>, online: boolean, zone: string, lang: Language, t: (k: MessageKey, v?: Record<string, string | number>) => string,
): string | null {
  if (!online || job.status !== 'scheduled' || !job.onMyWayPreview) return null;
  return t('tech.today.leaveNow', { time: timeOf(job.onMyWayPreview.arrival, zone, lang) });
}

const hour12 = (h: number) => ({ n: h % 12 === 0 ? 12 : h % 12, mer: h < 12 ? 'AM' : 'PM' });
/** "8-10 AM" or "10 AM-2 PM" (SD-17's window label), from the 2 wire times of a window. */
export function windowLabel(start: string, end: string): string {
  const s = hour12(fromWire(start).hour);
  const e = hour12(fromWire(end).hour);
  return s.mer === e.mer ? `${s.n}-${e.n} ${e.mer}` : `${s.n} ${s.mer}-${e.n} ${e.mer}`;
}

/** "Tue, Oct 20": the weekday and the date of a local date, words from the catalog (UI-SPECIFICATION section 12 rule 7). */
export function dayLabel(date: string, t: T): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7 + 1;
  return t('inbox.date', { weekday: t(`time.weekday.${weekday}` as MessageKey), month: t(`time.month.${m}` as MessageKey), day: d });
}

export const timeOf = (wire: string, zone: string, lang: Language): string => formatTime(fromWire(wire).toInstant(), zone, lang);

/** "Oct 14, 2025": the last visit's date in the person's words. */
export function lastVisitDate(date: string, t: T): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${t(`time.month.${m}` as MessageKey)} ${d}, ${y}`;
}

const EQUIPMENT_TYPES: ReadonlySet<string> = new Set(['furnace', 'air_conditioner', 'thermostat', 'water_heater']);

/** "gas furnace, 2014": the equipment's kind in the person's words, then its year. */
export function equipmentText(e: NonNullable<TodayJob['equipment']>, t: T): string {
  const label = (EQUIPMENT_TYPES.has(e.type) ? t(`customers.equipment.${e.type}` as MessageKey) : e.type.replace(/_/g, ' ')).toLowerCase();
  return e.year ? `${label}, ${e.year}` : label;
}

export type ServiceIcon = 'snow' | 'drop' | 'flame';
export const serviceIcon = (key: string): ServiceIcon => (/ac_|air|cool/.test(key) ? 'snow' : /plumb|water|drain/.test(key) ? 'drop' : 'flame');

/** Which of the 8 states of SCR-TEC-02 the list shows (UI-SPECIFICATION 8, SCR-TEC-02 States). */
export type TodayState = 'loading' | 'new_day' | 'success' | 'offline_saved' | 'offline_none' | 'no_jobs' | 'all_done';

export interface StateInput {
  /** A day to draw: the saved day or the one just read. */
  hasDay: boolean;
  /** The first read has settled, answered or not. */
  settled: boolean;
  online: boolean;
  jobs: readonly { status: JobStatus }[];
  /** The read of a new date is being repeated for the new today (MapMeReads, screens/mapme/reads.ts, owns the day read). */
  newDay: boolean;
}

/**
 * The "No signal and no saved job list" line (offline_none) belongs to a lost connection only. With signal, a first read that failed (a 5xx, a
 * refusal, an answer that does not parse) shows CMP-12 alone, as the web does (F-1109 b).
 */
export const showsNoSaved = (state: TodayState, online: boolean): boolean => state === 'offline_none' && !online;

export function todayState(i: StateInput): TodayState {
  if (i.newDay) return 'new_day';
  if (!i.hasDay) return i.settled ? 'offline_none' : 'loading';
  if (i.jobs.length === 0) return 'no_jobs';
  if (!nextJob(i.jobs)) return 'all_done';
  return i.online ? 'success' : 'offline_saved';
}
