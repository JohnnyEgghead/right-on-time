// SPDX-License-Identifier: AGPL-3.0-or-later
// P2-STREETS: the built street list, checked on the REAL output file (not a fixture), and the build script's SHA refusal.
// The file is a release asset (docs/build/spikes/P2-STREETS.md); BW_STREET_LIST overrides the default path .build/data/street-list.json.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestAsset } from './data-asset.ts';
import { foldStreetName, readStreetList, type StreetListRow } from './street-list.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const RECORD = path.join(ROOT, 'docs', 'build', 'spikes', 'P2-STREETS.md');
const LIST = process.env['BW_STREET_LIST'] ?? path.join(ROOT, '.build', 'data', 'street-list.json');
const DATA = path.join(ROOT, 'infra', 'data', 'p2-streets');
// The 3 branch rectangles of infra/data/s8/boxes.json (the one box table, F-15): lon_min, lat_min, lon_max, lat_max. Written out here on purpose.
const BOX: Record<string, [number, number, number, number]> = {
  columbus: [-83.45, 39.65, -82.55, 40.35],
  dayton: [-84.40, 39.55, -83.95, 39.95],
  springfield: [-83.95, 39.85, -83.55, 40.10],
};

describe('the built street list (real file)', () => {
  const rows = readStreetList(LIST);

  // why: SD-23
  it('is the file the record names: its SHA-256 equals the one recorded in docs/build/spikes/P2-STREETS.md, and the CI manifest pins the same one', () => {
    const m = /^\| `street-list\.json` \| \d+ \| ([0-9a-f]{64}) \|/m.exec(readFileSync(RECORD, 'utf8'));
    expect(m, 'record has a street-list.json output row').not.toBeNull();
    expect(createHash('sha256').update(readFileSync(LIST)).digest('hex')).toBe(m?.[1]);
    expect(manifestAsset('street-list.json').sha256).toBe(m?.[1]);
  });

  // why: SD-23, OI-9
  it('holds every point inside the box of the branch the row belongs to', () => {
    expect(rows.length).toBeGreaterThan(30000);
    for (const r of rows) {
      const box = BOX[r.branch];
      expect(box, `${r.branch} is one of the 3 branches`).toBeDefined();
      const [x0, y0, x1, y1] = box!;
      for (const [lon, lat] of r.points) {
        if (lon < x0 || lon > x1 || lat < y0 || lat > y1) throw new Error(`${r.name} (${r.branch}) point ${lon},${lat} is outside its box`);
      }
    }
  });

  // why: SD-23
  it('has 1 to 8 points per row and 1 row per branch, street name, city and ZIP code', () => {
    const seen = new Set<string>();
    for (const r of rows) {
      expect(r.points.length).toBeGreaterThanOrEqual(1);
      expect(r.points.length).toBeLessThanOrEqual(8);
      const key = JSON.stringify([r.branch, r.name, r.city, r.zip]);
      if (seen.has(key)) throw new Error(`duplicate row ${key}`);
      seen.add(key);
    }
  });

  // why: SD-23, OI-9
  it('gives a street that spans 2 ZIP codes 2 rows, each with its own points (Abbey Church Road, Columbus: 43017 and 43235)', () => {
    const abbey = rows.filter((r) => r.branch === 'columbus' && r.name === 'Abbey Church Road' && r.city === 'Columbus');
    expect(abbey.map((r) => r.zip).sort()).toEqual(['43017', '43235']);
    const [a, b] = abbey;
    expect(JSON.stringify(a?.points)).not.toBe(JSON.stringify(b?.points));
  });

  // why: OOS-10
  it('carries no house-number column: each row has exactly branch, name, city, zip and points', () => {
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['branch', 'city', 'name', 'points', 'zip']);
  });

  // why: SD-23
  it('leaves no row with an empty city or a ZIP that is not 5 digits', () => {
    for (const r of rows) {
      if (r.city.trim() === '' || !/^\d{5}$/.test(r.zip)) throw new Error(`bad city/ZIP on ${JSON.stringify(r)}`);
    }
  });

  // The Census place and county subdivision names of the pinned files, and the points that took an edge tie-break, as written by build.py.
  const names = JSON.parse(readFileSync(path.join(DATA, 'census-names.json'), 'utf8')) as { places: string[]; subdivisions: string[] };
  const ties = JSON.parse(readFileSync(path.join(DATA, 'tiebreak-points.json'), 'utf8')) as {
    branch: string; name: string; point: [number, number]; zip: string; city: string; zip_basis: string | null; city_basis: string | null;
  }[];

  // why: F-174 - owner ruling c19c29b6 (nearest town): no address city may be a township label, which no postal address uses and which repeats across counties
  it('carries no township label as a city: none ends in " township", none is a county subdivision name that is not also a place name', () => {
    const places = new Set(names.places);
    const subOnly = new Set(names.subdivisions.filter((s) => !places.has(s)));
    expect(subOnly.size).toBeGreaterThan(100);
    for (const r of rows) {
      if (/ township$/i.test(r.city)) throw new Error(`township label on ${JSON.stringify(r)}`);
      if (subOnly.has(r.city)) throw new Error(`county subdivision name used as a city on ${JSON.stringify(r)}`);
    }
  });

  // why: F-174 - a row outside every Census place must be relabeled with the nearest place, so every city (relabeled or not) must be a Census place name of the pinned place file
  it('gives every row, relabeled or not, a city that is a Census place name', () => {
    const places = new Set(names.places);
    expect(places.size).toBeGreaterThan(900);
    for (const r of rows) if (!places.has(r.city)) throw new Error(`city is not a Census place name: ${JSON.stringify(r)}`);
  });

  // why: F-173 - a point on a ZIP or city edge must join the row of the same street's other points, so an edge point does not mint a 1-point row
  it('gives each edge tie-break point the ZIP and city of its street other points', () => {
    expect(ties.length).toBeGreaterThan(300);
    let byStreet = 0;
    for (const t of ties) {
      const street = rows.filter((r) => r.branch === t.branch && r.name === t.name);
      const own = street.find((r) => r.zip === t.zip && r.city === t.city);
      if (!own || !own.points.some((p) => p[0] === t.point[0] && p[1] === t.point[1])) throw new Error(`tie-break point missing from its row: ${JSON.stringify(t)}`);
      const others = (r: StreetListRow) => r.points.some((p) => p[0] !== t.point[0] || p[1] !== t.point[1]);
      if (t.zip_basis === 'street') {
        byStreet++;
        if (!street.some((r) => r.zip === t.zip && others(r))) throw new Error(`no other point of the street holds ZIP ${t.zip}: ${JSON.stringify(t)}`);
      }
      if (t.city_basis === 'street' && !street.some((r) => r.city === t.city && others(r))) throw new Error(`no other point of the street holds city ${t.city}: ${JSON.stringify(t)}`);
    }
    expect(byStreet).toBeGreaterThan(200);
  });
});

