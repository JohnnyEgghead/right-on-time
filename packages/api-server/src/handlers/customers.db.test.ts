// SPDX-License-Identifier: AGPL-3.0-or-later
// Customer search, the customer page and the customer edits on the real database (PostgreSQL 18, the migrated schema, the reference
// seed with its bundled street list), through the production kernel: API-34, API-35, API-36, API-111 and API-139
// (P4-CUSTOMERS; FR-DISP-7, FR-DISP-29 to FR-DISP-32). Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { caller, ORIGIN, officeWorld, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: ReturnType<typeof caller>;

beforeAll(async () => {
  world = await officeWorld(db, 3);
  api = caller(world.kernel);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const who = (): Staff => world.staff.keisha;
const patch = (path: string, body: unknown) => world.kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
  method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: who().cookie },
}), { address: '203.0.113.9' });
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
type Found = { cities: string[]; customers: { id: string; name: string; plan: string | null; mobile: string | null; area: string; nextVisit: unknown; lastVisit: { date: string; service: string } | null }[]; total: number; next: string | null };
const search = async (query: string, filters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Found> => {
  const r = await api.post('/customer-searches', { query, filters, ...extra }, who());
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: Found }).data;
};

async function addCustomer(name: string, o: { mobile?: string | null; lang?: string; branch?: string; since?: string } = {}): Promise<string> {
  const r = await rows<{ id: string }>(
    `INSERT INTO world.customer (branch_id, name, name_search, mobile, texts_on, text_language, zone, street_id, house_number, lon, lat,
                                 customer_since, source, status, inbox_token)
     SELECT b.id, $1::text, $2::text, $3::text, $3::text IS NOT NULL, $4::text, b.zone, s.id, 2291, (s.points->0->>0)::float8, (s.points->0->>1)::float8, $5::date, 'import', 'active', 'tok-' || md5($1::text)
       FROM world.branch b JOIN LATERAL (SELECT id, points FROM world.street WHERE branch_id = b.id ORDER BY id LIMIT 1) s ON true WHERE b.id = $6::text RETURNING id`,
    [name, name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(), o.mobile ?? null, o.lang ?? 'en', o.since ?? '2017-04-02', o.branch ?? 'columbus']);
  return (r[0] as { id: string }).id;
}

