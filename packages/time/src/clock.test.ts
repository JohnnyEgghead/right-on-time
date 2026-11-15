// SPDX-License-Identifier: AGPL-3.0-or-later
// The clock seam (SPECIFICATIONS section 4.2, SD-10; FR-DEMO-2): demo time only from the 1 clock row, real time only
// by a named use. DbClock runs against an in-memory row here and against real PostgreSQL in ci/gates/G-CI4 (wave).
import { describe, expect, it } from 'vitest';
import { Temporal } from 'temporal-polyfill';
import { CLOCK_ROW_SQL, DbClock, FixedClock, type ClockRow } from './clock.ts';
import { realNow } from './real.ts';
import { REAL_TIME_USES, type RealTimeUse } from './uses.ts';

const I = (s: string) => Temporal.Instant.from(s);

function fakeDb(row: ClockRow | undefined) {
  const calls: string[] = [];
  return {
    calls,
    row,
    async query<R>(text: string) {
      calls.push(text);
      await Promise.resolve();
      return { rows: (this.row ? [this.row] : []) as R[] };
    },
  };
}

const ROW: ClockRow = {
  demo_anchor: new Date('2026-11-02T13:00:00Z'), real_anchor: new Date('2026-06-01T00:00:00Z'),
  rate: '1.0', paused: false, world_epoch: 3,
};

describe('DbClock: demo time from the clock row', () => {
  // why: FR-DEMO-2
  it('reads only system.demo_clock row 1 and computes demo_anchor + (real - real_anchor) x rate', async () => {
    const db = fakeDb({ ...ROW, rate: '2' });
    const clock = new DbClock(db, { real: () => I('2026-06-01T00:30:00Z'), cacheMs: 0 });
    expect((await clock.demoNow()).toString()).toBe('2026-11-02T14:00:00Z'); // 30 real minutes at rate 2
    expect(await clock.worldEpoch()).toBe(3);
    expect(db.calls.every((q) => q === CLOCK_ROW_SQL)).toBe(true);
    expect(CLOCK_ROW_SQL).toMatch(/FROM system\.demo_clock WHERE id = 1$/);
  });

  // why: FR-DEMO-2
  it('holds demo_anchor while paused, however much real time passes', async () => {
    let real = I('2026-06-01T00:00:00Z');
    const clock = new DbClock(fakeDb({ ...ROW, paused: true }), { real: () => real, cacheMs: 0 });
    expect((await clock.demoNow()).toString()).toBe('2026-11-02T13:00:00Z');
    real = real.add({ hours: 5 });
    expect((await clock.demoNow()).toString()).toBe('2026-11-02T13:00:00Z');
  });

  // why: FR-DEMO-2
  it('caches the row for 250 real ms per process, shares 1 query between concurrent callers, and re-reads after invalidate', async () => {
    let real = I('2026-06-01T00:00:00Z');
    const db = fakeDb(ROW);
    const clock = new DbClock(db, { real: () => real });
    await Promise.all([clock.demoNow(), clock.demoNow(), clock.worldEpoch()]);
    expect(db.calls).toHaveLength(1);
    real = real.add({ milliseconds: 249 });
    // The cached anchors still give a moving clock: 249 ms later reads 249 ms later.
    expect((await clock.demoNow()).toString()).toBe('2026-11-02T13:00:00.249Z');
    expect(db.calls).toHaveLength(1);
    real = real.add({ milliseconds: 1 });
    await clock.demoNow();
    expect(db.calls).toHaveLength(2);
    clock.invalidate();
    await clock.demoNow();
    expect(db.calls).toHaveLength(3);
  });

  // why: F-181 (FR-DEMO-2) a read already in flight when the process moves the clock does not fill the cache with the pre-move row,
  // and the next read after invalidate() starts its own query
  it('invalidate() drops a read in flight: the next demoNow() reads the row fresh', async () => {
    const real = I('2026-06-01T00:00:00Z');
    // A database whose answer is the row as it stood when the query was sent (the read is slow; the move lands meanwhile).
    const db = {
      calls: [] as string[], row: { ...ROW } as ClockRow,
      async query<R>(text: string) {
        this.calls.push(text);
        const sent = this.row;
        await Promise.resolve();
        return { rows: [sent] as R[] };
      },
    };
    const clock = new DbClock(db, { real: () => real });
    const stale = clock.demoNow(); // the read is in flight, holding the pre-move row
    db.row = { ...ROW, demo_anchor: new Date('2027-03-14T07:00:00Z'), paused: true };
    clock.invalidate();
    expect((await clock.demoNow()).toString()).toBe('2027-03-14T07:00:00Z');
    expect((await stale).toString()).toBe('2026-11-02T13:00:00Z'); // the old caller still gets what it asked for
    expect((await clock.demoNow()).toString()).toBe('2027-03-14T07:00:00Z'); // and its landing did not overwrite the cache
    expect(db.calls).toHaveLength(2);
  });

  // why: F-569 (FR-DEMO-2) a read in flight is shared only while it is younger than the cache lifetime, as a cached row is: with the
  // cache off (cacheMs 0, the test worker's clock) a caller after a clock move never gets the read sent before the move, and at
  // 250 ms a read in flight that long is not handed to a new caller
  it('shares a read in flight only while it is younger than the cache lifetime, so a caller after a move reads the moved row', async () => {
    const moved: ClockRow = { ...ROW, demo_anchor: new Date('2027-03-14T07:00:00Z'), paused: true, world_epoch: 4 };
    // A database whose answer is the row as it stood when the query was sent (the read is slow; the move lands meanwhile).
    const slowDb = () => ({
      calls: [] as string[], row: { ...ROW } as ClockRow,
      async query<R>(text: string) {
        this.calls.push(text);
        const sent = this.row;
        await Promise.resolve();
        return { rows: [sent] as R[] };
      },
    });
    const off = slowDb();
    const offClock = new DbClock(off, { real: () => I('2026-06-01T00:00:00Z'), cacheMs: 0 });
    const before = offClock.demoNow(); // in flight, holding the pre-move row
    off.row = moved; // another process moves the clock and commits
    expect((await offClock.demoNow()).toString()).toBe('2027-03-14T07:00:00Z');
    expect((await before).toString()).toBe('2026-11-02T13:00:00Z'); // the earlier caller still gets what it asked for
    expect(off.calls).toHaveLength(2);

    let real = I('2026-06-01T00:00:00Z');
    const on = slowDb();
    const onClock = new DbClock(on, { real: () => real });
    const first = onClock.worldEpoch();
    real = real.add({ milliseconds: 249 });
    const joined = onClock.worldEpoch(); // 249 ms after the read was sent: it joins that read
    real = real.add({ milliseconds: 1 });
    on.row = moved;
    const own = onClock.worldEpoch(); // 250 ms after: its own query
    expect([await first, await joined, await own]).toEqual([3, 3, 4]);
    expect(on.calls).toHaveLength(2);
  });

  // why: FR-DEMO-2
  it('a jump written to the row shows up after the cache, and a missing row is an error, never the wall clock', async () => {
    const db = fakeDb({ ...ROW });
    const clock = new DbClock(db, { real: () => I('2026-06-01T00:00:00Z'), cacheMs: 0 });
    db.row = { ...ROW, demo_anchor: new Date('2027-03-14T07:00:00Z') };
    expect((await clock.demoNow()).toString()).toBe('2027-03-14T07:00:00Z');
    db.row = undefined;
    await expect(clock.demoNow()).rejects.toThrow(/exactly 1 \(D11\)/);
    db.row = { ...ROW, rate: 'fast' };
    await expect(clock.demoNow()).rejects.toThrow(/not a rate/);
  });
});

