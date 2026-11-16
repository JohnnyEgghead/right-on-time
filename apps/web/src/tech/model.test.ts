// SPDX-License-Identifier: AGPL-3.0-or-later
// The map, parts and Me screens' pure rules (model.ts, view-model.ts, install.ts, session.ts): P5-TWA-MAP-ME. The browsers and the real server
// run the screens in ci/mapme-stack (the stack suite); the look is held by ci/look-values/tech-map.pw.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { installKind, installSeen, markInstallSeen } from './install.ts';
import {
  dayChanges, jobsDone, legTo, loginKey, miles, minutesOnClock, priceText, searchParts, snapshotOf, startOfDay, TEXT_PERCENT,
  type Part, type RouteData,
} from './model.ts';
import { ownItems } from './useOutbox.ts';
import { clearSignOutOwed, endSession, forgetShell, signOutOwed } from './session.ts';
import { distText, durationText, mapLayers, mapPhase, mapSummary, mePhase, partsPhase, phoneStart } from './view-model.ts';

const PARTS: Part[] = [
  { partId: '1', name: 'Run capacitor 45/5 MFD', code: 'CAP-455', priceCents: 3800 },
  { partId: '2', name: 'Furnace filter 16x25x4 MERV 11', code: 'FLT-16254', priceCents: 2400 },
  { partId: '3', name: 'Furnace filter 20x20x1 MERV 8', code: 'FLT-20201', priceCents: 900 },
  { partId: '4', name: 'Pressure switch', code: 'PSW-100', priceCents: 6100 },
];

const at = (hhmm: string) => `2026-09-15T${hhmm}-04:00[America/New_York]`;
const win = (a: string, b: string) => ({ start: at(`${a}:00:00`), end: at(`${b}:00:00`) });
const stop = (n: number, job: number, state: 'done' | 'next' | 'later') => ({
  jobNumber: job, number: n, customer: `Customer ${n}`, area: 'Westerville', address: `${n} Main St, Westerville`, window: win('10', '12'),
  serviceLabelKey: 'service.furnace_tune_up.screen', state, at: { lon: -82.9 + n / 100, lat: 40.1 },
});
const leg = (job: number, track: [number, number][] | null, minutes: number, distanceMeters: number | null) => ({
  toJob: job, from: { lon: -82.95, lat: 40.1 }, to: { lon: -82.9, lat: 40.1 }, track, minutes, distanceMeters,
});
const ROUTE: RouteData = {
  date: '2026-09-15', branch: 'columbus',
  stops: [stop(1, 101, 'done'), stop(2, 102, 'next'), stop(3, 103, 'later')],
  legs: [leg(101, [[-83, 40]], 8, 3000), leg(102, [[-82.95, 40.1], [-82.9, 40.1]], 12, 9335), leg(103, null, 9, null)],
  next: 102,
};

/** A message stub that fills {name} and returns the key's English text for the keys the tests read. */
const TEXT: Record<string, string> = {
  'tech.map.dist': '{n} min, {mi} mi - {service}',
  'tech.map.distApprox': '{n} min - {service}',
  'service.furnace_tune_up.screen': 'Furnace tune-up',
  'tech.map.stopWords': 'Stop {n}, {state}: {customer}, {area}',
  'tech.map.state.next': 'Next', 'tech.map.state.done': 'Done', 'tech.map.state.later': 'Later',
  'tech.me.hm': '{h} hr {m} min', 'tech.me.m': '{m} min',
  'tech.map.title': "Today's route", 'tech.map.summaryOpen': "Today's route - {stops} stops", 'tech.map.summary': "Today's route - {stops} stops - {done} done",
};
const t = Object.assign(
  (key: string, values: Record<string, string | number> = {}) => (TEXT[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k])),
  { lang: 'en' as const, rich: () => null },
) as never;

