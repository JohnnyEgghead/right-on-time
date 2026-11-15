// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI8 inv8-one-message, the office half (F-443; SPECIFICATIONS section 14 item 8: "the office text's 161st character
// refused"; FR-TEXT-20, API-143). The office's own text goes through the real route, POST /customers/{id}/texts, as a
// dispatcher with a real session, through the production kernel as bw_web on PostgreSQL 18. 160 GSM-7 characters make
// 1 message and are queued; the 161st is refused with message_too_long and no text row; a character outside GSM-7
// drops the limit to 70 (UCS-2). Section 14's must-fail, "an office text splits into 2 messages", is the 161 case.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { caller, officeWorld, type Caller, type OfficeWorld } from '../../../packages/api-server/src/office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let texting: string;

beforeAll(async () => {
  world = await officeWorld(db, 6);
  api = caller(world.kernel);
  texting = world.customers[0] as string;
  await db.admin().query(`UPDATE world.customer SET mobile = '(614) 555-0142', texts_on = true WHERE id = $1`, [texting]);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const send = (customerId: string, body: string) => api.post(`/customers/${customerId}/texts`, { body, jobNumber: null }, world.staff.keisha);
const texts = async (customerId: string) => Number((await db.admin().query<{ n: string }>(
  `SELECT count(*) AS n FROM world.outbox_text WHERE customer_id = $1 AND kind = 'office'`, [customerId])).rows[0]!.n);

describe('G-CI8: the office text is held to 1 message (API-143)', () => {
  // why: FR-TEXT-20 (160 GSM-7 characters fit 1 message)
  it('queues a 160-character GSM-7 text as 1 office text', async () => {
    const before = await texts(texting);
    const r = await send(texting, 'a'.repeat(160));
    expect(r.status, await r.clone().text()).toBe(201);
    const t = ((await r.json()) as { data: { text: { encoding: string; characters: number; status: string } } }).data.text;
    expect(t).toMatchObject({ encoding: 'gsm7', characters: 160 });
    expect(await texts(texting)).toBe(before + 1);
  });

  // why: FR-TEXT-20 (invariant 8: the 161st character is refused; SPECIFICATIONS section 14 item 8's must-fail)
  it('refuses the 161st GSM-7 character with message_too_long, the characters and the limit, and makes no text', async () => {
    const before = await texts(texting);
    const r = await send(texting, 'a'.repeat(161));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ code: 'message_too_long', characters: 161, limit: 160, encoding: 'gsm7' });
    expect(await texts(texting)).toBe(before);
  });

  // why: HC-06 (a character outside GSM-7 makes the text UCS-2: 70 characters fit, the 71st is refused)
  it('holds a UCS-2 text to 70 characters', async () => {
    expect((await send(texting, 'á'.repeat(70))).status).toBe(201);
    const r = await send(texting, 'á'.repeat(71));
    expect(await r.json()).toMatchObject({ code: 'message_too_long', characters: 71, limit: 70, encoding: 'ucs2' });
  });

  // why: FR-TEXT-20 (texts off and no mobile are refused with their codes, and no text is made)
  it('refuses a customer with texts off (texts_off) and one with no mobile (no_mobile)', async () => {
    const off = world.customers[1] as string;
    await db.admin().query(`UPDATE world.customer SET mobile = '(614) 555-0143', texts_on = false WHERE id = $1`, [off]);
    const none = world.customers[2] as string;
    await db.admin().query(`UPDATE world.customer SET mobile = NULL, texts_on = true WHERE id = $1`, [none]);
    expect(((await (await send(off, 'Hello')).json()) as { code: string }).code).toBe('texts_off');
    expect(((await (await send(none, 'Hello')).json()) as { code: string }).code).toBe('no_mobile');
    expect(await texts(off) + await texts(none)).toBe(0);
  });

  // why: FR-TEXT-7 (quiet hours: an office text sent before 8:00 AM the customer's time is held until then)
  it('holds a text sent in quiet hours until 8:00 AM the customer\'s time', async () => {
    const r = await send(texting, 'We will call you shortly.');
    const t = ((await r.json()) as { data: { text: { status: string; heldUntil: string | null } }; meta: { demoNow: string } });
    const hour = Number(t.meta.demoNow.slice(11, 13));
    if (hour >= 8 && hour < 21) expect(t.data.text).toMatchObject({ status: 'sending', heldUntil: null });
    else expect(t.data.text.heldUntil).toMatch(/T08:00:00/);
  });
});