describe('FixedClock: the test clock', () => {
  // why: FR-DEMO-2
  it('sets, advances and pauses demo time; real time moves only by advance', async () => {
    const clock = new FixedClock({ demo: '2026-11-02T13:00:00Z', real: '2026-06-01T00:00:00Z' });
    clock.advance({ minutes: 10 });
    expect((await clock.demoNow()).toString()).toBe('2026-11-02T13:10:00Z');
    expect(clock.realNow('session_idle').toString()).toBe('2026-06-01T00:10:00Z');
    clock.pause().advance({ hours: 1 });
    expect((await clock.demoNow()).toString()).toBe('2026-11-02T13:10:00Z');
    expect(clock.realNow('session_idle').toString()).toBe('2026-06-01T01:10:00Z');
    clock.resume().set('2026-11-03T00:00:00Z').setWorldEpoch(2);
    expect((await clock.demoNow()).toString()).toBe('2026-11-03T00:00:00Z');
    expect(await clock.worldEpoch()).toBe(2);
  });
});

describe('realNow: real time by named use only', () => {
  // why: FR-DEMO-2
  it('answers every section 11.3 use and refuses any other tag at run time', () => {
    for (const use of REAL_TIME_USES) expect(realNow(use)).toBeInstanceOf(Temporal.Instant);
    expect(() => realNow('wall_clock' as RealTimeUse)).toThrow(/not a real-time use of SPECIFICATIONS section 11\.3/);
    expect(() => new FixedClock({ demo: '2026-11-02T13:00:00Z' }).realNow('now' as RealTimeUse)).toThrow(TypeError);
  });
});
