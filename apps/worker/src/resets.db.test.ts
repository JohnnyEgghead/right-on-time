// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's automatic resets and Cleanup (SPECIFICATIONS SD-12, FR-DEMO-6, FR-DEMO-7; section 2 background work) on
// the real database, as the worker's login bw_worker (role app: the reset's EXECUTE on system.restore_world, F-150),
// after a day-start snapshot written by setup's own writeSnapshot. Each step is called with its real time, so no test
// reads the wall. Run by gate G-CI2 (ci/gates/G-CI2/vitest.db.config.ts: apps/worker/src/*.db.test.ts).
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDLE_MOVER, NIGHTLY_MOVER } from '@bw/db';
import { Temporal } from '@bw/time';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { addCustomer, addJob, loginPool, seedOutboxWorld, type OutboxRef } from '../../../packages/outbox/src/testing/world.ts';
import { writeSnapshot } from '../../../packages/setup/src/snapshot.ts';
import { CLEANUP_MIN_AGE_MS, cleanup } from './clock/cleanup.ts';
import { confirmStep, ConfirmerState } from './clock/confirmer.ts';
import { autoResetStep } from './clock/resets.ts';

const db = useMigratedDatabase();
let ref: OutboxRef;
let worker: ReturnType<typeof loginPool>;
const SETUP_REAL = new Date('2026-11-02T12:00:00Z');
const at = (iso: string) => new Date(iso);
const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

beforeAll(async () => {
  const a = db.admin();
  ref = await seedOutboxWorld(a, '2026-09-15T13:00:00Z');
  await a.query(`UPDATE system.demo_clock SET real_anchor = $1, last_reset_real = $1, last_write_real = $1 WHERE id = 1`, [SETUP_REAL]);
  await writeSnapshot(a, { clockReal: SETUP_REAL, recordReal: SETUP_REAL });
  worker = loginPool(db.url(), 'bw_worker');
});
afterAll(async () => {
  await worker?.end();
});

const clockRow = async () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await db.admin().query<any>(`SELECT world_epoch, pbs_epoch, paused, demo_anchor, last_move_by_name, last_move_kind, last_reset_real, last_write_real
                             FROM system.demo_clock WHERE id = 1`)).rows[0];
const customers = async () => Number((await db.admin().query<{ n: string }>('SELECT count(*) AS n FROM world.customer')).rows[0]!.n);

/** A confirmed world, clock running at `demo`, last reset at `resetReal` and last write at `writeReal`. */
async function world(o: { resetReal: Date; writeReal: Date; demo?: string }): Promise<void> {
  await db.admin().query(`UPDATE system.demo_clock SET pbs_epoch = world_epoch, paused = false, replay_target = NULL, demo_anchor = $3, real_anchor = $1,
                            last_reset_real = $1, last_write_real = $2 WHERE id = 1`, [o.resetReal, o.writeReal, o.demo ?? '2026-09-15T18:00:00Z']);
}

describe('the idle reset watcher (FR-DEMO-6)', () => {
  // why: FR-DEMO-6
  it('resets an idle world after 120 real minutes with no write, and not at 119, nor a world with no write since its reset', async () => {
    const r0 = at('2026-11-02T13:00:00Z');
    await world({ resetReal: r0, writeReal: plus(r0, 5) });
    const snapshotCustomers = await customers();
    await addCustomer(db.admin(), ref, { name: 'Visitor Added' });
    expect(await customers()).toBe(snapshotCustomers + 1);
    const before = await clockRow();

    expect(await autoResetStep({ pool: worker, real: plus(r0, 5 + 119), idleMinutes: 120, nightly: false })).toBeNull();
    expect((await clockRow())!.world_epoch).toBe(before!.world_epoch);
    expect(await autoResetStep({ pool: worker, real: plus(r0, 5 + 120), idleMinutes: 120, nightly: false })).toBe('idle');
    expect(await customers()).toBe(snapshotCustomers);
    expect(await clockRow()).toMatchObject({
      world_epoch: before!.world_epoch + 1, paused: true, demo_anchor: at('2026-09-15T11:00:00Z'), last_move_by_name: IDLE_MOVER, last_move_kind: 'reset',
      last_reset_real: plus(r0, 125), last_write_real: plus(r0, 125),
    });
    // The reset world has had no write since: the watcher leaves it, however long it stays idle.
    await db.admin().query('UPDATE system.demo_clock SET pbs_epoch = world_epoch WHERE id = 1');
    expect(await autoResetStep({ pool: worker, real: plus(r0, 125 + 600), idleMinutes: 120, nightly: false })).toBeNull();
  });

  // why: FR-DEMO-6
  it('never resets with IDLE_RESET_MINUTES=0, however long the world is idle', async () => {
    const r0 = at('2026-11-02T13:00:00Z');
    await world({ resetReal: r0, writeReal: plus(r0, 5) });
    const before = await clockRow();
    expect(await autoResetStep({ pool: worker, real: plus(r0, 5 + 120), idleMinutes: 0, nightly: false })).toBeNull();
    expect(await autoResetStep({ pool: worker, real: plus(r0, 5 + 60 * 24 * 30), idleMinutes: 0, nightly: false })).toBeNull();
    expect((await clockRow())!.world_epoch).toBe(before!.world_epoch);
  });
});

