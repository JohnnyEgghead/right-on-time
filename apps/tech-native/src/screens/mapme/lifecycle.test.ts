// SPDX-License-Identifier: AGPL-3.0-or-later
// The reads follow the session (F-1069): after sign-out no timer, no foreground listener and no round saves anything; a 401 forgets the copies
// and ends the app's session.
import { ApiError, dayRoute, partsList, todayJobs } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { MapMeLifecycle } from './lifecycle.ts';
import { KeptRecords, MapMeReads } from './reads.ts';
import { nodeDir } from '../../testing.ts';

const NOW = '2026-09-15T10:26:00-04:00[America/New_York]';
const window = { start: '2026-09-15T10:00:00-04:00[America/New_York]', end: '2026-09-15T12:00:00-04:00[America/New_York]' };
const A = { userId: 'u1', token: 'tok-a', origin: 'http://x' };

/** A lifecycle on fake timers and a scripted client; `tokens` lists the bearer token of every call made. */
function rig() {
  const dir = nodeDir();
  const st = { failure: null as unknown, calls: [] as string[], timers: new Set<() => void>(), listeners: new Set<() => void>(), ended: 0, forgotten: 0, gate: null as null | Promise<void> };
  const life = new MapMeLifecycle({
    make: (session) => {
      const api = {
        call: async (contract: unknown) => {
          st.calls.push(session.token);
          if (st.gate) await st.gate;
          if (st.failure) throw st.failure;
          if (contract === todayJobs) return { data: { date: '2026-09-15', jobs: [{ jobNumber: 1, window }], technician: { name: 'M' } }, envelope: { meta: { demoNow: NOW } } };
          if (contract === dayRoute) return { data: { stops: [], legs: [], next: null, branch: 'columbus' } };
          if (contract === partsList) return { data: { parts: [] } };
          throw new Error('unscripted call');
        },
      };
      return new MapMeReads(api as never, dir, session.userId);
    },
    onForeground: (fn) => { st.listeners.add(fn); return () => st.listeners.delete(fn); },
    every: (fn) => { st.timers.add(fn); return () => st.timers.delete(fn); },
    forget: () => { st.forgotten += 1; KeptRecords.forgetAll(dir); },
    endSession: () => { st.ended += 1; life.follow(null); },
    everyMs: 60_000,
  });
  return { st, life, dir };
}

describe('the reads follow the session', () => {
  // why: FR-AUTH-11 after sign-out no read runs with the old token and no copy is written back
  it('stops the timer and the foreground listener at sign-out, with no screen asking, and a round in flight saves nothing', async () => {
    const r = rig();
    let release = () => undefined as void;
    r.st.gate = new Promise<void>((res) => { release = res; });
    const reads = r.life.follow(A);
    expect(r.st.timers.size).toBe(1);
    expect(r.st.listeners.size).toBe(1);
    r.life.follow(null); // the app's session ended: nothing renders a Map, Parts or Me screen after this
    expect(r.st.timers.size).toBe(0);
    expect(r.st.listeners.size).toBe(0);
    release();
    await reads?.refresh();
    expect(r.dir.list()).toEqual([]); // the round that began before sign-out saved nothing
    const before = r.st.calls.length;
    for (const fn of [...r.st.timers, ...r.st.listeners]) fn();
    expect(r.st.calls.length).toBe(before);
  });

  // why: FR-AUTH-11 a session the server ended (401) clears that person's copies and ends the app's session
  it('forgets the copies and ends the session when a read is answered 401', async () => {
    const r = rig();
    const reads = r.life.follow(A);
    await reads?.refresh();
    expect(r.dir.list().length).toBeGreaterThan(0);
    r.st.failure = new ApiError(401, { type: 'x', title: 'x', status: 401, code: 'unauthorized' } as never);
    await reads?.refresh();
    expect(r.st.ended).toBe(1);
    expect(r.dir.list()).toEqual([]);
    expect(r.st.timers.size).toBe(0);
  });
});
