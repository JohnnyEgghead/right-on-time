// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S3 (G-S3-MAP-SAFARI): THROWAWAY page. MapLibre GL JS 6.14.0 + pmtiles 4.5.0, both served from
// this stack. The style has fill and line layers only (no text), so it needs no glyphs and no sprite.
// Every request goes to this origin (bw.j7l.io). The PMTiles file is read with HTTP Range requests.
import * as maplibregl from './vendor/maplibre-gl.mjs';

const base = new URL('.', location.href).href;
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const L = (id, type, sl, paint, extra = {}) => ({ id, type, source: 'cols', 'source-layer': sl, paint, ...extra });
const style = {
  version: 8,
  sources: { cols: { type: 'vector', url: 'pmtiles://' + base + 'columbus.pmtiles' } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#f4f1ea' } },
    L('earth', 'fill', 'earth', { 'fill-color': '#ece8dd' }),
    L('landuse', 'fill', 'landuse', { 'fill-color': '#cfe3c1' }, { filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest', 'nature_reserve', 'golf_course', 'cemetery']]] }),
    L('water', 'fill', 'water', { 'fill-color': '#9ccbe8' }),
    L('bldg', 'fill', 'buildings', { 'fill-color': '#d3cdc0' }, { minzoom: 13 }),
    L('minor', 'line', 'roads', { 'line-color': '#ffffff', 'line-width': 1 }, { filter: ['in', ['get', 'kind'], ['literal', ['minor_road', 'other']]], minzoom: 12 }),
    L('medium', 'line', 'roads', { 'line-color': '#ffffff', 'line-width': 2 }, { filter: ['==', ['get', 'kind'], 'medium_road'], minzoom: 10 }),
    L('major', 'line', 'roads', { 'line-color': '#f0c36d', 'line-width': 3 }, { filter: ['==', ['get', 'kind'], 'major_road'] }),
    L('highway', 'line', 'roads', { 'line-color': '#e8923c', 'line-width': 4 }, { filter: ['==', ['get', 'kind'], 'highway'] }),
  ],
};

const q = new URLSearchParams(location.search);
const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [-82.9988, 39.9612],
  zoom: Number(q.get('z') || 10),
  minZoom: 8,
  maxZoom: 15.99,
  attributionControl: false,
  fadeDuration: 0,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

// Hosts seen by this page: every resource entry from the Performance API plus the page itself.
const hostsOf = () => [...new Set(performance.getEntriesByType('resource').map((e) => new URL(e.name).host).concat(location.host))].sort();
const $ = (id) => document.getElementById(id);

// The page's Content-Security-Policy (index.html) allows this origin only. A request to any other host
// is blocked by the browser and counted here, so the screen shows 0 when nothing else was asked for.
const blocked = [];
document.addEventListener('securitypolicyviolation', (e) => {
  blocked.push(e.blockedURI);
  $('blocked').textContent = String(blocked.length);
  $('blockedWhat').textContent = blocked.slice(0, 3).join(' ');
});
function refresh() {
  $('zoom').textContent = map.getZoom().toFixed(1);
  $('status').textContent = map.areTilesLoaded() ? 'yes' : 'loading';
  $('hosts').textContent = 'Hosts seen: ' + hostsOf().join(', ');
}
map.on('render', refresh);
map.on('idle', refresh);
map.on('error', (e) => { $('status').textContent = 'ERROR ' + (e.error && e.error.message); });

// Test hook for the headless run: window.__s3 reports the state without touching the network.
window.__s3 = {
  map,
  hosts: hostsOf,
  blocked: () => blocked.slice(),
  state: () => ({
    zoom: map.getZoom(),
    loaded: map.areTilesLoaded() && map.isStyleLoaded(),
    renderedFeatures: map.queryRenderedFeatures().length,
    rendered: ['water', 'earth', 'bldg', 'minor', 'medium', 'major', 'highway'].map((id) => [id, map.queryRenderedFeatures({ layers: [id] }).length]),
  }),
};
