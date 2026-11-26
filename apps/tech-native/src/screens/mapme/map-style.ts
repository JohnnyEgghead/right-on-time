// SPDX-License-Identifier: AGPL-3.0-or-later
// The native map's style (P6-NATIVE-MAP-ME; SPECIFICATIONS 4.7, SD-34, 6.10): the web map's @protomaps/basemaps 5.7.2 style over the branch
// file kept in the app's storage, with the symbol layers kept so the street, place and water names are drawn (F-452). The glyph and sprite
// files are the set P3-MAP-LABELS committed (apps/web/src/map/assets), bundled into the app by xcuitest/add-map-assets.rb, so every file
// the style names is on the phone: no URL in it reaches the network (remoteUrls finds none; map-style.test.ts holds that).
import { layers, namedFlavor } from '@protomaps/basemaps';
import { legLine, NAME_LAYERS, type MapLeg, type MapStop } from './model.ts';

/** The text of a name layer is the OpenStreetMap name as mapped (never a translation); shields, one-way arrows and house numbers keep theirs. */
const OSM_NAME = ['get', 'name'];
const KEEP_TEXT_FIELD = new Set(['address_label', 'roads_shields', 'roads_oneway']);

/** The stop colors of the web map (map.css): Done --bw-site, Next --bw-way, Later --bw-free. */
export const STOP_COLOR = { done: '#1f9d55', next: '#2f6fe0', later: '#12738b' } as const;
const ROUTE_COLOR = '#2f6fe0';
/** The one font stack the stop numbers use; the glyph set holds it (apps/web/src/map/assets/fonts). */
const NUMBER_FONT = ['Noto Sans Medium'];

export interface NativeStyleFiles {
  /** file:// URI of the branch's .pmtiles file in the app's storage. */
  tiles: string;
  /** file:// URI of the bundled map-assets folder (fonts/ and sprites/). */
  assets: string;
}

type Json = Record<string, unknown>;

function featureCollection(features: Json[]): Json {
  return { type: 'FeatureCollection', features };
}

/** The style for one branch: the base map, then the route lines, then the numbered stops. */
export function nativeMapStyle(files: NativeStyleFiles, stops: readonly MapStop[], legs: readonly MapLeg[], names = true) {
  const flavor = namedFlavor('light');
  const base = names
    ? layers('protomaps', flavor, { lang: 'en' }).map((l) =>
        l.type === 'symbol' && !KEEP_TEXT_FIELD.has(l.id) ? { ...l, layout: { ...l.layout, 'text-field': OSM_NAME } } : l)
    : layers('protomaps', flavor).filter((l) => l.type !== 'symbol');
  const lines = legs.map((l) => ({ l, ...legLine(l) }));
  const routeData = featureCollection(lines.map(({ l, coordinates, approximate }) => ({
    type: 'Feature', id: l.id, properties: { approximate }, geometry: { type: 'LineString', coordinates },
  })));
  const stopData = featureCollection(stops.map((s) => ({
    type: 'Feature', id: s.id, properties: { state: s.state, text: s.text }, geometry: { type: 'Point', coordinates: [...s.at] },
  })));
  const line = { 'line-color': ROUTE_COLOR, 'line-width': 3, 'line-opacity': 0.9 };
  return {
    version: 8 as const,
    sources: {
      protomaps: { type: 'vector' as const, url: `pmtiles://${files.tiles}` },
      'bw-routes': { type: 'geojson' as const, data: routeData },
      'bw-stops': { type: 'geojson' as const, data: stopData },
    },
    ...(names ? { glyphs: `${files.assets}/fonts/{fontstack}/{range}.pbf`, sprite: `${files.assets}/sprites/light` } : {}),
    layers: [
      ...base,
      { id: 'bw-routes-baked', type: 'line', source: 'bw-routes', filter: ['==', ['get', 'approximate'], false], layout: { 'line-cap': 'round' }, paint: line },
      { id: 'bw-routes-approx', type: 'line', source: 'bw-routes', filter: ['==', ['get', 'approximate'], true], layout: { 'line-cap': 'round' }, paint: { ...line, 'line-dasharray': [2, 2] } },
      {
        id: 'bw-stops-disc', type: 'circle', source: 'bw-stops',
        paint: {
          'circle-radius': 11.8, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
          'circle-color': ['match', ['get', 'state'], 'done', STOP_COLOR.done, 'next', STOP_COLOR.next, STOP_COLOR.later],
        },
      },
      ...(names ? [{
        id: 'bw-stops-number', type: 'symbol', source: 'bw-stops',
        layout: { 'text-field': ['get', 'text'], 'text-font': NUMBER_FONT, 'text-size': 14, 'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': '#ffffff' },
      }] : []),
    ],
  };
}

/** Every URL-like string in the style that would reach the network: an http(s), ws(s) or mapbox URL, or a pmtiles:// that is not a file. */
export function remoteUrls(style: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (/^(https?|wss?|mapbox):\/\//i.test(v) || /^pmtiles:\/\/(?!file:\/\/)/i.test(v)) found.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(style);
  return found;
}

/** The layer ids that count as drawn names, by kind (the status line the XCUITest reads). */
export const NAME_LAYER_IDS: Record<keyof typeof NAME_LAYERS, readonly string[]> = NAME_LAYERS;
