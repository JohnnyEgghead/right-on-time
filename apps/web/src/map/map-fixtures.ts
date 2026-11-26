// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only: what each page that embeds CMP-05 passes it, drawn around a branch's downtown, for the test page
// (app/shell-preview/map/[config]) that proves the component in the 3 configurations FR-MAP-1 names. The pages that own
// these maps (the board map, the live map, the technician Map screen) pass their own data from the API; none of this ships in the release.
import { BRANCH_MAPS, type BranchId, type LngLat, type MapMarker, type MapRoute } from './map-model.ts';

export type MapConfig = 'board' | 'jobs' | 'live' | 'technician';
export const MAP_CONFIGS: readonly MapConfig[] = ['board', 'jobs', 'live', 'technician'];

const at = (branch: BranchId, dx: number, dy: number): LngLat => {
  const c = BRANCH_MAPS[branch].center;
  return [c[0] + dx, c[1] + dy];
};

export interface MapFixture {
  markers: MapMarker[];
  routes: MapRoute[];
  legend: 'vans' | 'jobs' | null;
  variant: 'panel' | 'card';
}

export function mapFixture(config: MapConfig, branch: BranchId): MapFixture {
  switch (config) {
    case 'board':
      // The office board's panel (DK-85): vans by status, the next stop's house, a trackless leg from the van on the way.
      return {
        variant: 'panel',
        legend: 'vans',
        markers: [
          { id: 'v1', kind: 'van', at: at(branch, -0.02, 0.01), state: 'way', text: 'DK', words: 'Van, Dev Kapoor, on the way to the next job, arriving about 10:40 AM' },
          { id: 'v2', kind: 'van', at: at(branch, 0.03, 0.02), state: 'site', text: 'MB', words: 'Van, Mia Brooks, on site' },
          { id: 'v3', kind: 'van', at: at(branch, 0.01, -0.03), state: 'late', text: 'GH', words: 'Van, Greg Hoffman, late to the next job, arriving about 12:25 PM' },
          { id: 'v4', kind: 'van', at: at(branch, -0.04, -0.02), state: 'free', text: 'JC', words: 'Van, Jamal Carter, free' },
          { id: 'h1', kind: 'house', at: at(branch, 0.02, 0.005), words: 'Next stop for Dev Kapoor' },
        ],
        routes: [{ id: 'r1', from: at(branch, -0.02, 0.01), to: at(branch, 0.02, 0.005), track: null }],
      };
    case 'jobs':
      return {
        variant: 'panel',
        legend: 'jobs',
        markers: [
          { id: 'j1', kind: 'job', at: at(branch, -0.02, 0.01), state: 'sched', words: 'Job, scheduled' },
          { id: 'j2', kind: 'job', at: at(branch, 0.03, 0.02), state: 'late', words: 'Job, late' },
          { id: 'j3', kind: 'job', at: at(branch, 0.01, -0.03), state: 'risk', words: 'Job, at risk' },
          { id: 'j4', kind: 'job', at: at(branch, -0.04, -0.02), state: 'unas', words: 'Job, unassigned' },
        ],
        routes: [],
      };
    case 'live':
      // The customer's live map (SCR-CUS-04): the van on its baked track to the customer's house.
      return {
        variant: 'card',
        legend: null,
        markers: [
          { id: 'v1', kind: 'van', at: at(branch, -0.02, 0.01), state: 'way', text: 'DK', words: 'Van, Dev Kapoor, on the way, arriving about 10:40 AM' },
          { id: 'h1', kind: 'house', at: at(branch, 0.025, -0.01), words: 'Your address' },
        ],
        routes: [
          {
            id: 'r1',
            from: at(branch, -0.02, 0.01),
            to: at(branch, 0.025, -0.01),
            track: [at(branch, -0.02, 0.01), at(branch, -0.005, 0.012), at(branch, 0.01, 0.004), at(branch, 0.025, -0.01)],
          },
        ],
      };
    case 'technician':
      // The technician's Map tab (SCR-TEC-08): numbered stops done, next and later; the leg to the next stop is baked, the
      // one after it has no track.
      return {
        variant: 'card',
        legend: null,
        markers: [
          { id: 's1', kind: 'stop', at: at(branch, -0.03, 0.01), state: 'done', text: '1', words: 'Stop 1, done' },
          { id: 's2', kind: 'stop', at: at(branch, 0.0, 0.02), state: 'next', text: '2', words: 'Stop 2, next, window 10 AM to 12 PM' },
          { id: 's3', kind: 'stop', at: at(branch, 0.03, -0.015), state: 'later', text: '3', words: 'Stop 3, later' },
        ],
        routes: [
          { id: 'r1', from: at(branch, -0.03, 0.01), to: at(branch, 0.0, 0.02), track: [at(branch, -0.03, 0.01), at(branch, -0.015, 0.018), at(branch, 0.0, 0.02)] },
          { id: 'r2', from: at(branch, 0.0, 0.02), to: at(branch, 0.03, -0.015), track: null },
        ],
      };
  }
}
