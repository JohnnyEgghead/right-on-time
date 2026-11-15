// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-22, FR-TEXT-4, NFR-04 (the live map page's rules: the minutes line, the trip progress, the ended page's variant, and a failed read never keeping a van)
import { describe, expect, it } from 'vitest';
import type { ClientT } from '../shell/intl.tsx';
import { endedHistoryState, endedOf, endedVariant, firstName, heroLine, nextState, progressPercent, shownState, visitLine, type LiveData, type LiveState } from './model.ts';
import { ARRIVED, CHANGED, LIVE_DATA } from './preview-data.ts';

const Z = '[America/New_York]';
const at = (hhmm: string) => `2026-09-15T${hhmm}-04:00${Z}`;
const t = ((key: string, values?: Record<string, string | number>) => `${key}${values ? JSON.stringify(values) : ''}`) as unknown as ClientT;

describe('the trip progress and the minutes line (FR-TEXT-22)', () => {
  // why: FR-TEXT-22
  it('runs the bar from the time the technician left to the arrival time, at the server\'s demo time', () => {
    expect(progressPercent(at('10:28:00'), at('10:40:00'), at('10:28:00'))).toBe(0);
    expect(progressPercent(at('10:28:00'), at('10:40:00'), at('10:34:00'))).toBe(50);
    expect(progressPercent(at('10:28:00'), at('10:40:00'), at('10:30:10'))).toBe(18);
    expect(progressPercent(at('10:28:00'), at('10:40:00'), at('10:55:00'))).toBe(100);
    expect(progressPercent(at('10:28:00'), at('10:28:00'), at('10:29:00'))).toBe(100);
    expect(progressPercent(at('10:28:00'), null, at('10:29:00'))).toBe(0);
  });

  // why: FR-TEXT-22
  it('says the minutes until arrival and the arrival time, in 2 parts so the time can stand bold', () => {
    expect(heroLine(t, 12, at('10:40:00'))).toEqual({ lead: 'livemap.hero.min{"n":12}', time: '10:40 AM' });
    expect(heroLine(t, 1, at('10:40:00'))?.lead).toBe('livemap.hero.min1');
    expect(heroLine(t, 0, at('10:40:00'))?.lead).toBe('livemap.hero.min1');
    expect(heroLine(t, null, at('10:40:00'))).toBeNull();
    expect(firstName('Maria Santos')).toBe('Maria');
  });
});

describe('what a read makes of the page (FR-TEXT-4, NFR-04)', () => {
  const live: LiveState = { kind: 'live', data: LIVE_DATA, now: at('10:30:10'), failed: false };
  const gone = (detail: Record<string, unknown>) => ({ ok: false as const, code: 'gone', status: 410, detail });

  // why: FR-TEXT-4
  it('takes a 410 as the ended page, by arrival or the visit changed, and a 410 with no reason as a failure with no van', () => {
    expect(nextState(live, gone({ ...ARRIVED }))).toEqual({ kind: 'ended', detail: ARRIVED });
    expect(nextState(live, gone({ ...CHANGED }))).toEqual({ kind: 'ended', detail: CHANGED });
    expect(nextState(live, gone({ reason: 'later' }))).toEqual({ kind: 'failed' });
    expect(endedOf({ reason: 'changed' })).toMatchObject({ reason: 'changed', visit: null, technician: null, officePhone: null });
  });

  // why: NFR-04
  it('removes the van on a failed read and never brings it back once the page has ended', () => {
    const failed = nextState(live, { ok: false, code: 'offline', status: 0, detail: {} });
    expect(failed).toMatchObject({ kind: 'live', failed: true });
    expect(nextState(failed, { ok: true, data: LIVE_DATA as LiveData, now: at('10:31:00') })).toMatchObject({ kind: 'live', failed: false });
    const ended: LiveState = { kind: 'ended', detail: ARRIVED };
    expect(nextState(ended, { ok: false, code: 'offline', status: 0, detail: {} })).toBe(ended);
    expect(nextState({ kind: 'loading' }, { ok: false, code: 'offline', status: 0, detail: {} })).toEqual({ kind: 'failed' });
    expect(nextState(live, { ok: false, code: 'not_found', status: 404, detail: {} })).toEqual({ kind: 'not_found' });
  });

  // why: FR-TEXT-4
  it('draws the Visit changed page from the office phone alone, and the arrival page only with its arrival', () => {
    expect(endedVariant(ARRIVED)).toBe('arrived');
    expect(endedVariant(CHANGED)).toBe('changed');
    // an arrival-less 410 still reads as the plain ended page; no preview or frame draws it any more (F-1140)
    expect(endedVariant({ ...ARRIVED, arrivedAt: null })).toBe('ended');
    expect(JSON.stringify(CHANGED)).not.toMatch(/lon|lat|Maria|window/);
  });

  // why: FR-TEXT-4
  it('keeps the ended page when a 200 answers a read that was sent before the 410', () => {
    const ended: LiveState = { kind: 'ended', detail: ARRIVED };
    expect(nextState(ended, { ok: true, data: LIVE_DATA as LiveData, now: at('10:31:00') })).toBe(ended);
    const gone: LiveState = { kind: 'not_found' };
    expect(nextState(gone, { ok: true, data: LIVE_DATA as LiveData, now: at('10:31:00') })).toBe(gone);
    // The race: a read in flight across the arrival answers 200 after the 410 read answered.
    let s: LiveState = live;
    s = nextState(s, { ok: false, code: 'gone', status: 410, detail: { ...ARRIVED } });
    s = nextState(s, { ok: true, data: LIVE_DATA as LiveData, now: at('10:30:50') });
    expect(s).toEqual({ kind: 'ended', detail: ARRIVED });
  });

  // why: FR-TEXT-4
  it('holds the kept live view and its van back after a page-cache restore until the re-read answers', () => {
    expect(shownState(live, true)).toEqual({ kind: 'loading' });
    expect(shownState(live, false)).toBe(live);
    const ended: LiveState = { kind: 'ended', detail: ARRIVED };
    expect(shownState(ended, true)).toBe(ended);
  });

  // why: FR-TEXT-4
  it('marks the ended page on its history entry and keeps the router\'s own keys', () => {
    expect(endedHistoryState({ tree: 1 })).toEqual({ tree: 1, bwLiveMap: 'ended' });
    expect(endedHistoryState(null)).toEqual({ bwLiveMap: 'ended' });
  });
});

describe('the visit window names the branch zone (FR-TEXT-17)', () => {
  // why: FR-TEXT-17
  it('prints the zone after the window in the visit line, EDT in September and EST in November', () => {
    const visit = (day: string, off: string, a: string, b: string) => ({ ...LIVE_DATA.visit, day, window: { start: `${day}T${a}:00${off}${Z}`, end: `${day}T${b}:00${off}${Z}` } });
    expect(visitLine(t, visit('2026-09-15', '-04:00', '10:00', '12:00'), at('10:28:00'))).toContain('"window":"10 AM-12 PM EDT"');
    expect(visitLine(t, visit('2026-11-10', '-05:00', '10:00', '12:00'), `2026-11-10T09:00:00-05:00${Z}`)).toContain('"window":"10 AM-12 PM EST"');
  });
});
