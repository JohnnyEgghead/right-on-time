// SPDX-License-Identifier: AGPL-3.0-or-later
// The demo clock page's logic (model.ts): a typed time as a wire time and its refusals, the preset states, the cool-down, and which moves are off.
import { catalogs } from '@bw/i18n';
import { fromWire } from '@bw/time';
import { describe, expect, it } from 'vitest';
import { cooldownMinutes, defaultFields, movesOff, presetOff, progressShown, progressWidth, refusalKey, resetOff, RESET_TARGET, shortWhen, typedMove } from './model.ts';
import { CATCHING_UP, COOLDOWN, JUMPED, presetsAt, RUNNING } from './preview-data.ts';

const t = (key: string, values: Record<string, string | number> = {}): string =>
  (catalogs.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? `{${k}}`));
const Z = 'America/New_York';
const now = fromWire(RUNNING.demoNow).toInstant();

describe('a typed date and time (FR-DEMO-5, CTL-OFC-17-03)', () => {
  // why: FR-DEMO-5 a typed time after the clock is sent as the wire time API-12 takes: local time, offset and zone
  it('turns a typed date and time into an RFC 9557 wire time in the clock zone', () => {
    expect(typedMove('2026-09-15', '18:05', Z, now)).toEqual({ ok: true, wire: '2026-09-15T18:05:00-04:00[America/New_York]' });
    // The offset follows the date: Nov 1 after 2:00 AM is EST (NFR-08, the daylight-saving cases visible on screen).
    expect(typedMove('2026-11-01', '17:55', Z, now)).toEqual({ ok: true, wire: '2026-11-01T17:55:00-05:00[America/New_York]' });
    expect(typedMove('2027-03-14', '07:00', Z, now)).toEqual({ ok: true, wire: '2027-03-14T07:00:00-04:00[America/New_York]' });
  });
  // why: FR-DEMO-4 a time at or before the clock is refused on the page with no call: the clock moves forward only
  it('refuses a time that is not after the clock, and the clock time itself', () => {
    expect(typedMove('2026-09-15', '09:00', Z, now)).toEqual({ ok: false, why: 'not_forward' });
    expect(typedMove('2026-09-15', '10:28', Z, now)).toEqual({ ok: false, why: 'not_forward' });
    expect(typedMove('2026-09-15', '10:29', Z, now).ok).toBe(true);
  });
  // why: FR-DEMO-5 an empty or half-typed field is no move
  it('treats an empty date or time as no move', () => {
    expect(typedMove('', '18:05', Z, now)).toEqual({ ok: false, why: 'empty' });
    expect(typedMove('2026-09-15', '', Z, now)).toEqual({ ok: false, why: 'empty' });
    expect(typedMove('2026-09-15', '6:05 PM', Z, now)).toEqual({ ok: false, why: 'empty' });
  });
  // why: FR-DEMO-5 the fields start at the clock's own date and time in its zone
  it('starts the fields at the clock date and time', () => {
    expect(defaultFields(now, Z)).toEqual({ date: '2026-09-15', time: '10:28' });
  });
});

describe('the presets (FR-DEMO-5, CTL-OFC-17-04)', () => {
  // why: FR-DEMO-5 the 6 presets are 6:00 PM reminder, Tomorrow 8:00 AM, Sat Oct 31, Sun Nov 1, Sat Mar 13 2027 and Sun Mar 14 2027, in that order, with catalog labels
  it('lists the 6 presets in screen order with their labels', () => {
    const labels = presetsAt().map((p) => t(p.labelKey));
    expect(labels).toEqual(['6:00 PM reminder', 'Tomorrow 8:00 AM', 'Sat, Oct 31', 'Sun, Nov 1', 'Sat, Mar 13, 2027', 'Sun, Mar 14, 2027']);
  });
  // why: FR-DEMO-5 a preset the clock has passed is disabled (Earlier than the clock. Reset first.); one ahead is on
  it('disables a preset that is not reachable', () => {
    expect(presetsAt((id) => id !== 'reminder_6pm').map(presetOff)).toEqual([true, false, false, false, false, false]);
    expect(t('admin.clock.err.earlier')).toBe('Earlier than the clock. Reset first.');
  });
  // why: FR-DEMO-5 the daylight-saving presets land on the day before and the day of the change, with the zone abbreviation the page shows
  it('prints the daylight-saving presets on their dates', () => {
    const when = (id: string) => {
      const z = fromWire(presetsAt().find((p) => p.presetId === id)!.target);
      return shortWhen(z.toInstant(), z.timeZoneId, 'en', t);
    };
    expect(when('sat_oct_31')).toBe('Sat, Oct 31, 7:00 AM');
    expect(when('sun_nov_1')).toBe('Sun, Nov 1, 5:55 PM');
    expect(when('sat_mar_13_2027')).toBe('Sat, Mar 13, 7:00 AM');
    expect(when('sun_mar_14_2027')).toBe('Sun, Mar 14, 7:00 AM');
  });
});

