// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1844: every serial-lane kind gives a failing event up after MAX_HANDLER_FAILURES failed runs, through the worker as
// main.ts starts it (the real registry, giveUpsFor, the real handlers). Each failed run and the give-up are logged at
// error level with the kind, the event id and the cause code; alert.check and eta.sweep still leave their next event
// due, and text.reminder and autopilot.step end with nothing after them. text.try's own give-up is giveUp.db.test.ts.
// The failure is made in the database, not in the code under test: a trigger refuses every end of these events except
// the give-up's (result handler_failed), so each real handler runs and its claim transaction rolls back.
// Run by gate G-CI2 (ci/gates/G-CI2/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { addCustomer, addJob, seedOutboxWorld, setDemoClock, type OutboxRef } from '../../../packages/outbox/src/testing/world.ts';
import { MAX_HANDLER_FAILURES } from './dispatcher.ts';
import { startTestWorker, type TestWorker } from './testing/worker.ts';

const db = useMigratedDatabase();
const NOW = '2026-09-15T14:00:00Z';
const NEXT = '2026-09-15T14:05:00.000Z';
const KINDS = ['alert.check', 'eta.sweep', 'text.reminder', 'autopilot.step'] as const;
const PRIVATE = 'Harold Jenkins 6145550100 at 12 Oak St';
let worker: TestWorker;
let ref: OutboxRef;

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin(), NOW);
  const admin = db.admin();
  await admin.query(`CREATE FUNCTION world.test_refuse_end() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF NEW.state <> 'due' AND NEW.result IS DISTINCT FROM 'handler_failed' AND NEW.kind = ANY(ARRAY['alert.check', 'eta.sweep', 'text.reminder', 'autopilot.step']) THEN
        RAISE EXCEPTION '${PRIVATE}' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $f$`);
  await admin.query(`CREATE TRIGGER test_refuse_end BEFORE UPDATE ON world.scheduled_event FOR EACH ROW EXECUTE FUNCTION world.test_refuse_end()`);
  worker = await startTestWorker(db.url());
});
afterAll(async () => {
  await worker?.stop();
});

describe('every serial-lane kind gives a failing event up (F-1844)', () => {
  // why: F-1844, F-368: alert.check, eta.sweep, text.reminder and autopilot.step retried a failing event every pass for ever, unseen.
  it('gives each kind up at the 5th failed run, logs every run and the give-up, and keeps the alert and eta chains going', async () => {
    const admin = db.admin();
    const ids = new Map<string, string>();
    for (const kind of KINDS) {
      const subject = kind === 'alert.check' ? 'alerts' : kind === 'eta.sweep' ? 'eta' : '24825';
      const r = await admin.query<{ id: string }>(
        `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ($1, $2, $3, '{}'::jsonb, 'due') RETURNING id`, [NOW, kind, subject]);
      ids.set(kind, r.rows[0]!.id);
    }
    await setDemoClock(admin, NOW);
    const states = async () =>
      (await admin.query<{ id: string; kind: string; state: string; result: string | null; n: number | null }>(
        `SELECT id, kind, state, result, (payload->>'failures')::int AS n FROM world.scheduled_event WHERE id = ANY($1::uuid[]) ORDER BY kind`, [[...ids.values()]])).rows;

    // The worker's own 1 s timer also runs passes, so read the rows: below the limit every event stays due.
    for (let pass = 0; pass < 40; pass += 1) {
      await worker.drain();
      const now = await states();
      if (now.every((s) => s.state === 'skipped')) break;
      for (const s of now) if (s.state === 'due') expect(s.n ?? 0).toBeLessThan(MAX_HANDLER_FAILURES);
    }
    expect((await states()).map((s) => [s.kind, s.state, s.result, s.n])).toEqual(
      [...KINDS].sort().map((k) => [k, 'skipped', 'handler_failed', MAX_HANDLER_FAILURES]));

    // The chains go on: 1 due successor each, 5 demo minutes on. The other 2 kinds leave nothing due.
    const due = await admin.query<{ kind: string; due_at: Date }>(`SELECT kind, due_at FROM world.scheduled_event WHERE state = 'due' ORDER BY kind`);
    expect(due.rows.map((r) => [r.kind, r.due_at.toISOString()])).toEqual([['alert.check', NEXT], ['eta.sweep', NEXT]]);

    const parsed = worker.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const kind of KINDS) {
      const id = ids.get(kind)!;
      const mine = parsed.filter((l) => l.eventId === id);
      expect(mine.map((l) => [l.level, l.status, l.eventKind, l.errorCode, l.failures])).toEqual([
        ...[1, 2, 3, 4, 5].map((n) => ['error', 'event failed', kind, '55000', n]),
        ['error', 'event gave up', kind, '55000', MAX_HANDLER_FAILURES],
      ]);
    }
    expect(worker.logs.join('')).not.toMatch(/Harold|6145550100|Oak/);
  });
});

describe('a reminder whose text can never be enqueued (F-2006 K-03)', () => {
  // why: F-2006 K-03 a given-up text.reminder ended skipped with no call list entry, so no one told the customer of the visit
  it('is on the call list, dated the day before the visit, after its 5th failed run', async () => {
    const admin = db.admin();
    const c = await addCustomer(admin, ref, { mobile: '6145550111' });
    const job = await addJob(admin, ref, c, '2026-09-16');
    // Every enqueue of this visit's text fails in the database (a full disk, a broken table): no reminder can go out.
    await admin.query(`CREATE FUNCTION world.test_refuse_text() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.job_number = ${job} THEN RAISE EXCEPTION 'no room' USING ERRCODE = '53100'; END IF;
        RETURN NEW;
      END $f$`);
    await admin.query(`CREATE TRIGGER test_refuse_text BEFORE INSERT ON world.outbox_text FOR EACH ROW EXECUTE FUNCTION world.test_refuse_text()`);
    // An at-once reminder (F-446), due now, so the clock need not move past the other chains' next events.
    const r = await admin.query<{ id: string }>(
      `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ($1, 'text.reminder', $2, $3::jsonb, 'due') RETURNING id`,
      [NOW, String(job), JSON.stringify({ jobNumber: job, atOnce: true, visitDate: '2026-09-16' })]);
    const id = r.rows[0]!.id;
    await setDemoClock(admin, NOW);
    const event = async () => (await admin.query<{ state: string; result: string | null; n: number | null }>(
      `SELECT state, result, (payload->>'failures')::int AS n FROM world.scheduled_event WHERE id = $1`, [id])).rows[0]!;
    for (let pass = 0; pass < 40 && (await event()).state === 'due'; pass += 1) await worker.drain();

    expect(await event()).toEqual({ state: 'skipped', result: 'handler_failed', n: MAX_HANDLER_FAILURES });
    const calls = await admin.query<{ call_date: string; reason: string }>(
      `SELECT call_date::text, reason FROM world.call_list_entry WHERE job_number = $1`, [job]);
    expect(calls.rows).toEqual([{ call_date: '2026-09-15', reason: 'no_mobile' }]);
    const mine = worker.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.eventId === id);
    expect(mine.map((l) => [l.status, l.errorCode])).toEqual([
      ...[1, 2, 3, 4, 5].map(() => ['event failed', '53100']), ['event gave up', '53100'],
    ]);
  });
});
