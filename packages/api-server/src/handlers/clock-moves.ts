// SPDX-License-Identifier: AGPL-3.0-or-later
// The clock moves (UI-SPECIFICATION 12.2 API-11 to API-14; SPECIFICATIONS 6.9 FR-DEMO-3 to FR-DEMO-6, section 5.2
// step 6, SD-12). Managers only (policy/clock.ts). Each runs in the call's transaction, takes the clock-move lock first (F-540) and
// locks the clock row:
//
//   API-11 presets       the 6 targets of FR-DEMO-5 in the branch zone, each reachable when after demo now.
//   API-12 jump          forward only (not_forward). Holds the clock paused at demo now (a clock_move row of kind pause
//                        by the mover), sets replay_target and answers 202; the worker's replay runs every due event
//                        through the target in time order and then sets the clock to it (apps/worker/src/clock/replay.ts).
//   API-13 pause/resume  re-anchors the clock at demo now; the banner's last move names the mover.
//   API-14 reset         the cool-down (RESET_COOLDOWN_SECONDS, real time since the last reset), then @bw/db resetWorld.
//
// While a replay runs or a reset is unconfirmed by the billing service (pbs_epoch < world_epoch), API-12, API-13 and
// API-14 answer replay_running (SD-11 step 6, SD-12). The mover is the caller's user.name (FR-DEMO-6).
import type { clockPresets, jumpClock, pauseClock, PresetId, resetWorldRow } from '@bw/api';
import { lockClockMoves, publishEvent, readClockAt, ResetRefused, resetWorld, type LockedClock } from '@bw/db';
import { addDays, atLocal, fromWire, localDateOf, Temporal, toWire, type Instant } from '@bw/time';
import type { z } from 'zod';
import { DEFAULT_ZONE } from '../kernel/mount.ts';
import type { ApiRequest, ApiResult, Handler, HandlerContext, Tx } from '../types.ts';
import { RESET_COOLDOWN_S } from './clock.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

const asDate = (i: Instant): Date => new Date(i.epochMilliseconds);
const asInstant = (d: Date): Instant => Temporal.Instant.fromEpochMilliseconds(d.getTime());

/** The 6 presets (FR-DEMO-5), relative to demo now's date in the branch zone where they say "today" or "tomorrow". */
export function presetTargets(demoNow: Instant, zone: string = DEFAULT_ZONE): readonly { presetId: PresetId; target: Instant }[] {
  const today = localDateOf(demoNow, zone);
  // A preset names a wall time that exists on its day ('reject' would only fire on a spring-forward gap, which none hits).
  const at = (date: string, time: string) => atLocal(date, time, zone, 'compatible');
  return [
    { presetId: 'reminder_6pm', target: at(today, '18:05') },
    { presetId: 'tomorrow_8am', target: at(addDays(today, 1), '08:00') },
    { presetId: 'sat_oct_31', target: at('2026-10-31', '07:00') },
    { presetId: 'sun_nov_1', target: at('2026-11-01', '17:55') },
    { presetId: 'sat_mar_13_2027', target: at('2027-03-13', '07:00') },
    { presetId: 'sun_mar_14_2027', target: at('2027-03-14', '07:00') },
  ];
}

const replayRunning = <T>(): ApiResult<T> => ({ ok: false, status: 409, code: 'replay_running' });
/** SD-12: a session whose user no longer exists (a reset removed it) answers unauthenticated. */
const noUser = <T>(): ApiResult<T> => ({ ok: false, status: 401, code: 'unauthenticated' });

/** A replay running, or a reset the billing service has not confirmed yet (SD-12): the clock moves wait. */
export const clockBusy = (c: Pick<LockedClock, 'replayTarget' | 'pbsEpoch' | 'worldEpoch'>): boolean =>
  c.replayTarget !== null || c.pbsEpoch < c.worldEpoch;

/** Seconds left of the reset cool-down at `real` (0 when a reset is allowed). */
export function cooldownLeft(lastResetReal: Date, real: Date, cooldownS: number): number {
  return Math.max(0, Math.ceil(cooldownS - (real.getTime() - lastResetReal.getTime()) / 1000));
}

async function moverName(tx: Tx, req: ApiRequest): Promise<string | null> {
  if (req.caller.kind !== 'staff') return null;
  const r = await tx.query<{ name: string }>('SELECT name FROM world."user" WHERE id = $1', [req.caller.userId]);
  return r.rows[0]?.name ?? null;
}

const realOf = (ctx: HandlerContext): Date => asDate(ctx.clock.realNow('clock_anchor'));

export const clockPresetsHandler: Handler<Out<typeof clockPresets>> = async (_req, tx, ctx) => {
  // The clock row itself, not the kernel's cached demo now (up to 250 ms old): a preset is reachable by the row a jump locks.
  const clock = await readClockAt(tx, realOf(ctx));
  if (!clock) return { ok: false, status: 500, code: 'server_error' };
  const now = asInstant(clock.demoNow);
  return {
    ok: true,
    status: 200,
    data: {
      presets: presetTargets(now).map((p) => ({
        presetId: p.presetId,
        labelKey: `clock.preset.${p.presetId}`,
        target: toWire(p.target, DEFAULT_ZONE),
        reachable: Temporal.Instant.compare(p.target, now) > 0,
      })),
    },
  };
};