describe('Parts search (SCR-TEC-16)', () => {
  // why: FR-TECH-10 the Parts tab finds a part by its name or its code, in any case, and lists its code and price
  it('finds a part by name or by code', () => {
    expect(searchParts(PARTS, 'capacitor').shown.map((p) => p.code)).toEqual(['CAP-455']);
    expect(searchParts(PARTS, 'flt-20201').shown.map((p) => p.name)).toEqual(['Furnace filter 20x20x1 MERV 8']);
    expect(searchParts(PARTS, 'FILTER').matched).toBe(2);
    expect(searchParts(PARTS, 'furnace merv 11').shown.map((p) => p.code)).toEqual(['FLT-16254']);
    expect(priceText(3800)).toBe('$38.00');
  });

  // why: FR-TECH-10 a search with nothing typed lists nothing, and one nothing matches says so
  it('lists nothing for an empty search and counts a miss as 0', () => {
    expect(searchParts(PARTS, '   ')).toEqual({ shown: [], matched: 0 });
    expect(searchParts(PARTS, 'capacitr')).toEqual({ shown: [], matched: 0 });
    expect(partsPhase(PARTS, '')).toBe('empty');
    expect(partsPhase(PARTS, 'capacitor')).toBe('results');
    expect(partsPhase(PARTS, 'capacitr')).toBe('nomatch');
  });

  // why: FR-TECH-10 with no copy of the list on the phone the screen says so instead of searching
  it('says there is no copy yet while the list has never loaded', () => {
    expect(partsPhase(null, 'capacitor')).toBe('nocopy');
  });
});

describe('Map tab (SCR-TEC-15)', () => {
  // why: FR-TECH-11 the stops keep the day's numbers and states, and the map draws the legs from the next stop on
  it('draws a numbered marker per stop and the legs into the next and later stops', () => {
    const l = mapLayers(t, ROUTE);
    expect(l.markers.map((m) => [m.text, m.state, m.kind])).toEqual([['1', 'done', 'stop'], ['2', 'next', 'stop'], ['3', 'later', 'stop']]);
    expect(l.markers[1]?.words).toBe('Stop 2, Next: Customer 2, Westerville');
    expect(l.routes.map((r) => [r.id, r.track === null])).toEqual([['leg-102', false], ['leg-103', true]]);
  });

  // why: FR-TECH-13 the Next stop card's line says the minutes and miles of the leg the Directions button shows; an approximate leg has no distance
  it('words the leg: minutes, miles to 1 decimal and the service; none on an approximate leg', () => {
    expect(distText(t, legTo(ROUTE, 102)!, 'service.furnace_tune_up.screen')).toBe('12 min, 5.8 mi - furnace tune-up');
    expect(distText(t, legTo(ROUTE, 103)!, 'service.furnace_tune_up.screen')).toBe('9 min - furnace tune-up');
    expect(miles(null)).toBeNull();
  });

  // why: FR-TECH-11 the screen is in the frame's state: loading, offline from the saved day, no jobs, all done, or the route
  it('picks the state the frames show', () => {
    expect(mapPhase(null, false, false)).toBe('loading');
    expect(mapPhase(ROUTE, false, false)).toBe('loading');
    expect(mapPhase(ROUTE, true, true)).toBe('offline');
    expect(mapPhase(null, true, true)).toBe('offline');
    expect(mapPhase({ ...ROUTE, stops: [], legs: [], next: null }, false, true)).toBe('none');
    expect(mapPhase({ ...ROUTE, stops: ROUTE.stops.map((s) => ({ ...s, state: 'done' as const })), next: null }, false, true)).toBe('alldone');
    expect(mapPhase(ROUTE, false, true)).toBe('route');
    expect(jobsDone(ROUTE.stops)).toBe(1);
  });

  // why: F-1750 with signal, no route saved and the route read failed, the Map is Route not loaded, not Loading with no end
  it('ends Loading with Route not loaded when the read failed and no route is saved', () => {
    expect(mapPhase(null, false, true, true)).toBe('error');
    expect(mapPhase(null, false, true)).toBe('loading');
    expect(mapPhase(null, false, false, true)).toBe('loading');
    expect(mapPhase(null, true, true, true)).toBe('offline');
    expect(mapPhase(ROUTE, false, true, true)).toBe('route');
  });

  // why: F-1758 Loading with no saved route, and Route not loaded, read Today's route with no stop count, never 0 stops
  it('shows no stop count in the route summary until a route is held', () => {
    expect(mapSummary(t, 'loading', null)).toBe("Today's route");
    expect(mapSummary(t, 'error', null)).toBe("Today's route");
    expect(mapSummary(t, 'loading', ROUTE)).toBe("Today's route - 3 stops");
    expect(mapSummary(t, 'route', ROUTE)).toBe("Today's route - 3 stops - 1 done");
  });
});

