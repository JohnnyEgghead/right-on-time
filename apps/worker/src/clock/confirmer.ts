// SPDX-License-Identifier: AGPL-3.0-or-later
// The reset confirmer (SPECIFICATIONS SD-12; section 2 background work: every 5 s real time, and at start-up). A reset
// is unconfirmed while system.demo_clock.pbs_epoch is below world_epoch, whichever process made it (API-14 in web, the
// idle watcher or the nightly job here) and across a crash. While unconfirmed, each step calls the billing service's
// reset endpoint with world_epoch; on success, in 1 transaction: pbs_epoch = that epoch, the clock unpaused at its
// paused time, a clock_move row of kind resume (the clock row's last move keeps the reset, for the banner), the
// billing_reset_waiting alert resolved, and world.reset published. Then the cleanup of a reset runs (./cleanup.ts).
//
// Bound: after RESET_CONFIRM_ALERT_AFTER failed calls in a row (about 60 real seconds) the step opens the alert
// billing_reset_waiting (SD-30) and keeps calling; the clock stays paused until pbs answers, the honest state while
// the billing system is down. pbs applies a reset once per epoch, so a repeated call after a lost answer is harmless.
import { inTransaction, publishEvent, readClockAt, type createPool } from '@bw/db';
import { Temporal, type Clock } from '@bw/time';
import { openAlert } from '../alerts/check.ts';
import type { BillingClient } from '../billing/client.ts';

type Pool = ReturnType<typeof createPool>;

/** SD-12: the alert opens after 12 failed calls in a row (about 60 real seconds at 1 call per 5 s). */
export const RESET_CONFIRM_ALERT_AFTER = 12;
/** SD-12 and section 2: the confirmer runs every 5 real seconds. */
export const RESET_CONFIRM_EVERY_MS = 5_000;
export const RESET_WAITING_SUBJECT = 'billing_reset';

export class ConfirmerState {
  /** Failed calls in a row for the current unconfirmed epoch. */
  failures = 0;
  epoch = 0;
}

export type ConfirmStep = 'none' | 'confirmed' | 'failed';

export interface ConfirmerDeps {
  pool: Pool;
  client: Pick<BillingClient, 'reset'>;
  clock: Pick<Clock, 'realNow'>;
  /** Real now (use clock_anchor): the clock row's new real anchor and the clock_move row's at_real. */
  real: () => Date;
  state: ConfirmerState;
}

/** 1 confirmer step: nothing to confirm, confirmed now, or a failed call (counted; the 12th opens the alert). */
export async function confirmStep(d: ConfirmerDeps): Promise<ConfirmStep> {
  const clock = await readClockAt(d.pool, d.real());
  if (!clock || clock.pbsEpoch >= clock.worldEpoch) {
    d.state.failures = 0;
    return 'none';
  }
  const epoch = clock.worldEpoch;
  if (d.state.epoch !== epoch) {
    d.state.epoch = epoch;
    d.state.failures = 0;
  }
  try {
    await d.client.reset(epoch);
  } catch {
    d.state.failures += 1;
    if (d.state.failures >= RESET_CONFIRM_ALERT_AFTER) {
      const now = Temporal.Instant.fromEpochMilliseconds(clock.demoNow.getTime());
      await inTransaction(d.pool, (tx) =>
        openAlert(tx, 'billing_reset_waiting', { subject: RESET_WAITING_SUBJECT, branchId: null, values: { epoch }, link: '/office/admin/health' }, { now, clock: d.clock }));
    }
    return 'failed';
  }
  const done = await inTransaction(d.pool, async (tx) => {
    const real = d.real();
    const c = await readClockAt(tx, real, true);
    // A newer reset meanwhile: the next step confirms that epoch (pbs applies a later epoch even when one was skipped).
    if (!c || c.worldEpoch !== epoch || c.pbsEpoch >= epoch) return false;
    const mover = await tx.query<{ by_name: string }>(
      'SELECT by_name FROM system.clock_move WHERE world_epoch = $1 ORDER BY at_real DESC, id DESC LIMIT 1', [epoch]);
    await tx.query(`UPDATE system.demo_clock SET pbs_epoch = $1, paused = false, demo_anchor = $2, real_anchor = $3 WHERE id = 1`, [epoch, c.demoNow, real]);
    await tx.query(
      `INSERT INTO system.clock_move (world_epoch, at_real, from_demo, to_demo, kind, by_name) VALUES ($1, $2, $3, $3, 'resume', $4)`,
      [epoch, real, c.demoNow, mover.rows[0]?.by_name ?? ''],
    );
    await tx.query(
      `UPDATE world.alert SET state = 'resolved', resolved_at = $1 WHERE type = 'billing_reset_waiting' AND state = 'open'`, [c.demoNow]);
    await publishEvent(tx, 'world.reset', { worldEpoch: epoch });
    return true;
  });
  d.state.failures = 0;
  return done ? 'confirmed' : 'none';
}