describe('customer search (API-34)', () => {
  // why: FR-DISP-7 the search ignores apostrophes, hyphens and capitals: O'Brien finds Sean O'Brien, Kathleen O'Brien-Miller and Kathy OBrien, whichever way it is typed
  it("finds Sean O'Brien, Kathleen O'Brien-Miller and Kathy OBrien for O'Brien, obrien, OBRIEN and a curly apostrophe, and nobody else", async () => {
    await addCustomer("Sean O'Brien", { mobile: '+16145550163' });
    await addCustomer("Kathleen O'Brien-Miller");
    await addCustomer('Kathy OBrien');
    await addCustomer('Brienna Otto');
    for (const q of ["O'Brien", 'obrien', 'OBRIEN', 'O’Brien']) {
      const got = await search(q);
      expect(got.customers.map((c) => c.name).sort(), q).toEqual(["Kathleen O'Brien-Miller", 'Kathy OBrien', "Sean O'Brien"]);
      expect(got.total).toBe(3);
    }
  });

  // why: FR-DISP-7 a phone number is compared by its digits, however it is typed
  it('finds a customer by the digits of a phone number typed with any punctuation', async () => {
    for (const q of ['(614) 555-0163', '614.555.0163', '6145550163', '555-0163']) {
      expect((await search(q)).customers.map((c) => c.name), q).toEqual(["Sean O'Brien"]);
    }
  });

  // why: FR-DISP-7 a street, or a house number and a street, finds the customers who live there
  it('finds customers by street name and by house number with street', async () => {
    const street = (await rows<{ name: string }>(`SELECT s.name FROM world.customer c JOIN world.street s ON s.id = c.street_id WHERE c.name = 'Kathy OBrien'`))[0] as { name: string };
    expect((await search(street.name)).customers.map((c) => c.name)).toContain('Kathy OBrien');
    expect((await search(`2291 ${street.name}`)).customers.map((c) => c.name)).toContain('Kathy OBrien');
    expect((await search(`2292 ${street.name}`)).customers.map((c) => c.name)).not.toContain('Kathy OBrien');
  });

  // why: FR-DISP-30 filters by branch, city, plan, text language and upcoming visit narrow the results; the count and the pages follow them
  it('filters by branch, city, plan, text language and upcoming visit, and pages with a cursor', async () => {
    const hector = await addCustomer('Hector Filtering', { lang: 'es', mobile: '+16145550177' });
    await addCustomer('Dayton Filtering', { branch: 'dayton' });
    await rows(`INSERT INTO world.membership (customer_id, since, renews, benefits_key) VALUES ($1, DATE '2019-03-01', DATE '2027-03-01', 'club.benefits')`, [hector]);
    const win = world.windows.get('two_hour 08:00') as string;
    const made = await api.post('/jobs', { customerId: hector, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-10-22', windowId: win, technicianId: null }, who());
    expect(made.status).toBe(201);
    const names = async (filters: Record<string, unknown>) => (await search('filtering', filters)).customers.map((c) => c.name).sort();
    expect(await names({})).toEqual(['Dayton Filtering', 'Hector Filtering']);
    expect(await names({ branch: 'dayton' })).toEqual(['Dayton Filtering']);
    expect(await names({ plan: 'comfort_club' })).toEqual(['Hector Filtering']);
    expect(await names({ plan: 'none' })).toEqual(['Dayton Filtering']);
    expect(await names({ textLanguage: 'es' })).toEqual(['Hector Filtering']);
    expect(await names({ upcomingVisit: true })).toEqual(['Hector Filtering']);
    expect(await names({ upcomingVisit: false })).toEqual(['Dayton Filtering']);
    const one = (await search('filtering', {}, { limit: 1 }));
    expect(one.customers).toHaveLength(1);
    expect(one.total).toBe(2);
    expect(one.next).not.toBeNull();
    const two = await search('filtering', {}, { limit: 1, cursor: one.next });
    expect(two.customers.map((c) => c.name)).not.toEqual(one.customers.map((c) => c.name));
    expect(two.next).toBeNull();
    const dayton = await search('filtering', { branch: 'dayton' });
    expect(dayton.cities.length).toBeGreaterThan(0);
    expect(dayton.cities).toEqual([...dayton.cities].sort());
    expect(dayton.cities.length).toBeLessThan((await search('filtering')).cities.length);
    const hit = (await search('hector')).customers[0] as Found['customers'][number];
    expect(hit.plan).toBe('comfort_club');
    expect(hit.nextVisit).toMatchObject({ day: '2026-10-22', status: 'scheduled', technician: null });
    expect(hit.lastVisit).toBeNull();
  });

  // why: F-675 a forged or malformed cursor answers validation_failed (422), never a 500 from OFFSET Infinity and never a silent first page
  it('refuses a forged cursor with validation_failed and still pages with its own', async () => {
    const forged = (sortKey: string) => Buffer.from(JSON.stringify([sortKey, '-']), 'utf8').toString('base64url');
    for (const cursor of [forged('1e999'), forged('-20'), forged('2.5'), forged('Infinity'), forged('NaN'), forged(''), 'not-a-cursor', forged('1'.repeat(12))]) {
      const r = await api.post('/customer-searches', { query: 'filtering', filters: {}, limit: 1, cursor }, who());
      expect(r.status, cursor).toBe(422);
      expect(((await r.json()) as { type?: string }).type ?? '', cursor).toContain('validation_failed');
    }
    const one = await search('filtering', {}, { limit: 1 });
    expect(one.next).not.toBeNull();
    expect((await search('filtering', {}, { limit: 1, cursor: one.next })).customers).toHaveLength(1);
  });

  // why: FR-DISP-30 each result's last visit is the latest by date among past visits and done jobs
  it("shows a customer's latest past visit as the last visit", async () => {
    const id = await addCustomer('Visitor Lastvisit');
    for (const [date, text] of [['2025-03-03', 'Furnace repair'], ['2026-03-03', 'AC not cooling']] as const) {
      await rows(
        `INSERT INTO world.past_visit (customer_id, technician_name, date, zone, window_start, window_end, outcome, service_text, source_ref)
         VALUES ($1, 'Maria Santos', $2::date, 'America/New_York', $2::date + time '10:00', $2::date + time '12:00', 'done', $3, 'x-' || $2::text)`, [id, date, text]);
    }
    expect((await search('lastvisit')).customers[0]?.lastVisit).toEqual({ date: '2026-03-03', service: 'AC not cooling', serviceId: null });
  });
});

describe('street search (API-111)', () => {
  // why: FR-DISP-29 the street picker finds streets from the bundled list by prefix, from 2 characters, and refuses 1
  it('answers streets with branch, city and ZIP code, at most 20, and refuses a 1-letter text', async () => {
    const r = await api.post('/public/street-searches', { query: 'hi' }, who());
    expect(r.status).toBe(200);
    const streets = ((await r.json()) as { data: { streets: { streetId: string; name: string; city: string; zip: string; branch: string }[] } }).data.streets;
    expect(streets.length).toBeGreaterThan(0);
    expect(streets.length).toBeLessThanOrEqual(20);
    expect(streets[0]).toMatchObject({ streetId: expect.any(String), city: expect.any(String), zip: expect.stringMatching(/^\d{5}$/), branch: expect.any(String) });
    expect((await api.post('/public/street-searches', { query: 'h' }, who())).status).toBe(422);
    expect(((await (await api.post('/public/street-searches', { query: 'zzzzqqqq' }, who())).json()) as { data: { streets: unknown[] } }).data.streets).toEqual([]);
  });
});

describe('create a customer (API-139)', () => {
  // why: FR-DISP-29 a new customer takes the branch, ZIP code and map position from the listed street and the branch's zone, is marked office, and is found by search
  it('creates the customer from a street and a house number, and search then finds them', async () => {
    const st = (await rows<{ id: string; branch_id: string; zip: string; points: [number, number][]; zone: string }>(
      `SELECT s.id, s.branch_id, s.zip, s.points, b.zone FROM world.street s JOIN world.branch b ON b.id = s.branch_id WHERE s.branch_id = 'dayton' ORDER BY s.id LIMIT 1`))[0] as { id: string; branch_id: string; zip: string; points: [number, number][]; zone: string };
    const r = await api.post('/customers', { name: 'Lucia Moreno', mobile: '(614) 555-0172', streetId: st.id, houseNumber: 2310, textLanguage: 'es', textsOn: true }, who());
    expect(r.status).toBe(201);
    const made = ((await r.json()) as { data: { id: string; branch: string; zip: string; zone: string; position: { lon: number; lat: number } } }).data;
    const pt = st.points[(2310 - 1) % st.points.length] as [number, number];
    expect(made).toMatchObject({ branch: 'dayton', zip: st.zip, zone: st.zone, position: { lon: pt[0], lat: pt[1] } });
    const row = (await rows<{ source: string; mobile: string; texts_on: boolean; text_language: string; customer_since: string }>(
      `SELECT source, mobile, texts_on, text_language, customer_since::text FROM world.customer WHERE id = $1`, [made.id]))[0];
    expect(row).toMatchObject({ source: 'office', mobile: '+16145550172', texts_on: true, text_language: 'es' });
    expect((await search('lucia moreno')).customers.map((c) => c.id)).toEqual([made.id]);
    // no mobile phone: texts are off, whatever was asked
    const none = await api.post('/customers', { name: 'Pat NoPhone', mobile: null, streetId: st.id, houseNumber: 5, textLanguage: 'en', textsOn: true }, who());
    expect(((await rows<{ texts_on: boolean }>(`SELECT texts_on FROM world.customer WHERE id = $1`, [((await none.json()) as { data: { id: string } }).data.id]))[0])?.texts_on).toBe(false);
  });

  // why: FR-DISP-29 a street not on the list, a number that is not 10 digits and a house number outside 1 to 99999 are refused with validation_failed
  it('refuses a street that is not on the list and a bad mobile number', async () => {
    const st = (await rows<{ id: string }>(`SELECT id FROM world.street LIMIT 1`))[0] as { id: string };
    const base = { name: 'Bad Input', mobile: null, streetId: st.id, houseNumber: 10, textLanguage: 'en', textsOn: false };
    expect((await api.post('/customers', { ...base, streetId: '00000000-0000-7000-8000-000000000001' }, who())).status).toBe(422);
    expect((await api.post('/customers', { ...base, mobile: '555-01' }, who())).status).toBe(422);
    expect((await api.post('/customers', { ...base, houseNumber: 100000 }, who())).status).toBe(422);
    expect((await api.post('/customers', { ...base, name: '   ' }, who())).status).toBe(422);
  });
});

describe('customer page and edits (API-35, API-36)', () => {
  // why: FR-DISP-5, F-1542, CTL-OFC-06-12 (a history row that is a job carries its job number; an old-system row carries none, so the page links only the job)
  it('answers the job number for a done job and none for an old-system visit in the history', async () => {
    const id = await addCustomer('Dana Pruitt', { mobile: '+16145550177', since: '2015-01-02' });
    await rows(
      `INSERT INTO world.past_visit (customer_id, technician_name, date, zone, window_start, window_end, outcome, service_text, source_ref)
       VALUES ($1, 'Maria Santos', DATE '2025-10-14', 'America/New_York', TIMESTAMPTZ '2025-10-14 10:00-04', TIMESTAMPTZ '2025-10-14 12:00-04', 'done', 'Furnace tune-up', 'old-f1542')`, [id]);
    const win = world.windows.get('two_hour 08:00') as string;
    const job = ((await (await api.post('/jobs', { customerId: id, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-10-21', windowId: win, technicianId: world.technicians.get('Kevin Doyle') }, who())).json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
    expect((await api.post(`/jobs/${job}/finish`, { parts: [], noPartsUsed: true, laborMinutes: 30, baseVersion: 1 }, who())).status).toBe(200);
    const d = ((await (await api.get(`/customers/${id}`, who())).json()) as { data: { history: { old: boolean; jobNumber: number | null }[] } }).data;
    expect(d.history.map((h) => [h.old, h.jobNumber])).toEqual([[false, job], [true, null]]);
  });

  // why: FR-DISP-31 the customer page read carries contact, address with its map position, text settings, the membership, notes, equipment, upcoming visits and history, with the import date for an imported customer
  it('reads a customer with equipment, a membership, an upcoming visit, history and the import date', async () => {
    const id = await addCustomer('Harold Jenkins', { mobile: '+16145550148', since: '2014-10-02' });
    await rows(`INSERT INTO world.membership (customer_id, since, renews, benefits_key) VALUES ($1, DATE '2019-03-01', DATE '2027-03-01', 'club.benefits')`, [id]);
    await rows(`INSERT INTO world.equipment (customer_id, type, year, location, details) VALUES ($1, 'furnace', 2014, 'basement', '80,000 BTU')`, [id]);
    await rows(`INSERT INTO world.import_run (kind, status, stage, percent, started_at, finished_at, by_setup) VALUES ('real', 'done', 'done', 100, '2026-08-31T12:00:00Z', '2026-08-31T12:10:00Z', true)`);
    await rows(
      `INSERT INTO world.past_visit (customer_id, technician_name, date, zone, window_start, window_end, outcome, service_text, source_ref)
       VALUES ($1, 'Maria Santos', DATE '2025-10-14', 'America/New_York', TIMESTAMPTZ '2025-10-14 10:00-04', TIMESTAMPTZ '2025-10-14 12:00-04', 'done', 'Furnace tune-up', 'old-1')`, [id]);
    const win = world.windows.get('two_hour 08:00') as string;
    const job = ((await (await api.post('/jobs', { customerId: id, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-10-22', windowId: win, technicianId: world.technicians.get('Kevin Doyle') }, who())).json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
    const got = await api.get(`/customers/${id}`, who());
    expect(got.status).toBe(200);
    const d = ((await got.json()) as { data: { importedAt: string; position: unknown; equipment: unknown; upcoming: unknown; history: unknown } & Record<string, unknown> }).data;
    expect(d).toMatchObject({
      id, name: 'Harold Jenkins', branch: 'columbus', language: 'en', source: 'import', customerSince: '2014-10-02',
      contact: { mobile: '+16145550148', textsOn: true, homePhone: null, email: null },
      membership: { since: '2019-03-01', renews: '2027-03-01', benefitsKey: 'club.benefits' },
    });
    expect(d.importedAt).toMatch(/^2026-08-31T/);
    expect(d.position).toEqual({ lon: expect.any(Number), lat: expect.any(Number) });
    expect(d.equipment).toEqual([expect.objectContaining({ type: 'furnace', year: 2014, location: 'basement' })]);
    expect(d.upcoming).toEqual([expect.objectContaining({ jobNumber: job, day: '2026-10-22', status: 'scheduled', technician: expect.objectContaining({ name: 'Kevin Doyle', initials: 'KD' }) })]);
    expect(d.history).toEqual([expect.objectContaining({ date: '2025-10-14', service: 'Furnace tune-up', technician: 'Maria Santos', old: true })]);
    expect((await api.get('/customers/00000000-0000-7000-8000-000000000009', who())).status).toBe(404);
  });

  // why: F-869 (UI-SPECIFICATION 12.2 API-35: upcoming visits carry timing; SD-15) it was always null
  it('reads the timing of today\'s upcoming visit and null for another day', async () => {
    const id = await addCustomer('Timing Target', { mobile: '+16145550177' });
    const win = world.windows.get('two_hour 08:00') as string;
    const mk = async (date: string) => ((await (await api.post('/jobs', { customerId: id, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: win, technicianId: world.technicians.get('Kevin Doyle') }, who())).json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
    const later = await mk('2026-10-22');
    const today = await mk('2026-10-23');
    const anchor = (await rows<{ d: string; t: string }>(`SELECT (demo_anchor AT TIME ZONE 'America/New_York')::date::text AS d, demo_anchor::text AS t FROM system.demo_clock WHERE id = 1`))[0]!;
    // today's visit sits in a window that ended 3 hours before the demo now, so the estimate is past it: Late
    await rows(`UPDATE world.job SET date = $2::date, window_start = $3::timestamptz - interval '5 hours', window_end = $3::timestamptz - interval '3 hours' WHERE job_number = $1`, [today, anchor.d, anchor.t]);
    const d = ((await (await api.get(`/customers/${id}`, who())).json()) as { data: { upcoming: { jobNumber: number; timing: string | null }[] } }).data;
    expect(d.upcoming.find((u) => u.jobNumber === today)?.timing).toBe('late');
    expect(d.upcoming.find((u) => u.jobNumber === later)?.timing).toBeNull();
  });

  // why: F-906 (API-35 Recent texts) a held demo clock makes equal times common, so the 6 shown must not depend on row order
  it('lists the 6 recent texts by id when their times are equal', async () => {
    const id = await addCustomer('Tied Texts', { mobile: '+16145550166' });
    for (let n = 1; n <= 8; n += 1) {
      await rows(
        `INSERT INTO world.outbox_text (id, customer_id, kind, language, encoding, body, characters, status, due_at, created_at, delivered_at)
         VALUES ($1, $2, $3, 'en', 'gsm7', 'x', 1, 'sent', TIMESTAMPTZ '2026-10-23 08:02:00-04', TIMESTAMPTZ '2026-10-23 08:02:00-04', TIMESTAMPTZ '2026-10-23 08:02:00-04')`,
        [`00000000-0000-7000-8000-00000000010${n}`, id, `tie_${n}`]);
    }
    const d = ((await (await api.get(`/customers/${id}`, who())).json()) as { data: { recentTexts: { kind: string }[] } }).data;
    expect(d.recentTexts.map((t) => t.kind)).toEqual(['tie_8', 'tie_7', 'tie_6', 'tie_5', 'tie_4', 'tie_3']);
  });

  // why: FR-DISP-31 the office edits name, mobile, street and house number (branch and map position re-derived), text language, texts on and the time zone
  it('edits the contact, the address and the zone, and re-derives the branch and position from the street', async () => {
    const id = await addCustomer('Edit Target', { mobile: '+16145550100' });
    const dayton = (await rows<{ id: string; points: [number, number][] }>(`SELECT id, points FROM world.street WHERE branch_id = 'dayton' ORDER BY id LIMIT 1`))[0] as { id: string; points: [number, number][] };
    const r = await patch(`/customers/${id}`, { name: 'Edit Target Jr', mobile: '(614) 555-0199', streetId: dayton.id, houseNumber: 7, textLanguage: 'es', textsOn: false, timeZone: 'America/Chicago' });
    expect(r.status).toBe(200);
    const row = (await rows<Record<string, unknown>>(`SELECT name, name_search, mobile, branch_id, house_number, lon, lat, text_language, texts_on, zone FROM world.customer WHERE id = $1`, [id]))[0];
    expect(row).toMatchObject({ name: 'Edit Target Jr', name_search: 'edit target jr', mobile: '+16145550199', branch_id: 'dayton', house_number: 7, text_language: 'es', texts_on: false, zone: 'America/Chicago', lon: dayton.points[6 % dayton.points.length]?.[0], lat: dayton.points[6 % dayton.points.length]?.[1] });
    expect((await patch(`/customers/${id}`, { mobile: '12' })).status).toBe(422);
    expect((await patch(`/customers/${id}`, { timeZone: 'Mars/Olympus' })).status).toBe(422);
    expect((await patch(`/customers/${id}`, { streetId: '00000000-0000-7000-8000-000000000001' })).status).toBe(422);
    expect((await patch(`/customers/00000000-0000-7000-8000-000000000009`, { name: 'x' })).status).toBe(404);
  });

  // why: FR-DISP-32 the Comfort Club membership is sample data: a membership field is refused with rule_refused and nothing changes
  it('refuses a membership field with rule_refused', async () => {
    const id = await addCustomer('Member Locked');
    await rows(`INSERT INTO world.membership (customer_id, since, renews, benefits_key) VALUES ($1, DATE '2019-03-01', DATE '2027-03-01', 'club.benefits')`, [id]);
    const r = await patch(`/customers/${id}`, { name: 'Changed Name', membership: { renews: '2030-01-01' } });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code?: string; type?: string }).type ?? '').toContain('rule_refused');
    expect((await rows<{ name: string }>(`SELECT name FROM world.customer WHERE id = $1`, [id]))[0]?.name).toBe('Member Locked');
    expect((await rows<{ renews: string }>(`SELECT renews::text FROM world.membership WHERE customer_id = $1`, [id]))[0]?.renews).toBe('2027-03-01');
  });
});