describe('Me day states (SCR-TEC-10)', () => {
  // why: F-1739 with the phone's copy read and no day saved, Me is Loading (or Day not loaded, or Offline nothing saved), never the day's values drawn empty
  it('picks Loading, Day not loaded or Offline nothing saved when no day is saved', () => {
    expect(mePhase(true, false, false, false, false)).toBe('reading');
    expect(mePhase(false, false, false, false, false)).toBe('loading');
    expect(mePhase(false, false, false, true, false)).toBe('loading');
    expect(mePhase(false, false, false, true, true)).toBe('error');
    expect(mePhase(false, false, true, true, true)).toBe('nosaved');
    expect(mePhase(false, false, true, false, false)).toBe('nosaved');
    expect(mePhase(false, true, false, true, true)).toBe('day');
    expect(mePhase(false, true, true, true, false)).toBe('day');
  });
});

describe('Me (SCR-TEC-10)', () => {
  // why: FR-TECH-15 hours on the clock count from the day's start by the demo clock
  it('counts the minutes from the start to demo now, in hours and minutes', () => {
    expect(minutesOnClock(at('07:45:00'), at('10:26:00'))).toBe(161);
    expect(durationText(t, 161)).toBe('2 hr 41 min');
    expect(durationText(t, 40)).toBe('40 min');
    expect(minutesOnClock(at('10:26:00'), at('07:45:00'))).toBe(0);
  });

  // why: FR-TECH-15 the start is the server's, or the phone's own first action while the server's has not arrived (OI-40), whichever is earlier
  it('shows the phone\'s first action until the server\'s start arrives', () => {
    expect(startOfDay(null, null)).toBeNull();
    expect(startOfDay(null, at('07:50:00'))).toBe(at('07:50:00'));
    expect(startOfDay(at('07:45:00'), null)).toBe(at('07:45:00'));
    expect(startOfDay(at('07:45:00'), at('07:30:00'))).toBe(at('07:30:00'));
    expect(startOfDay(at('07:45:00'), at('07:50:00'))).toBe(at('07:45:00'));
    const item = (kind: string, demoTime: string) => ({ kind, demoTime }) as never;
    expect(phoneStart([item('note', at('07:10:00')), item('arrived', at('07:55:00')), item('on_my_way', at('07:40:00'))], '2026-09-15')).toBe(at('07:40:00'));
    expect(phoneStart([item('note', at('07:10:00'))], '2026-09-15')).toBeNull();
    expect(phoneStart([item('arrived', '2026-09-14T07:55:00-04:00[America/New_York]')], '2026-09-15')).toBeNull();
  });

  // why: FR-TECH-15 the text size has 3 settings, the larger two enlarge the app's text, and anything else on the phone reads as Standard
  it('has the sizes Standard, Large and Larger', () => {
    expect(Object.keys(TEXT_PERCENT)).toEqual(['standard', 'large', 'larger']);
    expect(TEXT_PERCENT.large).toBeGreaterThan(TEXT_PERCENT.standard);
    expect(TEXT_PERCENT.larger).toBeGreaterThan(TEXT_PERCENT.large);
  });
});