export const jumpClockHandler: Handler<Out<typeof jumpClock>> = async (req, tx, ctx) => {
  const p = req.params as In<typeof jumpClock>;
  await lockClockMoves(tx); // F-540: before the clock row and any world read
  const real = realOf(ctx);
  const clock = await readClockAt(tx, real, true);
  if (!clock) return { ok: false, status: 500, code: 'server_error' };
  if (clockBusy(clock)) return replayRunning();
  const by = await moverName(tx, req);
  if (by === null) return noUser();
  const from = asInstant(clock.demoNow);
  let target: Instant;
  if (p.presetId !== undefined) {
    target = presetTargets(from).find((x) => x.presetId === p.presetId)!.target;
  } else {
    try {
      target = fromWire(p.to!).toInstant();
    } catch {
      return { ok: false, status: 422, code: 'validation_failed' };
    }
  }
  // FR-DEMO-4: forward only; backward is a reset.
  if (Temporal.Instant.compare(target, from) <= 0) return { ok: false, status: 409, code: 'not_forward' };
  const due = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM world.scheduled_event WHERE state = 'due' AND due_at <= $1`, [asDate(target)]);
  const total = Number(due.rows[0]?.n ?? 0);
  // Section 5.2 step 6: hold the clock paused at the old time (clock_move only; the banner's last move is written when
  // the replay ends), and leave the replay to the worker.
  await tx.query(
    `UPDATE system.demo_clock SET demo_anchor = $1, real_anchor = $2, paused = true, replay_target = $3, replay_done = 0, replay_total = $4
      WHERE id = 1`,
    [clock.demoNow, real, asDate(target), total],
  );
  await tx.query(
    `INSERT INTO system.clock_move (world_epoch, at_real, from_demo, to_demo, kind, by_name) VALUES ($1, $2, $3, $3, 'pause', $4)`,
    [clock.worldEpoch, real, clock.demoNow, by],
  );
  await publishEvent(tx, 'clock.changed');
  return { ok: true, status: 202, data: { replay: { running: true, done: 0, total } } };
};

export const pauseClockHandler: Handler<Out<typeof pauseClock>> = async (req, tx, ctx) => {
  const p = req.params as In<typeof pauseClock>;
  await lockClockMoves(tx); // F-540: before the clock row and any world read
  const real = realOf(ctx);
  const clock = await readClockAt(tx, real, true);
  if (!clock) return { ok: false, status: 500, code: 'server_error' };
  if (clockBusy(clock)) return replayRunning();
  // Already in the asked state: nothing moves, and the banner keeps its last move.
  if (clock.paused === p.paused) return { ok: true, status: 200, data: { paused: p.paused } };
  const by = await moverName(tx, req);
  if (by === null) return noUser();
  const kind = p.paused ? 'pause' : 'resume';
  await tx.query(
    `UPDATE system.demo_clock SET demo_anchor = $1, real_anchor = $2, paused = $3,
            last_move_by_name = $4, last_move_kind = $5, last_move_to = $1, last_move_real = $2
      WHERE id = 1`,
    [clock.demoNow, real, p.paused, by, kind],
  );
  await tx.query(
    `INSERT INTO system.clock_move (world_epoch, at_real, from_demo, to_demo, kind, by_name) VALUES ($1, $2, $3, $3, $4, $5)`,
    [clock.worldEpoch, real, clock.demoNow, kind, by],
  );
  await publishEvent(tx, 'clock.changed');
  return { ok: true, status: 200, data: { paused: p.paused } };
};

export const resetWorldHandler: Handler<Out<typeof resetWorldRow>> = async (req, tx, ctx) => {
  await lockClockMoves(tx); // F-540: before the clock row and any world read
  const real = asDate(ctx.clock.realNow('reset_cooldown'));
  const cooldownS = ctx.settings.RESET_COOLDOWN_SECONDS ?? RESET_COOLDOWN_S;
  const refusal = (c: LockedClock): string | null => {
    // A demo reset ends a running replay (owner-approved 7ccb76ec, F-545: resetWorld clears replay_target; the worker's replay step then reads 'lost').
    // Only a reset the billing service has not confirmed yet still makes it wait (SD-12).
    if (c.pbsEpoch < c.worldEpoch) return 'replay_running';
    return cooldownLeft(c.lastResetReal, real, cooldownS) > 0 ? 'cooldown' : null;
  };
  const answer = (c: LockedClock, reason: string): ApiResult<Out<typeof resetWorldRow>> =>
    reason === 'cooldown'
      ? { ok: false, status: 429, code: 'cooldown', detail: { availableInSeconds: cooldownLeft(c.lastResetReal, real, cooldownS) } }
      : replayRunning();
  // Refuse before the restore when the unlocked row already says no; resetWorld checks again under its lock.
  const before = await readClockAt(tx, real);
  if (!before) return { ok: false, status: 500, code: 'server_error' };
  const early = refusal(before);
  if (early !== null) return answer(before, early);
  const by = await moverName(tx, req);
  if (by === null) return noUser();
  try {
    const r = await resetWorld(tx, { byName: by, real, guard: refusal });
    return { ok: true, status: 202, data: { worldEpoch: r.epoch } };
  } catch (e) {
    if (!(e instanceof ResetRefused)) throw e;
    const now = await readClockAt(tx, real);
    return answer(now ?? before, e.reason);
  }
};