describe('which controls are off (CTL-OFC-17-03 to -08)', () => {
  // why: FR-DEMO-3 while a replay runs, the moves are off and the page says the clock is still catching up
  it('turns the moves and Reset off while a replay runs', () => {
    expect(movesOff(RUNNING)).toBeNull();
    expect(movesOff(CATCHING_UP)).toBe('catching_up');
    expect(resetOff(CATCHING_UP)).toBe('catching_up');
    expect(t('admin.clock.err.catchingUp')).toBe('The clock is still catching up.');
  });
  // why: FR-DEMO-6 Reset is off during the cool-down after a reset, and on again when it is over
  it('turns Reset off during the cool-down only', () => {
    expect(resetOff(COOLDOWN)).toBe('cooldown');
    expect(resetOff({ ...COOLDOWN, resetAvailableInSeconds: 0 })).toBeNull();
    expect(resetOff(JUMPED)).toBeNull();
  });
  // why: FR-DEMO-6 the cool-down reads in whole minutes, a part minute counting as 1
  it('rounds the cool-down up to whole minutes', () => {
    expect([1, 59, 60, 61, 240, 300].map(cooldownMinutes)).toEqual([1, 1, 1, 2, 4, 5]);
    expect(t('admin.clock.next', { minutes: 4 })).toContain('Next reset allowed in');
  });
  // why: CTL-OFC-17-07 the progress bar shows only while a replay runs; an unconfirmed reset (F-919) holds running true with 0 of 0 events (F-1173)
  it('draws no progress for an unconfirmed reset (running, 0 of 0) and keeps the moves off', () => {
    const unconfirmed = { ...RUNNING, replay: { running: true, done: 0, total: 0 } };
    expect(progressShown(unconfirmed)).toBe(false);
    expect(movesOff(unconfirmed)).toBe('catching_up');
    expect(progressShown(CATCHING_UP)).toBe(true);
    expect(progressShown(RUNNING)).toBe(false);
  });
  // why: FR-DEMO-5 the progress bar reads done of total as a whole percent and never leaves 0 to 100
  it('sets the progress bar width from done and total', () => {
    expect([progressWidth(120, 340), progressWidth(0, 0), progressWidth(5, 3), progressWidth(-1, 10)]).toEqual(['35%', '0%', '100%', '0%']);
  });
});

describe('a refused move (Errors to UI)', () => {
  // why: FR-DEMO-4 each refusal code has its own message; an unknown one gets the generic try-again text
  it('maps not_forward, replay_running and cooldown to their messages', () => {
    expect(t(refusalKey('not_forward'))).toBe('The clock only moves forward. To go back, reset the world.');
    expect(t(refusalKey('replay_running'))).toBe('The clock is still catching up.');
    expect(refusalKey('cooldown')).toBe('admin.clock.err.cooldown');
    expect(refusalKey('bad_time')).toBe('admin.clock.err.badTime');
    expect(refusalKey('network')).toBe('admin.clock.err.failed');
  });
  // why: FR-DEMO-4 the reset goes back to Tue, Sep 15, 7:00 AM, the day the sample world starts
  it('names the day the world resets to', () => {
    const z = fromWire(RESET_TARGET);
    expect(t('admin.clock.reset.button', { when: shortWhen(z.toInstant(), z.timeZoneId, 'en', t) })).toBe('Reset to Tue, Sep 15, 7:00 AM');
  });
});
