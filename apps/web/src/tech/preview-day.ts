// SPDX-License-Identifier: AGPL-3.0-or-later
// The sample day of the technician map, parts, Me and install frames (mockups/pages/tech-map.html, tech-me.html, r1-techweb-parts.html,
// r1-techweb-install.html), for the harness build's preview routes and the look comparator. Never read by a release route. Maria Santos,
// Columbus, Van 12, Tue, Sep 15, 10:26 AM: 5 stops, the first done, Harold Jenkins next.
import type { OutboxState } from './engine.ts';
import type { TechData } from './data.ts';
import { STATES } from './preview-states.ts';
import type { DayData, Part, RouteData } from './model.ts';
import type { RouteRead, RouteStep, ShownRoute } from './steps.ts';

const Z = '[America/New_York]';
const at = (hhmm: string) => `2026-09-15T${hhmm}-04:00${Z}`;
const NOW = at('10:26:00');
const win = (a: string, b: string) => ({ start: at(`${a}:00:00`), end: at(`${b}:00:00`) });

const PEOPLE = [
  { jobNumber: 24827, customer: 'Whitaker', area: 'Worthington', address: '1180 High St, Worthington', window: win('08', '10'), serviceLabelKey: 'service.ac_tune_up.screen', at: { lon: -83.0178, lat: 40.0931 } },
  { jobNumber: 24830, customer: 'Harold Jenkins', area: 'Westerville', address: '418 Maple Hollow Ct, Westerville', window: win('10', '12'), serviceLabelKey: 'service.furnace_tune_up.screen', at: { lon: -82.9293, lat: 40.1262 } },
  { jobNumber: 24833, customer: 'Linda Miller', area: 'Westerville', address: '2271 Cobblestone Dr, Westerville', window: win('12', '14'), serviceLabelKey: 'service.ac_tune_up.screen', at: { lon: -82.925, lat: 40.1215 } },
  { jobNumber: 24836, customer: 'Holloway', area: 'Gahanna', address: '77 Mill Race Rd, Gahanna', window: win('14', '16'), serviceLabelKey: 'service.heating_or_ac_fix.screen', at: { lon: -82.8794, lat: 40.0192 } },
  { jobNumber: 24839, customer: 'Brennan', area: 'New Albany', address: '9 Rose Run Ln, New Albany', window: win('16', '18'), serviceLabelKey: 'service.heating_or_ac_fix.screen', at: { lon: -82.8086, lat: 40.0817 } },
] as const;

const DEPOT = { lon: -83.0, lat: 39.96 };
const TRACK: [number, number][] = [[-83.0178, 40.0931], [-82.975, 40.11], [-82.9293, 40.1262]];

function routeOf(done: number): RouteData {
  const stops = PEOPLE.map((p, i) => ({ ...p, number: i + 1, state: (i < done ? 'done' : i === done ? 'next' : 'later') as 'done' | 'next' | 'later' }));
  const legs = PEOPLE.map((p, i) => {
    const from = i === 0 ? DEPOT : PEOPLE[i - 1]!.at;
    // The leg into the next stop is the frame's: 12 minutes on a baked track, 5.8 miles; the others are straight lines.
    if (i === 1) return { toJob: p.jobNumber, from, to: p.at, track: TRACK, minutes: 12, distanceMeters: 9335 };
    return { toJob: p.jobNumber, from, to: p.at, track: null, minutes: 14 + i, distanceMeters: null };
  });
  return { date: '2026-09-15', branch: 'columbus', stops, legs, next: done >= PEOPLE.length ? null : PEOPLE[done]!.jobNumber };
}

const DAY: DayData = {
  date: '2026-09-15',
  asOf: NOW,
  zone: 'America/New_York',
  van: { number: '12', vehicle: 'Ford Transit 250' },
  startedAt: at('07:45:00'),
  officePhone: '(614) 555-0100',
  technician: { name: 'Maria Santos', initials: 'MS', employeeNumber: '40712', skill: 'heating_cooling', branch: 'columbus' },
  jobs: PEOPLE.map((p, i) => ({
    jobNumber: p.jobNumber, version: 3, position: i + 1, status: i === 0 ? ('done' as const) : ('scheduled' as const), window: p.window,
    customer: { name: p.customer, language: 'en' as const }, address: p.address, area: p.area, serviceLabelKey: p.serviceLabelKey,
    equipment: null, lastVisit: null, customerNote: null, plannedArrival: null, textedArrival: null, endedAt: null, lateText: null, onMyWayPreview: null,
  })),
};

const FILTERS: Part[] = [
  ['Furnace filter 16x25x4 MERV 11', 'FLT-16254', 2400], ['Furnace filter 16x25x1 MERV 8', 'FLT-16251', 950], ['Furnace filter 20x25x4 MERV 11', 'FLT-20254', 2700],
  ['Furnace filter 20x20x1 MERV 8', 'FLT-20201', 900], ['Filter rack, 16x25, 4 in', 'RCK-1625', 4600], ['Water filter cartridge, whole house', 'WF-1010', 3200],
  ['Run capacitor 45/5 MFD', 'CAP-455', 3800],
].map(([name, code, priceCents], i) => ({ partId: `00000000-0000-4000-8000-0000000000${String(10 + i)}`, name: name as string, code: code as string, priceCents: priceCents as number }));

/** 1,240 parts in all (the frame's count): the 7 above and fittings that match none of the frame's searches. */
export const PARTS: Part[] = [
  ...FILTERS,
  ...Array.from({ length: 1233 }, (_, i) => ({ partId: `00000000-0000-4000-8000-${String(100000000000 + i)}`, name: `Fitting ${i + 1}`, code: `FIT-${String(i + 1).padStart(4, '0')}`, priceCents: 500 + i })),
];

