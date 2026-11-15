// SPDX-License-Identifier: AGPL-3.0-or-later
// The native Map, Parts and Me rules (model.ts) against the web app's (apps/web/src/tech/model.ts, view-model.ts and map/map-model.ts): the native app
// imports no web code (SD-2), so the rules are written again, and these tests run both on the same inputs.
import { describe, expect, it } from 'vitest';
import * as web from '../../../../web/src/tech/model.ts';
import * as webView from '../../../../web/src/tech/view-model.ts';
import * as webMap from '../../../../web/src/map/map-model.ts';
import * as webSteps from '../../../../web/src/tech/steps.ts';
import { formatterFor } from '@bw/i18n/src/format.ts';
import * as native from './model.ts';
import * as nativeSteps from './steps.ts';

const PARTS = [
  { partId: 1, code: 'FLT-16254', name: 'Furnace filter 16x25x4 MERV 11', priceCents: 2400 },
  { partId: 2, code: 'RCK-1625', name: 'Filter rack, 16x25, 4 in', priceCents: 4600 },
  { partId: 3, code: 'CAP-45', name: 'Run capacitor 45/5 MFD', priceCents: 1850 },
] as never[];

describe('the search of the parts list', () => {
  // why: FR-TECH-10 the native search finds what the web search finds: every word, name or code, any case, and the same count line
  it('matches the web app on words, codes, case and no match', () => {
    for (const q of ['filter', 'FLT', 'filter rack', '  Furnace   16x25 ', 'zzqx', '', 'cap 45']) {
      expect(native.searchParts(PARTS, q), q).toEqual(web.searchParts(PARTS, q));
      expect(native.partsPhase(PARTS, q), q).toBe(webView.partsPhase(PARTS, q));
    }
    expect(native.partsPhase(null, 'x')).toBe('nocopy');
    expect(native.priceText(2400)).toBe(web.priceText(2400));
    expect(native.PARTS_SHOWN).toBe(web.PARTS_SHOWN);
  });
});

describe('the Me screen\'s day', () => {
  // why: FR-TECH-15 the hours, the start of the day, the jobs done and the day-changed notices come out as the web app computes them
  it('matches the web app on the start, the clock, jobs done and what changed in the day', () => {
    const a = '2026-09-15T07:45:00-04:00[America/New_York]';
    const b = '2026-09-15T07:40:00-04:00[America/New_York]';
    const now = '2026-09-15T10:26:00-04:00[America/New_York]';
    expect(native.startOfDay(a, b)).toBe(web.startOfDay(a, b));
    expect(native.startOfDay(null, b)).toBe(web.startOfDay(null, b));
    expect(native.startOfDay(a, null)).toBe(web.startOfDay(a, null));
    expect(native.minutesOnClock(a, now)).toBe(web.minutesOnClock(a, now));
    expect(native.minutesOnClock(now, a)).toBe(0);
    const stops = [{ state: 'done' }, { state: 'next' }, { state: 'later' }] as never[];
    expect(native.jobsDone(stops)).toBe(web.jobsDone(stops));
    const day1 = { date: '2026-09-15', jobs: [{ jobNumber: 1, window: { start: 'a', end: 'b' } }, { jobNumber: 2, window: { start: 'a', end: 'b' } }] };
    const day2 = { date: '2026-09-15', jobs: [{ jobNumber: 2, window: { start: 'c', end: 'd' } }, { jobNumber: 3, window: { start: 'a', end: 'b' } }] };
    expect(native.dayChanges(native.snapshotOf(day1), native.snapshotOf(day2))).toEqual(web.dayChanges(web.snapshotOf(day1), web.snapshotOf(day2)));
    expect(native.dayChanges(native.snapshotOf(day1), native.snapshotOf(day2)).map((c) => c.kind).sort()).toEqual(['added', 'removed', 'window']);
    expect(native.dayChanges(null, native.snapshotOf(day2))).toEqual([]);
    expect(native.TEXT_PERCENT).toEqual(web.TEXT_PERCENT);
    expect(native.TEXT_SIZES).toEqual(web.TEXT_SIZES);
    const waiting = [{ kind: 'note', demoTime: '2026-09-15T09:00:00-04:00[America/New_York]' }, { kind: 'arrived', demoTime: '2026-09-15T09:30:00-04:00[America/New_York]' },
      { kind: 'on_my_way', demoTime: '2026-09-15T08:50:00-04:00[America/New_York]' }];
    expect(native.phoneStart(waiting, '2026-09-15')).toBe(webView.phoneStart(waiting as never, '2026-09-15'));
    expect(native.phoneStart(waiting, '2026-09-16')).toBeNull();
    expect([...native.ENDING_KINDS]).toEqual([...webView.ENDING_KINDS]);
  });
});

