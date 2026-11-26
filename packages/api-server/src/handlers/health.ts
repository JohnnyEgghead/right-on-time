// SPDX-License-Identifier: AGPL-3.0-or-later
// API-171, the health check (SPECIFICATIONS section 7.4): 200 {status: "ok"} when the database answers and
// system.worker_heartbeat.beat_real is under 60 s old by realNow('health_heartbeat'); 503 otherwise, with no product data.
// An old or missing heartbeat answers 503 here; a database that does not answer throws, and the kernel answers that 503
// too (mount.ts HEALTH_CHECK), never 500: the deploy's wait rolls back at once on 500 (F-99, F-215).
import type { Handler } from '../types.ts';

/** The heartbeat is stale at this age: the worker writes every 10 s, so 60 s is 6 missed beats. */
const HEARTBEAT_LIMIT_MS = 60_000;

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
 * API-172 (SD-43, F-885): the samples of 1 request, each stored as ms = receive time minus the seq's emit time (the bus keeps each
 * seq's emit time 60 s) minus the sample's heldMs, floored at 0. It includes the board's re-read, so it slightly over-counts. A seq
 * the process no longer holds (another process's, or past 60 s) stores nothing; the answer is 204 either way. Every sample goes in
 * 1 insert, and the request prunes the samples older than 24 real hours once. The old body, seq alone, is 1 sample held 0 ms; a
 * body with both stores both (the contract refuses a body with neither).
 */
export const boardDelaySampleHandler: Handler<Record<string, never>> = async (req, tx, ctx) => {
  const p = req.params as { samples?: readonly { seq: number; heldMs: number }[]; seq?: number };
  const samples = [...(p.samples ?? []), ...(p.seq !== undefined ? [{ seq: p.seq, heldMs: 0 }] : [])];
  const received = ctx.clock.realNow('board_delay_window');
  const rows: { seq: number; emitted: number; ms: number }[] = [];
  for (const s of samples) {
    const emitted = ctx.events?.emitTime(s.seq);
    if (emitted !== undefined) rows.push({ seq: s.seq, emitted, ms: Math.max(0, Math.round(received.epochMilliseconds - emitted - s.heldMs)) });
  }
  if (rows.length > 0) {
    await tx.query(
      `INSERT INTO system.delay_sample (seq, emitted_real, acked_real, ms)
       SELECT s, to_timestamp(e / 1000.0), $4::timestamptz, m FROM unnest($1::bigint[], $2::double precision[], $3::integer[]) AS u(s, e, m)`,
      [rows.map((r) => r.seq), rows.map((r) => r.emitted), rows.map((r) => r.ms), received.toString()],
    );
  }
  await tx.query(`DELETE FROM system.delay_sample WHERE acked_real < $1::timestamptz - make_interval(hours => $2)`, [received.toString(), DELAY_SAMPLE_KEEP_HOURS]);
  return { ok: true, status: 204, data: {} };
};
