// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1690: one place-name rule for every response that names an area for a job or customer (areaName in @bw/domain: a neighborhood for the
// ZIPs the approved Jobs page names one for, the street's city otherwise). A customer on a 43202 street shows Clintonville in the customer
// search, the week board's unassigned jobs, the day board and the text log, and the street's own city once the ZIP is another one. The
// postal address lines keep the city. Real database through the production kernel; run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;

beforeAll(async () => {
  world = await officeWorld(db, 20);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const sql = async <T>(text: string, params: unknown[] = []) => (await db.admin().query<T>(text, params)).rows;
const win = (key: string) => world.windows.get(key) as string;
const data = async <T>(r: Response): Promise<T> => {
  if (r.status !== 200) throw new Error(`answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as { data: T }).data;
};

describe('the area named in every response (F-1690)', () => {
  // why: F-1690 the Jobs list said Clintonville for ZIP 43202 while the other pages said the city; one rule everywhere
  it('says Clintonville for a 43202 customer in the customer search, week board, day board and text log, and the city for another ZIP', async () => {
    const id = world.customers[0] as string;
    const st = (await sql<{ id: string; zip: string; city: string; name: string; cname: string }>(
      `SELECT s.id, s.zip, s.city, s.name, cu.name AS cname FROM world.customer cu JOIN world.street s ON s.id = cu.street_id WHERE cu.id = $1`, [id]))[0]!;
    const booked = await api.post('/jobs', { customerId: id, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-09-17', windowId: win('two_hour 10:00'), technicianId: null }, keisha);
    expect(booked.status).toBe(201);
    const jn = ((await booked.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;

    await sql(
      `INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at, delivered_at)
       VALUES ($1, $2, 'confirmation', 'en', 'gsm7', 'Brightwater: You are booked!', 40, 'delivered', 0, '2026-09-15T14:10:00Z', '2026-09-15T14:10:00Z', '2026-09-15T14:20:00Z')`, [id, jn]);

    const areas = async () => {
      const found = await data<{ customers: { id: string; area: string; address?: { city: string } }[] }>(await api.post('/customer-searches', { query: st.cname, filters: {} }, keisha));
      const week = await data<{ unassignedJobs: { jobNumber: number; area: string }[] }>(await api.get('/board/week?branch=columbus&week=2026-09-14', keisha));
      const day = await data<{ unassigned: { jobNumber: number; area: string }[] }>(await api.get('/board?branch=columbus&date=2026-09-17', keisha));
      const log = await data<{ texts: { customer: string; context: { area: string } }[] }>(await api.post('/text-searches', { date: '2026-09-15', branch: 'columbus' }, keisha));
      return {
        search: found.customers.find((c) => c.id === id)?.area,
        week: week.unassignedJobs.find((j) => j.jobNumber === jn)?.area,
        day: day.unassigned.find((j) => j.jobNumber === jn)?.area,
        log: log.texts.filter((t) => t.customer === st.cname).map((t) => t.context.area),
      };
    };
    try {
      await sql(`UPDATE world.street SET zip = '43202' WHERE id = $1`, [st.id]);
      const named = await areas();
      expect(named).toMatchObject({ search: 'Clintonville', week: 'Clintonville', day: 'Clintonville' });
      expect(named.log.length).toBeGreaterThan(0);
      expect(new Set(named.log)).toEqual(new Set(['Clintonville']));
      await sql(`UPDATE world.street SET zip = '43215' WHERE id = $1`, [st.id]);
      const other = await areas();
      expect(other).toMatchObject({ search: st.city, week: st.city, day: st.city });
      expect(new Set(other.log)).toEqual(new Set([st.city]));
    } finally {
      await sql(`UPDATE world.street SET zip = $2 WHERE id = $1`, [st.id, st.zip]);
    }
  });
});
