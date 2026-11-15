// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-05 Map (UI-SPECIFICATION 3.5; SPECIFICATIONS 4.7, SD-34): MapLibre GL JS over the branch's PMTiles file, read from the
// app's own origin by byte ranges (API-106). No key, no outside request (FR-MAP-1, NFR-12): the style's glyph ranges and
// sprite sheet are the app's own files (map-assets.ts, F-452), so the map draws street, place, road-shield and water
// names; the tile work runs in a module worker that is one of the app's own static files, and the only outside address
// on the page is the credit link, which opens on a tap and loads nothing (HC-04, FR-MAP-2). The board, the job page, the
// technician map and the live map embed this one component; each passes its markers and routes.
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import type { Map as MapLibreMap, Marker } from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../shell/Icon.tsx';
import { ICON_PATHS } from '../shell/icon-paths.ts';
import { useT } from '../shell/intl.tsx';
import { boundedMinZoom, BRANCH_MAPS, LEGEND_KEYS, LEGENDS, mapStyle, NAME_LAYERS, OSM_COPYRIGHT_URL, routeLine, type BranchId, type LegendKind, type LngLat, type MapMarker, type MapRoute, type NameKind } from './map-model.ts';

export type MapState = 'loading' | 'ready' | 'failed';

export interface MapViewProps {
  branch: BranchId;
  markers?: readonly MapMarker[];
  routes?: readonly MapRoute[];
  /** Which legends to show under the map (the board's Vans, Jobs or both of them); none for the pages that draw no legend. */
  legend?: readonly LegendKind[] | null;
  /** panel: the board's side panel (DK-85); card: a box inside a page (the job page, the technician and live maps). */
  variant?: 'panel' | 'card';
  /** Show the text alternative (CTL-CMP-05-06) as a list under the map; otherwise it is read aloud only. */
  altVisible?: boolean;
  /** The file to read, a name under /maps/. The branch's own unless a test names one the server does not have. */
  file?: string;
  /** Draw the names (default). False is the shapes-only style, which the render test compares the named map with. */
  names?: boolean;
  /** Open framed on the markers given at mount (the job page's van and visit), so a narrow box still shows both. */
  fit?: boolean;
  /** Where the map opens, at the branch's zoom: the branch's center unless given (SCR-OFC-40 opens on the address, its frame's pin at the middle). */
  center?: LngLat;
  /** The zoom the map opens at, the branch's unless given (the board's panel shows the whole branch area). */
  zoom?: number;
  /** A marker with a `ctl` was pressed. The element anchors whatever opens. */
  onMarker?: (id: string, element: HTMLElement) => void;
  /** CTL-TEC-15-05 Show the whole route: each time this number changes the map frames its markers again, as it first opened (a read, not a refetch). */
  fitKey?: number;
  /** CTL-TEC-08-01: frame the routes' points as well as the markers (Directions: the whole route, from the start to the job). */
  fitRoutes?: boolean;
  /** CTL-TEC-08-06: a picked step centers the map on its turn; each new `key` moves the map there (a read, not a refetch). */
  focus?: { at: LngLat; key: number } | null;
  /** A control the page lays over the map's box (the board's Larger map button). */
  overlay?: ReactNode;
}

const NAME_KINDS = Object.keys(NAME_LAYERS) as NameKind[];
/** How a framed map (fit) sits on its markers. */
const FIT = { padding: 40, maxZoom: 14 } as const;
const NO_NAMES: Record<NameKind, number> = { street: 0, place: 0, water: 0, shield: 0 };

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string>, text?: string): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A marker on the map, kept by id across draws: a read moves it and rewrites its words, and its element stays (F-813). */
interface PlacedMarker {
  marker: Marker;
  element: HTMLElement;
  ctl: string | undefined;
  /** What {@link paintMarker} drew. */
  look: string;
}

const lookOf = (m: MapMarker): string => JSON.stringify([m.kind, m.state, m.selected, m.text, m.tag, m.icon]);

/** The marker's name and where it is: these change on a read while the marker keeps its look. */
function labelMarker(wrap: HTMLElement, m: MapMarker): void {
  // A button's name holds the words it shows (WCAG 2.5.3): the initials and the van tag come after the marker's words.
  const shown = [m.text, m.tag].filter((x) => x);
  wrap.setAttribute('aria-label', m.ctl && shown.length > 0 ? `${m.words} ${shown.join(' ')}` : m.words);
  wrap.dataset.markerAt = m.at.join(',');
}

