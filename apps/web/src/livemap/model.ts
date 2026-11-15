// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-04 Live map: on the way and SCR-CUS-05 Live map: ended, the pure parts (UI-SPECIFICATION 2.3; FR-TEXT-4, FR-TEXT-22, FR-TEXT-23;
// NFR-04). The values come from API-116; this file words them: the minutes line, the progress bar's fraction, the visit line, the ended
// page's reason. No React, so a unit test covers each.
import type { liveMapData, liveMapEndedDetail, z } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { fromWire } from '@bw/time';
import { dateNumbers } from '../customers/model.ts';
import { dayText } from '../messages/model.ts';
import { timeText } from '../board/model.ts';
import { windowZoned } from '../booking/model.ts';
import type { ClientT } from '../shell/intl.tsx';

export type LiveData = z.output<typeof liveMapData.response>;
export type EndedDetail = z.output<typeof liveMapEndedDetail>;

/** The page re-reads API-116 this often while it is shown (UI-SPECIFICATION SCR-CUS-04 Reads: interval; FR-TEXT-22). */
export const POLL_MS = 10_000;

export type LiveState =
  | { kind: 'loading' }
  /** `failed`: the last read failed; the van is removed and the message shows until a read works (NFR-04). `now` is the server's demo time of the read. */
  | { kind: 'live'; data: LiveData; now: string; failed: boolean }
  | { kind: 'ended'; detail: EndedDetail }
  | { kind: 'not_found' }
  /** The first read failed: nothing to show but the message. */
  | { kind: 'failed' };

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** The trip's progress, 0 to 100, from the time the technician left to the arrival estimate at the server's demo time `now`. */
export function progressPercent(leftAt: string, eta: string | null, now: string): number {
  if (!eta) return 0;
  const a = fromWire(leftAt).epochMilliseconds;
  const b = fromWire(eta).epochMilliseconds;
  if (b <= a) return 100;
  const p = (fromWire(now).epochMilliseconds - a) / (b - a);
  return Math.min(100, Math.max(0, Math.round(p * 100)));
}

/** The heading's second line, in 2 parts so the arrival time can stand bold: "About 12 minutes away, arriving about " + "10:40 AM". */
export function heroLine(t: ClientT, minutesAway: number | null, eta: string | null): { lead: string; time: string } | null {
  if (minutesAway === null || !eta) return null;
  const lead = minutesAway <= 1 ? t('livemap.hero.min1') : t('livemap.hero.min', { n: minutesAway });
  return { lead, time: timeText(eta) };
}

const sameDay = (day: string, wire: string): boolean => fromWire(wire).toPlainDate().toString() === day;

/** "Furnace tune-up, today 10 AM-12 PM": the service, the day (today, else its date) and the window. */
export function visitLine(t: ClientT, v: LiveData['visit'], today: string): string {
  const day = sameDay(v.day, today) ? t('msg.ctx.today') : dayText(t, v.day);
  return t('livemap.who.visit', { service: t(v.serviceLabelKey as MessageKey), day, window: windowZoned(v.window.start, v.window.end) });
}

/** "Tue, Sep 15, 2026" (the ended page's Day line). */
export function longDay(t: ClientT, day: string): string {
  return `${dayText(t, day)}, ${dateNumbers(day).year}`;
}

/** The technician card's second line: "Your Brightwater technician, Van 12" (no van, no van words). */
export const techLine = (t: ClientT, van: string | null): string => (van ? t('livemap.who.van', { van }) : t('livemap.who.tech'));

/** Did the technician arrive inside the arrival window (the ended page's heading says it)? */
export function arrivedInside(arrivedAt: string, window: { start: string; end: string }): boolean {
  const at = fromWire(arrivedAt).epochMilliseconds;
  return at >= fromWire(window.start).epochMilliseconds && at <= fromWire(window.end).epochMilliseconds;
}

/** What the ended page says: by arrival, ended for another reason (facts, no arrival line), or the visit changed (the office phone only). */
export type EndedVariant = 'arrived' | 'ended' | 'changed';
export const endedVariant = (d: EndedDetail): EndedVariant => (d.reason === 'changed' ? 'changed' : d.arrivedAt ? 'arrived' : 'ended');

/** The 410 answer's members from a Problem body, or null when the body is not an ended answer. */
export function endedOf(problem: Record<string, unknown>): EndedDetail | null {
  const reason = problem.reason;
  if (reason !== 'arrived' && reason !== 'changed') return null;
  return {
    reason,
    arrivedAt: typeof problem.arrivedAt === 'string' ? problem.arrivedAt : null,
    visit: (problem.visit as EndedDetail['visit']) ?? null,
    technician: (problem.technician as EndedDetail['technician']) ?? null,
    officePhone: typeof problem.officePhone === 'string' ? problem.officePhone : null,
  };
}

/** What the server's answer to 1 read makes of the page. */
export type ReadOutcome =
  | { ok: true; data: LiveData; now: string }
  | { ok: false; code: string; status: number; detail: Record<string, unknown> };

/** The next state after a read: a live answer, the ended page, not valid, or "update failed" (the van removed, the last facts kept). */
export function nextState(prev: LiveState, r: ReadOutcome): LiveState {
  // Ended and not valid are final for every outcome: a 200 that answers a read sent before the 410 never brings back the live view or the van.
  if (prev.kind === 'ended' || prev.kind === 'not_found') return prev;
  if (r.ok) return { kind: 'live', data: r.data, now: r.now, failed: false };
  if (r.status === 410) {
    const detail = endedOf(r.detail);
    // A 410 that is not an ended answer is a defect: show the failure, never a van.
    return detail ? { kind: 'ended', detail } : { kind: 'failed' };
  }
  if (r.status === 404) return { kind: 'not_found' };
  if (prev.kind === 'live') return { ...prev, failed: true };
  return { kind: 'failed' };
}

/** What the page draws: after a restore from the page cache the kept live view (and its van) is held back until the re-read answers. */
export const shownState = (state: LiveState, restoring: boolean): LiveState => (restoring && state.kind === 'live' ? { kind: 'loading' } : state);

/** The history state the ended page writes over its entry (kept keys stay: the router's own). */
export const endedHistoryState = (prev: unknown): Record<string, unknown> => ({ ...(prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {}), bwLiveMap: 'ended' });

/** Preview and test states, by name (the harness build's preview routes). */
export const LIVEMAP_STATES = ['on-the-way', 'loading', 'not-valid', 'update-failed'] as const;
export const ENDED_STATES = ['by-arrival', 'changed'] as const;
