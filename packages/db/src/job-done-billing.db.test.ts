// SPDX-License-Identifier: AGPL-3.0-or-later
// Migration 0012 (F-384; SPECIFICATIONS section 6.6 FR-BILL-1, FR-BILL-3; invariant 10): a transaction that moves a job
// into done with no billing_item fails at commit, whichever writer made the move; a finish that bills in its
// transaction commits; rows inserted as done (the seed, a reset's restore) and No one home are not held by it.
// Run by gate schema-gates (packages/db/vitest.db.config.ts).
import { describe, expect, it } from 'vitest';
import { createPool, inTransaction } from './client.ts';
import { errorCode, insertJob, seedReference, useMigratedDatabase } from './testing/fixture.ts';

const db = useMigratedDatabase();
const asApp = (url: string) => {
  const u = new URL(url);
  u.username = 'bw_web';
  return createPool({ connectionString: u.toString(), max: 2 });
};

describe('every move into done bills the job (migration 0012, F-384)', () => {
  // why: FR-BILL-1, FR-BILL-3, invariant 10
  it('refuses at commit a done-writer that skipped the billing entry, as the web login, and leaves the job unfinished', async () => {
    const ref = await seedReference(db.admin());
    const pool = asApp(db.url());
    try {
      const skipped = await insertJob(db.admin(), ref, { status: 'on_site' });
      const err = await errorCode(inTransaction(pool, async (tx) => {
        await tx.query(`UPDATE world.job SET status = 'done', ended_at = '2026-09-15T15:00:00Z', labor_minutes = 30, no_parts_used = true WHERE job_number = $1`, [skipped]);
      }));
      expect(err).toBe('23514');
      expect((await db.admin().query<{ status: string }>('SELECT status FROM world.job WHERE job_number = $1', [skipped])).rows[0]?.status).toBe('on_site');

      // The billing entry later in the same transaction satisfies it (deferred to commit).
      const billed = await insertJob(db.admin(), ref, { status: 'on_site' });
      await inTransaction(pool, async (tx) => {
        await tx.query(`UPDATE world.job SET status = 'done', ended_at = '2026-09-15T15:00:00Z', labor_minutes = 30, no_parts_used = true WHERE job_number = $1`, [billed]);
        await tx.query(`INSERT INTO world.billing_item (job_number, state, tries) VALUES ($1, 'sending', 0)`, [billed]);
      });
      expect((await db.admin().query<{ status: string }>('SELECT status FROM world.job WHERE job_number = $1', [billed])).rows[0]?.status).toBe('done');

      // Not moves into done: No one home, and a row inserted as done.
      const nobody = await insertJob(db.admin(), ref, { status: 'on_site' });
      await inTransaction(pool, (tx) => tx.query(`UPDATE world.job SET status = 'no_one_home', ended_at = '2026-09-15T15:00:00Z' WHERE job_number = $1`, [nobody]));
      expect(await insertJob(db.admin(), ref, { status: 'done', labor_minutes: 30, no_parts_used: true })).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
