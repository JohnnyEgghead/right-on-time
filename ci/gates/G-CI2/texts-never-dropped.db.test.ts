// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI2, inv2-never-dropped, its texts case (P3-OUTBOX; SPECIFICATIONS section 14 item 2, invariant 2; FR-TEXT-12,
// FR-TEXT-24; UC-06). Through the real paths: the confirmation is enqueued as the web process's login
// (bw_web), and the worker as main.ts starts it (the job registry, bw_worker, DbClock on system.demo_clock) runs the
// tries while the test moves the clock row minute by minute, as the 1-second dispatcher would see it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../../../packages/db/src/client.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { enqueueText, tryNow } from '../../../packages/outbox/src/index.ts';
import {
  addCustomer, addJob, attemptsOf, confirmationValues, count, I, loginPool, seedOutboxWorld, setDemoClock, setSimulator,
  testCatalog, textRow, type OutboxRef,
} from '../../../packages/outbox/src/testing/world.ts';
import { startTestWorker, type TestWorker } from '../../../apps/worker/src/testing/worker.ts';

const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;
let worker: TestWorker;

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin());
  web = loginPool(db.url(), 'bw_web');
  worker = await startTestWorker(db.url());
});
afterAll(async () => {
  await worker?.stop();
  await web?.end();
});

/** Walk the clock row from `from` to `to` 1 minute at a time, with a dispatcher pass at each minute. */
async function walk(from: string, to: string): Promise<void> {
  for (let t = I(from); t.epochMilliseconds <= I(to).epochMilliseconds; t = t.add({ minutes: 1 })) {
    await setDemoClock(db.admin(), t);
    await worker.drain();
  }
}

async function bookConfirmation(at: string, customerName: string): Promise<{ textId: string; jobNumber: number; customerId: string }> {
  const customerId = await addCustomer(db.admin(), ref, { name: customerName });
  const jobNumber = await addJob(db.admin(), ref, customerId);
  await setDemoClock(db.admin(), at);
  const r = await inTransaction(web, (tx) =>
    enqueueText(tx, { kind: 'confirmation', customerId, jobNumber, now: I(at), catalog: testCatalog, values: confirmationValues }),
  );
  if (!r.ok) throw new Error(`not enqueued: ${r.reason}`);
  return { textId: r.textId, jobNumber, customerId };
}