describe('Day-changed notices (CTL-TEC-02-14)', () => {
  const day = (jobs: [number, string, string][]) => ({
    date: '2026-09-15',
    jobs: jobs.map(([jobNumber, a, b]) => ({ jobNumber, window: win(a, b) })),
  });

  // why: FR-TECH-15 a re-read that finds a job added, one that left the day or one with a new window is a change; the same day is not, and neither is the first read or a new day
  it('finds a job added, removed or moved to another window', () => {
    const before = snapshotOf(day([[1, '08', '10'], [2, '10', '12']]));
    expect(dayChanges(before, snapshotOf(day([[1, '08', '10'], [2, '10', '12']])))).toEqual([]);
    expect(dayChanges(before, snapshotOf(day([[1, '08', '10'], [2, '10', '12'], [3, '12', '14']])))).toEqual([{ kind: 'added', job: 3 }]);
    expect(dayChanges(before, snapshotOf(day([[1, '08', '10']])))).toEqual([{ kind: 'removed', job: 2 }]);
    expect(dayChanges(before, snapshotOf(day([[1, '08', '10'], [2, '12', '14']])))).toEqual([{ kind: 'window', job: 2 }]);
    expect(dayChanges(null, snapshotOf(day([[1, '08', '10']])))).toEqual([]);
    expect(dayChanges(before, { ...snapshotOf(day([[9, '08', '10']])), date: '2026-09-16' })).toEqual([]);
  });
});

describe('Install the app (SCR-TEC-11)', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
  const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36';

  // why: NFR-09 the page shows the steps for the visitor's browser: Safari on iPhone, Chrome on Android with or without the install prompt, or the Other browser words
  it('tells the 4 browsers apart', () => {
    expect(installKind(IPHONE, false)).toBe('iphone');
    expect(installKind(ANDROID, true)).toBe('android-prompt');
    expect(installKind(ANDROID, false)).toBe('android');
    expect(installKind(IPHONE_CHROME, false)).toBe('other');
    expect(installKind(SAMSUNG, true)).toBe('other');
    expect(installKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/130.0', false)).toBe('other');
  });

  // why: NFR-09 Continue in the browser stops the page showing in this browser; a browser that keeps nothing shows it each time
  it('keeps that the guide was seen, and survives a browser that keeps nothing', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(installSeen(storage)).toBe(false);
    markInstallSeen(storage);
    expect(installSeen(storage)).toBe(true);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(installSeen(blocked)).toBe(false);
    expect(() => markInstallSeen(blocked)).not.toThrow();
    expect(installSeen(null)).toBe(false);
  });
});

describe('Sign-out and the technician service worker', () => {
  // why: F-937 sign-out posts {type: 'forget'} to the active technician worker so it drops the /tech pages it kept
  it('posts forget to the active worker of the /tech scope', async () => {
    const post = vi.fn();
    const scopes: (string | undefined)[] = [];
    const container = { getRegistration: async (scope?: string) => { scopes.push(scope); return { active: { postMessage: post } }; } };
    expect(await forgetShell(container)).toBe(true);
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'forget' });
    expect(scopes).toEqual(['/tech']);
  });

  // why: F-937 a browser with no worker, no active worker or a refusal leaves sign-out going on
  it('goes on when there is no worker to tell', async () => {
    expect(await forgetShell(undefined)).toBe(false);
    expect(await forgetShell({ getRegistration: async () => undefined })).toBe(false);
    expect(await forgetShell({ getRegistration: async () => ({ active: null }) })).toBe(false);
    expect(await forgetShell({ getRegistration: async () => { throw new Error('refused'); } })).toBe(false);
  });
});