const BASE: TechData = {
  day: { at: NOW, data: DAY },
  route: { at: NOW, data: routeOf(1) },
  parts: { at: NOW, data: PARTS },
  routes: null,
  online: true,
  settled: true,
  failed: false,
  signedOut: false,
  now: NOW,
  notices: [],
  noticesOn: true,
  textSize: 'large',
};

export interface TechPreview {
  data: TechData;
  outbox: OutboxState;
}

const synced = STATES.synced!;
const offline = STATES.offline!;
const at1126 = at('11:06:00');

export const MAP_PREVIEWS: Record<string, TechPreview> = {
  route: { data: BASE, outbox: synced },
  loading: { data: { ...BASE, settled: false }, outbox: synced },
  offline: { data: { ...BASE, online: false }, outbox: { ...offline, waiting: offline.waiting.slice(0, 1) } },
  nojobs: { data: { ...BASE, route: { at: NOW, data: { ...routeOf(0), stops: [], legs: [], next: null } } }, outbox: synced },
  alldone: { data: { ...BASE, route: { at: NOW, data: routeOf(5) } }, outbox: synced },
};

export const PARTS_PREVIEWS: Record<string, TechPreview & { query: string }> = {
  results: { data: BASE, outbox: synced, query: 'filter' },
  empty: { data: BASE, outbox: synced, query: '' },
  nomatch: { data: BASE, outbox: synced, query: 'capacitr' },
  nocopy: { data: { ...BASE, parts: null }, outbox: synced, query: '' },
  offline: { data: { ...BASE, online: false }, outbox: offline, query: 'CAP' },
};

export const ME_PREVIEWS: Record<string, TechPreview & { phase?: 'refused' | 'signing'; sizeOpen?: boolean }> = {
  success: { data: BASE, outbox: synced },
  refused: { data: BASE, outbox: STATES.waiting!, phase: 'refused' },
  signing: { data: BASE, outbox: synced, phase: 'signing' },
  offline: { data: { ...BASE, online: false, now: at1126 }, outbox: { ...offline } },
  notstarted: { data: { ...BASE, day: { at: NOW, data: { ...DAY, startedAt: null } } }, outbox: synced },
  sizeopen: { data: BASE, outbox: synced, sizeOpen: true },
};

/**
 * The Directions frames' route (mockups/pages/tech-map.html, kit 0.9): Harold Jenkins's job to Linda Miller's, 11 minutes, with the frame's 4 steps
 * (UI-SPECIFICATION SCR-TEC-08 sample words). The step meters add up to the leg's distance, as SD-49 guarantees (483 + 1,931 + 322 + 0).
 */
const DIR_TRACK: [number, number][] = [PEOPLE[1].at, { lon: -82.9293, lat: 40.1262 + 0.004 }, { lon: -82.925, lat: 40.1215 + 0.004 }, PEOPLE[2].at].map((p) => [p.lon, p.lat]);
const dirStep = (kind: string, road: string | null, distanceMeters: number, i: number, o: Partial<RouteStep> = {}): RouteStep =>
  ({ kind, direction: null, heading: null, road, exit: null, side: null, at: DIR_TRACK[i]!, distanceMeters, ...o }) as RouteStep;
const DIR_STEPS: RouteStep[] = [
  dirStep('depart', 'Cleveland Ave', 483, 0, { heading: 'n' }),
  dirStep('turn', 'E Schrock Rd', 1931, 1, { direction: 'right' }),
  dirStep('turn', 'Cobblestone Dr', 322, 2, { direction: 'left' }),
  dirStep('arrive', 'Cobblestone Dr', 0, 3, { side: 'right' }),
];
const DIR_LEG = { toJob: 24833, from: PEOPLE[1].at, to: PEOPLE[2].at, track: DIR_TRACK, minutes: 11, distanceMeters: 2736 };
const DIR_ROUTE: ShownRoute = { leg: DIR_LEG, branch: 'columbus', steps: DIR_STEPS, at: NOW };
const dirRead = (r: ShownRoute): RouteRead => ({ kind: 'leg', ...r });

export const DIR_PREVIEWS: Record<string, TechPreview & { read: RouteRead | null; job: number; updated?: boolean }> = {
  route: { data: BASE, outbox: synced, read: dirRead(DIR_ROUTE), job: 24833 },
  loading: { data: BASE, outbox: synced, read: null, job: 24833 },
  approximate: { data: BASE, outbox: synced, read: dirRead({ ...DIR_ROUTE, leg: { ...DIR_LEG, track: null, distanceMeters: null }, steps: [] }), job: 24833 },
  // No signal, and the phone keeps the route read at 10:26 AM (rule 11): the kept steps, no Now mark, no Next turn card.
  offlinesaved: { data: { ...BASE, online: false, routes: { date: '2026-09-15', routes: { '24833': DIR_ROUTE } } }, outbox: offline, read: null, job: 24833 },
  offline: { data: { ...BASE, online: false }, outbox: offline, read: null, job: 24833 },
  notloaded: { data: BASE, outbox: synced, read: { kind: 'failed' }, job: 24833 },
  moved: { data: BASE, outbox: synced, read: { kind: 'moved' }, job: 24833 },
  updated: { data: BASE, outbox: synced, read: dirRead(DIR_ROUTE), job: 24833, updated: true },
  nonext: { data: BASE, outbox: synced, read: null, job: 0 },
};
