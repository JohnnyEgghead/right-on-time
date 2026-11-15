// SPDX-License-Identifier: AGPL-3.0-or-later
// The native Map, Directions, Parts and Me screens, the pure part (P6-NATIVE-MAP-ME; SCR-TEC-08, -10, -15, -16): the numbers and words the
// screens show, from the reads' answers. The rules are the web app's (apps/web/src/tech/model.ts, view-model.ts and map/map-model.ts); the
// native app imports no web code (SD-2), so they are written here again and model.test.ts runs both on the same inputs. No React, no clock,
// no storage.
import type { dayRoute, partsList, routeLeg, TodayAnswer, z } from '@bw/api';
import type { MessageKey } from '@bw/i18n/src/catalog.ts';

export type DayData = TodayAnswer;
export type RouteData = z.output<typeof dayRoute.response>;
export type Stop = RouteData['stops'][number];
export type Leg = z.output<typeof routeLeg>;
export type StopLeg = RouteData['legs'][number];
export type Part = z.output<typeof partsList.response>['parts'][number];

/** The words function the screens take (ui/intl.tsx useT). */
export type Say = (key: MessageKey, values?: Record<string, string | number>) => string;

/** The milliseconds of a wire time ("2026-09-15T10:26:00-04:00[America/New_York]"); the bracketed zone name is not part of the instant. */
export const wireMs = (wire: string): number => Date.parse(wire.replace(/\[.*\]$/, ''));

export const PARTS_SHOWN = 100;

