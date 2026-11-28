// SPDX-License-Identifier: AGPL-3.0-or-later
// A given-up billing item's reason on the billing page and in its export (P10-BILL-WORDS, F-2119; FR-BILL-2, FR-BILL-12, CTL-OFC-10-03):
// API-60 names billing's give-up as its own reason kind, read from the event row the give-up leaves, so the page words and the API-159
// export row say the give-up in both languages, after Mark fixed and after a Send again that reaches billing. The handlers are called
// directly on real PostgreSQL 18, as the kernel calls them; the world is the one billing's give-up writes (apps/worker/src/billing/link.ts
// billingGiveUp: waiting_person, no try written, its billing event ended skipped as handler_failed). Run by gate G-CI7.
import { describe, expect, it } from 'vitest';
import { leftReasonText, waitingReasonText } from '@bw/i18n/src/billing-rows.ts';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { Temporal } from '@bw/time';
import { markFixedInTx, sendAgain, type BillingClient } from 'bw-worker/billing';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { addCustomer, addJob, seedOutboxWorld } from '../../../outbox/src/testing/world.ts';
import type { ApiRequest, HandlerContext } from '../types.ts';
import { billingReadHandlers } from './billing-reads.ts';

const db = useMigratedDatabase();
const NOW = '2026-09-15T14:00:00Z';
const en = formatterFor('en');
const es = formatterFor('es');

const pbs = { getMode: async () => ({ mode: 'up' }), enterByHand: async () => undefined } as unknown as BillingClient;
const handlers = billingReadHandlers(() => pbs);
const req = (contract: string, params: unknown): ApiRequest => ({
  contract, params, body: null, caller: { kind: 'staff', userId: '00000000-0000-0000-0000-000000000000', role: 'office', client: 'web', via: 'password' },
  worldEpoch: 1, demoNow: Temporal.Instant.from(NOW),
} as ApiRequest);
const noPublish = async () => undefined;
const ctx = {} as HandlerContext;

type Row = { jobNumber: number; reasonKind: string | null; reason: string | null; state?: string };
async function queue(): Promise<{ items: Row[]; leftLast7Days: Row[] }> {
  const r = await handlers['API-60']!(req('API-60', { branch: 'columbus' }), db.admin(), ctx);
  if (!r.ok) throw new Error(`API-60 refused: ${r.code}`);
  return r.data as { items: Row[]; leftLast7Days: Row[] };
}
async function csv(lang: 'en' | 'es'): Promise<string[][]> {
  const r = await handlers['API-159']!(req('API-159', { branch: 'columbus', lang }), db.admin(), ctx);
  if (!r.ok) throw new Error(`API-159 refused: ${r.code}`);
  // The cells these tests read hold no comma or quote, so a plain split is enough.
  return (r.data as string).replace(/^﻿/, '').split('\r\n').filter((l) => l !== '').map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
}
const sel = <T>(rows: T[], job: number): T | undefined => rows.find((x) => (x as Row).jobNumber === job);

/** The world billing's give-up leaves for a job (the item 24790 shape), or the item still on its first try (given up false). */
async function listedJob(date: string, o: { givenUp: boolean }): Promise<number> {
  const a = db.admin();
  const customer = await addCustomer(a, ref, { name: `Customer ${date}${o.givenUp ? 'g' : 'f'}` });
  const job = await addJob(a, ref, customer, date, { status: 'done', ended_at: '2026-09-15T13:00:00Z', billing_state: o.givenUp ? 'waiting_person' : 'sending' });
  if (o.givenUp) {
    await a.query(
      `INSERT INTO world.billing_item (job_number, state, reason_key, tries) VALUES ($1, 'waiting_person', 'the send failed 5 times in a row', 0)`, [job]);
    await a.query(
      `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state, run_at, result) VALUES ($1, 'billing.send', $2, '{}', 'skipped', $1, 'handler_failed')`,
      ['2026-09-15T13:30:00Z', String(job)]);
  } else {
    // A first send still unanswered 60 demo minutes after it was due is listed (F-1857), and has no failed try and no give-up.
    await a.query(`INSERT INTO world.billing_item (job_number, state, tries) VALUES ($1, 'sending', 0)`, [job]);
    await a.query(
      `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-15T12:00:00Z', 'billing.send', $1, '{}', 'due')`, [String(job)]);
  }
  return job;
}

