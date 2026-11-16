// SPDX-License-Identifier: AGPL-3.0-or-later
// The legs of the seeded schedule, the track file and the coverage check, on a small planted schedule (FR-MAP-5). The
// same checks over the real fixture and the real track set run in map-manifest.maps.test.ts (the gate map-manifest).
import { describe, expect, it } from 'vitest';
import { checkCoverage } from './coverage.ts';
import { buildLegs, legKey } from './legs.ts';
import { decodePolyline, loadVanTracks, parseTracks, trackKey, type TrackRow } from './tracks.ts';
import type { StreetListRow } from '../../db/src/street-list.ts';
import type { FixtureJob, WorldFixture } from '../../setup/src/fixture.ts';

const streets: StreetListRow[] = [
  { branch: 'columbus', name: 'High', city: 'Columbus', zip: '43215', points: [[-83.0, 39.96], [-83.001, 39.961]] },
  { branch: 'dayton', name: 'Main', city: 'Dayton', zip: '45402', points: [[-84.19, 39.76]] },
];
const customers = [
  { ref: 'C1', name: 'a', nameSearch: 'a', street: 'High', city: 'Columbus', zip: '43215', houseNumber: 1 },
  { ref: 'C2', name: 'b', nameSearch: 'b', street: 'High', city: 'Columbus', zip: '43215', houseNumber: 2 },
  { ref: 'C3', name: 'c', nameSearch: 'c', street: 'High', city: 'Columbus', zip: '43215', houseNumber: 3 },
  { ref: 'D1', name: 'd', nameSearch: 'd', street: 'Main', city: 'Dayton', zip: '45402', houseNumber: 9 },
  { ref: 'D2', name: 'e', nameSearch: 'e', street: 'Main', city: 'Dayton', zip: '45402', houseNumber: 10 },
];
const roster = [{ employeeNumber: '1', branch: 'columbus' }, { employeeNumber: '2', branch: 'columbus' }, { employeeNumber: '3', branch: 'dayton' }];
const job = (jobNumber: number, customer: string, technician: string, date: string, windowStart: string): FixtureJob => ({
  jobNumber, customer, technician, service: 's', date, windowStart, windowEnd: '12:00', status: 'scheduled', arrivedAt: null, endedAt: null, bookedVia: 'office', bookedAt: '2026-08-01T08:00',
});
const fixture = (jobs: FixtureJob[]): WorldFixture => ({ zone: 'America/New_York', customers, pilotJobs: [], pilotCalls: [], demoWeekJobs: jobs, memberships: [], sampleDayScript: [] });
const jobs = [
  job(10, 'C2', '1', '2026-09-15', '10:00'),
  job(11, 'C1', '1', '2026-09-15', '08:00'),
  job(12, 'C3', '2', '2026-09-15', '08:00'),
  job(20, 'D1', '3', '2026-09-15', '08:00'),
  job(21, 'D2', '3', '2026-09-16', '08:00'),
  job(30, 'C1', '1', '2026-09-19', '08:00'), // Sat Sep 19: not a covered day
  job(31, 'C1', '1', '2026-10-31', '08:00'), // a preset day with a job: covered
];

describe('the legs of the seeded schedule', () => {
  const set = buildLegs(fixture(jobs), streets, roster);
  const keys = new Set(set.legs.map(legKey));

  // why: FR-MAP-5
  it('routes each technician-day depot to first job, job to job in window order, last job to depot', () => {
    for (const k of ['columbus|depot|11', 'columbus|11|10', 'columbus|10|depot', 'columbus|depot|12', 'columbus|12|depot', 'dayton|depot|20', 'dayton|20|depot', 'dayton|depot|21', 'columbus|depot|31', 'columbus|31|depot']) {
      expect(keys.has(k), k).toBe(true);
    }
    expect(keys.has('columbus|depot|10')).toBe(false);
  });

  // why: FR-MAP-5
  it('adds every ordered same-branch pair of Sep 15 jobs, and no cross-branch pair', () => {
    for (const k of ['columbus|10|11', 'columbus|11|10', 'columbus|10|12', 'columbus|12|10', 'columbus|11|12', 'columbus|12|11', 'dayton|20|20x']) {
      expect(keys.has(k), k).toBe(k !== 'dayton|20|20x');
    }
    expect([...keys].some((k) => /^(columbus\|\d+\|2\d|dayton\|\d+\|1\d)$/.test(k))).toBe(false);
  });

  // why: FR-MAP-5
  it('leaves out a job on a day that is neither in the demo week nor a preset day, and takes the point from the house number', () => {
    expect([...keys].some((k) => k.includes('|30'))).toBe(false);
    expect(set.jobsByDay['2026-09-19']).toBeUndefined();
    expect(set.jobsByDay['2026-10-31']).toEqual([31]);
    const c2 = set.legs.find((l) => legKey(l) === 'columbus|11|10')!;
    expect(c2.from).toEqual([-83.0, 39.96]); // house 1 -> points[0]
    expect(c2.to).toEqual([-83.001, 39.961]); // house 2 -> points[1]
  });

  // why: FR-MAP-5
  it('stops on a job whose street is not in the list or is in another branch than its technician', () => {
    expect(() => buildLegs(fixture([job(40, 'C1', '3', '2026-09-15', '08:00')]), streets, roster)).toThrow(/street is in branch columbus/);
    expect(() => buildLegs(fixture(jobs), [], roster)).toThrow(/not in the street list/);
    // F-1691: an Unassigned job (technician null) whose street is missing gets the street message, not the customer-or-technician one
    expect(() => buildLegs(fixture([{ ...job(41, 'C1', '1', '2026-09-15', '08:00'), technician: null }]), [], roster)).toThrow(/not in the street list/);
  });
});

