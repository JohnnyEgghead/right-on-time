// SPDX-License-Identifier: AGPL-3.0-or-later
// API-171, the health check (SPECIFICATIONS section 7.4): 200 {status: "ok"} when the database answers and
// system.worker_heartbeat.beat_real is under 60 s old by realNow('health_heartbeat'); 503 otherwise, with no product data.
// An old or missing heartbeat answers 503 here; a database that does not answer throws, and the kernel answers that 503
// too (mount.ts HEALTH_CHECK), never 500: the deploy's wait rolls back at once on 500 (F-99, F-215).
import type { Handler } from '../types.ts';

/** The heartbeat is stale at this age: the worker writes every 10 s, so 60 s is 6 missed beats. */
export const HEARTBEAT_LIMIT_MS = 60_000;

export const health: Handler<{ status: 'ok' }> = async (_req, tx, ctx) => {
  const r = await tx.query<{ beat_real: Date }>('SELECT beat_real FROM system.worker_heartbeat WHERE id = 1');
  const beat = r.rows[0]?.beat_real;
  if (!beat || ctx.clock.realNow('health_heartbeat').epochMilliseconds - beat.getTime() >= HEARTBEAT_LIMIT_MS) {
    return { ok: false, status: 503, code: 'server_error' };
  }
  return { ok: true, status: 200, data: { status: 'ok' } };
};

/** SD-43: samples older than this many real hours are pruned. */
export const DELAY_SAMPLE_KEEP_HOURS = 24;

/**
 * API-172: store ms = receive time minus the seq's emit time (the bus keeps each seq's emit time 60 s). It includes the
 * board's re-read, so it slightly over-counts. A seq the process no longer holds (another process's, or past 60 s) is
 * answered 204 and stores nothing. Each post also prunes the samples older than 24 real hours.
 */
export const boardDelaySampleHandler: Handler<Record<string, never>> = async (req, tx, ctx) => {
  const { seq } = req.params as { seq: number };
  const emitted = ctx.events?.emitTime(seq);
  const received = ctx.clock.realNow('board_delay_window');
  if (emitted !== undefined) {
    await tx.query(
      `INSERT INTO system.delay_sample (seq, emitted_real, acked_real, ms) VALUES ($1, to_timestamp($2 / 1000.0), $3, $4)`,
      [seq, emitted, received.toString(), Math.max(0, Math.round(received.epochMilliseconds - emitted))],
    );
  }
  await tx.query(`DELETE FROM system.delay_sample WHERE acked_real < $1::timestamptz - make_interval(hours => $2)`, [received.toString(), DELAY_SAMPLE_KEEP_HOURS]);
  return { ok: true, status: 204, data: {} };
};
