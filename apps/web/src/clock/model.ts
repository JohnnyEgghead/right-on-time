// SPDX-License-Identifier: AGPL-3.0-or-later
// The demo clock page's logic with no React in it (SCR-OFC-17, SCR-OFC-27): which controls are on and why not, a typed date and time as a
// wire time, a preset's reachability, the cool-down in minutes, and the words of a refused move. FR-DEMO-2: nothing here reads the device
// clock; "now" is the demo time the caller passes (API-10's anchor advanced by the monotonic time since the read).
import type { clockPresets } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { atLocal, dateParts, formatTime, localDateOf, localTimeOf, toWire, type Instant, type Language } from '@bw/time';
import type { z } from '@bw/api';
import type { ClockAnswer } from '../shell/clock.ts';

export type Preset = z.output<typeof clockPresets.response>['presets'][number];
type T = (key: MessageKey, values?: Record<string, string | number>) => string;

/** The demo day the world resets to (SD-12): Tue, Sep 15, 7:00 AM Eastern, as a wire time (CTL-OFC-17-06, CTL-OFC-27-01). */
export const RESET_TARGET = '2026-09-15T07:00:00-04:00[America/New_York]';

export type Why = 'catching_up' | 'cooldown' | null;

/** Why the moves are off, in the order the spec words it: a running replay first (state Catching up), then the cool-down (Reset only). */
export function movesOff(a: Pick<ClockAnswer, 'replay'>): Why {
  return a.replay?.running ? 'catching_up' : null;
}

/**
 * CTL-OFC-17-07 shows replay progress, state replay running (F-1173). API-10 holds running true also while a reset is unconfirmed
 * (F-919), when the reset has zeroed done and total: no replay runs then, so there is no progress to draw. The catching-up note stays.
 */
export const progressShown = (a: Pick<ClockAnswer, 'replay'>): boolean => Boolean(a.replay?.running) && (a.replay?.total ?? 0) > 0;

/** CTL-OFC-17-06: Reset is off while a replay runs and during the cool-down. */
export function resetOff(a: Pick<ClockAnswer, 'replay' | 'resetAvailableInSeconds'>): Why {
  if (a.replay?.running) return 'catching_up';
  return (a.resetAvailableInSeconds ?? 0) > 0 ? 'cooldown' : null;
}

/** "4 minutes" is a whole-minute round up of the seconds left (a part minute counts as a minute). */
export const cooldownMinutes = (seconds: number): number => Math.max(1, Math.ceil(seconds / 60));

/** The input fields' first values: the demo date and time now, in the clock's zone. */
export function defaultFields(now: Instant, zone: string): { date: string; time: string } {
  return { date: localDateOf(now, zone), time: localTimeOf(now, zone) };
}

export type TypedMove = { ok: true; wire: string } | { ok: false; why: 'empty' | 'not_forward' };

/**
 * CTL-OFC-17-03: a typed date and time as the wire time API-12 takes. An empty field is no move; a time that is not after the clock is
 * refused here with the spec's message and no call. A wall time in the fall-back hour takes the earlier of its two instants.
 */
export function typedMove(date: string, time: string, zone: string, now: Instant): TypedMove {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { ok: false, why: 'empty' };
  let at: Instant;
  try {
    at = atLocal(date, time, zone, 'earlier');
  } catch {
    return { ok: false, why: 'empty' };
  }
  if (at.epochMilliseconds <= now.epochMilliseconds) return { ok: false, why: 'not_forward' };
  return { ok: true, wire: toWire(at, zone) };
}

/** CTL-OFC-17-04: a preset is disabled when API-11 says it is not reachable (its target is not after demo now). */
export const presetOff = (p: Pick<Preset, 'reachable'>): boolean => !p.reachable;

/** The catalog key of a refused move's message (Errors to UI of CTL-OFC-17-03 to -05 and CTL-OFC-27-02). */
export function refusalKey(code: string): MessageKey {
  switch (code) {
    case 'not_forward':
      return 'admin.clock.err.notForward';
    case 'replay_running':
      return 'admin.clock.err.catchingUp';
    case 'bad_time':
      return 'admin.clock.err.badTime';
    case 'cooldown':
      return 'admin.clock.err.cooldown';
    default:
      return 'admin.clock.err.failed';
  }
}

/** Where a message shows: by the control that was pressed (state Refused). */
export type Place = 'jump' | 'presets' | 'pause' | 'reset';

/** The progress bar's width: done of total, whole percent, never past 100 (a total of 0 is an empty bar). */
export function progressWidth(done: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.min(100, Math.max(0, Math.round((done / total) * 100)))}%`;
}

/** "Tue, Sep 15, 7:00 AM": a wire time without its zone, as the page's buttons and notes print it (the catalog's weekday and month names). */
export function shortWhen(at: Instant, zone: string, lang: Language, t: T): string {
  const p = dateParts(at, zone);
  return t('shell.clock.short', {
    weekday: t(`time.weekday.${p.weekday}` as MessageKey),
    month: t(`time.month.${p.month}` as MessageKey),
    day: p.day,
    time: formatTime(at, zone, lang),
  });
}
