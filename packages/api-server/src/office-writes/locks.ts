// SPDX-License-Identifier: AGPL-3.0-or-later
// The locks of SPECIFICATIONS section 5.3 (SD-14; invariant 3). This is the lock API every write that changes a
// technician's day or a branch day uses: the office writes of this module, the arrival window writes (handlers/windows.ts),
// and, through this module's functions, the online booking, the customer's own move and an office customer merge or its undo.
// A technician item takes no lock of this file: it takes its item key's lock (tech-items/shared.ts) and its job's row lock.
//
// Rules, for every caller:
//   1. Lock order, always: booking-day rows, then technician-day locks, then job or block rows (section 5.3 step 6).
//      Take every lock of a kind in 1 call: each function sorts its keys, so 2 writes that need the same set wait on
//      each other in the same order and cannot deadlock.
//   2. Both are transaction locks: they end at COMMIT or ROLLBACK. Call them inside the write's transaction, never on a
//      pooled connection outside one (a transaction-level advisory lock taken outside a transaction ends at once).
//   3. Take them before reading what the write decides on (counts, the day's jobs, blocks, a window's capacity, the day's mode).
//      PostgreSQL's READ COMMITTED gives each later statement a fresh snapshot, so a value read after the lock sees every write
//      that held it before. A capacity edit (API-155) and a day switch (API-91) hold the booking-day rows, so a write that decides
//      on either value, the online booking too, reads it after that lock (F-745).
//   4. A row lock (UPDATE, SELECT ... FOR UPDATE) on a job or a block comes after these locks, never before.
import type { Queryable } from '@bw/db';

export interface BookingDayKey {
  branch: string;
  /** Local date YYYY-MM-DD in the branch zone. */
  date: string;
}

export interface TechnicianDayKey {
  technicianId: string;
  /** Local date YYYY-MM-DD in the branch zone. */
  date: string;
}

const unique = <K>(keys: readonly K[], name: (k: K) => string): K[] => {
  const seen = new Map<string, K>();
  for (const k of keys) seen.set(name(k), k);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, k]) => k);
};

/**
 * Booking-day lock (section 5.3 step 3): `SELECT ... FROM booking_day ... FOR UPDATE` on each (branch, date), inserting
 * the row first when it is missing ("created on first booking"). 2 writes adding a job to the same branch day
 * serialize here, so the second counts the first's job (the last place in a window: exactly 1 succeeds).
 */
export async function lockBookingDays(tx: Queryable, keys: readonly BookingDayKey[]): Promise<void> {
  for (const k of unique(keys, (x) => `${x.branch}|${x.date}`)) {
    // ON CONFLICT DO NOTHING: 2 first bookings of a day both try the insert; the loser waits for the winner's row, then locks it.
    await tx.query('INSERT INTO world.booking_day (branch_id, date) VALUES ($1, $2::date) ON CONFLICT DO NOTHING', [k.branch, k.date]);
    await tx.query('SELECT 1 FROM world.booking_day WHERE branch_id = $1 AND date = $2::date FOR UPDATE', [k.branch, k.date]);
  }
}

/** The advisory key of a technician-day: hashtext(technician_id || date), as section 5.3 step 2 states it. */
const TECHNICIAN_DAY_KEY_SQL = 'hashtext($1::text || $2::text)';

/**
 * Technician-day lock (section 5.3 step 2): `pg_advisory_xact_lock(hashtext(technician_id || date))` for each day the
 * write touches, in sorted order. Under it the caller checks the technician works that day, the room left and the
 * block overlap, and recomputes the day's planned arrivals (office-writes/day.ts settleDay).
 */
export async function lockTechnicianDays(tx: Queryable, keys: readonly TechnicianDayKey[]): Promise<void> {
  for (const k of unique(keys, (x) => `${x.technicianId}|${x.date}`)) {
    await tx.query(`SELECT pg_advisory_xact_lock(${TECHNICIAN_DAY_KEY_SQL})`, [k.technicianId, k.date]);
  }
}

/**
 * Try the technician-day locks without waiting (F-622): true when every key was taken. A key that is taken stays held when a
 * later one fails, so a caller that gets false rolls back to a savepoint taken before the first try (a lock taken after a
 * savepoint is released by the rollback to it).
 */
export async function tryLockTechnicianDays(tx: Queryable, keys: readonly TechnicianDayKey[]): Promise<boolean> {
  let all = true;
  for (const k of unique(keys, (x) => `${x.technicianId}|${x.date}`)) {
    const r = await tx.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(${TECHNICIAN_DAY_KEY_SQL}) AS ok`, [k.technicianId, k.date]);
    if (r.rows[0]?.ok !== true) all = false;
  }
  return all;
}
