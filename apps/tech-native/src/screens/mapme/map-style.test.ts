// SPDX-License-Identifier: AGPL-3.0-or-later
// The native map's style (map-style.ts): every file it names is on the phone, the lettering layers are kept (F-452), and the bundled glyph and sprite
// set is the one the web map serves.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapStyle } from '../../../../web/src/map/map-model.ts';
import { nativeMapStyle, remoteUrls } from './map-style.ts';
import { NAME_LAYERS } from './model.ts';

const FILES = { tiles: 'file:///var/mobile/Documents/bw-maps/columbus.pmtiles', assets: 'file:///var/containers/RightOnTime.app/map-assets' };
const STOPS = [{ id: 'stop-1', at: [-82.99, 39.96] as const, state: 'next' as const, text: '1', words: 'Stop 1' }];
const LEGS = [{ id: 'leg-1', from: [-82.99, 39.96] as const, to: [-82.95, 39.99] as const, track: null }];
const ASSETS = path.resolve(import.meta.dirname, '../../../../web/src/map/assets');

describe('the native map style', () => {
  // why: NFR-12 the style names no URL that reaches the network: the tiles, glyphs and sprite are files on the phone
  it('names only files on the phone', () => {
    expect(remoteUrls(nativeMapStyle(FILES, STOPS, LEGS))).toEqual([]);
    // the same function finds the web map's style, which is served over the app's own origin, and a tile source of another host
    expect(remoteUrls(mapStyle('http://127.0.0.1:8080', 'columbus.pmtiles')).length).toBeGreaterThan(0);
    expect(remoteUrls({ sources: { x: { url: 'pmtiles://https://tiles.example/x.pmtiles' } } })).toHaveLength(1);
    expect(remoteUrls({ glyphs: 'https://fonts.example/{fontstack}/{range}.pbf' })).toHaveLength(1);
    expect(remoteUrls({ sources: { x: { url: 'pmtiles://file:///a.pmtiles' } } })).toEqual([]);
  });

  // why: FR-MAP-1 F-452 the native map keeps the style's lettering layers, so it draws the street, place and water names the web map draws
  it('keeps the symbol layers of every kind of name and sets their text to the mapped name', () => {
    const style = nativeMapStyle(FILES, STOPS, LEGS);
    const web = mapStyle('http://x', 'columbus.pmtiles');
    const ids = new Set(style.layers.map((l) => l.id));
    for (const kind of Object.values(NAME_LAYERS)) for (const id of kind) expect(ids.has(id), id).toBe(true);
    const road = style.layers.find((l) => l.id === 'roads_labels_major') as { layout: { 'text-field': unknown } };
    expect(road.layout['text-field']).toEqual(['get', 'name']);
    // the base layers are the web style's, in order; the app's own layers follow them
    expect(style.layers.slice(0, web.layers.length).map((l) => l.id)).toEqual(web.layers.map((l) => l.id));
    expect(style.layers.slice(web.layers.length).map((l) => l.id)).toEqual(['bw-routes-baked', 'bw-routes-approx', 'bw-stops-disc', 'bw-stops-number']);
    expect(style.glyphs).toBe(`${FILES.assets}/fonts/{fontstack}/{range}.pbf`);
    expect(style.sprite).toBe(`${FILES.assets}/sprites/light`);
    expect(style.sources.protomaps.url).toBe(`pmtiles://${FILES.tiles}`);
  });

  // why: FR-MAP-1 the known-bad: a style with no lettering has no symbol layers, which the XCUITest's street-name count then reports as 0
  it('drops every symbol layer in the shapes-only style the known-bad run uses', () => {
    const bare = nativeMapStyle(FILES, STOPS, LEGS, false);
    expect(bare.layers.filter((l) => l.type === 'symbol')).toEqual([]);
    expect('glyphs' in bare).toBe(false);
  });

  // why: FR-MAP-3 the route is drawn along its baked track and a leg with none is dashed and flagged approximate; each stop is a numbered disc in its state's color
  it('draws legs and stops as sources of the style', () => {
    const style = nativeMapStyle(FILES, STOPS, [...LEGS, { id: 'leg-2', from: [-83, 40] as const, to: [-83.1, 40.1] as const, track: [[-83, 40], [-83.05, 40.05], [-83.1, 40.1]] as const }]);
    const routes = style.sources['bw-routes'].data as { features: { properties: { approximate: boolean }; geometry: { coordinates: unknown[] } }[] };
    expect(routes.features.map((f) => f.properties.approximate)).toEqual([true, false]);
    expect(routes.features[1]?.geometry.coordinates).toHaveLength(3);
    const stops = style.sources['bw-stops'].data as { features: { properties: { state: string; text: string } }[] };
    expect(stops.features.map((f) => `${f.properties.text}:${f.properties.state}`)).toEqual(['1:next']);
  });
});

describe('the bundled glyph and sprite set', () => {
  // why: FR-MAP-1 the font stacks the style names (the symbol layers' and the stop numbers') are folders of the bundled set, with the ranges the map asks for first
  it('holds every font stack the style names', () => {
    const style = nativeMapStyle(FILES, STOPS, LEGS);
    const stacks = new Set<string>();
    for (const l of style.layers as { layout?: { 'text-font'?: unknown } }[]) {
      const f = l.layout?.['text-font'];
      if (Array.isArray(f) && f.every((x) => typeof x === 'string')) f.forEach((x) => stacks.add(x as string));
    }
    expect(stacks.size).toBeGreaterThan(0);
    for (const stack of stacks) {
      expect(existsSync(path.join(ASSETS, 'fonts', stack, '0-255.pbf')), stack).toBe(true);
    }
    expect(readdirSync(path.join(ASSETS, 'sprites')).sort()).toContain('light.json');
  });

  // why: FR-MAP-2 the bundled set keeps its licenses and provenance, which the iOS bundle carries as the folder map-assets
  it('carries its licenses with it', () => {
    expect(existsSync(path.join(ASSETS, 'fonts', 'OFL-1.1.txt'))).toBe(true);
    expect(readFileSync(path.join(ASSETS, 'PROVENANCE.txt'), 'utf8').length).toBeGreaterThan(0);
  });
});