const enc1 = (n: number): string => {
  let v = n < 0 ? ~(n << 1) : n << 1;
  let s = '';
  while (v >= 0x20) {
    s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return s + String.fromCharCode(v + 63);
};
const poly = (pts: [number, number][]): string => {
  let a = 0;
  let o = 0;
  return pts.map(([lon, lat]) => {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    const r = enc1(la - a) + enc1(lo - o);
    a = la;
    o = lo;
    return r;
  }).join('');
};
const track = (l: { branch_id: string; from_ref: string; to_ref: string }): TrackRow => ({ ...l, polyline: poly([[-83, 39.96], [-83.01, 39.97]]), seconds: [0, 55], distance_m: 1200, build_id: 'b', steps: STEPS });
const STEPS: TrackRow['steps'] = [
  { kind: 'depart', direction: null, heading: 'nw', road: 'High St', exit: null, side: null, at: [-83, 39.96], distanceMeters: 1200 },
  { kind: 'arrive', direction: null, heading: null, road: 'High St', exit: null, side: 'right', at: [-83.01, 39.97], distanceMeters: 0 },
];

describe('the track file and the coverage check', () => {
  const set = buildLegs(fixture(jobs), streets, roster);
  const all = set.legs.map(track);

  // why: FR-MAP-5
  it('passes when every required leg has a drawable track', () => {
    const r = checkCoverage(set, all);
    expect(r.missing).toEqual([]);
    expect(r.outside).toEqual([]);
    expect(r.bad).toEqual([]);
    expect(r.legs).toBe(set.legs.length);
  });

  // why: FR-MAP-5
  it('names a leg with no track, a track outside the covered days, and an undrawable track', () => {
    const lacking = all.filter((t) => trackKey(t.branch_id, t.from_ref, t.to_ref) !== 'columbus|11|10');
    expect(checkCoverage(set, lacking).missing).toEqual(['columbus|11|10']);
    const past = [...all, track({ branch_id: 'columbus', from_ref: '99', to_ref: 'depot' })];
    expect(checkCoverage(set, past).outside).toEqual(['columbus|99|depot']);
    const broken = all.map((t, i) => (i === 0 ? { ...t, seconds: [0, 5, 9] } : t));
    expect(checkCoverage(set, broken).bad).toHaveLength(1);
  });

  // why: FR-MAP-5
  it('reads tracks.ndjson back to the rows, decodes the polyline, and refuses a bad line', () => {
    const text = `${all.map((t) => JSON.stringify(t)).join('\n')}\n`;
    expect(parseTracks(text)).toEqual(all);
    expect(decodePolyline(all[0]!.polyline)).toEqual([[-83, 39.96], [-83.01, 39.97]]);
    expect(() => parseTracks('{"branch_id":1}\n')).toThrow(/line 1 is malformed/);
    expect(() => parseTracks('nope\n')).toThrow(/line 1 is not JSON/);
  });

  // why: FR-MAP-5
  it('loads the rows into world.van_track in chunks of 500 with seconds as integer[] and the steps as jsonb', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const many = Array.from({ length: 1201 }, (_, i) => track({ branch_id: 'columbus', from_ref: String(i), to_ref: 'depot' }));
    const n = await loadVanTracks({ query: (sql, params) => { calls.push({ sql, params: params ?? [] }); return Promise.resolve(); } }, many);
    expect(n).toBe(1201);
    expect(calls.map((c) => c.params.length / 8)).toEqual([500, 500, 201]);
    expect(calls[0]!.sql).toContain('INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id, steps)');
    expect(calls[0]!.sql).toContain('::integer[]');
    expect(calls[0]!.sql).toContain('::jsonb)');
    expect(calls[0]!.params[4]).toEqual([0, 55]);
    expect(JSON.parse(calls[0]!.params[7] as string)).toEqual(STEPS);
  });
});
