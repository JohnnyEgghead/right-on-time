// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI8 inv8-one-message, the technician name half (P4-TECHNICIANS; SPECIFICATIONS section 14 item 8 and section 6.4; FR-TEXT-11, FR-TEXT-9; API-32
// and API-33). A technician's name in texts goes through the real routes as a dispatcher with a real session, through the production kernel as bw_web
// on PostgreSQL 18. A name outside the GSM-7 basic set (the o-acute of "Ramón", an extension-table "[" that counts 2 septets) or over 10 characters is
// refused with text_value_breaks_limit and the problem, and the stored name stays, so no text can take 2 messages from a name; a plain one is saved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { caller, officeWorld, type Caller, type OfficeWorld } from '../../../packages/api-server/src/office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let maria: string;

beforeAll(async () => {
  world = await officeWorld(db, 4);
  api = caller(world.kernel);
  maria = world.technicians.get('Maria Santos') as string;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const stored = async () => (await db.admin().query<{ name_in_texts: string }>('SELECT name_in_texts FROM world.technician WHERE id = $1', [maria])).rows[0]!.name_in_texts;
const edit = (nameInTexts: string) => api.patch(`/technicians/${maria}`, { nameInTexts }, world.staff.keisha);

describe('G-CI8: a technician\'s name in texts is held to 1 message (API-32, API-33)', () => {
  // why: FR-TEXT-11 (a name that would break 1 message is refused by API-33 with the problem, and never stored)
  it.each([
    ['Ramón', 'not_gsm7_basic'],
    ['[Ann]', 'not_gsm7_basic'],
    ['Bartholomew', 'too_long'],
  ])('refuses %s (%s) and keeps the stored name', async (name, problem) => {
    const before = await stored();
    const r = await edit(name);
    expect(r.status).toBe(422);
    const body = (await r.json()) as { code: string; problem: string };
    expect(body).toMatchObject({ code: 'text_value_breaks_limit', problem });
    expect(await stored()).toBe(before);
    // the check API-32 says the same of the same value
    const check = (await (await api.post('/text-checks', { slot: 'technician', value: name }, world.staff.keisha)).json()) as { data: { ok: boolean; problem: string } };
    expect(check.data).toMatchObject({ ok: false, problem });
  });

  // why: FR-TEXT-11 (a plain name of up to 10 characters is saved, the 11th character is refused, and API-32 says it fits)
  it('saves a plain name of up to 10 characters and refuses the 11th', async () => {
    const r = await edit('Mary Anne 1');
    expect(r.status).toBe(422);
    const ok = await edit('Mary Anne');
    expect(ok.status).toBe(200);
    expect(await stored()).toBe('Mary Anne');
    const check = (await (await api.post('/text-checks', { slot: 'technician', value: 'Mary Anne' }, world.staff.keisha)).json()) as { data: { ok: boolean } };
    expect(check.data.ok).toBe(true);
  });
});
