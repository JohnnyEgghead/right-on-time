// SPDX-License-Identifier: AGPL-3.0-or-later
// API-10 read the clock (UI-SPECIFICATION 12.2; SPECIFICATIONS FR-DEMO-1, FR-DEMO-3, FR-DEMO-6, section 4.2): the shared
// demo clock as every web surface's header shows it (CMP-01, CMP-02). Read only: the moves (API-11 to API-14) are
// P3-REPLAY's. Answers before the access code (beforeAccessCode, SPECIFICATIONS 4.1).
//
// 1 read of the clock row, in the call's transaction, so every field is of 1 row: demoNow is that row's demo time at
// the real instant reported as realNow (the P2-TIME seam demoTimeAt, the formula DbClock uses), so a client that keeps
// realNow's offset (section 5.1 step 2) advances from a consistent pair. The envelope's meta.demoNow is the kernel
// clock's (cached up to 250 ms, section 4.2), so the 2 can differ by that cache age.
import type { readClock } from '@bw/api';
import { demoTimeAt, realNow, Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { DEFAULT_ZONE } from '../kernel/mount.ts';
import type { Handler } from '../types.ts';

type ClockAnswer = z.infer<typeof readClock.response>;

/** API-14 refuses a reset within 5 real minutes of the last (SPECIFICATIONS FR-DEMO-6, `cooldown`), when RESET_COOLDOWN_SECONDS is not given. */
export const RESET_COOLDOWN_S = 300;

interface ClockRow {
  demo_anchor: Date;
  real_anchor: Date;
  rate: string;
  paused: boolean;
  world_epoch: number;
  pbs_epoch: number;
  last_move_by_name: string | null;
  last_move_kind: 'jump' | 'pause' | 'resume' | 'reset' | null;
  last_move_to: Date | null;
  replay_target: Date | null;
  replay_done: number;
  replay_total: number;
  last_reset_real: Date;
}

const CLOCK_SQL = `SELECT demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_move_by_name, last_move_kind, last_move_to,
                          replay_target, replay_done, replay_total, last_reset_real
                     FROM system.demo_clock WHERE id = 1`;

const instant = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime());

export const readClockHandler: Handler<ClockAnswer> = async (_req, tx, ctx) => {
  const { rows } = await tx.query<ClockRow>(CLOCK_SQL);
  // Before setup writes epoch 1 (P2-SEED) there is no row: server_error, as DbClock answers (D11).
  const row = rows[0];
  if (rows.length !== 1 || !row) return { ok: false, status: 500, code: 'server_error' };
  const rate = Number(row.rate);
  const real = realNow('clock_anchor');
  const demo = demoTimeAt({ demoAnchor: instant(row.demo_anchor), realAnchor: instant(row.real_anchor), rate, paused: row.paused }, real);
  const sinceReset = real.since(instant(row.last_reset_real)).total('seconds');
  // P3-REPLAY: the cool-down is the setting API-14 applies (RESET_COOLDOWN_SECONDS), 300 s by default.
  const cooldown = ctx?.settings.RESET_COOLDOWN_SECONDS ?? RESET_COOLDOWN_S;
  const lastMove =
    row.last_move_by_name !== null && row.last_move_kind !== null && row.last_move_to !== null
      ? { by: row.last_move_by_name, kind: row.last_move_kind, toDemo: toWire(instant(row.last_move_to), DEFAULT_ZONE) }
      : null;
  return {
    ok: true,
    status: 200,
    data: {
      demoNow: toWire(demo, DEFAULT_ZONE),
      realNow: toWire(real, DEFAULT_ZONE),
      rate,
      paused: row.paused,
      worldEpoch: row.world_epoch,
      lastMove,
      // F-919: running also holds while a reset is unconfirmed by the billing service (pbs_epoch < world_epoch), the same window
      // API-12 to API-14 answer replay_running in (SD-12), so the page offers no preset a press of which would be refused.
      replay: { running: row.replay_target !== null || row.pbs_epoch < row.world_epoch, done: row.replay_done, total: row.replay_total },
      resetAvailableInSeconds: Math.min(cooldown, Math.max(0, Math.ceil(cooldown - sinceReset))),
    },
  };
};