const callListRows = (textId: string) => count(db.admin(), `SELECT count(*) AS n FROM world.call_list_entry WHERE text_id = $1`, [textId]);
const alerts = (textId: string) => count(db.admin(), `SELECT count(*) AS n FROM world.alert WHERE type = 'text_gave_up' AND subject = $1`, [textId]);
const dueTries = (textId: string) => count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'text.try' AND subject = $1 AND state = 'due'`, [textId]);

describe('G-CI2 texts: "All sends fail" is tried 5 times, then reported, never dropped (invariant 2)', () => {
  // why: UC-06
  it('gives tries 1 to 5 at 0, 2, 4, 9 and 19 minutes, then 1 call list row and 1 alert, and no 6th try', async () => {
    await setSimulator(db.admin(), 'all_fail');
    // Tue, Sep 15, 2026, 10:00 AM EDT: the confirmation is due at once (FR-TEXT-1).
    const { textId, jobNumber, customerId } = await bookConfirmation('2026-09-15T14:00:00Z', 'Harold Jenkins');
    await walk('2026-09-15T14:00:00Z', '2026-09-15T14:30:00Z');

    // why: FR-TEXT-12
    expect(await attemptsOf(db.admin(), textId)).toEqual([
      [1, '2026-09-15T14:00:00Z', 'failed'],
      [2, '2026-09-15T14:02:00Z', 'failed'],
      [3, '2026-09-15T14:04:00Z', 'failed'],
      [4, '2026-09-15T14:09:00Z', 'failed'],
      [5, '2026-09-15T14:19:00Z', 'failed'],
    ]);
    expect(await textRow(db.admin(), textId)).toMatchObject({ status: 'gave_up', tries: 5, next_try_at: null });
    const entry = await db.admin().query(`SELECT branch_id, call_date, customer_id, job_number, reason, added_at FROM world.call_list_entry WHERE text_id = $1`, [textId]);
    expect(entry.rows).toEqual([
      { branch_id: ref.branchId, call_date: '2026-09-15', customer_id: customerId, job_number: jobNumber, reason: 'text_gave_up', added_at: new Date('2026-09-15T14:19:00Z') },
    ]);
    const alert = await db.admin().query(`SELECT state, branch_id, at, link_target FROM world.alert WHERE type = 'text_gave_up' AND subject = $1`, [textId]);
    expect(alert.rows).toEqual([{ state: 'open', branch_id: ref.branchId, at: new Date('2026-09-15T14:19:00Z'), link_target: '/office/messages/call-list?date=2026-09-15' }]);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.inbox_message WHERE text_id = $1`, [textId])).toBe(0);

    // Never a 6th: a day later and a fresh pass leave the record as it was.
    await walk('2026-09-15T14:31:00Z', '2026-09-15T14:45:00Z');
    await setDemoClock(db.admin(), '2026-09-16T15:00:00Z');
    await worker.drain();
    expect((await attemptsOf(db.admin(), textId)).length).toBe(5);
    expect(await dueTries(textId)).toBe(0);
    expect(await callListRows(textId)).toBe(1);
    expect(await alerts(textId)).toBe(1);
  });

  // why: FR-TEXT-24
  it('counts Try now as the next numbered try, so the call list and the alert still follow the 5th failure, never a 6th', async () => {
    await setSimulator(db.admin(), 'all_fail');
    const start = '2026-09-15T16:00:00Z'; // 12:00 PM EDT
    const { textId } = await bookConfirmation(start, 'Rosa Delgado');
    await walk(start, '2026-09-15T16:00:00Z'); // try 1 at 12:00
    await setDemoClock(db.admin(), '2026-09-15T16:01:00Z');
    const moved = await inTransaction(web, (tx) => tryNow(tx, { textId, by: ref.userId, now: I('2026-09-15T16:01:00Z') }));
    expect(moved).toMatchObject({ ok: true, number: 2, heldUntil: null });
    await walk('2026-09-15T16:01:00Z', '2026-09-15T16:40:00Z');

    const tries = await attemptsOf(db.admin(), textId);
    expect(tries.map(([n, at]) => [n, at])).toEqual([
      [1, '2026-09-15T16:00:00Z'],
      [2, '2026-09-15T16:01:00Z'], // Try now
      [3, '2026-09-15T16:04:00Z'], // the first try's time + 4, unchanged by Try now
      [4, '2026-09-15T16:09:00Z'],
      [5, '2026-09-15T16:19:00Z'],
    ]);
    const by = await db.admin().query<{ by: string | null }>(`SELECT "by" FROM world.text_attempt WHERE text_id = $1 ORDER BY number`, [textId]);
    expect(by.rows.map((r) => r.by)).toEqual([null, ref.userId, null, null, null]);
    expect(await callListRows(textId)).toBe(1);
    expect(await alerts(textId)).toBe(1);
    const late = await inTransaction(web, (tx) => tryNow(tx, { textId, by: ref.userId, now: I('2026-09-15T16:41:00Z') }));
    expect(late).toEqual({ ok: false, reason: 'not_retryable' });
    expect((await attemptsOf(db.admin(), textId)).length).toBe(5);
  });

  // why: F-372
  it('gives 2 texts of 1 customer each their own call list row and alert when both give up (the row is deduped by text, not by customer)', async () => {
    await setSimulator(db.admin(), 'all_fail');
    const at = '2026-09-15T18:00:00Z';
    const customerId = await addCustomer(db.admin(), ref, { name: 'Two Texts' });
    await setDemoClock(db.admin(), at);
    const ids: string[] = [];
    for (let k = 0; k < 2; k += 1) {
      const jobNumber = await addJob(db.admin(), ref, customerId);
      const r = await inTransaction(web, (tx) =>
        enqueueText(tx, { kind: 'confirmation', customerId, jobNumber, now: I(at), catalog: testCatalog, values: confirmationValues }),
      );
      if (!r.ok) throw new Error(`not enqueued: ${r.reason}`);
      ids.push(r.textId);
    }
    await walk(at, '2026-09-15T18:30:00Z');
    for (const textId of ids) {
      expect(await textRow(db.admin(), textId)).toMatchObject({ status: 'gave_up', tries: 5 });
      expect(await callListRows(textId)).toBe(1);
      expect(await alerts(textId)).toBe(1);
    }
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.call_list_entry WHERE customer_id = $1`, [customerId])).toBe(2);
  });
});
