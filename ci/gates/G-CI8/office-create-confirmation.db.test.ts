// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI8 inv8-one-message, the office writes' half (P4-NEWJOB; SPECIFICATIONS SD-45, section 6.4; FR-DISP-29, FR-TEXT-6, UC-16; F-671).
// A job the office makes (API-28) and a visit the office moves (API-24) go through the real routes, as a dispatcher with a real session,
// through the production kernel as bw_web on PostgreSQL 18. Each makes exactly 1 confirmation text of 1 message, in the customer's
// text language, and the same transaction plans the reminder; a customer with texts off or no mobile gets no text row and the answer
// says none. The write's own tests (office-writes.db.test.ts) hold the booking rules; this holds the texts they send.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { caller, officeWorld, type Caller, type OfficeWorld } from '../../../packages/api-server/src/office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let english: string;
let spanish: string;
let off: string;
let none: string;

beforeAll(async () => {
  world = await officeWorld(db, 8);
  api = caller(world.kernel);
  [english, spanish, off, none] = world.customers as [string, string, string, string];
  const a = db.admin();
  await a.query(`UPDATE world.customer SET mobile = '(614) 555-0142', texts_on = true, text_language = 'en' WHERE id = $1`, [english]);
  await a.query(`UPDATE world.customer SET mobile = '(614) 555-0143', texts_on = true, text_language = 'es' WHERE id = $1`, [spanish]);
  await a.query(`UPDATE world.customer SET mobile = '(614) 555-0144', texts_on = false WHERE id = $1`, [off]);
  await a.query(`UPDATE world.customer SET mobile = NULL, texts_on = true WHERE id = $1`, [none]);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const DATE = '2026-09-22';
const window = (key: string) => world.windows.get(key) as string;
const create = (customerId: string, windowKey = 'two_hour 10:00') =>
  api.post('/jobs', { customerId, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: DATE, windowId: window(windowKey), technicianId: null }, world.staff.keisha);
const made = async (r: Response) => {
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { data: { job: { jobNumber: number; version: number }; confirmationText: { status: string } | null } }).data;
};
const confirmations = async (jobNumber: number) => (await db.admin().query<{ language: string; encoding: string; characters: number; body: string; status: string }>(
  `SELECT language, encoding, characters, body, status FROM world.outbox_text WHERE job_number = $1 AND kind = 'confirmation' ORDER BY created_at, id`, [jobNumber])).rows;
const reminders = async (jobNumber: number) => Number((await db.admin().query<{ n: string }>(
  `SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject = $1 AND state = 'due'`, [String(jobNumber)])).rows[0]!.n);

describe('G-CI8: the office-made job sends 1 confirmation in the customer\'s language (API-28)', () => {
  // why: FR-DISP-29 (a job made for a customer whose texts are Spanish sends a Spanish confirmation)
  it('queues 1 Spanish confirmation of 1 message for a Spanish-texts customer, and plans the reminder', async () => {
    const d = await made(await create(spanish));
    const rows = await confirmations(d.job.jobNumber);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ language: 'es' });
    expect(rows[0]!.body).toContain('Cita reservada');
    expect(rows[0]!.characters).toBeLessThanOrEqual(rows[0]!.encoding === 'gsm7' ? 160 : 70);
    expect(d.confirmationText).toMatchObject({ status: expect.stringMatching(/^(queued|held)$/) });
    expect(await reminders(d.job.jobNumber)).toBe(1);
  });

  // why: FR-LANG-1 (F-1153: the Spanish confirmation for a 2-4 PM window reads the doc batch's wording, the same words as DK-127, in 1 message)
  it('words a 2-4 PM window for a Spanish-texts customer as de 2 a 4 PM EDT, with the 106-character fixed copy of SD-17', async () => {
    const d = await made(await create(spanish, 'two_hour 14:00'));
    const rows = await confirmations(d.job.jobNumber);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain('el técnico llega de 2 a 4 PM EDT.');
    expect(rows[0]!.body).toContain('Responda C para confirmar o R para cambiar.');
    expect(rows[0]!.encoding).toBe('gsm7');
    expect(rows[0]!.characters).toBeLessThanOrEqual(160);
  });

  // why: UC-16 (the confirmation arrives in the customer's text language: an English customer's is English)
  it('queues 1 English confirmation naming the new day, window and service for an English-texts customer', async () => {
    const d = await made(await create(english, 'two_hour 12:00'));
    const rows = await confirmations(d.job.jobNumber);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ language: 'en' });
    expect(rows[0]!.body).toContain("You're booked");
    expect(rows[0]!.body).toContain('Sep 22');
    expect(rows[0]!.body).toContain('12-2 PM');
    expect(rows[0]!.encoding).toBe('gsm7');
  });

  // why: FR-TEXT-13 (texts off and no mobile make no text, and the answer says none)
  it('makes no text for a customer with texts off or no mobile, and answers confirmationText null', async () => {
    for (const c of [off, none]) {
      const d = await made(await create(c, 'two_hour 14:00'));
      expect(d.confirmationText).toBeNull();
      expect(await confirmations(d.job.jobNumber)).toHaveLength(0);
    }
  });

  // why: F-671 (an office reschedule through API-24 sends a new confirmation for the new day and window; SD-45)
  it('sends a new confirmation for the new day and window when the office reschedules, and the answer says a text was sent', async () => {
    const d = await made(await create(english, 'two_hour 08:00'));
    expect(await confirmations(d.job.jobNumber)).toHaveLength(1);
    const r = await api.post(`/jobs/${d.job.jobNumber}/schedule`, { date: '2026-09-23', windowId: window('two_hour 14:00'), baseVersion: d.job.version }, world.staff.keisha);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as { data: { outcome: { textSent: boolean } } }).data.outcome.textSent).toBe(true);
    const rows = await confirmations(d.job.jobNumber);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.body).toContain('Sep 23');
    expect(rows[1]!.body).toContain('2-4 PM');
    expect(rows[0]!.body).toContain('Sep 22');
    expect(await reminders(d.job.jobNumber)).toBe(1);
  });

  // why: F-671 (a reschedule of a customer who gets no texts sends none, and the answer says so)
  it('sends nothing on a reschedule for a customer with texts off, and the answer says no text was sent', async () => {
    const d = await made(await create(off, 'two_hour 08:00'));
    const r = await api.post(`/jobs/${d.job.jobNumber}/schedule`, { date: '2026-09-23', windowId: window('two_hour 10:00'), baseVersion: d.job.version }, world.staff.keisha);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as { data: { outcome: { textSent: boolean } } }).data.outcome.textSent).toBe(false);
    expect(await confirmations(d.job.jobNumber)).toHaveLength(0);
  });
});