/** The element a person can focus. Its drawing is {@link paintMarker}'s, so a change of look never replaces it. */
function markerElement(m: MapMarker, pressed: ((id: string, element: HTMLElement) => void) | undefined): HTMLElement {
  const wrap = document.createElement('div');
  wrap.setAttribute('role', m.ctl ? 'button' : 'img');
  if (m.ctl) {
    wrap.dataset.ctl = m.ctl;
    wrap.tabIndex = 0;
    wrap.addEventListener('click', () => pressed?.(m.id, wrap));
    wrap.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pressed?.(m.id, wrap);
    });
  }
  wrap.dataset.markerId = m.id;
  labelMarker(wrap, m);
  paintMarker(wrap, m);
  return wrap;
}

/** The kit's pins (mockups/src/assets/map.js): a disc with initials or a stop number, a job square, a house. */
function paintMarker(wrap: HTMLElement, m: MapMarker): void {
  wrap.dataset.markerKind = m.kind;
  // The frame's own drawing units (map.js, pin 17): a disc of radius 17, a job square of 14.28, a house disc of 15.3. The
  // svg is scaled to the size the board's panel draws them at (map.css), so a computed size equals the frame's.
  const root = svg('svg', { viewBox: '-20 -20 40 40', class: `bw-marker ${m.kind === 'stop' ? 'numbered' : m.kind} ${m.state ?? ''} ${m.selected ? 'selected' : ''}`.replace(/\s+/g, ' ').trim(), 'aria-hidden': 'true' });
  if (m.kind === 'turn') {
    // The next turn (CTL-TEC-08-01, DK-113 small()): a white disc ringed in teal with the turn's arrow, the 24-unit icon scaled to the disc.
    const g = svg('g', { transform: 'translate(-11.5 -11.5) scale(.96)', fill: 'none', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'turn-icon' });
    g.innerHTML = ICON_PATHS[m.icon ?? 'arrowUp'];
    root.append(svg('circle', { r: '17', 'stroke-width': '3' }), g);
  } else if (m.kind === 'job') {
    root.append(svg('rect', { x: '-7.14', y: '-7.14', width: '14.28', height: '14.28', rx: '2.5' }));
  } else if (m.kind === 'house') {
    root.append(svg('circle', { r: '15.3' }), svg('path', { d: 'M-7.65 0.77 L0 -7.65 L7.65 0.77 M-5.5 -0.92 V7.04 H5.5 V-0.92' }));
  } else {
    // The selected van is the frame's 1.2 times larger pin in a ring of 7 units (map.js highlight).
    if (m.selected) root.append(svg('circle', { class: 'ring', r: '27.4' }));
    root.append(
      svg('circle', { r: m.selected ? '20.4' : '17', 'stroke-width': m.selected ? '3.26' : '2.72' }),
      svg('text', { y: m.selected ? '6.94' : '5.78', ...(m.selected ? { 'font-size': '17.54' } : {}) }, m.text ?? ''),
    );
  }
  wrap.replaceChildren(root);
  if (m.tag) {
    const tag = document.createElement('span');
    tag.className = 'bw-van-tag';
    tag.textContent = m.tag;
    wrap.append(tag);
  }
}

/** The box that holds the markers and, when given, the routes' lines: [west, south, east, north]; null with nothing to frame. */
function boundsOf(markers: readonly MapMarker[], routes: readonly MapRoute[]): [number, number, number, number] | null {
  const points: LngLat[] = [...markers.map((m) => m.at), ...routes.flatMap((r) => routeLine(r).coordinates)];
  if (points.length === 0) return null;
  return [
    Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1])),
  ];
}

let protocolReady = false;

