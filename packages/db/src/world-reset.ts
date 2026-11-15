// SPDX-License-Identifier: AGPL-3.0-or-later
// The world reset of SPECIFICATIONS SD-12, shared by its 3 makers: the reset contract (API-14, web process), the idle
// watcher and the nightly job (worker). 1 transaction, the caller's:
//
//   0. lockClockMoves (F-540): the clock-move advisory lock, taken first by every maker of a clock move (API-12, API-13, API-14
//      and both automatic resets), so a jump or pause (clock row FOR UPDATE, then world.user) and a reset (world tables, then
//      the clock row) never wait on each other in a cycle.
//   1. system.restore_world() (migration 0014): lock every world table, truncate, insert from world_snapshot, reset
//      the sequences, refresh the statistics. The world tables are locked BEFORE the clock row (a billing outcome locks its
//      item, then reads the clock row FOR SHARE); the clock-move writers hold the lock of step 0 around both.
//   2. The clock row, FOR UPDATE: the caller's guard decides on the locked row (API-14: cool-down and replay_running),
//      and a refusal throws ResetRefused, which rolls the restore back.
//   3. Clock row: Tue, Sep 15, 2026, 7:00 AM America/New_York, paused, world_epoch + 1, the mover's name as the last
//      move (kind reset), no replay; last_reset_real and last_write_real = the reset's real time (cool-down, idle).
//   4. A clock_move row of kind reset, the info alert world_reset (section 3 writer table: worldReset), clock.changed.
//
// The reset stays unconfirmed (pbs_epoch < world_epoch) until the worker's reset confirmer has pbs apply the epoch and
// unpauses the clock (apps/worker/src/clock/confirmer.ts), whichever process made it. Real time comes from the caller
// (realNow('reset_cooldown') or ('idle_reset') or ('nightly_reset')): this package reads no clock.
import type { Queryable } from './client.ts';
import { publishEvent } from './events.ts';

/** The demo time every reset sets: Tue, Sep 15, 2026, 7:00 AM America/New_York (SD-12, FR-DEMO-4, FR-DEMO-7). */
export const RESET_DEMO_TIME = new Date('2026-09-15T07:00:00-04:00');

/**
 * The mover names of the 2 automatic resets (clock_move.by_name and demo_clock.last_move_by_name; F-338). The banner
 * (apps/web/src/shell/clock.ts moveKey, CTL-CMP-02-01) names "the nightly reset" or "the idle reset" for these, never a
 * person. A person's move writes that person's user.name (FR-DEMO-6); setup writes "Setup" on its clock_move row only.
 */
export const NIGHTLY_MOVER = 'nightly';
export const IDLE_MOVER = 'idle';

/** The clock row as a reset maker reads it under its lock. */
export interface LockedClock {
  worldEpoch: number;
  pbsEpoch: number;
  paused: boolean;
  /** Demo now at the reset's real time. */
  demoNow: Date;
  replayTarget: Date | null;
  lastResetReal: Date;
  lastWriteReal: Date;
}

/** A guard's refusal: the reset rolls back and writes nothing. */
export class ResetRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`reset refused: ${reason}`);
    this.name = 'ResetRefused';
    this.reason = reason;
  }
}

export interface ResetResult {
  /** The new world epoch. */
  epoch: number;
  /** Demo now just before the reset (the clock_move row's from_demo). */
  fromDemo: Date;
  /** Number of world tables restored. */
  tables: number;
}

interface ClockRowSql {
  world_epoch: number;
  pbs_epoch: number;
  paused: boolean;
  demo_now: Date;
  replay_target: Date | null;
  last_reset_real: Date;
  last_write_real: Date;
}

/** Read the clock row (FOR UPDATE when `lock`), with demo now computed at `real` (SD-10's formula). Null before setup. */
export async function readClockAt(tx: Queryable, real: Date, lock = false): Promise<LockedClock | null> {
  const r = await tx.query<ClockRowSql>(
    `SELECT world_epoch, pbs_epoch, paused, replay_target, last_reset_real, last_write_real,
            CASE WHEN paused THEN demo_anchor ELSE demo_anchor + ($1::timestamptz - real_anchor) * rate::float8 END AS demo_now
       FROM system.demo_clock WHERE id = 1${lock ? ' FOR UPDATE' : ''}`,
    [real],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    worldEpoch: row.world_epoch, pbsEpoch: row.pbs_epoch, paused: row.paused, demoNow: row.demo_now, replayTarget: row.replay_target,
    lastResetReal: row.last_reset_real, lastWriteReal: row.last_write_real,
  };
}

/**
 * Reset the world in `tx` (SD-12). `guard` sees the locked clock row and answers a refusal reason or null; a reason
 * throws ResetRefused (the caller's transaction then rolls back the restore). Throws when there is no clock row.
 */
/** pg_advisory_xact_lock class of the clock moves ('cm'); the billing link uses 0x6269, the item keys 'ti'. */
export const CLOCK_MOVE_LOCK_CLASS = 0x636d;

/** Take the clock-move lock (F-540): the first statement of a transaction that moves or resets the clock. Re-entrant in a transaction. */
export async function lockClockMoves(tx: Queryable): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1, 1)', [CLOCK_MOVE_LOCK_CLASS]);
}

export async function resetWorld(
  tx: Queryable,
  opts: { byName: string; real: Date; guard?: (clock: LockedClock) => string | null },
): Promise<ResetResult> {
  await lockClockMoves(tx);
  const restored = await tx.query<{ tables: number }>('SELECT system.restore_world() AS tables');
  const clock = await readClockAt(tx, opts.real, true);
  if (!clock) throw new Error('system.demo_clock holds no row: setup has not run (D11)');
  const refusal = opts.guard?.(clock) ?? null;
  if (refusal !== null) throw new ResetRefused(refusal);
  const epoch = clock.worldEpoch + 1;
  await tx.query(
    `UPDATE system.demo_clock
        SET demo_anchor = $1, real_anchor = $2, paused = true, world_epoch = $3,
            last_move_by_name = $4, last_move_kind = 'reset', last_move_to = $1, last_move_real = $2,
            replay_target = NULL, replay_done = 0, replay_total = 0, last_reset_real = $2, last_write_real = $2
      WHERE id = 1`,
    [RESET_DEMO_TIME, opts.real, epoch, opts.byName],
  );
  await tx.query(
    `INSERT INTO system.clock_move (world_epoch, at_real, from_demo, to_demo, kind, by_name) VALUES ($1, $2, $3, $4, 'reset', $5)`,
    [epoch, opts.real, clock.demoNow, RESET_DEMO_TIME, opts.byName],
  );
  // The info alert of section 3's writer table (alert.type world_reset: worldReset; SD-30: no bell, no email).
  await tx.query(
    `INSERT INTO world.alert (type, state, branch_id, at, at_real, subject, message_key, message_values, link_target, emailed)
     VALUES ('world_reset', 'info', NULL, $1, $2, $3, 'alert.world_reset', '{}'::jsonb, '/office/admin/clock', false)`,
    [RESET_DEMO_TIME, opts.real, `epoch:${epoch}`],
  );
  await publishEvent(tx, 'clock.changed');
  return { epoch, fromDemo: clock.demoNow, tables: restored.rows[0]?.tables ?? 0 };
}
