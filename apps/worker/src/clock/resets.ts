// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's 2 automatic resets (SPECIFICATIONS SD-12, FR-DEMO-6, FR-DEMO-7; section 2 background work). Both are
// real-time rules (section 11.3: idle_reset, nightly_reset) and both reset through @bw/db resetWorld, so the reset is
// exactly API-14's: 1 transaction, epoch + 1, unconfirmed until the reset confirmer has pbs apply it.
//
//   Idle reset watcher  every 1 min: reset when IDLE_RESET_MINUTES real minutes passed since last_write_real (the
//                       kernel stamps it on each successful write). Mover "idle" (the banner: "The idle reset").
//   Nightly reset       NIGHTLY_RESET=on: reset at 3:00 AM America/New_York real time. A night's reset is due from that
//                       3:00 AM for NIGHTLY_WINDOW_MINUTES, unless a reset already happened since it (any maker's:
//                       last_reset_real), so a worker that restarts at 3:20 resets once, and one down all night does
//                       not wipe a morning's visitors at 9:00. Mover "nightly".
//
// A reset that comes due while a replay is running ends the replay, as API-14 does (owner ruling 7ccb76ec call 7, F-863;
// resetWorld clears replay_target and the replay step then reads 'lost'). Neither runs
// on a database with no day-start snapshot (system.day_snapshot empty: setup has not finished, nothing to restore).
// A world with no write since its last reset is not reset again by the idle watcher: it is still the snapshot, and a
// new epoch would only mark every phone's queued items world_reset (owner-visible choice, stated in the lane report).
import { IDLE_MOVER, inTransaction, NIGHTLY_MOVER, readClockAt, ResetRefused, resetWorld, type createPool, type LockedClock } from '@bw/db';
import { atLocal, localDateOf, Temporal, type Instant } from '@bw/time';

type Pool = ReturnType<typeof createPool>;

export const NIGHTLY_ZONE = 'America/New_York';
export const NIGHTLY_TIME = '03:00';
/** How long after 3:00 AM a missed nightly reset still runs (a worker restarted in the night). */
export const NIGHTLY_WINDOW_MINUTES = 60;
/** SD-12 / section 2: the idle watcher looks every 1 real minute. */
export const IDLE_CHECK_EVERY_MS = 60_000;

const instant = (d: Date): Instant => Temporal.Instant.fromEpochMilliseconds(d.getTime());

/** The 3:00 AM America/New_York real instant of the night `real` belongs to (the latest one at or before `real`). */
export function nightlyInstant(real: Instant): Instant {
  const today = localDateOf(real, NIGHTLY_ZONE);
  const at = atLocal(today, NIGHTLY_TIME, NIGHTLY_ZONE, 'compatible');
  if (Temporal.Instant.compare(at, real) <= 0) return at;
  const yesterday = Temporal.PlainDate.from(today).subtract({ days: 1 }).toString();
  return atLocal(yesterday, NIGHTLY_TIME, NIGHTLY_ZONE, 'compatible');
}

/** Is the nightly reset due at `real`, given the last reset's real time? */
export function nightlyDue(lastResetReal: Instant, real: Instant): boolean {
  const night = nightlyInstant(real);
  if (Temporal.Instant.compare(lastResetReal, night) >= 0) return false;
  return real.since(night).total('minutes') < NIGHTLY_WINDOW_MINUTES;
}

/** Is the idle reset due at `real`? Only after a write since the last reset, and idleMinutes after the last write. */
export function idleDue(c: Pick<LockedClock, 'lastWriteReal' | 'lastResetReal'>, real: Instant, idleMinutes: number): boolean {
  if (c.lastWriteReal.getTime() <= c.lastResetReal.getTime()) return false;
  return real.since(instant(c.lastWriteReal)).total('minutes') >= idleMinutes;
}

export type AutoReset = 'idle' | 'nightly';

/**
 * Run the automatic resets due at `real`: the nightly one first (when on), then the idle one. Answers which reset ran,
 * or null. The rule is checked again on the locked clock row inside the reset's transaction.
 */
export async function autoResetStep(d: { pool: Pool; real: Date; idleMinutes: number; nightly: boolean }): Promise<AutoReset | null> {
  const clock = await readClockAt(d.pool, d.real);
  if (!clock) return null;
  const snap = await d.pool.query('SELECT 1 FROM system.day_snapshot LIMIT 1');
  if ((snap.rowCount ?? 0) === 0) return null;
  const real = instant(d.real);
  const which: AutoReset | null = d.nightly && nightlyDue(instant(clock.lastResetReal), real) ? 'nightly' : idleDue(clock, real, d.idleMinutes) ? 'idle' : null;
  if (which === null) return null;
  const stillDue = (c: LockedClock): string | null => {
    const due = which === 'nightly' ? nightlyDue(instant(c.lastResetReal), real) : idleDue(c, real, d.idleMinutes);
    return due ? null : 'not_due';
  };
  try {
    await inTransaction(d.pool, (tx) => resetWorld(tx, { byName: which === 'nightly' ? NIGHTLY_MOVER : IDLE_MOVER, real: d.real, guard: stillDue }));
  } catch (e) {
    if (e instanceof ResetRefused) return null;
    throw e;
  }
  return which;
}