/** The parts whose name or code holds every word typed (any case); the list in its order, capped at PARTS_SHOWN. */
export function searchParts(parts: readonly Part[], query: string): { shown: Part[]; matched: number } {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return { shown: [], matched: 0 };
  const hits = parts.filter((p) => {
    const hay = `${p.name} ${p.code}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return { shown: hits.slice(0, PARTS_SHOWN), matched: hits.length };
}

export const priceText = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const minutesOnClock = (startedAt: string, now: string): number => Math.max(0, Math.floor((wireMs(now) - wireMs(startedAt)) / 60_000));

/** The start the Me screen shows (OI-40): the earlier of the server's and the phone's own first action of the day. */
export function startOfDay(server: string | null, phone: string | null): string | null {
  if (server === null) return phone;
  if (phone === null) return server;
  return wireMs(phone) < wireMs(server) ? phone : server;
}

export const jobsDone = (stops: readonly Pick<Stop, 'state'>[]): number => stops.filter((s) => s.state === 'done').length;

export const TEXT_SIZES = ['standard', 'large', 'larger'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_PERCENT: Record<TextSize, number> = { standard: 100, large: 112.5, larger: 125 };
export const isTextSize = (v: unknown): v is TextSize => typeof v === 'string' && (TEXT_SIZES as readonly string[]).includes(v);
export const SIZE_KEY: Record<TextSize, MessageKey> = { standard: 'tech.me.size.standard', large: 'tech.me.size.large', larger: 'tech.me.size.larger' };

export type DayChange = { kind: 'added' | 'removed' | 'window'; job: number };
export interface SnapshotJob { jobNumber: number; start: string; end: string }
export interface DaySnapshot { date: string; jobs: SnapshotJob[] }

export const snapshotOf = (day: { date: string; jobs: readonly { jobNumber: number; window: { start: string; end: string } }[] }): DaySnapshot => ({
  date: day.date,
  jobs: day.jobs.map((j) => ({ jobNumber: j.jobNumber, start: j.window.start, end: j.window.end })),
});

/** What a re-read found changed against what the phone last saw (UD-43): a job added, one that left the day, one with a new window. */
export function dayChanges(prev: DaySnapshot | null, next: DaySnapshot): DayChange[] {
  if (prev === null || prev.date !== next.date) return [];
  const before = new Map(prev.jobs.map((j) => [j.jobNumber, j]));
  const now = new Map(next.jobs.map((j) => [j.jobNumber, j]));
  const out: DayChange[] = [];
  for (const j of next.jobs) {
    const old = before.get(j.jobNumber);
    if (!old) out.push({ kind: 'added', job: j.jobNumber });
    else if (old.start !== j.start || old.end !== j.end) out.push({ kind: 'window', job: j.jobNumber });
  }
  for (const j of prev.jobs) if (!now.has(j.jobNumber)) out.push({ kind: 'removed', job: j.jobNumber });
  return out;
}

export const legTo = (route: Pick<RouteData, 'legs'>, job: number): StopLeg | undefined => route.legs.find((l) => l.toJob === job);
export const miles = (meters: number | null): string | null => (meters === null ? null : (meters / 1609.344).toFixed(1));

// ---- the view rules ------------------------------------------------------------------------------------------------------------

export const STATE_KEY: Record<Stop['state'], MessageKey> = { done: 'tech.map.state.done', next: 'tech.map.state.next', later: 'tech.map.state.later' };

export type MapPhase = 'loading' | 'route' | 'offline' | 'none' | 'alldone';

/** Which of the frames' states the Map tab is in (offline shows the saved day; a day with no stops is "none" whatever else is true). */
export function mapPhase(route: RouteData | null, offline: boolean, settled: boolean): MapPhase {
  if (offline) return route && route.stops.length === 0 ? 'none' : 'offline';
  if (!settled || !route) return 'loading';
  if (route.stops.length === 0) return 'none';
  return route.next === null ? 'alldone' : 'route';
}

/** The service line of the Next stop card (CTL-TEC-15-09): "12 min, 5.8 mi - furnace tune-up"; an approximate leg shows no distance. */
export function distText(t: Say, lang: string, leg: Leg, serviceKey: string): string {
  const mi = miles(leg.distanceMeters);
  const service = t(serviceKey as MessageKey).toLocaleLowerCase(lang);
  return mi === null ? t('tech.map.distApprox', { n: leg.minutes, service }) : t('tech.map.dist', { n: leg.minutes, mi, service });
}

// SCR-TEC-08's states and reads: steps.ts (P6-NATIVE-STEPS, kit 0.9: Job moved, Route not loaded and Offline, steps saved are its own).

export type PartsPhase = 'nocopy' | 'empty' | 'results' | 'nomatch';

export function partsPhase(parts: readonly Part[] | null, query: string): PartsPhase {
  if (parts === null) return 'nocopy';
  if (query.trim() === '') return 'empty';
  return searchParts(parts, query).matched > 0 ? 'results' : 'nomatch';
}

export const durationText = (t: Say, minutes: number): string =>
  minutes >= 60 ? t('tech.me.hm', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('tech.me.m', { m: minutes });

// ---- the map's pure part (map-model.ts) ----------------------------------------------------------------------------------------

export type LngLat = readonly [lng: number, lat: number];
export type Bbox = readonly [west: number, south: number, east: number, north: number];
export const BRANCH_IDS = ['columbus', 'dayton', 'springfield'] as const;
export type BranchId = (typeof BRANCH_IDS)[number];
export interface BranchMap { file: string; center: LngLat; zoom: number; bbox: Bbox }

export const BRANCH_MAPS: Record<BranchId, BranchMap> = {
  columbus: { file: 'columbus.pmtiles', center: [-82.9988, 39.9612], zoom: 11, bbox: [-83.45, 39.65, -82.55, 40.35] },
  dayton: { file: 'dayton.pmtiles', center: [-84.1916, 39.7589], zoom: 11, bbox: [-84.4, 39.55, -83.95, 39.95] },
  springfield: { file: 'springfield.pmtiles', center: [-83.8088, 39.9242], zoom: 11, bbox: [-83.95, 39.85, -83.55, 40.1] },
};
export const isBranchId = (v: unknown): v is BranchId => typeof v === 'string' && (BRANCH_IDS as readonly string[]).includes(v);

/** The OpenStreetMap copyright page: the credit's link (HC-04, FR-MAP-2). */
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/** The symbol layers that carry each kind of name, by Protomaps layer id (the counts the status line reports). */
export const NAME_LAYERS = {
  street: ['roads_labels_major', 'roads_labels_minor'],
  place: ['places_locality', 'places_subplace', 'places_region', 'places_country'],
  water: ['water_label_lakes', 'water_label_ocean', 'water_waterway_label'],
  shield: ['roads_shields'],
} as const;

export interface MapStop { id: string; at: LngLat; state: Stop['state']; text: string; words: string }
export interface MapLeg { id: string; from: LngLat; to: LngLat; track: readonly LngLat[] | null }

/** The stops and legs the map draws: the leg into the next stop and the legs after it; the stops done are driven. */
export function mapLayers(t: Say, route: RouteData): { stops: MapStop[]; legs: MapLeg[] } {
  const stops: MapStop[] = route.stops.map((s) => ({
    id: `stop-${s.jobNumber}`, at: [s.at.lon, s.at.lat], state: s.state, text: String(s.number),
    words: t('tech.map.stopWords', { n: s.number, state: t(STATE_KEY[s.state]), customer: s.customer, area: s.area }),
  }));
  const legs: MapLeg[] = route.stops.filter((s) => s.state !== 'done').flatMap((s) => {
    const leg = legTo(route, s.jobNumber);
    return leg ? [{ id: `leg-${s.jobNumber}`, from: [leg.from.lon, leg.from.lat] as const, to: [leg.to.lon, leg.to.lat] as const, track: leg.track }] : [];
  });
  return { stops, legs };
}

/** A leg's line: the baked track, else the straight line (approximate). */
export function legLine(r: MapLeg): { coordinates: LngLat[]; approximate: boolean } {
  const track = r.track && r.track.length >= 2 ? [...r.track] : null;
  return { coordinates: track ?? [r.from, r.to], approximate: track === null };
}

// ---- the Me screen's day (view-model.ts) ---------------------------------------------------------------------------------------

/** The item kinds that are a status action of the day (FR-TECH-15: the day starts at the first sign-in or status action). */
const STATUS_KINDS: ReadonlySet<string> = new Set(['on_my_way', 'arrived', 'no_one_home', 'finished']);
/** The kinds that end a visit: the phone counts them as done at once (UD-51). */
export const ENDING_KINDS: ReadonlySet<string> = new Set(['no_one_home', 'finished']);

/** The phone's own first status action of the day (OI-40): the earliest demo time among the status items still waiting, entered today. */
export function phoneStart(waiting: readonly { kind: string; demoTime: string }[], date: string | null): string | null {
  const mine = waiting.filter((i) => STATUS_KINDS.has(i.kind) && (date === null || i.demoTime.startsWith(date)));
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (wireMs(b.demoTime) < wireMs(a.demoTime) ? b : a)).demoTime;
}

/** The branch names are proper names: the id with its first letter capitalized (Columbus, Dayton, Springfield). */
export const branchName = (id: string | null | undefined): string => {
  const known = isBranchId(id) ? id : 'columbus';
  return known.charAt(0).toUpperCase() + known.slice(1);
};
