// SPDX-License-Identifier: AGPL-3.0-or-later
// The Map, Parts and Me reads (reads.ts) on node:fs and a scripted client: each answer is kept on the phone and read back after the app is closed, a
// failed call is "no signal" and keeps the saved copy, a refusal is not, the notices switch and the text size are kept, and no copy outlives its person.
import { ApiError, dayRoute, partsList, todayJobs } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { KeptRecords, MapMeReads } from './reads.ts';
import { routeRead } from './steps.ts';
import { nodeDir } from '../../testing.ts';

const NOW = '2026-09-15T10:26:00-04:00[America/New_York]';
const window = { start: '2026-09-15T10:00:00-04:00[America/New_York]', end: '2026-09-15T12:00:00-04:00[America/New_York]' };
const day = (jobs: number[], date = '2026-09-15') => ({ date, jobs: jobs.map((n) => ({ jobNumber: n, window })), technician: { name: 'Maria Santos' } });
const ROUTE = { stops: [{ jobNumber: 1, number: 1, state: 'next' }], legs: [], next: 1, branch: 'columbus' };
const PARTS = [{ partId: 1, code: 'FLT-1', name: 'Filter', priceCents: 100 }];

/** A client whose calls answer from a script and fail with `failure` when it is set. */
function client() {
  const state = { jobs: [1, 2], failure: null as unknown, calls: [] as string[], dates: [] as string[], dayCalls: 0, steps: [{ kind: 'depart' }, { kind: 'arrive' }] as unknown[] };
  const api = {
    call: async (contract: unknown) => {
      if (state.failure) throw state.failure;
      if (contract === todayJobs) {
        state.dayCalls += 1;
        return { data: day(state.jobs, state.dates.shift() ?? '2026-09-15'), envelope: { meta: { demoNow: NOW } } };
      }
      if (contract === dayRoute) return { data: ROUTE };
      if (contract === partsList) return { data: { parts: PARTS } };
      if (contract === routeRead) return { data: { leg: { minutes: 12, track: [[1, 2], [3, 4]] }, branch: 'columbus', steps: state.steps }, envelope: { meta: { demoNow: NOW } } };
      throw new Error('unscripted call');
    },
  };
  return { state, api: api as never };
}