describe('the nightly reset (FR-DEMO-7)', () => {
  // why: FR-DEMO-7
  // why: F-863 (owner ruling 7ccb76ec call 7: a demo reset ends a running replay); both resets waited for it
  it('an idle reset and a nightly reset each end a running replay', async () => {
    const r0 = at('2026-11-02T13:00:00Z');
    const running = async () => (await db.admin().query<{ replay_target: Date | null }>('SELECT replay_target FROM system.demo_clock WHERE id = 1')).rows[0]!.replay_target;
    const startReplay = () => db.admin().query(`UPDATE system.demo_clock SET replay_target = $1, replay_done = 1, replay_total = 5 WHERE id = 1`, [at('2026-09-16T13:00:00Z')]);
    await world({ resetReal: r0, writeReal: plus(r0, 5) });
    await startReplay();
    expect(await autoResetStep({ pool: worker, real: plus(r0, 5 + 120), idleMinutes: 120, nightly: false })).toBe('idle');
    expect(await running()).toBeNull();

    const night = at('2026-11-03T08:00:00Z');
    await world({ resetReal: plus(night, -24 * 60), writeReal: plus(night, -60 * 20) });
    await startReplay();
    expect(await autoResetStep({ pool: worker, real: plus(night, 5), idleMinutes: 100_000, nightly: true })).toBe('nightly');
    expect(await running()).toBeNull();
  });

  it("resets at 3:00 AM Eastern: the clock then reads Tue, Sep 15, 7:00 AM and the day's visitor changes are gone", async () => {
    const evening = at('2026-11-03T01:00:00Z'); // Mon, Nov 2, 8:00 PM EST
    await world({ resetReal: evening, writeReal: plus(evening, 10), demo: '2026-09-16T20:00:00Z' });
    const snapshotCustomers = await customers();
    await addCustomer(db.admin(), ref, { name: 'Visitor Of The Day' });
    const night = at('2026-11-03T08:00:00Z'); // Tue, Nov 3, 3:00 AM EST
    expect(await autoResetStep({ pool: worker, real: plus(night, -1), idleMinutes: 100_000, nightly: true })).toBeNull();
    expect(await autoResetStep({ pool: worker, real: plus(night, 0.5), idleMinutes: 100_000, nightly: true })).toBe('nightly');
    expect(await customers()).toBe(snapshotCustomers);
    expect(await clockRow()).toMatchObject({ paused: true, demo_anchor: at('2026-09-15T11:00:00Z'), last_move_by_name: NIGHTLY_MOVER, last_move_kind: 'reset' });
    // The confirmer has pbs apply the epoch and unpauses the clock at Tue, Sep 15, 7:00 AM.
    const state = new ConfirmerState();
    const confirmed = await confirmStep({ pool: worker, client: { reset: async (e) => ({ applied: true, epoch: e }) }, clock: { realNow: () => Temporal.Instant.from('2026-11-03T08:00:40Z') }, real: () => plus(night, 1), state });
    expect(confirmed).toBe('confirmed');
    const c = await clockRow();
    expect(c).toMatchObject({ paused: false, demo_anchor: at('2026-09-15T11:00:00Z') });
    expect(c!.pbs_epoch).toBe(c!.world_epoch);
    // The same night runs it once; with NIGHTLY_RESET off it never runs.
    expect(await autoResetStep({ pool: worker, real: plus(night, 20), idleMinutes: 100_000, nightly: true })).toBeNull();
    await world({ resetReal: evening, writeReal: plus(evening, 10) });
    expect(await autoResetStep({ pool: worker, real: plus(night, 0.5), idleMinutes: 100_000, nightly: false })).toBeNull();
  });
});

