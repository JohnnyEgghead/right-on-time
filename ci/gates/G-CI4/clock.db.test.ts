// SPDX-License-Identifier: AGPL-3.0-or-later
// DbClock against the real system.demo_clock table (PostgreSQL 18, the migrated schema), as role app: the 1 clock
// row (D11) is the only source of demo time (FR-DEMO-2). Run by gate G-CI4 (ci/gates/G-CI4/vitest.db.config.ts).
import { describe, expect, it } from 'vitest';
import { attempt, useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { DbClock, Temporal, toWire } from '../../../packages/time/src/index.ts';

const db = useMigratedDatabase();
const I = (s: string) => Temporal.Instant.from(s);
const INSERT = `INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
  VALUES (1, $1, $2, $3, $4, 7, 7, $2, $2)`;

describe('DbClock on the real clock row', () => {
  // why: FR-DEMO-2
  it('reads demo time and the world epoch from system.demo_clock as role app', async () => {
    await db.asRole('app', async (tx) => {
      await tx.query(INSERT, ['2026-10-31T21:59:00Z', '2026-06-01T12:00:00Z', '1.0', false]);
      let real = I('2026-06-01T12:00:00Z');
      const clock = new DbClock(tx, { real: () => real, cacheMs: 0 });
      expect(toWire(await clock.demoNow(), 'America/New_York')).toBe('2026-10-31T17:59:00-04:00[America/New_York]');
      real = real.add({ hours: 25, minutes: 1 });
      expect(toWire(await clock.demoNow(), 'America/New_York')).toBe('2026-11-01T18:00:00-05:00[America/New_York]');
      expect(await clock.worldEpoch()).toBe(7);
      await tx.query('UPDATE system.demo_clock SET paused = true, demo_anchor = $1 WHERE id = 1', ['2027-03-14T07:00:00Z']);
      real = real.add({ hours: 3 });
      expect((await clock.demoNow()).toString()).toBe('2027-03-14T07:00:00Z');
    });
  });

  // why: FR-DEMO-2
  it('has no row to read before setup writes it, and the table refuses a second clock row', async () => {
    await db.asRole('app', async (tx) => {
      const clock = new DbClock(tx, { real: () => I('2026-06-01T12:00:00Z') });
      await expect(clock.demoNow()).rejects.toThrow(/exactly 1 \(D11\)/);
    });
    const second = INSERT.replace('VALUES (1,', 'VALUES (2,');
    const code = await db.asRole('app', (tx) => attempt(tx, second, ['2026-10-31T21:59:00Z', '2026-06-01T12:00:00Z', '1.0', false]));
    expect(code).toBe('23514'); // demo_clock_id_is_1
  });
});