describe('Sign-out with no signal (F-1004)', () => {
  const memory = () => {
    const store = new Map<string, string>();
    return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  };
  const noAnswer = async () => ({ ok: false as const, reason: 'failed' as const });

  // why: FR-AUTH-4 (F-1033) the screens show only the signed-in person's waiting items; the sign-out guard still counts every item
  it('keeps only the signed-in person\'s items for the screens, and everything for a preview with no person', () => {
    const items = [{ key: 'a', userId: 'maria' }, { key: 'b', userId: 'luis' }, { key: 'c' }];
    expect(ownItems(items, 'maria').map((i) => i.key)).toEqual(['a']);
    expect(ownItems(items, null)).toEqual([]);
    expect(ownItems(items, undefined)).toHaveLength(3);
  });

  // why: F-1014 the mark is also a cookie the web server reads, set with the mark and removed with it, so each /tech page is rendered as it will stand
  it('sets the owed cookie with the mark and removes it when API-06 answers or a person signs in', async () => {
    const jar: string[] = [];
    vi.stubGlobal('document', { set cookie(v: string) { jar.push(v); } });
    try {
      const storage = memory();
      await endSession(noAnswer, storage);
      expect(jar.at(-1)).toMatch(/^bw_tech_owed=1; path=\/tech; .*max-age=31536000/);
      await endSession(async () => ({ ok: true as const, data: null }), storage);
      expect(jar.at(-1)).toMatch(/^bw_tech_owed=; path=\/tech; .*max-age=0/);
      clearSignOutOwed(storage);
      expect(jar).toHaveLength(4); // set, set, removed on the answer, removed by the sign-in
      expect(jar.at(-1)).toMatch(/max-age=0/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // why: F-1012 CTL-TEC-10-04 a proxy's 502 or 504 (the web container down or restarting) is no answer from API-06: the cookie is still there, so the mark stays
  it('keeps the sign-out owed on a 502 and a 504, and settles it on a 401', async () => {
    const storage = memory();
    for (const status of [502, 504, 500]) {
      expect(await endSession(async () => ({ ok: false as const, reason: 'failed' as const, code: 'server_error', status }), storage)).toBe(false);
      expect(signOutOwed(storage)).toBe(true);
    }
    expect(await endSession(async () => ({ ok: false as const, reason: 'failed' as const, code: 'unauthenticated', status: 401 }), storage)).toBe(true);
    expect(signOutOwed(storage)).toBe(false);
  });

  // why: F-1004 CTL-TEC-10-04 "fails offline with nothing waiting: the local session is cleared anyway": the httpOnly cookie goes only with API-06's answer, so the phone owes it until one comes
  it('keeps the sign-out owed while API-06 does not answer, and settles it on any answer', async () => {
    const storage = memory();
    expect(signOutOwed(storage)).toBe(false);
    expect(await endSession(noAnswer, storage)).toBe(false);
    expect(signOutOwed(storage)).toBe(true);
    // a session already gone answers 401: an answer all the same, and it clears the cookie (F-230)
    expect(await endSession(async () => ({ ok: false as const, reason: 'failed' as const, code: 'unauthenticated', status: 401 }), storage)).toBe(true);
    expect(signOutOwed(storage)).toBe(false);
    expect(await endSession(async () => ({ ok: true as const, data: null }), storage)).toBe(true);
    expect(signOutOwed(storage)).toBe(false);
  });

  // why: F-1004 the mark is written before API-06 is called, so a phone closed while the call is in flight still owes the sign-out
  it('marks the sign-out owed before it calls API-06', async () => {
    const storage = memory();
    let owedDuringCall = false;
    await endSession(async () => { owedDuringCall = signOutOwed(storage); return noAnswer(); }, storage);
    expect(owedDuringCall).toBe(true);
  });

  // why: F-1004 blocked storage keeps no mark and never stops the sign-out
  it('goes on with storage blocked or missing', async () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(await endSession(noAnswer, blocked)).toBe(false);
    expect(signOutOwed(blocked)).toBe(false);
    expect(await endSession(async () => ({ ok: true as const, data: null }), null)).toBe(true);
    expect(signOutOwed(null)).toBe(false);
  });
});

describe('The sign-in lock compares names like the server (F-1065)', () => {
  // why: FR-AUTH-4 (UD-20, F-1065) the waiting technician's own early tap is not refused for a trailing space or a different case: API-03 trims and matches an email without case
  it('reads a trailing space and case as the same name, and another name as another', () => {
    expect(loginKey('Maria.Santos@Brightwater.example ')).toBe(loginKey('maria.santos@brightwater.example'));
    expect(loginKey('maria.santos@brightwater.example')).not.toBe(loginKey('luis@brightwater.example'));
  });
});
