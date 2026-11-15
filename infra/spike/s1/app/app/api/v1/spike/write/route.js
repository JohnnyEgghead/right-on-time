// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S1: the write. 1 transaction inserts a row and calls pg_notify, so the event
// leaves only at commit (SPECIFICATIONS section 4.3, "Publish"). The payload is ids only.
import { bus } from '../../../../../lib/bus.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request) {
  const body = await request.json();
  const run = Number(body.run);
  const branchId = Number(body.branchId ?? 1);
  const client = await bus.pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('INSERT INTO spike_write (run, branch_id) VALUES ($1, $2) RETURNING id', [run, branchId]);
    const writeId = Number(row.rows[0].id);
    const event = { seq: writeId, name: 'spike.write', ids: { writeId, run, branchId } };
    await client.query("SELECT pg_notify('bw_events', $1)", [JSON.stringify(event)]);
    await client.query('COMMIT');
    return Response.json({ writeId, ...bus.stats() });
  } catch (err) {
    await client.query('ROLLBACK');
    return Response.json({ error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function GET() {
  return Response.json(bus.stats());
}
