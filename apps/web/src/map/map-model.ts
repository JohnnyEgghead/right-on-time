// SPDX-License-Identifier: AGPL-3.0-or-later
// CMP-05 Map, the pure part (UI-SPECIFICATION 3.5; SPECIFICATIONS 4.7, SD-34): the branch map files, the style over a
// branch's PMTiles file, the markers and routes the component draws, and the words a map says about them. No browser
// and no map library in here, so the rules are tested without either (map-model.test.ts).
import { layers, namedFlavor } from '@protomaps/basemaps';
import type { MessageKey } from '@bw/i18n';

export type LngLat = readonly [lng: number, lat: number];
export type Bbox = readonly [west: number, south: number, east: number, north: number];

export const BRANCH_IDS = ['columbus', 'dayton', 'springfield'] as const;
export type BranchId = (typeof BRANCH_IDS)[number];

export interface BranchMap {
  /** The file the app's own origin serves (API-106), one per branch (D7). */
  file: string;
  /** Where the map opens: the branch's downtown. Inside `bbox`. */
  center: LngLat;
  zoom: number;
  /** The area the file covers (packages/maps/MANIFEST.json); the map does not pan past it. */
  bbox: Bbox;
}

/** The 3 branch areas (FR-MAP-1). The boxes equal the manifest's; map-model.test.ts compares them. */
export const BRANCH_MAPS: Record<BranchId, BranchMap> = {
  columbus: { file: 'columbus.pmtiles', center: [-82.9988, 39.9612], zoom: 11, bbox: [-83.45, 39.65, -82.55, 40.35] },
  dayton: { file: 'dayton.pmtiles', center: [-84.1916, 39.7589], zoom: 11, bbox: [-84.4, 39.55, -83.95, 39.95] },
  springfield: { file: 'springfield.pmtiles', center: [-83.8088, 39.9242], zoom: 11, bbox: [-83.95, 39.85, -83.55, 40.1] },
};

export const isBranchId = (v: unknown): v is BranchId => typeof v === 'string' && (BRANCH_IDS as readonly string[]).includes(v);

/** A marker's state: a van's status (the legend's first 3 and Late or at risk), a job's, or a technician's stop. */
type MarkerState = 'site' | 'way' | 'free' | 'late' | 'sched' | 'risk' | 'unas' | 'closed' | 'done' | 'next' | 'later';

export interface MapMarker {
  id: string;
  kind: 'van' | 'job' | 'stop' | 'house' | 'turn';
  at: LngLat;
  state?: MarkerState;
  /** Initials on a van, or the stop number on a stop. */
  text?: string;
  /** The marker in words, for the text alternative (CTL-CMP-05-06): "Van, Maria Santos, on the way to Westerville...". */
  words: string;
  /** A marker a person can press carries its control id: it is a button, and MapView's onMarker hears it. */
  ctl?: string;
  /** The selected van: drawn larger, in a ring, with `tag` under it (DK-85 highlight). */
  selected?: boolean;
  tag?: string;
  /** The turn marker's arrow (CTL-TEC-08-01): the name of a DK-70 or step icon, drawn in a white disc ringed in teal. */
  icon?: 'arrowUp' | 'turnLeft' | 'turnRight' | 'exitRight' | 'pin';
}

/**
 * A route to draw (FR-MAP-3). `track` is the baked track from API-104 or API-163 (a list of points); null means no track
 * exists, and the map draws the straight line between `from` and `to` labeled "Approximate route".
 */
export interface MapRoute {
  id: string;
  from: LngLat;
  to: LngLat;
  track: readonly LngLat[] | null;
}

export type LegendId = 'site' | 'way' | 'free' | 'next' | 'late' | 'jobSched' | 'jobWay' | 'jobSite' | 'jobClosed' | 'jobLate' | 'jobRisk' | 'jobUnas';

export type LegendKind = 'vans' | 'jobs';
export const LEGENDS: Record<LegendKind, readonly LegendId[]> = {
  vans: ['site', 'way', 'free', 'next', 'late'],
  jobs: ['jobSched', 'jobWay', 'jobSite', 'jobClosed', 'jobLate', 'jobRisk', 'jobUnas'],
};