describe('the reads of the day', () => {
  // why: FR-TECH-10, FR-TECH-15 a read keeps the day, the route and the parts list on the phone, and the app opened again has them before any call
  it('keeps each answer and shows it again after the app is closed, with no call', async () => {
    const c = client();
    const dir = nodeDir();
    const reads = new MapMeReads(c.api, dir, 'u1');
    await reads.refresh();
    expect(reads.snapshot.settled).toBe(true);
    expect(reads.snapshot.parts?.data).toEqual(PARTS);
    const again = new MapMeReads(client().api, nodeDir(dir.root), 'u1');
    expect(again.snapshot.parts?.data).toEqual(PARTS);
    expect(again.snapshot.route?.data).toEqual(ROUTE);
    expect(again.snapshot.day?.at).toBe(NOW);
    expect(again.snapshot.settled).toBe(false);
  });

  // why: FR-TECH-10 with no signal the search still has the copy: a call that never reached the server is "no signal", and the saved copy stays
  it('reads a failed call as no signal and keeps the copy; a refusal is not no signal; a 401 says the session ended', async () => {
    const c = client();
    const reads = new MapMeReads(c.api, nodeDir(), 'u1');
    await reads.refresh();
    c.state.failure = new TypeError('Network request failed');
    await reads.refresh();
    expect(reads.snapshot).toMatchObject({ online: false, failed: true, signedOut: false });
    expect(reads.snapshot.parts?.data).toEqual(PARTS);
    c.state.failure = new ApiError(500, { type: 'x', title: 'x', status: 500, code: 'server_error' } as never);
    await reads.refresh();
    expect(reads.snapshot).toMatchObject({ online: false, failed: true, signedOut: false }); // a refusal leaves the connection as it was
    c.state.failure = new ApiError(401, { type: 'x', title: 'x', status: 401, code: 'unauthorized' } as never);
    await reads.refresh();
    expect(reads.snapshot.signedOut).toBe(true);
  });

  // why: F-1109 (a) an answer that does not parse (a ZodError, a JSON failure) is a failed read with signal, never a lost connection
  it('does not read an answer that fails to parse as no signal', async () => {
    const c = client();
    const reads = new MapMeReads(c.api, nodeDir(), 'u1');
    await reads.refresh();
    c.state.failure = new SyntaxError('Unexpected end of JSON input');
    await reads.refresh();
    expect(reads.snapshot).toMatchObject({ online: true, failed: true, signedOut: false });
  });

  // why: FR-TECH-15, UD-43 a re-read that finds a job added, moved or given a new window raises 1 notice only while the Notifications switch is on
  it('raises a day-changed notice per read while the switch is on, none while it is off', async () => {
    const c = client();
    const reads = new MapMeReads(c.api, nodeDir(), 'u1');
    await reads.refresh();
    c.state.jobs = [1, 2, 3];
    await reads.refresh();
    expect(reads.snapshot.notices).toHaveLength(1);
    expect(reads.snapshot.notices[0]?.change).toEqual({ kind: 'added', job: 3 });
    reads.setNotices(false);
    expect(reads.snapshot.notices).toEqual([]);
    c.state.jobs = [1];
    await reads.refresh();
    expect(reads.snapshot.notices).toEqual([]);
  });

  // why: FR-TECH-1 the clock passing midnight shows SCR-TEC-02's New day state while the list is read again for the new today, and the new day raises no notice
  it('reads the day again when the answer is another date than the one shown', async () => {
    const c = client();
    const reads = new MapMeReads(c.api, nodeDir(), 'u1');
    await reads.refresh();
    expect(c.state.dayCalls).toBe(1);
    const seen: boolean[] = [];
    const datesWhileNew: string[] = [];
    reads.subscribe(() => {
      seen.push(reads.snapshot.newDay);
      if (reads.snapshot.newDay) datesWhileNew.push(reads.snapshot.day?.data.date ?? '');
    });
    c.state.dates = ['2026-09-16', '2026-09-16'];
    c.state.jobs = [9];
    await reads.refresh();
    expect(seen).toContain(true);
    expect(datesWhileNew).toEqual(['2026-09-16']); // the New day state is drawn under the new date
    expect(reads.snapshot.newDay).toBe(false);
    expect(c.state.dayCalls).toBe(3);
    expect(reads.snapshot.day?.data.date).toBe('2026-09-16');
    expect(reads.snapshot.notices).toEqual([]);
  });

  // why: FR-TECH-15 the Notifications switch and the Text size choice are kept on the phone and are the same after the app is closed
  it('keeps the notices switch and the text size', async () => {
    const dir = nodeDir();
    const reads = new MapMeReads(client().api, dir, 'u1');
    expect(reads.snapshot).toMatchObject({ noticesOn: true, textSize: 'standard' });
    reads.setNotices(false);
    reads.setSize('large');
    const again = new MapMeReads(client().api, nodeDir(dir.root), 'u1');
    expect(again.snapshot).toMatchObject({ noticesOn: false, textSize: 'large' });
  });

  // why: FR-AUTH-11 a copy kept for 1 person is no copy for the next, and sign-out removes them all
  it('shows no copy of another person and forgets every copy on sign-out', async () => {
    const dir = nodeDir();
    await new MapMeReads(client().api, dir, 'u1').refresh();
    expect(new MapMeReads(client().api, nodeDir(dir.root), 'u2').snapshot.parts).toBeNull();
    expect(new MapMeReads(client().api, nodeDir(dir.root), 'u1').snapshot.parts).not.toBeNull();
    KeptRecords.forgetAll(dir);
    expect(new MapMeReads(client().api, nodeDir(dir.root), 'u1').snapshot.parts).toBeNull();
  });

  // why: FR-TECH-5 the leg into a job reads as a leg with its steps, a 404 as Job moved (the job is no longer this technician's), any other failure as Route not loaded
  it('reads the Directions leg with its steps and tells a moved job from a failed read', async () => {
    const c = client();
    const reads = new MapMeReads(c.api, nodeDir(), 'u1');
    expect(await reads.leg(1)).toMatchObject({ kind: 'leg', branch: 'columbus', steps: [{ kind: 'depart' }, { kind: 'arrive' }], at: NOW });
    c.state.failure = new ApiError(404, { type: 'x', title: 'x', status: 404, code: 'not_found' } as never);
    expect(await reads.leg(9)).toEqual({ kind: 'moved' });
    c.state.failure = new TypeError('Network request failed');
    expect(await reads.leg(1)).toEqual({ kind: 'failed' });
  });

  // why: F-1330 under a paused demo clock every round answers the same demoNow, so Directions must key its re-read on the day object (a new one per round), never on now
  it('gives each round a new saved day while a paused demo clock keeps now the same', async () => {
    const c = client();
    const reads = new MapMeReads(c.api, nodeDir(), 'u1');
    await reads.refresh();
    const first = reads.snapshot;
    await reads.refresh();
    const second = reads.snapshot;
    expect(second.now).toBe(first.now);
    expect(second.day).not.toBe(first.day);
  });

  // why: FR-TECH-5 UI-SPECIFICATION 4.5 rule 11 the last route read for each destination is kept on the phone with the saved day, so Directions has its steps with no signal after the app is closed
  it('keeps the last route read for each destination with the saved day, through a close and open', async () => {
    const c = client();
    const dir = nodeDir();
    const reads = new MapMeReads(c.api, dir, 'u1');
    await reads.refresh();
    expect(reads.keptRoute(1)).toBeNull();
    await reads.leg(1);
    c.state.steps = [{ kind: 'arrive' }];
    await reads.leg(2, 1);
    expect(reads.keptRoute(1)?.steps).toEqual([{ kind: 'depart' }, { kind: 'arrive' }]);
    expect(reads.keptRoute(2)?.steps).toEqual([{ kind: 'arrive' }]);
    await reads.leg(1);
    expect(reads.keptRoute(1)?.steps).toEqual([{ kind: 'arrive' }]);
    c.state.failure = new TypeError('Network request failed');
    expect(await reads.leg(1)).toEqual({ kind: 'failed' });
    expect(reads.snapshot.online).toBe(false); // no signal: Directions shows the kept route
    expect(reads.keptRoute(1)?.steps).toEqual([{ kind: 'arrive' }]);
    const reopened = new MapMeReads(client().api, nodeDir(dir.root), 'u1');
    expect(reopened.keptRoute(2)).toMatchObject({ at: NOW, branch: 'columbus', steps: [{ kind: 'arrive' }] });
    expect(new MapMeReads(client().api, nodeDir(dir.root), 'u2').keptRoute(2)).toBeNull();
  });

  // why: FR-TECH-5 rule 11 the kept routes go when the saved day goes: a read of another date leaves none, and sign-out forgets them
  it('drops the kept routes when the day read is another date, and on sign-out', async () => {
    const c = client();
    const dir = nodeDir();
    const reads = new MapMeReads(c.api, dir, 'u1');
    await reads.refresh();
    await reads.leg(1);
    expect(reads.keptRoute(1)).not.toBeNull();
    c.state.dates = ['2026-09-16', '2026-09-16'];
    await reads.refresh();
    expect(reads.keptRoute(1)).toBeNull();
    expect(new MapMeReads(client().api, nodeDir(dir.root), 'u1').snapshot.routes).toBeNull();
    await reads.leg(1);
    KeptRecords.forgetAll(dir);
    expect(new MapMeReads(client().api, nodeDir(dir.root), 'u1').keptRoute(1)).toBeNull();
  });

  // why: FR-AUTH-11 a round that began before sign-out saves nothing after it
  it('saves nothing from a round that outlives its person', async () => {
    const c = client();
    const dir = nodeDir();
    const reads = new MapMeReads(c.api, dir, 'u1');
    const round = reads.refresh();
    reads.stop();
    await round;
    expect(new MapMeReads(client().api, nodeDir(dir.root), 'u1').snapshot.day).toBeNull();
  });
});
