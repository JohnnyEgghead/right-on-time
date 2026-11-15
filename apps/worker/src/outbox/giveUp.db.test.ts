// SPDX-License-Identifier: AGPL-3.0-or-later
// F-368: a text.try event whose handler throws on every run is not retried forever unseen. The dispatcher counts each
// failed run; at the 5th the text gives up exactly as after its 5th failed try (call list entry and text_gave_up alert),
// and the event is marked skipped with the result handler_failed (invariant 2: every end path has its end record).
// Run by gate G-CI2 (ci/gates/G-CI2/vitest.db.config.ts); the merge set excludes *.db.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { useMigratedDatabase } from '../../../../packages/db/src/testing/fixture.ts';
import { scheduleTry } from '../../../../packages/outbox/src/index.ts';
import { addCustomer, addJob, I, loginPool, seedOutboxWorld, setDemoClock, type OutboxRef } from '../../../../packages/outbox/src/testing/world.ts';
import { startTestWorker, type TestWorker } from '../testing/worker.ts';
import { MAX_HANDLER_FAILURES } from '../dispatcher.ts';

const db = useMigratedDatabase();
const NOW = '2026-09-15T14:00:00Z';
let ref: OutboxRef;
let worker: TestWorker;

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin(), NOW);
  worker = await startTestWorker(db.url());
});
afterAll(async () => {
  await worker?.stop();
});

describe('a text.try event that fails on every run (F-368)', () => {
  // why: F-368, FR-TEXT-12
  it('counts each failed run, gives the text up at the 5th, and reports it to the call list and the office', async () => {
    // A customer zone Temporal cannot read (customer.zone has no CHECK) makes the quiet-hours recheck throw on every run.
    const c = await addCustomer(db.admin(), ref, { zone: 'Mars/Olympus_Mons' });
    const job = await addJob(db.admin(), ref, c);
    const t = await db.admin().query<{ id: string }>(
      `INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at)
       VALUES ($1, $2, 'confirmation', 'en', 'gsm7', 'x', 1, 'queued', 0, $3, $3) RETURNING id`, [c, job, NOW]);
    const textId = t.rows[0]!.id;
    const web = loginPool(db.url(), 'bw_web');
    try {
      await inTransaction(web, (tx) => scheduleTry(tx, I(NOW), { textId, number: 1 }));
    } finally {
      await web.end();
    }
    await setDemoClock(db.admin(), NOW);
    const failures = async () =>
      (await db.admin().query<{ n: number | null; state: string; result: string | null }>(
        `SELECT (payload->>'failures')::int AS n, state, result FROM world.scheduled_event WHERE kind = 'text.try' AND subject = $1`, [textId])).rows[0]!;

    // The worker's own 1 s timer also runs passes, so count from the row: below the limit the event stays due and the text queued.
    for (let pass = 0; pass < 30; pass += 1) {
      await worker.drain();
      const f = await failures();
      if (f.state === 'skipped') break;
      expect(f).toMatchObject({ state: 'due' });
      expect(f.n ?? 0).toBeLessThan(MAX_HANDLER_FAILURES);
      expect((await db.admin().query(`SELECT status FROM world.outbox_text WHERE id = $1`, [textId])).rows[0]).toEqual({ status: 'queued' });
    }
    expect(await failures()).toMatchObject({ n: MAX_HANDLER_FAILURES, state: 'skipped', result: 'handler_failed' });
    expect((await db.admin().query(`SELECT status, next_try_at FROM world.outbox_text WHERE id = $1`, [textId])).rows[0]).toEqual({ status: 'gave_up', next_try_at: null });
    expect((await db.admin().query(`SELECT reason FROM world.call_list_entry WHERE text_id = $1`, [textId])).rows).toEqual([{ reason: 'text_gave_up' }]);
    expect((await db.admin().query(`SELECT state, subject FROM world.alert WHERE type = 'text_gave_up'`)).rows).toEqual([{ state: 'open', subject: textId }]);
    // Nothing is left to retry: a further pass runs no failing event.
    expect((await worker.drain()).failed).toEqual([]);
  });
});