describe('foldStreetName', () => {
  // why: SD-23
  it('lowercases and folds accents and punctuation', () => {
    expect(foldStreetName("St. Mary's Ave")).toBe('st marys ave');
    expect(foldStreetName('Calle Peña')).toBe('calle pena');
  });
});

describe('the one branch box table (F-15)', () => {
  const table = path.join(ROOT, 'infra', 'data', 's8', 'boxes.json');
  const readers = ['s8/run.sh', 's8/streets.py', 'p2-streets/build.py', 'p2-streets/run.sh'].map((f) => path.join(ROOT, 'infra', 'data', f));

  // why: F-15 - a box copied into 2 scripts drifted once (the street source kept the first-pass Columbus box); the table is the only place a box may be written
  it('holds the boxes the street list is checked against, and no script carries a box of its own', () => {
    const boxes = (JSON.parse(readFileSync(table, 'utf8')) as { boxes: Record<string, number[]> }).boxes;
    expect(boxes).toEqual(BOX);
    for (const f of readers) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} reads boxes.json`).toContain('boxes.json');
      expect(src, `${f} has no coordinate literal`).not.toMatch(/-8[2-4]\.\d+\s*,\s*(39|40)\.\d+/);
    }
  });
});

describe('the build script input check', () => {
  // why: SD-23
  it('refuses, writes nothing and exits 2 when an input does not match its pinned SHA-256', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'p2streets-'));
    for (const f of ['streets.json', 'tl_2024_us_zcta520.zip', 'tl_2024_39_place.zip', 'tl_2024_39_cousub.zip']) writeFileSync(path.join(dir, f), 'not the pinned file');
    const out = path.join(dir, 'out');
    const run = spawnSync('python3', ['-I', path.join(ROOT, 'infra', 'data', 'p2-streets', 'build.py'), RECORD, dir, out], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('REFUSED');
    expect(existsSync(out)).toBe(false);
  });

  for (const bad of ['streets.json', 'tl_2024_us_zcta520.zip', 'tl_2024_39_place.zip', 'tl_2024_39_cousub.zip']) {
    // why: F-175 - one bad input among good ones must be refused by name, so a check that stops after the first input cannot pass
    it(`refuses when only ${bad} is wrong and names only that file`, () => {
      const names = ['streets.json', 'tl_2024_us_zcta520.zip', 'tl_2024_39_place.zip', 'tl_2024_39_cousub.zip'];
      const dir = mkdtempSync(path.join(tmpdir(), 'p2streets-one-'));
      const rows: string[] = [];
      for (const n of names) {
        const body = `fake ${n}`;
        writeFileSync(path.join(dir, n), n === bad ? 'changed bytes' : body);
        rows.push(`| \`${n}\` | ${body.length} | ${createHash('sha256').update(body).digest('hex')} |`);
      }
      const record = path.join(dir, 'record.md');
      writeFileSync(record, `${rows.join('\n')}\n`);
      const out = path.join(dir, 'out');
      const run = spawnSync('python3', ['-I', path.join(ROOT, 'infra', 'data', 'p2-streets', 'build.py'), record, dir, out], { encoding: 'utf8' });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('REFUSED');
      expect(run.stderr).toContain(`${bad}: SHA-256`);
      for (const n of names.filter((x) => x !== bad)) expect(run.stderr).not.toContain(n);
      expect(existsSync(out)).toBe(false);
    });
  }
});
