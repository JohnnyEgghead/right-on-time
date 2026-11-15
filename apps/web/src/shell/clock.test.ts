// SPDX-License-Identifier: AGPL-3.0-or-later
import { Temporal } from '@bw/time';
import { describe, expect, it } from 'vitest';
import { serverT } from './i18n-server.ts';
import { advance, bannerLine, clockText, moveKey, shortText, toView, type ClockAnswer } from './clock.ts';

const ANSWER: ClockAnswer = { demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', rate: 1, paused: false, worldEpoch: 1 };
const en = serverT('en');
const es = serverT('es');

describe('CMP-01 demo clock', () => {
  // why: FR-DEMO-1 the header shows the current demo time and date ("Demo clock" with the demo time)
  it('shows the demo time API-10 answers with weekday, date, time and zone, in both languages', () => {
    const v = toView(ANSWER);
    expect(v.zone).toBe('America/New_York');
    expect(clockText(v.at, v.zone, 'en', en)).toBe('Tue, Sep 15, 10:28 AM EDT');
    expect(clockText(v.at, v.zone, 'es', es)).toBe('mar, 15 de sep, 10:28 AM EDT');
    expect(en('shell.clock.label')).toBe('Demo clock');
  });

  // why: FR-DEMO-1 the shown time follows the demo clock, never the device clock's now (FR-DEMO-2)
  it('advances from the anchor by the elapsed real time times the rate, and not at all while paused', () => {
    const v = toView(ANSWER);
    expect(advance(v, 90_000).equals(v.at.add({ seconds: 90 }))).toBe(true);
    expect(advance(toView({ ...ANSWER, rate: 60 }), 1_000).equals(v.at.add({ minutes: 1 }))).toBe(true);
    expect(advance(toView({ ...ANSWER, paused: true }), 3_600_000).equals(v.at)).toBe(true);
    expect(advance(v, -5).equals(v.at)).toBe(true);
  });

  // why: FR-DEMO-1 the header clock names its zone (UD-15)
  it('names the zone across the fall-back change (EDT, then EST)', () => {
    const before = toView({ ...ANSWER, demoNow: '2026-11-01T01:30:00-04:00[America/New_York]' });
    const after = before.at.add(Temporal.Duration.from({ hours: 1 }));
    expect(clockText(before.at, before.zone, 'en', en)).toBe('Sun, Nov 1, 1:30 AM EDT');
    expect(clockText(after, before.zone, 'en', en)).toBe('Sun, Nov 1, 1:30 AM EST');
  });
});

describe('CMP-02 clock banner', () => {
  // why: FR-DEMO-1 the strip carries the clock banner (CTL-CMP-02-01, CTL-CMP-02-02)
  it('shows a running replay first, then the last move, else nothing', () => {
    expect(bannerLine(ANSWER)).toBeNull();
    const moved = { ...ANSWER, lastMove: { by: 'Dana Ruiz', kind: 'jump' as const, toDemo: '2026-09-15T18:05:00-04:00[America/New_York]' } };
    expect(bannerLine(moved)).toBe('move');
    expect(bannerLine({ ...moved, replay: { running: true, done: 120, total: 340 } })).toBe('replay');
    expect(bannerLine({ ...moved, replay: { running: false, done: 340, total: 340 } })).toBe('move');
  });

  // why: FR-DEMO-1 the last-move line names who moved the clock and the demo time it moved to (UD-26)
  it('names the person, or the automatic reset, that moved the clock', () => {
    const to = '2026-09-15T18:05:00-04:00[America/New_York]';
    expect(moveKey({ by: 'Dana Ruiz', kind: 'jump', toDemo: to })).toBe('shell.clock.moved.jump');
    expect(moveKey({ by: 'nightly', kind: 'reset', toDemo: to })).toBe('shell.clock.moved.nightly');
    expect(moveKey({ by: 'idle', kind: 'reset', toDemo: to })).toBe('shell.clock.moved.idle');
    const v = toView({ ...ANSWER, demoNow: to });
    expect(shortText(v.at, v.zone, 'en', en)).toBe('Tue, Sep 15, 6:05 PM');
    expect(en('shell.clock.catchingUp', { done: 120, total: 340 })).toBe('Catching up on events: 120 of 340');
  });
});
