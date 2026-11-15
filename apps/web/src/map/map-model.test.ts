// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { catalogs } from '@bw/i18n';
import { describe, expect, it } from 'vitest';
import { MAP_CONFIGS, mapFixture } from './map-fixtures.ts';
import { boundedMinZoom, BRANCH_IDS, BRANCH_MAPS, LEGEND_KEYS, LEGENDS, mapStyle, NAME_LAYERS, OSM_COPYRIGHT_URL, routeLine } from './map-model.ts';

const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../../packages/maps/MANIFEST.json'), 'utf8')) as {
  assets: { id: string; kind: string; bbox?: number[] }[];
};

describe('the branch map files (CMP-05)', () => {
  // why: FR-MAP-1 the 3 branch areas the map opens on are the 3 files the manifest names, over the same boxes
  it('names the manifest files and boxes, and opens each map inside its box', () => {
    for (const id of BRANCH_IDS) {
      const b = BRANCH_MAPS[id];
      const asset = manifest.assets.find((a) => a.id === b.file);
      expect(asset, b.file).toBeDefined();
      expect([...b.bbox], id).toEqual(asset!.bbox);
      expect(b.center[0], id).toBeGreaterThan(b.bbox[0]);
      expect(b.center[0], id).toBeLessThan(b.bbox[2]);
      expect(b.center[1], id).toBeGreaterThan(b.bbox[1]);
      expect(b.center[1], id).toBeLessThan(b.bbox[3]);
    }
    expect([...BRANCH_IDS]).toEqual(['columbus', 'dayton', 'springfield']);
  });

  // why: FR-MAP-1 the shapes-only style reads only the app's own origin, needs no key, and draws no lettering (so it has no glyphs or sprite)
  it('builds a shapes-only style whose every address is the page origin, with no glyphs, sprite or symbol layer', () => {
    const origin = 'http://127.0.0.1:8080';
    for (const id of BRANCH_IDS) {
      const style = mapStyle(origin, BRANCH_MAPS[id].file, false);
      const text = JSON.stringify(style);
      expect(style.sources.protomaps.url).toBe(`pmtiles://${origin}/maps/${BRANCH_MAPS[id].file}`);
      const addresses = text.match(/https?:\/\/[^"]+/g) ?? [];
      expect(addresses.filter((a) => !a.startsWith(origin)), id).toEqual([]);
      expect(text).not.toMatch(/key=|apikey|token/i);
      expect(Object.keys(style)).not.toContain('glyphs');
      expect(Object.keys(style)).not.toContain('sprite');
      expect(style.layers.length).toBeGreaterThan(10);
      expect(style.layers.some((l) => (l.type as string) === 'symbol')).toBe(false);
    }
  });

  // why: FR-MAP-1 the named style keeps the symbol layers with glyph and sprite addresses on the page origin, and no address leaves it
  it('builds a named style whose glyphs, sprite and every other address are the page origin', () => {
    const origin = 'http://127.0.0.1:8080';
    for (const id of BRANCH_IDS) {
      const style = mapStyle(origin, BRANCH_MAPS[id].file) as ReturnType<typeof mapStyle> & { glyphs: string; sprite: string };
      const text = JSON.stringify(style);
      expect(style.glyphs).toBe(`${origin}/map-assets/fonts/{fontstack}/{range}.pbf`);
      expect(style.sprite).toBe(`${origin}/map-assets/sprites/light`);
      const addresses = text.match(/https?:\/\/[^"]+/g) ?? [];
      expect(addresses.filter((a) => !a.startsWith(origin)), id).toEqual([]);
      expect(text).not.toMatch(/key=|apikey|token/i);
      const symbols = style.layers.filter((l) => (l.type as string) === 'symbol').map((l) => l.id);
      for (const ids of Object.values(NAME_LAYERS)) for (const lid of ids) expect(symbols, lid).toContain(lid);
    }
  });

  // why: FR-MAP-1 a label reads the OpenStreetMap name field as mapped, never a translated name (REQUIREMENTS 4.10)
  it('sets every name layer to the mapped name, with no translated field', () => {
    const style = mapStyle('http://127.0.0.1:8080', 'columbus.pmtiles');
    const text = JSON.stringify(style.layers.filter((l) => (l.type as string) === 'symbol' && !['address_label', 'roads_shields', 'roads_oneway'].includes(l.id)));
    expect(text).not.toMatch(/name:en|name:es|pgf:name|name2|name3/);
    const roadLabel = style.layers.find((l) => l.id === 'roads_labels_major') as { layout: Record<string, unknown> };
    expect(roadLabel.layout['text-field']).toEqual(['get', 'name']);
  });
});

describe('routes (CMP-05, CTL-CMP-05-05)', () => {
  const a = [-82.99, 39.96] as const;
  const b = [-82.95, 39.99] as const;
  // why: FR-MAP-3 a leg with no baked track is drawn as the straight line between its ends and marked approximate
  it('draws the straight line, marked approximate, where no track exists', () => {
    const l = routeLine({ id: 'r', from: a, to: b, track: null });
    expect(l.approximate).toBe(true);
    expect(l.coordinates).toEqual([a, b]);
    expect(l.mid[0]).toBeCloseTo(-82.97, 6);
    expect(l.mid[1]).toBeCloseTo(39.975, 6);
    // A track of 1 point is not a line: still approximate.
    expect(routeLine({ id: 'r', from: a, to: b, track: [a] }).approximate).toBe(true);
  });
  // why: FR-MAP-3 routes are drawn from the baked track when one exists, and then carry no approximate mark
  it('draws the baked track as given, not marked approximate', () => {
    const track = [a, [-82.97, 39.97], b] as const;
    const l = routeLine({ id: 'r', from: a, to: b, track });
    expect(l.approximate).toBe(false);
    expect(l.coordinates).toEqual([...track]);
  });
});

describe('the credit and the words of the map (HC-04, FR-MAP-2, FR-MAP-3)', () => {
  // why: HC-04 the credit links the OpenStreetMap copyright page, the data's license notice
  it('links the OpenStreetMap copyright page over https', () => {
    expect(OSM_COPYRIGHT_URL).toBe('https://www.openstreetmap.org/copyright');
  });
  // why: FR-MAP-3 the label reads "Approximate route" in the page's language, from the catalog in both languages
  it('has the label and every legend word in English and Spanish', () => {
    expect(catalogs.en['map.approx']).toBe('Approximate route');
    expect(catalogs.es['map.approx']).toBe('Ruta aproximada');
    for (const key of ['map.label', 'map.failed', 'map.zoomIn', 'map.zoomOut', 'map.altApprox', ...Object.values(LEGEND_KEYS)]) {
      expect(catalogs.en[key], key).toBeTruthy();
      expect(catalogs.es[key], key).toBeTruthy();
      expect(catalogs.es[key], key).not.toBe(catalogs.en[key]);
    }
    expect(LEGENDS.vans.length + LEGENDS.jobs.length).toBe(12); // F-816: Between jobs, and a begun or closed job
  });
});

describe('the test page data (FR-MAP-1)', () => {
  // why: FR-MAP-1 the 3 configurations the plan names (board, live map, technician map) are on the test page, over every branch
  it('has a board, live and technician configuration inside each branch box, with a baked and a trackless leg to prove', () => {
    expect([...MAP_CONFIGS]).toEqual(expect.arrayContaining(['board', 'live', 'technician']));
    for (const id of BRANCH_IDS) {
      const box = BRANCH_MAPS[id].bbox;
      for (const c of MAP_CONFIGS) {
        const fx = mapFixture(c, id);
        for (const m of fx.markers) {
          expect(m.at[0]).toBeGreaterThan(box[0]);
          expect(m.at[0]).toBeLessThan(box[2]);
          expect(m.at[1]).toBeGreaterThan(box[1]);
          expect(m.at[1]).toBeLessThan(box[3]);
        }
      }
      expect(mapFixture('board', id).routes.map((r) => routeLine(r).approximate)).toEqual([true]);
      expect(mapFixture('live', id).routes.map((r) => routeLine(r).approximate)).toEqual([false]);
      expect(mapFixture('technician', id).routes.map((r) => routeLine(r).approximate)).toEqual([false, true]);
    }
  });
});

describe('the zoom-out end (F-453)', () => {
  // why: FR-MAP-1 the measured stops: the bounds lift the real minimum above minZoom 8, so Zoom out must end where the map stops
  it('finds the zoom the map really stops at, as measured on the 372 px panel and the Springfield card', () => {
    expect(boundedMinZoom(372, 262, BRANCH_MAPS.columbus.bbox)).toBeCloseTo(8.18, 2);
    expect(boundedMinZoom(520, 300, BRANCH_MAPS.springfield.bbox)).toBeCloseTo(9.83, 1);
  });
});
