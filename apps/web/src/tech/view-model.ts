// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's map, directions, parts and Me screens, the view rules (P5-TWA-MAP-ME): which of a frame's states a screen is in and the
// words and layers it draws from the reads. Pure (no React, no storage), so the rules are tested without a browser (view-model.test.ts).
import type { MessageKey } from '@bw/i18n';
import type { ClientT } from '../shell/intl.tsx';
import type { MapMarker, MapRoute } from '../map/map-model.ts';
import { dateNumbers } from '../week/week-model.ts';
import type { OutboxState } from './engine.ts';
import { legTo, miles, searchParts, wireMs, type Leg, type Part, type RouteData, type Stop, type TextSize } from './model.ts';

export const STATE_KEY: Record<Stop['state'], MessageKey> = { done: 'tech.map.state.done', next: 'tech.map.state.next', later: 'tech.map.state.later' };

export type MapPhase = 'loading' | 'error' | 'route' | 'offline' | 'none' | 'alldone';

/**
 * Which of the frame's states the screen is in. Offline shows the saved day (a day with no stops is "none" whatever else is true); the first
 * read still out is loading, with the saved stop list under the skeleton; with signal, no route saved and the read failed it is "error"
 * (Route not loaded, F-1750: never Loading with no end); then a day with no stops, every stop done, or the route.
 */
export function mapPhase(route: RouteData | null, offline: boolean, settled: boolean, failed = false): MapPhase {
  if (offline) return route && route.stops.length === 0 ? 'none' : 'offline';
  if (!settled) return 'loading';
  if (!route) return failed ? 'error' : 'loading';
  if (route.stops.length === 0) return 'none';
  return route.next === null ? 'alldone' : 'route';
}

/**
 * The route summary of the header (CTL-TEC-15-08). A count of stops is shown only when a route is held: Loading with no saved route and
 * Route not loaded read "Today's route" alone, never "0 stops" (F-1750, F-1758).
 */
export function mapSummary(t: ClientT, phase: MapPhase, route: RouteData | null): string {
  if (route === null || phase === 'error') return t('tech.map.title');
  const stops = route.stops.length;
  if (phase === 'loading' || phase === 'none') return t('tech.map.summaryOpen', { stops });
  return t('tech.map.summary', { stops, done: route.stops.filter((s) => s.state === 'done').length });
}

export type MePhase = 'reading' | 'loading' | 'error' | 'nosaved' | 'day';

/**
 * Which of the Me card states the screen is in (UI-SPECIFICATION SCR-TEC-10): Reading the phone before the copy is read; with no day saved,
 * no signal is Offline, nothing saved, a failed day read with signal is Day not loaded, and anything else is Loading (F-1739: never No van
 * assigned, a call button with no number or a title that ends in a separator); a saved or read day is the day.
 */
export function mePhase(reading: boolean, hasDay: boolean, offline: boolean, settled: boolean, failed: boolean): MePhase {
  if (reading) return 'reading';
  if (hasDay) return 'day';
  if (offline) return 'nosaved';
  return settled && failed ? 'error' : 'loading';
}


const lower = (t: ClientT, key: string): string => t(key as MessageKey).toLocaleLowerCase(t.lang);

/** The service line of the Next stop card (CTL-TEC-15-09): "12 min, 5.8 mi - furnace tune-up"; an approximate leg shows no distance. */
export function distText(t: ClientT, leg: Leg, serviceKey: string): string {
  const mi = miles(leg.distanceMeters);
  const service = lower(t, serviceKey);
  return mi === null ? t('tech.map.distApprox', { n: leg.minutes, service }) : t('tech.map.dist', { n: leg.minutes, mi, service });
}

/** The markers (numbered stops) and routes the map draws: the leg into the next stop and the legs after it; the stops done are driven. */
export function mapLayers(t: ClientT, route: RouteData): { markers: MapMarker[]; routes: MapRoute[] } {
  const markers: MapMarker[] = route.stops.map((s) => ({
    id: `stop-${s.jobNumber}`, kind: 'stop', at: [s.at.lon, s.at.lat], state: s.state, text: String(s.number),
    words: t('tech.map.stopWords', { n: s.number, state: t(STATE_KEY[s.state]), customer: s.customer, area: s.area }),
  }));
  const routes: MapRoute[] = route.stops.filter((s) => s.state !== 'done').flatMap((s) => {
    const leg = legTo(route, s.jobNumber);
    return leg ? [{ id: `leg-${s.jobNumber}`, from: [leg.from.lon, leg.from.lat] as const, to: [leg.to.lon, leg.to.lat] as const, track: leg.track } satisfies MapRoute] : [];
  });
  return { markers, routes };
}


/** The destination the screen names: the job's facts from the day (CTL-TEC-08-02). */
export interface Destination {
  jobNumber: number;
  customer: string;
  address: string;
  window: { start: string; end: string };
}


export type PartsPhase = 'nocopy' | 'empty' | 'results' | 'nomatch';

/** Which of the frames' states the screen is in: no copy of the list yet, nothing typed, matches, or none. */
export function partsPhase(parts: readonly Part[] | null, query: string): PartsPhase {
  if (parts === null) return 'nocopy';
  if (query.trim() === '') return 'empty';
  return searchParts(parts, query).matched > 0 ? 'results' : 'nomatch';
}


/** The item kinds that are a status action of the day (FR-TECH-15: the day starts at the first sign-in or status action). */
const STATUS_KINDS: ReadonlySet<string> = new Set(['on_my_way', 'arrived', 'no_one_home', 'finished']);
/** The kinds that end a visit: the phone counts them as done at once (UD-51). */
export const ENDING_KINDS: ReadonlySet<string> = new Set(['no_one_home', 'finished']);

export const SIZE_KEY: Record<TextSize, MessageKey> = { standard: 'tech.me.size.standard', large: 'tech.me.size.large', larger: 'tech.me.size.larger' };

export const durationText = (t: ClientT, minutes: number): string =>
  minutes >= 60 ? t('tech.me.hm', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('tech.me.m', { m: minutes });

/** Today's date as the Me card's heading shows it: "Tue, Sep 15". */
export function dateText(t: ClientT, date: string): string {
  const n = dateNumbers(date);
  return t('week.date.short', { weekday: t(`time.weekday.${n.weekday}` as MessageKey), month: t(`time.month.${n.month}` as MessageKey), day: n.day });
}

/** The phone's own first status action of the day (OI-40): the earliest demo time among the status items still waiting, entered today. */
export function phoneStart(waiting: OutboxState['waiting'], date: string | null): string | null {
  const mine = waiting.filter((i) => STATUS_KINDS.has(i.kind) && (date === null || i.demoTime.startsWith(date)));
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (wireMs(b.demoTime) < wireMs(a.demoTime) ? b : a)).demoTime;
}

