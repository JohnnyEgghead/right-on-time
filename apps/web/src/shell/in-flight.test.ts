// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createInFlight, createKeyedInFlight, useInFlight } from './in-flight.ts';

describe('the keyed in-flight guard (F-2077, F-2079)', () => {
  // why: F-2079 1 guard for a whole row of buttons dropped a press on a 2nd row with no sign; each key holds on its own
  it('refuses a key while it is held and lets another key go on', () => {
    const told: string[][] = [];
    const g = createKeyedInFlight((k) => told.push([...k]));
    expect([g.begin('a'), g.begin('a'), g.begin('b'), g.held('a')]).toEqual([true, false, true, true]);
    g.end('a');
    g.end('a'); // a second end tells nothing
    expect([g.held('a'), g.held('b'), g.begin('a')]).toEqual([false, true, true]);
    expect(told).toEqual([['a'], ['a', 'b'], ['b'], ['b', 'a']]);
  });
});

describe('the in-flight guard (K-01, F-2011)', () => {
  // why: K-01 a second press while a write is in flight must send nothing, so only the first begin goes on
  it('lets the first begin go on and refuses every begin until end', () => {
    const told: boolean[] = [];
    const g = createInFlight((h) => told.push(h));
    expect([g.begin(), g.begin(), g.held]).toEqual([true, false, true]);
    g.end();
    expect([g.held, g.begin()]).toEqual([false, true]);
    g.end();
    g.end(); // a second end changes nothing and tells nothing
    expect(told).toEqual([true, false, true, false]);
  });

  // why: K-01 the guard is held outside React state, so 2 calls through 1 render's functions find it taken
  it("holds the hook's guard across calls made from 1 render's functions", () => {
    let got: ReturnType<typeof useInFlight> | null = null;
    function Probe() {
      got = useInFlight();
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    const g = got as unknown as ReturnType<typeof useInFlight>;
    expect([g.busy, g.begin(), g.begin()]).toEqual([false, true, false]);
    g.end();
    expect(g.begin()).toBe(true);
  });
});
