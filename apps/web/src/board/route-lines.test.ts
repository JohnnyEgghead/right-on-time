// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Van } from './model.ts';
import { routeLines } from './route-lines.ts';

const P = { lon: -82.9, lat: 40 };
const ROAD: [number, number][] = [[-82.9, 40], [-82.95, 40.05], [-83, 40.1]];
const OTHER: [number, number][] = [[-82.9, 40], [-82.8, 39.9]];
const van = (id: string, key: string | null, track: [number, number][] | null): Van => ({
  technicianId: id, name: id, initials: id.slice(0, 2), van: null, skills: [], phone: '', position: P, status: 'on_the_way', jobNumber: 1, eta: null,
  route: { from: P, to: P, key, track },
});

describe('the board\'s held route lines (API-21 have, F-817)', () => {
  // why: F-817 the first read names no line; the next names the lines of the last answer, and a route answered with track null is drawn from the held line
  it('names the held keys and fills a route the answer left without its line', () => {
    const lines = routeLines();
    expect(lines.have()).toEqual([]);
    lines.take([van('a', 'aaaaaaaaaaaaaaaa', ROAD), van('b', null, null)], 1);
    expect(lines.have()).toEqual(['aaaaaaaaaaaaaaaa']);
    const second = lines.take([van('a', 'aaaaaaaaaaaaaaaa', null)], 1);
    expect(second[0]!.route!.track).toEqual(ROAD);
    expect(lines.have()).toEqual(['aaaaaaaaaaaaaaaa']);
  });

  // why: F-817 a changed line comes with a new key and its whole track; the old key is dropped once no answer names it
  it('keeps the new line of a changed key and drops a key the answer no longer names', () => {
    const lines = routeLines();
    lines.take([van('a', 'aaaaaaaaaaaaaaaa', ROAD)], 1);
    const changed = lines.take([van('a', 'bbbbbbbbbbbbbbbb', OTHER)], 1);
    expect(changed[0]!.route!.track).toEqual(OTHER);
    expect(lines.have()).toEqual(['bbbbbbbbbbbbbbbb']);
    lines.take([van('a', null, null)], 1);
    expect(lines.have()).toEqual([]);
  });

  // why: F-817 after a failed read, a worldEpoch change, or a route left without a line the board does not hold, the next read names no line
  it('names no line after a reset, a worldEpoch change, or a line it does not hold', () => {
    const lines = routeLines();
    lines.take([van('a', 'aaaaaaaaaaaaaaaa', ROAD)], 1);
    lines.reset();
    expect(lines.have()).toEqual([]);
    lines.take([van('a', 'aaaaaaaaaaaaaaaa', ROAD)], 1);
    lines.take([van('a', 'aaaaaaaaaaaaaaaa', ROAD)], 2);
    expect(lines.have()).toEqual([]);
    lines.take([van('a', 'aaaaaaaaaaaaaaaa', ROAD)], 2);
    expect(lines.have()).toEqual(['aaaaaaaaaaaaaaaa']);
    const unknown = lines.take([van('a', 'aaaaaaaaaaaaaaaa', ROAD), van('c', 'cccccccccccccccc', null)], 2);
    expect(unknown[1]!.route!.track).toBeNull();
    expect(lines.have()).toEqual([]);
  });

  // why: F-817 the request takes at most 50 keys
  it('names at most 50 keys', () => {
    const lines = routeLines();
    lines.take(Array.from({ length: 60 }, (_, i) => van(`v${i}`, i.toString(16).padStart(16, '0'), ROAD)), 1);
    expect(lines.have()).toHaveLength(50);
  });
});
