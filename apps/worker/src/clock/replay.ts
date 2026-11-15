// SPDX-License-Identifier: AGPL-3.0-or-later
// The replay of a forward clock jump (SPECIFICATIONS section 5.2 step 6, SD-11; FR-DEMO-3). API-12 holds the clock
// paused at the old time D with replay_target = T; this step, run by the worker's clock job, then:
//
//   1. picks the next batch: the first REPLAY_BATCH due events through T, in (due_at, id) order, of the kinds this
//      worker runs, and drains through the batch's last due_at with the event dispatcher (drainThrough), each event at
//      its own due_at (max(due_at, D)), so a 6:00 PM reminder is stamped 6:00 PM. Events a run creates (a retry 2
//      minutes after a failure) join the same ordered drain when they fall inside the batch, and the next batch's
//      query when they fall after it: the query is made again after every batch, never a fixed list;
//   2. after each batch, replay_done and replay_total (done + the due events left through T at query time) on the
//      clock row, and clock.changed;
//   3. when no due event is left through T: in 1 transaction the clock row is set to T, unpaused, the last move is the
//      jump by its mover (the name on the jump's pause row), a clock_move row of kind jump is written at that moment,
//      and clock.changed and board.refresh are published.
//
// An event whose handler throws stays due and is left out of the rest of this replay (it is tried again by normal
// running once the clock is at T), so a failing row never holds the replay. Nothing here is lost on a crash: the clock
// row keeps replay_target, so the worker's next start continues the replay from the events still due.
// The clock moves wait meanwhile: API-12 and API-13 answer replay_running while replay_target is set (all 3 do while a reset is
// unconfirmed), and API-14 ends a running replay (packages/api-server/src/handlers/clock-moves.db.test.ts, F-642).
import { inTransaction, publishEvent, readClockAt, type createPool } from '@bw/db';
import { Temporal, type Instant } from '@bw/time';
import type { Dispatcher } from '../dispatcher.ts';

type Pool = ReturnType<typeof createPool>;

/** Events per batch (section 5.2 step 6: "in batches of 50"). */
export const REPLAY_BATCH = 50;

const asInstant = (d: Date): Instant => Temporal.Instant.fromEpochMilliseconds(d.getTime());

export type ReplayStep = 'idle' | 'batch' | 'ended' | 'lost';

/** The replay's own state in this worker: the events that failed during it (left out of its later batches). */
export class ReplayState {
  #key = '';
  #failed = new Set<string>();
  forReplay(epoch: number, target: Date): Set<string> {
    const key = `${epoch}:${target.toISOString()}`;
    if (key !== this.#key) {
      this.#key = key;
      this.#failed = new Set();
    }
    return this.#failed;
  }
}

export interface ReplayDeps {
  pool: Pool;
  dispatcher: Pick<Dispatcher, 'drainThrough' | 'kinds'>;
  /** Real now (use clock_anchor): the clock row's new real anchor and the clock_move row's at_real. */
  real: () => Date;
  state: ReplayState;
  batch?: number;
}

const DUE_SQL = `FROM world.scheduled_event WHERE state = 'due' AND due_at <= $1 AND kind = ANY($2::text[]) AND NOT (id = ANY($3::uuid[]))`;

/** Run 1 batch of the replay, or end it. `idle`: no replay; `lost`: the replay was ended elsewhere (a reset). */
export async function replayStep(d: ReplayDeps): Promise<ReplayStep> {
  const clock = await readClockAt(d.pool, d.real());
  if (!clock || clock.replayTarget === null) return 'idle';
  const target = clock.replayTarget;
  const epoch = clock.worldEpoch;
  const failed = d.state.forReplay(epoch, target);
  const kinds = [...d.dispatcher.kinds];
  const next = await d.pool.query<{ due_at: Date }>(`SELECT due_at ${DUE_SQL} ORDER BY due_at, id LIMIT $4`, [target, kinds, [...failed], d.batch ?? REPLAY_BATCH]);
  const last = next.rows.at(-1);
  if (!last) return finish(d, epoch, target);

  const report = await d.dispatcher.drainThrough({ through: asInstant(last.due_at), demoNow: asInstant(clock.demoNow), replayTarget: asInstant(target), epoch });
  for (const id of report.failed) failed.add(id);
  const left = await d.pool.query<{ n: string }>(`SELECT count(*) AS n ${DUE_SQL}`, [target, kinds, [...failed]]);
  const ran = report.ran + report.skipped;
  const moved = await d.pool.query(
    `UPDATE system.demo_clock SET replay_done = replay_done + $1, replay_total = replay_done + $1 + $2
      WHERE id = 1 AND replay_target = $3 AND world_epoch = $4`,
    [ran, Number(left.rows[0]?.n ?? 0), target, epoch],
  );
  if ((moved.rowCount ?? 0) === 0) return 'lost';
  await publishEvent(d.pool, 'clock.changed');
  return 'batch';
}

async function finish(d: ReplayDeps, epoch: number, target: Date): Promise<ReplayStep> {
  return inTransaction(d.pool, async (tx) => {
    const real = d.real();
    const clock = await readClockAt(tx, real, true);
    if (!clock || clock.worldEpoch !== epoch || clock.replayTarget?.getTime() !== target.getTime()) return 'lost';
    // The mover: the name on this epoch's latest clock_move row, the pause API-12 wrote when it held the clock.
    const mover = await tx.query<{ by_name: string }>(
      'SELECT by_name FROM system.clock_move WHERE world_epoch = $1 ORDER BY at_real DESC, id DESC LIMIT 1', [epoch]);
    const by = mover.rows[0]?.by_name ?? '';
    await tx.query(
      `UPDATE system.demo_clock
          SET demo_anchor = $1, real_anchor = $2, paused = false, replay_target = NULL, replay_total = replay_done,
              last_move_by_name = $3, last_move_kind = 'jump', last_move_to = $1, last_move_real = $2
        WHERE id = 1`,
      [target, real, by],
    );
    await tx.query(
      `INSERT INTO system.clock_move (world_epoch, at_real, from_demo, to_demo, kind, by_name) VALUES ($1, $2, $3, $4, 'jump', $5)`,
      [epoch, real, clock.demoNow, target, by],
    );
    await publishEvent(tx, 'clock.changed');
    await publishEvent(tx, 'board.refresh');
    return 'ended' as const;
  });
}