export const LEGEND_KEYS: Record<LegendId, MessageKey> = {
  site: 'map.legend.site',
  way: 'map.legend.way',
  free: 'map.legend.free',
  next: 'map.legend.next',
  late: 'map.legend.late',
  jobSched: 'map.legend.jobSched',
  jobWay: 'map.legend.jobWay',
  jobSite: 'map.legend.jobSite',
  jobClosed: 'map.legend.jobClosed',
  jobLate: 'map.legend.jobLate',
  jobRisk: 'map.legend.jobRisk',
  jobUnas: 'map.legend.jobUnas',
};

/** The line a route draws, and whether it is a guess. The line is a track when one exists, else the straight line. */
export function routeLine(r: MapRoute): { coordinates: LngLat[]; approximate: boolean; mid: LngLat } {
  const track = r.track && r.track.length >= 2 ? [...r.track] : null;
  const coordinates = track ?? [r.from, r.to];
  const a = coordinates[0]!;
  const b = coordinates[coordinates.length - 1]!;
  // The label sits at the middle point of the line; for a track that is its middle vertex.
  const mid: LngLat = track ? track[Math.floor(track.length / 2)]! : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return { coordinates, approximate: track === null, mid };
}

/**
 * The smallest zoom a map box can reach over `bbox` (F-453): `maxBounds` lifts the real minimum above the map's minZoom until
 * the box fits inside the bounds. The sum the library's constrain does: the box's size over the bounds' share of the world,
 * in Web Mercator, at 512 pixels a world.
 */
export function boundedMinZoom(width: number, height: number, bbox: Bbox): number {
  const x = (lng: number) => (lng + 180) / 360;
  const y = (lat: number) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  const [west, south, east, north] = bbox;
  return Math.log2(Math.max(width / (x(east) - x(west)), height / (y(south) - y(north))) / 512);
}

/** The OpenStreetMap copyright page: the credit's link and the data's license notice (HC-04, FR-MAP-2). */
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/** Where the bundled glyph and sprite files are answered (map-assets.ts), under the page's origin. */
const MAP_ASSET_PATH = '/map-assets';

/** The symbol layers that carry each kind of name, by Protomaps layer id (the counts the component reports). */
export const NAME_LAYERS = {
  street: ['roads_labels_major', 'roads_labels_minor'],
  place: ['places_locality', 'places_subplace', 'places_region', 'places_country'],
  water: ['water_label_lakes', 'water_label_ocean', 'water_waterway_label'],
  shield: ['roads_shields'],
} as const;
export type NameKind = keyof typeof NAME_LAYERS;

/** The text of a name layer is the OpenStreetMap name as mapped (never a translation); shields draw the road's ref. */
const OSM_NAME = ['get', 'name'];
const KEEP_TEXT_FIELD = new Set(['address_label', 'roads_shields', 'roads_oneway']);

/**
 * The map style over one branch file. `origin` is the page's own origin: the file is read with byte ranges through the
 * pmtiles protocol, and the glyph ranges and the sprite sheet are the app's own files, so nothing leaves the app (NFR-12).
 * `names` false is the shapes-only style (earth, water, land use, buildings, roads, no lettering) that P3-MAP-WEB first
 * shipped; the render test uses it to tell a named map from an unnamed one.
 */
export function mapStyle(origin: string, file: string, names = true) {
  const flavor = namedFlavor('light');
  const sources = { protomaps: { type: 'vector' as const, url: `pmtiles://${origin}/maps/${file}` } };
  if (!names) return { version: 8 as const, sources, layers: layers('protomaps', flavor).filter((l) => l.type !== 'symbol') };
  return {
    version: 8 as const,
    sources,
    glyphs: `${origin}${MAP_ASSET_PATH}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}${MAP_ASSET_PATH}/sprites/light`,
    // A language is what makes the library emit the lettering layers; its own text expressions prefer name:<lang> and
    // pre-translated fields, so each name layer's text is set to the mapped name itself (REQUIREMENTS 4.10).
    layers: layers('protomaps', flavor, { lang: 'en' }).map((l) =>
      l.type === 'symbol' && !KEEP_TEXT_FIELD.has(l.id) ? { ...l, layout: { ...l.layout, 'text-field': OSM_NAME } } : l,
    ),
  };
}