describe('Cleanup after a reset (SD-12, section 2)', () => {
  // why: F-474, FR-DEMO-4
  // why: FR-TECH-3 (SD-32) a photo's small copy is referenced by its photo's row: it stays with its photo and goes with an orphan
  it('deletes old photo files no row references, keeps referenced and young ones, and prunes earlier epochs\' clock moves', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bw-photos-'));
    try {
      const real = at('2026-11-04T12:00:00Z');
      const old = new Date(real.getTime() - CLEANUP_MIN_AGE_MS - 1000);
      const young = new Date(real.getTime() - CLEANUP_MIN_AGE_MS + 60_000);
      await mkdir(path.join(dir, '2026-09'));
      const files = {
        referenced: '2026-09/aaaa', orphan: '2026-09/bbbb', inFlight: '2026-09/cccc', keptRefused: '2026-09/dddd',
        referencedThumb: '2026-09/aaaa.thumb.jpg', orphanThumb: '2026-09/bbbb.thumb.jpg', keptRefusedThumb: '2026-09/dddd.thumb.jpg',
      };
      for (const [k, f] of Object.entries(files)) {
        await writeFile(path.join(dir, f), 'x');
        const t = k === 'inFlight' ? young : old;
        await utimes(path.join(dir, f), t, t);
      }
      const signer = await addCustomer(db.admin(), ref, { name: 'Signed Customer' });
      const jobNumber = await addJob(db.admin(), ref, signer, '2026-09-15');
      await db.admin().query(`INSERT INTO world.signature (key, job_number, signed_by_name, signed_at, file, sent_at)
                              VALUES (gen_random_uuid(), $1, 'Signed Customer', '2026-09-15T15:00:00Z', $2, '2026-09-15T15:00:00Z')`, [jobNumber, files.referenced]);
      // F-1168: a refused photo kept for the dispatcher is referenced by its flagged ledger row (payload.file), so the sweep leaves it
      const tech = (await db.admin().query<{ id: string }>('SELECT id FROM world.technician LIMIT 1')).rows[0]!.id;
      await db.admin().query(`INSERT INTO world.tech_item (key, technician_id, job_number, kind, world_epoch, device_time_real, offset_saved_real, demo_time, since_save_ms, received_at, result, payload)
                              VALUES (gen_random_uuid(), $1, $2, 'photo', 0, now(), now(), now(), 0, now(), 'flagged', $3::jsonb)`, [tech, jobNumber, JSON.stringify({ file: files.keptRefused })]);
      const moves = await db.admin().query<{ n: string }>('SELECT count(*) AS n FROM system.clock_move WHERE world_epoch < (SELECT world_epoch FROM system.demo_clock)');
      expect(Number(moves.rows[0]!.n)).toBeGreaterThan(0);
      const report = await cleanup({ pool: worker, photosDir: dir, real });
      expect(report.filesDeleted).toBe(2);
      await expect(stat(path.join(dir, files.orphan))).rejects.toThrow();
      await expect(stat(path.join(dir, files.orphanThumb))).rejects.toThrow(); // SD-32: an orphan's small copy goes with it
      for (const f of [files.referencedThumb, files.keptRefusedThumb]) expect((await stat(path.join(dir, f))).isFile()).toBe(true);
      expect((await stat(path.join(dir, files.referenced))).isFile()).toBe(true);
      expect((await stat(path.join(dir, files.keptRefused))).isFile()).toBe(true); // a flagged photo row still points at this file, so cleanup keeps it (F-1168)
      expect((await stat(path.join(dir, files.inFlight))).isFile()).toBe(true); // F-474: a send's file before its row commits
      expect(report.clockMovesPruned).toBe(Number(moves.rows[0]!.n));
      expect(await cleanup({ pool: worker, photosDir: path.join(dir, 'none'), real })).toMatchObject({ filesDeleted: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
