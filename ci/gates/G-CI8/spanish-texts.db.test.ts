// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI8 inv8-one-message, the Spanish customer's half (P7-SPANISH; REQUIREMENTS UC-04, FR-TEXT-6, FR-LANG-4). Rosa Delgado gets her texts in
// Spanish: the real triggers (confirmation, reminder, on-the-way) and the late text go through the real catalog and slot formatter on
// PostgreSQL 18 as bw_web. Each stored text is Spanish, GSM-7 and 1 message.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeSms } from '../../../packages/sms/src/index.ts';
import { inTransaction } from '../../../packages/db/src/index.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { catalogs as realCatalogs } from '../../../packages/i18n/src/catalog.ts';
import { enqueueText } from '../../../packages/outbox/src/enqueue.ts';
import { fireReminder, planReminder, sendConfirmation, sendOnTheWay, type TextContext } from '../../../packages/outbox/src/triggers.ts';
import { textCatalogOf } from '../../../packages/outbox/src/slots.ts';
import { addCustomer, addJob, I, loginPool, seedOutboxWorld, textRow, type OutboxRef } from '../../../packages/outbox/src/testing/world.ts';

const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;
let techId: string;

const catalogs = { en: { ...realCatalogs.en, 't.k': 'furnace tune-up' }, es: { ...realCatalogs.es, 't.k': 'ajuste de calefactor' } };
const ctx: TextContext = { catalogs, linkHost: 'bw.j7l.io' };

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin());
  techId = (await db.admin().query<{ id: string }>(`SELECT id FROM world.technician LIMIT 1`)).rows[0]!.id;
  web = loginPool(db.url(), 'bw_web');
});
afterAll(async () => {
  await web?.end();
});

describe('G-CI8: a customer who gets texts in Spanish gets every text in Spanish, GSM-7, 1 message (UC-04)', () => {
  // why: UC-04
  it('Rosa Delgado\'s confirmation, reminder, on-the-way and late texts are Spanish, GSM-7 and 1 message each', async () => {
    const rosa = await addCustomer(db.admin(), ref, { language: 'es', name: 'Rosa Delgado' });
    const job = await addJob(db.admin(), ref, rosa, '2026-09-16', { technician_id: techId });
    const now = I('2026-09-15T14:00:00Z'); // 10:00 AM EDT: no quiet hours
    const ids: Record<string, string> = {};
    const confirmation = await inTransaction(web, (tx) => sendConfirmation(tx, ctx, { jobNumber: job, now }));
    if (!confirmation.ok) throw new Error(confirmation.reason);
    ids.confirmation = confirmation.textId;
    const evening = I('2026-09-15T23:15:00Z'); // 7:15 PM EDT: the reminder goes at once
    await inTransaction(web, (tx) => planReminder(tx, { jobNumber: job, now: evening }));
    const reminder = await inTransaction(web, (tx) => fireReminder(tx, ctx, { jobNumber: job, eventDueAt: evening, now: evening, atOnce: { visitDate: '2026-09-16' } }));
    if (reminder.result !== 'sent') throw new Error(`reminder ${JSON.stringify(reminder)}`);
    ids.reminder = reminder.textId;
    const way = await inTransaction(web, (tx) => sendOnTheWay(tx, ctx, { jobNumber: job, eta: I('2026-09-16T14:42:10Z'), now: I('2026-09-16T14:28:00Z') }));
    if (!way.sent) throw new Error(way.reason);
    ids.on_the_way = way.textId;
    const late = await inTransaction(web, (tx) =>
      enqueueText(tx, { kind: 'late', customerId: rosa, jobNumber: job, now: I('2026-09-16T15:00:00Z'), catalog: textCatalogOf(catalogs), values: { tech: 'Maria', arrival: '11:25 AM' } }),
    );
    if (!late.ok) throw new Error(late.reason);
    ids.late = late.textId;

    const spanishPrefix: Record<string, string> = {
      confirmation: 'Brightwater: ¡Cita reservada!',
      reminder: 'Recordatorio de Brightwater:',
      on_the_way: 'Brightwater: ¡Maria va en camino!',
      late: 'Brightwater:',
    };
    for (const kind of ['confirmation', 'reminder', 'on_the_way', 'late']) {
      const row = await textRow(db.admin(), ids[kind] as string);
      expect(row, kind).toMatchObject({ kind, language: 'es', encoding: 'gsm7' });
      const body = row.body as string;
      expect(body.startsWith(spanishPrefix[kind] as string), `${kind}: ${body}`).toBe(true);
      expect(analyzeSms(body), kind).toMatchObject({ encoding: 'GSM-7', messages: 1 });
      expect(body, kind).not.toMatch(/\b(Reply|arrives|on the way|running late)\b/);
    }
  });
});
