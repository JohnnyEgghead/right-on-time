// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI10, inv10-billing-exactly-once: P3-REPLAY's epoch case (BUILD_PLAN D-15; SPECIFICATIONS SD-12). A world
// reset is confirmed with the billing service through the durable marker pbs_epoch, so the fresh world and pbs never
// disagree on the epoch an invoice belongs to. With pbs stopped the clock stays paused, and after 12 failed calls in a
// row the confirmer opens billing_reset_waiting and keeps calling; when pbs answers, it applies the epoch once, the
// clock runs and the alert resolves. Real PostgreSQL 18, the real pbs server (apps/pbs) over HTTP, the worker's login
// bw_worker and pbs's bw_pbs. Run by ci/gates/G-CI10.sh step 2.
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, inTransaction, resetWorld } from '../../../packages/db/src/index.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { createLogger } from '../../../packages/log/src/index.ts';
import { Temporal } from '../../../packages/time/src/index.ts';
import { seedOutboxWorld } from '../../../packages/outbox/src/testing/world.ts';
import { writeSnapshot } from '../../../packages/setup/src/snapshot.ts';
import { startPbs, type PbsServer } from '../../../apps/pbs/src/server.ts';
import { ensureModeRow } from '../../../apps/pbs/src/store.ts';
import { HttpBillingClient } from '../../../apps/worker/src/billing/client.ts';
import { confirmStep, ConfirmerState, RESET_CONFIRM_ALERT_AFTER } from '../../../apps/worker/src/clock/confirmer.ts';

const db = useMigratedDatabase();
const login = (user: string) => {
  const u = new URL(db.url());
  u.username = user;
  return u.toString();
};
let worker: ReturnType<typeof createPool>;
let pbsPool: ReturnType<typeof createPool>;
let pbs: (PbsServer & { url: string }) | undefined;
let port = 0;
const REAL = new Date('2026-11-02T15:00:00Z');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

beforeAll(async () => {
  const a = db.admin();
  await seedOutboxWorld(a, '2026-09-15T13:00:00Z');
  await writeSnapshot(a, { clockReal: REAL, recordReal: REAL });
  worker = createPool({ connectionString: login('bw_worker'), max: 2 });
  pbsPool = createPool({ connectionString: login('bw_pbs'), max: 4 });
  await ensureModeRow(pbsPool);
  port = await freePort();
});
afterAll(async () => {
  await pbs?.close();
  await worker?.end();
  await pbsPool?.end();
});

const clockRow = async () =>
  (await db.admin().query<{ world_epoch: number; pbs_epoch: number; paused: boolean; demo_anchor: Date }>(
    'SELECT world_epoch, pbs_epoch, paused, demo_anchor FROM system.demo_clock WHERE id = 1')).rows[0]!;
const openAlerts = async () =>
  (await db.admin().query(`SELECT state FROM world.alert WHERE type = 'billing_reset_waiting' ORDER BY at`)).rows.map((r) => (r as { state: string }).state);

describe('G-CI10 epoch case: a reset is confirmed by the billing service before the clock runs (SD-12)', () => {
  // why: FR-DEMO-6, SD-12
  it('with pbs stopped the clock stays paused, billing_reset_waiting opens after 12 calls, and resolves when pbs answers', async () => {
    // A reset (the idle watcher's maker, as the worker runs it): epoch 2, unconfirmed.
    const r = await inTransaction(worker, (tx) => resetWorld(tx, { byName: 'idle', real: REAL }));
    expect(r.epoch).toBe(2);
    const state = new ConfirmerState();
    // pbs is stopped: nothing listens on its port.
    const client = new HttpBillingClient(`http://127.0.0.1:${port}`);
    const step = (n: number) => confirmStep({
      pool: worker, client, clock: { realNow: () => Temporal.Instant.fromEpochMilliseconds(REAL.getTime() + n * 5000) },
      real: () => new Date(REAL.getTime() + n * 5000), state,
    });
    for (let n = 1; n < RESET_CONFIRM_ALERT_AFTER; n++) {
      expect(await step(n)).toBe('failed');
      expect(await openAlerts(), `call ${n}`).toEqual([]);
    }
    expect(await step(RESET_CONFIRM_ALERT_AFTER)).toBe('failed');
    expect(await openAlerts()).toEqual(['open']);
    expect(await step(RESET_CONFIRM_ALERT_AFTER + 1)).toBe('failed'); // it keeps calling; still 1 open alert
    expect(await openAlerts()).toEqual(['open']);
    expect(await clockRow()).toMatchObject({ world_epoch: 2, pbs_epoch: 0, paused: true, demo_anchor: new Date('2026-09-15T11:00:00Z') });

    // pbs comes back on its port: the next call applies epoch 2 once, the clock runs and the alert resolves.
    pbs = await startPbs({ pool: pbsPool, log: createLogger({ process: 'pbs', write: () => undefined }), host: '127.0.0.1', port });
    expect(await step(RESET_CONFIRM_ALERT_AFTER + 2)).toBe('confirmed');
    expect(await clockRow()).toMatchObject({ world_epoch: 2, pbs_epoch: 2, paused: false, demo_anchor: new Date('2026-09-15T11:00:00Z') });
    expect(await openAlerts()).toEqual(['resolved']);
    const mode = await db.admin().query<{ epoch: number }>('SELECT epoch FROM pbs.mode');
    expect(mode.rows).toEqual([{ epoch: 2 }]);
    const moves = await db.admin().query(`SELECT kind, by_name FROM system.clock_move WHERE world_epoch = 2 ORDER BY at_real, id`);
    expect(moves.rows).toEqual([{ kind: 'reset', by_name: 'idle' }, { kind: 'resume', by_name: 'idle' }]);
    // The banner keeps the reset as the last move (SD-12: the resume is a clock_move row only).
    const last = await db.admin().query(`SELECT last_move_kind, last_move_by_name FROM system.demo_clock`);
    expect(last.rows).toEqual([{ last_move_kind: 'reset', last_move_by_name: 'idle' }]);
    expect(await step(RESET_CONFIRM_ALERT_AFTER + 3)).toBe('none'); // confirmed: nothing more to call
  });
});
