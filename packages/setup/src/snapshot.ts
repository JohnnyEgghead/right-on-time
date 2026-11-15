// SPDX-License-Identifier: AGPL-3.0-or-later
// D-3 step 6, the snapshot of SD-12: copy `world` and `pbs` table by table into `world_snapshot` and `pbs_snapshot`
// (CREATE TABLE ... AS SELECT), record it in 1 system.day_snapshot row, and append epoch 1's clock_move row of kind
// `reset` (SD-12: "setup writes epoch 1's"). Runs in the caller's transaction, after the world seed.
//
// Setup's clock state (F-251). SD-12 treats setup as epoch 1's reset, and after a reset the clock is paused at Tue,
// Sep 15, 2026, 7:00 AM with the reset unconfirmed (pbs_epoch below world_epoch) until the worker's reset confirmer
// has the billing service apply the epoch, then unpauses it. The reference seed writes pbs_epoch 1 = world_epoch, which
// claims a confirmation pbs never gave (pbs.mode holds no row), so the confirmer would never run and the clock would
// stay paused. Setup sets pbs_epoch 0 here: epoch 1 is unconfirmed, exactly as after every later reset.
import { LIVE_BUILD_ID, type Queryable } from '@bw/db';
import { SetupError } from './errors.ts';

/**
 * The by_name a mover that is not a person writes (clock_move.by_name; SPECIFICATIONS FR-DEMO-6 names only a person's
 * user.name, so this is setup's choice, kept in this 1 place): setup's epoch 1 reset row is moved by "Setup".
 */
export const SETUP_MOVER_NAME = 'Setup';
export const SNAPSHOT_LABEL = 'Setup: world epoch 1';

/** The clock row's demo time after setup's reset: Tue, Sep 15, 2026, 7:00 AM America/New_York (SD-12). */
export const RESET_DEMO_TIME = new Date('2026-09-15T07:00:00-04:00');

export interface SnapshotResult {
  worldTables: number;
  pbsTables: number;
}

async function baseTables(tx: Queryable, schema: string): Promise<string[]> {
  const r = await tx.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`, [schema]);
  return r.rows.map((x) => x.name);
}

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * The rows of a world table the snapshot keeps: all of them, except van_track's live rows (SD-49: live rows are world data that the reset
 * drops, so the next read routes again). Setup routes nothing live, so this filter keeps every row it wrote; it is here so that a live
 * row can never reach the snapshot and come back with every reset.
 */
const kept = (schema: string, table: string): string =>
  schema === 'world' && table === 'van_track' ? ` WHERE build_id <> '${LIVE_BUILD_ID}'` : '';

/** clockReal: the clock row's real anchors and the clock_move row (use clock_anchor); recordReal: day_snapshot.created_real (record_stamp). */
export async function writeSnapshot(tx: Queryable, opts: { clockReal: Date; recordReal: Date }): Promise<SnapshotResult> {
  const out: Record<string, number> = {};
  for (const [from, to] of [['world', 'world_snapshot'], ['pbs', 'pbs_snapshot']] as const) {
    if ((await baseTables(tx, to)).length > 0) throw new SetupError('world_not_fresh', `${to} already holds tables; the snapshot is written once per setup`);
    const tables = await baseTables(tx, from);
    for (const t of tables) await tx.query(`CREATE TABLE ${to}.${ident(t)} AS SELECT * FROM ${from}.${ident(t)}${kept(from, t)}`);
    out[from] = tables.length;
  }
  await tx.query(`INSERT INTO system.day_snapshot (schema_name, created_real, label) VALUES ('world_snapshot', $1, $2)`, [opts.recordReal, SNAPSHOT_LABEL]);

  const clock = await tx.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1 FOR UPDATE');
  const row = clock.rows[0];
  if (!row || row.world_epoch !== 1) throw new SetupError('world_not_fresh', `the clock row is ${row ? `at world epoch ${row.world_epoch}` : 'missing'}, not the reference seed's epoch 1`);
  await tx.query(
    `INSERT INTO system.clock_move (world_epoch, at_real, from_demo, to_demo, kind, by_name) VALUES (1, $1, $2, $2, 'reset', $3)`,
    [opts.clockReal, RESET_DEMO_TIME, SETUP_MOVER_NAME]);
  await tx.query(
    `UPDATE system.demo_clock SET demo_anchor = $2, real_anchor = $1, paused = true, pbs_epoch = 0, last_reset_real = $1, last_write_real = $1
      WHERE id = 1`, [opts.clockReal, RESET_DEMO_TIME]);
  return { worldTables: out.world ?? 0, pbsTables: out.pbs ?? 0 };
}