let ref: Awaited<ReturnType<typeof seedOutboxWorld>>;
const manager = async () => (await db.admin().query<{ id: string }>(
  `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
   VALUES ('dana.bill@example.test', 'Dana Ruiz', 'dana ruiz', 'manager', 'columbus', 'en', 'active', false, false)
   ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).rows[0]!.id;

describe('a given-up billing item reads its give-up reason (F-2119)', () => {
  // why: FR-BILL-2, CTL-OFC-10-03 the item 24790 shape (waiting_person, 0 tries, its billing event given up) reads the give-up words in both
  // languages, never "Waiting for its first try"; the item still on its first try gets no reason kind and keeps those words
  it('names the give-up as its reason kind on the waiting list, and gives a first-try item none', async () => {
    ref = await seedOutboxWorld(db.admin(), NOW);
    const gave = await listedJob('2026-09-10', { givenUp: true });
    const first = await listedJob('2026-09-11', { givenUp: false });
    const q = await queue();
    const row = sel(q.items, gave)!;
    expect(row).toMatchObject({ state: 'waiting_person', reasonKind: 'gave_up', reason: null });
    expect(waitingReasonText(row as never, en)).toBe('Billing stopped trying after its failed runs');
    expect(waitingReasonText(row as never, es)).toBe('La facturación dejó de intentarlo tras varios fallos');
    const firstRow = sel(q.items, first)!;
    expect(firstRow.reasonKind).toBeNull();
    expect(waitingReasonText(firstRow as never, en)).toBe('Waiting for its first try');
    expect(waitingReasonText(firstRow as never, es)).toBe('Esperando su primer intento');
    // FR-BILL-12: the export row says what the page row says, in the page's language
    for (const [lang, t] of [['en', en], ['es', es]] as const) {
      const rows = await csv(lang);
      const header = rows[0]!;
      const cell = (job: number) => rows.find((r) => r[0] === String(job))![header.indexOf(t('billing.csv.reason'))];
      expect(cell(gave)).toBe(waitingReasonText(row as never, t));
      expect(cell(first)).toBe(waitingReasonText(firstRow as never, t));
    }
  });

  // why: FR-BILL-2, CTL-OFC-10-03 the give-up is read from the event row it leaves, which a later Mark fixed does not erase: the Fixed card's
  // reason cell reads the give-up words, never blank, in both languages, and the export's Fixed row says the same
  it('keeps the give-up reason kind after Mark fixed, in the Fixed card and the export', async () => {
    const job = await listedJob('2026-09-12', { givenUp: true });
    const by = await manager();
    expect(await markFixedInTx(db.admin(), { client: pbs, publish: noPublish }, { jobNumber: job, reason: 'Entered by hand', by, at: Temporal.Instant.from(NOW) })).toEqual({ ok: true });
    const q = await queue();
    expect(sel(q.items, job)).toBeUndefined();
    const left = sel(q.leftLast7Days, job)!;
    expect(left).toMatchObject({ reasonKind: 'gave_up', how: 'marked_fixed' });
    expect(leftReasonText(left as never, en)).toBe('Billing gave up');
    expect(leftReasonText(left as never, es)).toBe('Dejó de intentarlo');
    for (const [lang, t] of [['en', en], ['es', es]] as const) {
      const rows = await csv(lang);
      const header = rows[0]!;
      expect(rows.find((r) => r[0] === String(job))![header.indexOf(t('billing.csv.reason'))]).toBe(leftReasonText(left as never, t));
    }
  });

  // why: FR-BILL-2 a Send again clears the item's own reason_key, and its success leaves the Fixed card's row: both leave the give-up event row
  // alone, so API-60 still gives the give-up reason kind, and a failed try that comes later (the latest failed try) takes over
  it('keeps the give-up reason kind after a Send again that reaches billing, and a later failed try wins', async () => {
    const job = await listedJob('2026-09-13', { givenUp: true });
    const by = await manager();
    const at = Temporal.Instant.from(NOW);
    expect(await sendAgain(db.admin(), { jobNumber: job, by, at }, noPublish)).toEqual({ ok: true });
    // Sending again, with no try yet: not a give-up row (it is not waiting for a person), and not listed until it is overdue.
    // The send reaches billing (link.ts: a success writes in_billing, left_at and left_how, and clears reason_key):
    await db.admin().query(
      `INSERT INTO world.billing_attempt (job_number, number, at, result) VALUES ($1, 1, $2, 'success')`, [job, NOW]);
    await db.admin().query(
      `UPDATE world.billing_item SET state = 'in_billing', tries = 1, last_try_at = $2, reason_key = NULL, send_cause = NULL, left_at = $2, left_how = 'sent_again' WHERE job_number = $1`, [job, NOW]);
    const left = sel((await queue()).leftLast7Days, job)!;
    expect(left).toMatchObject({ reasonKind: 'gave_up', how: 'sent_again' });
    expect(leftReasonText(left as never, en)).toBe('Billing gave up');
    // a failed try on another job takes the reason kind of that try, whatever the give-up row says
    const other = await listedJob('2026-09-14', { givenUp: true });
    await db.admin().query(`INSERT INTO world.billing_attempt (job_number, number, at, result) VALUES ($1, 1, $2, 'timeout')`, [other, NOW]);
    expect(sel((await queue()).items, other)).toMatchObject({ reasonKind: 'timeout' });
  });

  // why: FR-BILL-2, CTL-OFC-10-03 the latest event wins (F-2122): a job that timed out, was retried, and was then given up reads the give-up
  // on the waiting list and in the Fixed cell, never "did not answer" or "Retrying every 15 minutes", because nothing retries after the give-up
  it('reads the give-up when an earlier try timed out and the give-up came later', async () => {
    const job = await listedJob('2026-09-09', { givenUp: true });
    await db.admin().query(
      `INSERT INTO world.billing_attempt (job_number, number, at, result) VALUES ($1, 1, '2026-09-15T13:10:00Z', 'timeout'), ($1, 2, '2026-09-15T13:20:00Z', 'timeout')`, [job]);
    await db.admin().query(`UPDATE world.billing_item SET tries = 2, last_try_at = '2026-09-15T13:20:00Z' WHERE job_number = $1`, [job]);
    const row = sel((await queue()).items, job)!;
    expect(row).toMatchObject({ state: 'waiting_person', reasonKind: 'gave_up' });
    expect(waitingReasonText(row as never, en)).toBe('Billing stopped trying after its failed runs');
    expect(waitingReasonText(row as never, es)).toBe('La facturación dejó de intentarlo tras varios fallos');
    const by = await manager();
    expect(await markFixedInTx(db.admin(), { client: pbs, publish: noPublish }, { jobNumber: job, reason: 'Entered by hand', by, at: Temporal.Instant.from(NOW) })).toEqual({ ok: true });
    const left = sel((await queue()).leftLast7Days, job)!;
    expect(left).toMatchObject({ reasonKind: 'gave_up', how: 'marked_fixed' });
    expect(leftReasonText(left as never, en)).toBe('Billing gave up');
    expect(leftReasonText(left as never, es)).toBe('Dejó de intentarlo');
  });
});
