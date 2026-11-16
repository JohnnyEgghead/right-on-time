// SPDX-License-Identifier: AGPL-3.0-or-later
// F-817 (SPECIFICATIONS 7.4 API-21): the board keeps the route lines of its last van answer by key and names them as `have` on its
// next read, so a leg that does not change travels once. An answer's route with a key and track null is drawn from the line held
// for that key; a line whose key the answer no longer names is dropped. The board sends no `have` on its first read, after a failed
// read (reset()) and after a worldEpoch change (take() then keeps nothing). A key is made from the line itself, so a held line drawn
// for its key is always that line.
import { ROUTE_HAVE_MAX } from '@bw/api';
import type { Van } from './model.ts';

type Track = NonNullable<NonNullable<Van['route']>['track']>;

export interface RouteLines {
  /** The keys to send as `have` (empty: send none). */
  have(): string[];
  /** The vans of 1 answer with each held line filled in; keeps this answer's lines for the next read. */
  take(vans: readonly Van[], worldEpoch: number): Van[];
  /** Forgets every line: the next read sends no `have` (a failed read, a branch change). */
  reset(): void;
}

export function routeLines(): RouteLines {
  let lines = new Map<string, Track>();
  let epoch: number | null = null;
  return {
    have: () => [...lines.keys()].slice(0, ROUTE_HAVE_MAX),
    take(vans, worldEpoch) {
      const next = new Map<string, Track>();
      // A route the answer left without its line that the board does not hold (never asked for): the next read asks for all.
      let missing = false;
      const out = vans.map((v) => {
        const r = v.route;
        if (!r || r.key === null) return v;
        const track = r.track ?? lines.get(r.key);
        if (track === undefined) {
          missing = true;
          return v;
        }
        next.set(r.key, track);
        return r.track === track ? v : { ...v, route: { ...r, track } };
      });
      const changed = epoch !== null && epoch !== worldEpoch;
      epoch = worldEpoch;
      lines = changed || missing ? new Map() : next;
      return out;
    },
    reset() {
      lines = new Map();
      epoch = null;
    },
  };
}