export function MapView({ branch, markers = [], routes = [], legend = null, variant = 'card', altVisible = false, file, names = true, fit = false, center, zoom: openZoom, onMarker, fitKey, fitRoutes = false, focus = null, overlay = null }: MapViewProps) {
  const t = useT();
  const canvas = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const libRef = useRef<typeof import('maplibre-gl') | null>(null);
  /** True once MapLibre has fired its 1 'load' (it never fires it again): later updates draw at once (F-451). */
  const loadedRef = useRef(false);
  const placedRef = useRef(new Map<string, PlacedMarker>());
  const labelsRef = useRef<Marker[]>([]);
  const [state, setState] = useState<MapState>('loading');
  const [features, setFeatures] = useState(0);
  const [nameCounts, setNameCounts] = useState(NO_NAMES);
  const [zoomValue, setZoomValue] = useState(0);
  /** The center the map reports once idle (lng,lat to 5 places): what a test reads to find where the map opened. */
  const [centerValue, setCenterValue] = useState('');
  const [zoomEnds, setZoomEnds] = useState({ min: false, max: false });
  const [started, setStarted] = useState(0);
  const mapFile = file ?? BRANCH_MAPS[branch].file;
  const pressed = useRef(onMarker);
  pressed.current = onMarker;
  const centerKey = center ? `${center[0]},${center[1]}` : '';

  useEffect(() => {
    const host = canvas.current;
    if (!host) return;
    let cancelled = false;
    let map: MapLibreMap | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;
    void (async () => {
      try {
        const [lib, { Protocol }] = await Promise.all([import('maplibre-gl'), import('pmtiles')]);
        if (cancelled) return;
        // The tile worker is a static file of this app: the bundler emits it under /_next/static, so it is answered with
        // the same headers as every other file (SPECIFICATIONS 11.5). The library's own default would look for it
        // next to its code, which the bundle does not keep.
        lib.setWorkerUrl(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).href);
        if (!protocolReady) {
          lib.addProtocol('pmtiles', new Protocol().tile as never);
          protocolReady = true;
        }
        libRef.current = lib;
        const b = BRANCH_MAPS[branch];
        const framed = fit ? boundsOf(markers, fitRoutes ? routes : []) : null;
        map = new lib.Map({
          container: host,
          style: mapStyle(window.location.origin, mapFile, names) as never,
          center: center ? [...center] : [...b.center],
          zoom: openZoom ?? b.zoom,
          ...(framed ? { bounds: framed, fitBoundsOptions: FIT } : {}),
          minZoom: 8,
          maxZoom: 16,
          maxBounds: [b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]],
          attributionControl: false,
          // The canvas's own label is the library's English "Map": it takes the catalog's (FR-LANG-2).
          locale: { 'Map.Title': t('map.label') },
          fadeDuration: 0,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
        });
        map.touchZoomRotate.disableRotation();
        // The canvas follows its box when the box changes size (a narrower window): measured on WebKit, the library's own
        // tracking left the canvas at the old width after a viewport change. A framed map keeps its markers in view.
        observer = new ResizeObserver(() => {
          if (!map) return;
          map.resize();
          if (framed) map.fitBounds(framed, { ...FIT, animate: false });
          ends();
        });
        observer.observe(host);
        mapRef.current = map;
        // The zoom-out end is where the map really stops (F-453): the bounds lift it above minZoom in a small box.
        const lowest = () => (map ? Math.max(map.getMinZoom(), boundedMinZoom(host.clientWidth, host.clientHeight, b.bbox)) : 0);
        const ends = () => map && setZoomEnds({ min: map.getZoom() <= lowest() + 0.01, max: map.getZoom() >= map.getMaxZoom() });
        map.on('zoom', ends);
        loadedRef.current = false;
        map.once('load', () => {
          loadedRef.current = true;
        });
        // CTL-CMP-05-01 names only the file failing to load: an error before the first load, or the file's own read (the
        // source's metadata, no tile), blanks the map. A tile that fails after a good load leaves the map working (F-451).
        map.on('error', (e) => {
          const ev = e as { sourceId?: string; tile?: unknown };
          if (!loadedRef.current || (ev.sourceId === 'protomaps' && !ev.tile)) setState('failed');
        });
        // The names drawn: rendered symbol features that carry text (a shield's text is the road's ref).
        const countNames = () => {
          if (!map || !map.getStyle()) return;
          const counts = { ...NO_NAMES };
          for (const kind of NAME_KINDS) {
            const ids = NAME_LAYERS[kind].filter((id) => map?.getLayer(id));
            if (ids.length === 0) continue;
            const field = kind === 'shield' ? 'shield_text' : 'name';
            counts[kind] = map.queryRenderedFeatures({ layers: ids }).filter((f) => String(f.properties?.[field] ?? '') !== '').length;
          }
          setNameCounts(counts);
        };
        map.on('idle', () => {
          if (!map) return;
          // The base map's features only: the route lines are drawn from their own sources, and a blank base map with 1 route must count 0 (F-454).
          setFeatures(map.queryRenderedFeatures().filter((f) => f.source === 'protomaps').length);
          countNames();
          // Symbols are placed a frame or two after the last tile arrives: read the names again once they have settled.
          clearTimeout(settle);
          settle = setTimeout(countNames, 700);
          setZoomValue(Math.round(map.getZoom() * 100) / 100);
          const c = map.getCenter();
          setCenterValue(`${c.lng.toFixed(5)},${c.lat.toFixed(5)}`);
          setState((s) => (s === 'failed' ? s : 'ready'));
          ends();
        });
        setStarted((n) => n + 1);
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(settle);
      observer?.disconnect();
      map?.remove();
      mapRef.current = null;
      // The markers went with the map.
      placedRef.current.clear();
      labelsRef.current = [];
    };
    // centerKey stands for center (compared by value, so a new array of the same point does not reload the map)
  }, [branch, mapFile, names, centerKey]);

  // Markers and routes: redrawn when the data the page passes changes (compared by value, so a new array of the same
  // markers does not redraw). A marker keeps its element by id: a van's 10 s read moves it with setLngLat, a new look is
  // drawn inside the same element, and the element a person focused stays focused (F-813, NFR-06). If the focused marker
  // leaves the map, focus goes to the map itself, so a keyboard user is not thrown out of it.
  const drawKey = JSON.stringify([markers, routes, t.lang]);
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib || started === 0) return;
    const draw = () => {
      const placed = placedRef.current;
      const focused = [...placed.entries()].find(([, p]) => p.element === document.activeElement)?.[0] ?? null;
      const lines = routes.map((r) => ({ r, ...routeLine(r) }));
      const data = {
        type: 'FeatureCollection' as const,
        features: lines.map((l) => ({
          type: 'Feature' as const,
          properties: { approximate: l.approximate },
          geometry: { type: 'LineString' as const, coordinates: l.coordinates.map((c) => [...c]) },
        })),
      };
      const source = map.getSource('bw-routes') as { setData(d: unknown): void } | undefined;
      if (source) source.setData(data);
      else {
        map.addSource('bw-routes', { type: 'geojson', data: data as never });
        const paint = { 'line-color': '#2f6fe0', 'line-width': 3, 'line-opacity': 0.9 };
        map.addLayer({ id: 'bw-routes-baked', type: 'line', source: 'bw-routes', filter: ['==', ['get', 'approximate'], false], layout: { 'line-cap': 'round' }, paint });
        map.addLayer({ id: 'bw-routes-approx', type: 'line', source: 'bw-routes', filter: ['==', ['get', 'approximate'], true], layout: { 'line-cap': 'round' }, paint: { ...paint, 'line-dasharray': [2, 2] } });
      }
      for (const l of labelsRef.current) l.remove();
      labelsRef.current = [];
      for (const l of lines) {
        if (!l.approximate) continue;
        const label = document.createElement('span');
        label.className = 'bw-aprx';
        label.dataset.ctl = 'CTL-CMP-05-05';
        label.textContent = t('map.approx');
        labelsRef.current.push(new lib.Marker({ element: label }).setLngLat([...l.mid]).addTo(map));
      }
      const press = (id: string, element: HTMLElement) => pressed.current?.(id, element);
      const wanted = new Set(markers.map((m) => m.id));
      for (const [id, p] of placed) {
        if (wanted.has(id)) continue;
        p.marker.remove();
        placed.delete(id);
      }
      for (const m of markers) {
        const old = placed.get(m.id);
        if (old && old.ctl === m.ctl) {
          old.marker.setLngLat([...m.at]);
          labelMarker(old.element, m);
          const look = lookOf(m);
          if (look !== old.look) {
            paintMarker(old.element, m);
            old.look = look;
          }
          continue;
        }
        old?.marker.remove();
        const element = markerElement(m, press);
        placed.set(m.id, { marker: new lib.Marker({ element }).setLngLat([...m.at]).addTo(map), element, ctl: m.ctl, look: lookOf(m) });
      }
      // The elements stay in the order the page gave: it is the tab order, and the later marker draws on top.
      const box = map.getCanvasContainer();
      let next: Element | null = null;
      for (const m of [...markers].reverse()) {
        const el: HTMLElement = (placed.get(m.id) as PlacedMarker).element;
        if (el.nextElementSibling !== next) box.insertBefore(el, next);
        next = el;
      }
      if (focused !== null) {
        const target = placed.get(focused)?.element ?? map.getCanvas();
        if (document.activeElement !== target) target.focus({ preventScroll: true });
      }
    };
    // addSource, setData and Marker work while tiles load, so draw at once after the first load (isStyleLoaded is false
    // whenever any in-view tile is loading, and 'load' fires only once).
    if (loadedRef.current || map.isStyleLoaded()) draw();
    else map.once('load', draw);
    return () => {
      map.off('load', draw);
    };
    // drawKey stands for markers, routes and the language (compared by value); the lint rule for hook dependencies is not configured here
  }, [drawKey, started]);

  const zoom = useCallback((by: 1 | -1) => (by === 1 ? mapRef.current?.zoomIn() : mapRef.current?.zoomOut()), []);
  // CTL-TEC-15-05: frame the markers again when asked.
  useEffect(() => {
    const map = mapRef.current;
    const box = boundsOf(markers, fitRoutes ? routes : []);
    if (!fitKey || !map || box === null) return;
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], FIT);
    // only a new fitKey frames the map; the markers it frames are the ones drawn now
  }, [fitKey]);
  // CTL-TEC-08-06: a picked step centers the map on its turn.
  useEffect(() => {
    const map = mapRef.current;
    if (!focus || !map) return;
    map.easeTo({ center: [focus.at[0], focus.at[1]], zoom: Math.max(map.getZoom(), 15), duration: 0 });
    // only a new key moves the map
  }, [focus?.key]);
  const failed = state === 'failed';
  const kinds = routes.map((r) => (routeLine(r).approximate ? 'approximate' : 'baked')).join(' ');

  return (
    <>
      <div
        className={variant === 'panel' ? 'r1-map bw-map bw-map-panel' : 'r1-map bw-map'}
        role="application"
        aria-label={t('map.label')}
        data-cmp="CMP-05"
        data-ctl="CTL-CMP-05-01"
        data-map-state={state}
        data-map-branch={branch}
        data-map-file={mapFile}
        data-map-features={features}
        data-map-names={names ? 'on' : 'off'}
        data-map-street-names={nameCounts.street}
        data-map-place-names={nameCounts.place}
        data-map-water-names={nameCounts.water}
        data-map-shields={nameCounts.shield}
        data-map-zoom={zoomValue}
        data-map-center={centerValue}
        data-map-routes={kinds}
        data-map-markers={markers.length}
      >
        <div ref={canvas} className="bw-map-canvas" />
        {failed ? (
          <div className="fail" role="img" aria-label={t('map.failed')}>
            <Icon name="map" />
            {t('map.failed')}
          </div>
        ) : (
          <div className="zm">
            <button type="button" aria-label={t('map.zoomIn')} data-ctl="CTL-CMP-05-02" disabled={zoomEnds.max} onClick={() => zoom(1)}>
              +
            </button>
            <button type="button" aria-label={t('map.zoomOut')} data-ctl="CTL-CMP-05-03" disabled={zoomEnds.min} onClick={() => zoom(-1)}>
              -
            </button>
          </div>
        )}
        {overlay}
        <a className="osm" href={OSM_COPYRIGHT_URL} target="_blank" rel="noopener noreferrer" data-ctl="CTL-CMP-05-04">
          {t('map.credit')}
        </a>
      </div>
      {legend && !failed ? legend.map((kind) => (
        <div key={kind} className="bw-mkey" data-ctl="CTL-OFC-02-25" data-map-legend={kind}>
          {LEGENDS[kind].map((id) => (
            <span key={id}>
              <i className={kind === 'jobs' ? `jm ${id}` : id} />
              {t(LEGEND_KEYS[id])}
            </span>
          ))}
        </div>
      )) : null}
      <ul className={altVisible ? 'r1-mapalt' : 'bw-sr'} data-ctl="CTL-CMP-05-06">
        {markers.map((m) => (
          <li key={m.id}>{m.words}</li>
        ))}
        {routes.filter((r) => routeLine(r).approximate).map((r) => (
          <li key={r.id}>{t('map.altApprox')}</li>
        ))}
      </ul>
    </>
  );
}
