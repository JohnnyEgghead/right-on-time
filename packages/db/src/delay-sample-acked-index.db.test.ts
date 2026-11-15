// SPDX-License-Identifier: AGPL-3.0-or-later
// Migration 0021 (F-896): system.delay_sample has an index on acked_real, the column API-172's per-post prune, the health
// page's window read and the worker's alert rule filter on.
import { describe, expect, it } from 'vitest';
import { useMigratedDatabase } from './testing/fixture.ts';

const db = useMigratedDatabase();

describe('delay_sample acked_real index (F-896)', () => {
  // why: F-896: without the index the prune's acked_real filter can only scan the table; with it, an index scan is possible
  it('serves the acked_real filter of the prune, as an index scan', async () => {
    const q = db.admin();
    const idx = await q.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'system' AND tablename = 'delay_sample' AND indexname = 'delay_sample_acked'`);
    expect(idx.rows[0]?.indexdef).toContain('(acked_real)');
    await q.query('BEGIN');
    try {
      await q.query('SET LOCAL enable_seqscan = off');
      const plan = await q.query<{ 'QUERY PLAN': string }>(`EXPLAIN DELETE FROM system.delay_sample WHERE acked_real < now() - make_interval(hours => 24)`);
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('delay_sample_acked');
    } finally {
      await q.query('ROLLBACK');
    }
  });
});