describe('the Map and Directions states', () => {
  const route = (stops: { state: string }[], next: number | null) => ({ stops, next, legs: [] }) as never;
  // why: FR-TECH-11 the Map tab is in the same frame state as the web Map tab for the same day, signal and read
  it('matches the web app on the Map tab\'s phase and the Directions screen\'s phase', () => {
    const cases: [ReturnType<typeof route> | null, boolean, boolean][] = [
      [null, false, false], [null, true, true], [route([], null), false, true], [route([], null), true, true],
      [route([{ state: 'done' }], null), false, true], [route([{ state: 'next' }], 1), false, true], [route([{ state: 'next' }], 1), true, true], [null, false, true],
    ];
    for (const [r, offline, settled] of cases) expect(native.mapPhase(r, offline, settled)).toBe(webView.mapPhase(r, offline, settled));
  });

  // The turn-by-turn rules are 2 copies (D-20): steps.ts here and apps/web/src/tech/steps.ts. F-1313: the line that held the 2 apps' Directions states
  // equal came out with P6-NATIVE-STEPS (its states became kit 0.9's) and is back, over the same inputs, with the Route updated rule and the step rows.
  const STEP = (kind: string, road: string | null, distanceMeters: number, at: [number, number], o: Record<string, unknown> = {}) =>
    ({ kind, direction: null, heading: null, road, exit: null, side: null, at, distanceMeters, ...o }) as never;
  const A = [
    STEP('depart', 'Cleveland Ave', 483, [-82.93, 40.12], { heading: 'n' }), STEP('turn', 'E Schrock Rd', 1931, [-82.93, 40.13], { direction: 'right' }),
    STEP('exit', 'Ramp', 90, [-82.94, 40.13], { direction: 'slight_right' }), STEP('uturn', 'Cobblestone Dr', 322, [-82.95, 40.13]), STEP('arrive', 'Cobblestone Dr', 0, [-82.96, 40.13], { side: 'left' }),
  ];
  const line = (steps: never[], track: boolean, from: [number, number] = [-82.93, 40.12]): Record<string, unknown> => ({
    leg: { toJob: 1, from: { lon: from[0], lat: from[1] }, to: { lon: -82.96, lat: 40.13 }, track: track ? [[-82.93, 40.12], [-82.96, 40.13]] : null, minutes: 11, distanceMeters: track ? 2826 : null },
    branch: 'columbus', steps, at: '2026-09-15T10:26:00-04:00[America/New_York]',
  });
  // why: FR-TECH-5 the native Directions states, step rows, Next turn card and Route updated rule are the web app's on the same inputs (D-20; F-1313, F-1317)
  it('matches the web app on the Directions states, the step rows, the next turn and whether a re-read is another route', () => {
    const routed = { kind: 'leg', ...line(A as never[], true) } as never;
    const approx = { kind: 'leg', ...line([], false) } as never;
    for (const read of [null, routed, approx, { kind: 'moved' }, { kind: 'failed' }] as never[]) {
      for (const offline of [false, true]) {
        for (const kept of [false, true]) for (const hasJob of [false, true]) expect(nativeSteps.stepsPhase(read, offline, kept, hasJob)).toBe(webSteps.stepsPhase(read, offline, kept, hasJob));
      }
    }
    for (const lang of ['en', 'es'] as const) {
      const t = formatterFor(lang);
      for (const now of [true, false]) expect(nativeSteps.stepRows(A as never[], t, '2271 Cobblestone Dr', now)).toEqual(webSteps.stepRows(A as never[], t, '2271 Cobblestone Dr', now));
      expect(nativeSteps.nextTurn(A as never[], t, '2271 Cobblestone Dr')).toEqual(webSteps.nextTurn(A as never[], t, '2271 Cobblestone Dr'));
      expect(nativeSteps.nextTurn(A.slice(4) as never[], t, 'x')).toEqual(webSteps.nextTurn(A.slice(4) as never[], t, 'x'));
    }
    for (const st of A) expect(nativeSteps.stepIcon(st)).toBe(webSteps.stepIcon(st));
    expect(nativeSteps.streetOf('2271 Cobblestone Dr, Westerville')).toBe(webSteps.streetOf('2271 Cobblestone Dr, Westerville'));
    expect(nativeSteps.stepsMeters(A as never[])).toBe(webSteps.stepsMeters(A as never[]));
    // Route updated: the rest of the route, a routed and an approximate leg replacing each other, another destination, another way, and the van along
    // (and past the end of) the straight line (F-1317).
    // on the extension of the shown line, 0.2 of its length past the destination (0 m across, past the end), so it reaches the upper bound
    const beyond: [number, number] = [-82.966, 40.132];
    const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
      [line(A as never[], true), line(A.slice(2) as never[], true)], [line(A as never[], true), line(A as never[], true)], [line(A as never[], true), line([], false)],
      [line([], false), line(A as never[], true)], [line(A.slice(2) as never[], true), line(A as never[], true)], [line([], false), line([], false, [-82.945, 40.125])],
      [line([], false), line([], false, [-82.92, 40.115])], [line([], false), line([], false, beyond)], [line([], false, [-82.945, 40.125]), line([], false, [-82.93, 40.12])],
    ];
    expect(webSteps.isRestOf(line([], false) as never, line([], false, beyond) as never)).toBe(false);
    expect(nativeSteps.isRestOf(line([], false) as never, line([], false, beyond) as never)).toBe(false);
    // F-1296 the read of API-104 with and without steps: the same answer parsed by both copies
    const answer = (steps?: unknown) => ({ branch: 'columbus', leg: { toJob: 1, from: { lon: -82.93, lat: 40.12 }, to: { lon: -82.96, lat: 40.13 }, track: null, minutes: 11, distanceMeters: null }, insideWindow: true, ...(steps === undefined ? {} : { steps }) });
    for (const wire of [undefined, [], A, [{ kind: 'teleport' }]]) {
      const w = webSteps.routeRead.response.safeParse(answer(wire));
      const n = nativeSteps.routeRead.response.safeParse(answer(wire));
      expect(n.success).toBe(w.success);
      expect(n.data).toEqual(w.data);
    }
    for (const [shown, next] of pairs) expect(nativeSteps.isRestOf(shown as never, next as never)).toBe(webSteps.isRestOf(shown as never, next as never));
  });

  // why: FR-MAP-1 the branch files, their centers and boxes and the name layers are the web map's, so the native map opens where the web map does
  it('has the web map\'s branch boxes, name layers and credit link', () => {
    expect(native.BRANCH_MAPS).toEqual(webMap.BRANCH_MAPS);
    expect(native.BRANCH_IDS).toEqual(webMap.BRANCH_IDS);
    expect(native.NAME_LAYERS).toEqual(webMap.NAME_LAYERS);
    expect(native.OSM_COPYRIGHT_URL).toBe(webMap.OSM_COPYRIGHT_URL);
    expect(native.isBranchId('dayton')).toBe(true);
    expect(native.isBranchId('toledo')).toBe(false);
    expect(native.branchName('springfield')).toBe('Springfield');
    expect(native.branchName(null)).toBe('Columbus');
  });

  // why: FR-MAP-3 a leg with a baked track is drawn along it and one with none is the straight line, labeled approximate, as on the web map
  it('draws a leg along its track, else straight, as the web app\'s routeLine does', () => {
    const track = [[-83, 40], [-83.1, 40.1], [-83.2, 40.2]] as const;
    const withTrack = { id: 'a', from: [-83, 40] as const, to: [-83.2, 40.2] as const, track };
    const without = { id: 'b', from: [-83, 40] as const, to: [-83.2, 40.2] as const, track: null };
    expect(native.legLine(withTrack)).toEqual({ coordinates: webMap.routeLine(withTrack).coordinates, approximate: false });
    expect(native.legLine(without)).toEqual({ coordinates: webMap.routeLine(without).coordinates, approximate: true });
    expect(native.legLine({ ...withTrack, track: [[-83, 40]] }).approximate).toBe(true);
  });

  // why: FR-TECH-13 the drive time and the distance line are built as the web card builds them: miles to 1 decimal, none on an approximate leg
  it('writes the service line of the Next stop card as the web app does', () => {
    expect(native.miles(9334)).toBe(web.miles(9334));
    expect(native.miles(null)).toBeNull();
    const say = (key: string, v?: Record<string, string | number>) => `${key}:${JSON.stringify(v ?? {})}`;
    const exact = { minutes: 12, distanceMeters: 9334 } as never;
    const approx = { minutes: 12, distanceMeters: null } as never;
    expect(native.distText(say as never, 'en', exact, 'service.tuneup')).toContain('"mi":"5.8"');
    expect(native.distText(say as never, 'en', approx, 'service.tuneup')).toContain('tech.map.distApprox');
    expect(native.distText(say as never, 'en', exact, 'service.tuneup')).toBe(webView.distText(say as never, exact, 'service.tuneup'));
  });
});
