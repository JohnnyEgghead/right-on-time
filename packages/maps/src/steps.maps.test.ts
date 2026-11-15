// SPDX-License-Identifier: AGPL-3.0-or-later
// The turn-by-turn steps of the real baked tracks file (the gate map-manifest; vitest.maps.config.ts; P6-ROUTE-BAKE Acceptance): every
// baked track's steps start with depart, end with arrive, place each `at` on a vertex of its polyline and add up to its distance_m
// (SPECIFICATIONS v0.13 section 3 `van_track.steps`, SD-49), and every step is worded in English and Spanish (section 6.3: the test
// renders every step of the baked tracks file and fails on a step with no catalog wording). Needs the verified tracks file in $MAPS_DIR
// (default .build/data/maps): `pnpm run setup:maps`. Nothing here skips.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatterFor } from '../../i18n/src/format.ts';
import { stepDistanceText, stepText } from '../../i18n/src/step-words.ts';
import { MAPS_DIR } from './manifest.ts';
import { STEP_KINDS, stepVertexIndexes } from './steps.ts';
import { decodePolyline, parseTracks } from './tracks.ts';

const dir = process.env['MAPS_DIR'] ?? MAPS_DIR;
const tracks = parseTracks(readFileSync(path.join(dir, 'tracks.ndjson'), 'utf8'));
const where = (t: (typeof tracks)[number]): string => `${t.branch_id} ${t.from_ref} to ${t.to_ref}`;

describe('the steps of the real baked tracks', () => {
  // why: FR-TECH-5
  it('every track starts with depart, ends with arrive, places each at on a vertex of its polyline in order, and adds up to distance_m', () => {
    expect(tracks.length).toBeGreaterThan(3000);
    for (const t of tracks) {
      const s = t.steps;
      expect(s.length, where(t)).toBeGreaterThanOrEqual(2);
      expect(s[0]!.kind, where(t)).toBe('depart');
      expect(s[s.length - 1]!.kind, where(t)).toBe('arrive');
      expect(s.slice(1, -1).every((x) => x.kind !== 'depart' && x.kind !== 'arrive'), where(t)).toBe(true);
      const vs = decodePolyline(t.polyline);
      const idx = stepVertexIndexes(s, vs); // throws, naming the step, on an `at` that is no vertex at or after the step before's
      expect(idx[0], where(t)).toBe(0);
      expect(idx[idx.length - 1], where(t)).toBe(vs.length - 1);
      expect(s.reduce((a, x) => a + x.distanceMeters, 0), where(t)).toBe(t.distance_m);
      for (const x of s) {
        expect(STEP_KINDS, where(t)).toContain(x.kind);
        expect(Number.isInteger(x.distanceMeters) && x.distanceMeters >= 0, where(t)).toBe(true);
        expect(x.heading === null, `${where(t)} heading on ${x.kind}`).toBe(x.kind !== 'depart');
        if (x.kind !== 'arrive') expect(x.side, where(t)).toBeNull();
        if (x.kind !== 'roundabout') expect(x.exit, where(t)).toBeNull();
        if (['depart', 'arrive', 'roundabout', 'uturn'].includes(x.kind)) expect(x.direction, where(t)).toBeNull();
        expect(x.road === null || x.road.length > 0, where(t)).toBe(true);
      }
    }
  });

  // why: FR-TECH-5, FR-LANG-1
  it('words every step of every track in English and Spanish, with no step left without catalog wording', () => {
    const unworded: string[] = [];
    const kinds = new Set<string>();
    for (const lang of ['en', 'es'] as const) {
      const t = formatterFor(lang);
      for (const tr of tracks) {
        for (const [i, s] of tr.steps.entries()) {
          kinds.add(s.kind);
          const w = stepText(s, t, '2271 Cobblestone Dr');
          if (!w || /[{}]/.test(w)) unworded.push(`${lang} ${where(tr)} step ${i} ${JSON.stringify(s)}`);
          expect(stepDistanceText(s.distanceMeters, t)).toMatch(/^[0-9.]+ (ft|pies|mi)$/);
        }
      }
    }
    expect(unworded.slice(0, 5)).toEqual([]);
    expect(kinds.has('depart') && kinds.has('turn') && kinds.has('arrive')).toBe(true);
  });
});
