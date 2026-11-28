// SPDX-License-Identifier: AGPL-3.0-or-later
// API-133 Jobs list and API-134 Jobs export (FR-DISP-24, FR-DISP-14, NFR-05; SPECIFICATIONS section 6.2 "Jobs list", UD-44, UD-52) on the real
// database (PostgreSQL 18, the migrated schema, P2-SEED's reference seed: 12 Columbus technicians and the windows), through the production kernel
// as the web process's login bw_web, with a dispatcher whose session the real session layer created. Jobs are created by API-28 (the real write);
// the planted cases (channel, billing state, flagged conflict, a job whose window has passed) are SQL on top, since the clock stands on Tue,
// Sep 15, 7:00 AM. Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 60);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

interface Row {
  jobNumber: number; customer: string; area: string; service: string; day: string; window: { start: string; end: string }; technicianId: string | null; technician: string | null;
  status: string; timing: string | null; eta: string | null; dayMode: string; bookedVia: string; bookedBy: string | null; billingState: string; billingTries: number; billedAt: string | null;
  needsAttention: boolean;
}
interface List {
  branch: string; today: string; asOf: string;
  counts: { all: number; unassigned: number; atRisk: number; late: number; notInBilling: number };
  rows: Row[]; range: { from: string; to: string }; total: number; pages: number;
}

const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;
const nextCustomer = () => world.customers[customer++ % world.customers.length] as string;
const sql = async <T>(text: string, params: unknown[] = []) => (await db.admin().query<T>(text, params)).rows;
const list = async (body: Record<string, unknown> = {}, who: Staff = keisha): Promise<List> => {
  const r = await api.post('/job-searches', { branch: 'columbus', ...body }, who);
  if (r.status !== 200) throw new Error(`jobs list answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as { data: List }).data;
};
async function book(date: string, window: string, technician: string | null, service = 'furnace_tune_up', customerId = nextCustomer()): Promise<number> {
  const r = await api.post('/jobs', {
    customerId, serviceId: service, equipmentId: null, problem: null, date, windowId: win(window), technicianId: technician ? tech(technician) : null,
  }, keisha);
  if (r.status !== 201) throw new Error(`create ${date} ${window} ${technician} ${service} answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
}
const set = (job: number, column: string, value: unknown) => sql(`UPDATE world.job SET ${column} = $2 WHERE job_number = $1`, [job, value]);

let planted: { unassigned: number[]; today: number; later: number; farther: number };

describe('the jobs list read (API-133)', () => {
  beforeAll(async () => {
    const un = [
      await book('2026-09-15', 'two_hour 12:00', null, 'water_heater'),
      await book('2026-09-15', 'two_hour 14:00', null),
      await book('2026-09-16', 'four_hour 08:00', null),
    ];
    planted = {
      unassigned: un,
      today: await book('2026-09-15', 'two_hour 08:00', 'Marcus Bell'),
      later: await book('2026-09-17', 'two_hour 10:00', 'Luis Ortega'),
      farther: await book('2026-09-21', 'two_hour 10:00', 'Luis Ortega'), // beyond today + 4: outside Today and upcoming
    };
  }, 120_000);

  // why: FR-DISP-24 the page lists today and the next 4 days, and each tab count equals the rows of that tab; the Unassigned jobs lead under attention-first
  it('lists Sep 15 to Sep 19 with the unassigned jobs first, and each tab count equals the rows that tab lists', async () => {
    const all = await list();
    expect(all.range).toEqual({ from: '2026-09-15', to: '2026-09-19' });
    expect(all.today).toBe('2026-09-15');
    expect(all.rows.map((r) => r.jobNumber)).not.toContain(planted.farther);
    expect(all.rows.slice(0, 3).map((r) => r.jobNumber)).toEqual(planted.unassigned.slice(0, 2).concat(planted.unassigned[2]!));
    expect(all.rows.slice(0, 3).every((r) => r.needsAttention && r.technicianId === null)).toBe(true);
    expect(all.rows.slice(3).some((r) => r.needsAttention)).toBe(false);
    expect(all.total).toBe(all.counts.all);
    for (const [tab, count] of [['unassigned', all.counts.unassigned], ['at-risk', all.counts.atRisk], ['late', all.counts.late], ['not-in-billing', all.counts.notInBilling]] as const) {
      const t = await list({ tab });
      expect([tab, t.total, t.rows.length]).toEqual([tab, count, count]);
    }
    expect(all.counts.unassigned).toBe(3);
    // the counts of one list are the same whichever tab is picked
    expect((await list({ tab: 'unassigned' })).counts).toEqual(all.counts);
    expect(all.asOf).toMatch(/^2026-09-15T07:00:00-04:00\[America\/New_York\]$/);
  });

  // why: FR-DISP-24 Today picks demo today only, a picked day only that day; the days are the range API-133 answers (CTL-OFC-30-18)
  it('answers the range of the Date filter and lists only those days', async () => {
    const today = await list({ date: 'today' });
    expect(today.range).toEqual({ from: '2026-09-15', to: '2026-09-15' });
    expect(new Set(today.rows.map((r) => r.day))).toEqual(new Set(['2026-09-15']));
    const day = await list({ date: '2026-09-17' });
    expect(day.range).toEqual({ from: '2026-09-17', to: '2026-09-17' });
    expect(day.rows.map((r) => r.jobNumber)).toContain(planted.later);
    expect(new Set(day.rows.map((r) => r.day))).toEqual(new Set(['2026-09-17']));
  });

  // why: FR-DISP-24 sort window lists by day, window start, then job number; attention-first puts the attention jobs ahead whatever their day
  it('sorts by day and window start under Arrival window, and attention jobs ahead of earlier-window jobs under the default', async () => {
    const w = await list({ sort: 'window' });
    const keys = w.rows.map((r) => `${r.day} ${r.window.start} ${String(r.jobNumber).padStart(8, '0')}`);
    expect(keys).toEqual([...keys].sort());
    const a = await list();
    // the 8 AM job of Marcus Bell does not need attention, so it comes after the unassigned 2 PM job
    expect(a.rows.findIndex((r) => r.jobNumber === planted.today)).toBeGreaterThan(a.rows.findIndex((r) => r.jobNumber === planted.unassigned[1]));
  });

  // why: FR-DISP-24 UD-52: an open job that is Late needs attention and leads, a closed job never does; a job whose window has passed is Late
  it('marks a job whose window passed as Late and leads with it, and never marks a closed job', async () => {
    const jn = await book('2026-09-15', 'two_hour 08:00', 'Greg Hoffman');
    await sql(`UPDATE world.job SET window_start = '2026-09-15T05:00:00-04:00', window_end = '2026-09-15T06:00:00-04:00' WHERE job_number = $1`, [jn]);
    const closed = await book('2026-09-15', 'two_hour 08:00', null);
    await sql(`INSERT INTO world.billing_item (job_number, state) VALUES ($1, 'sending')`, [closed]);
    await set(closed, 'status', 'done');
    const l = await list();
    const row = l.rows.find((r) => r.jobNumber === jn)!;
    expect(row).toMatchObject({ timing: 'late', needsAttention: true, status: 'scheduled' });
    expect(row.eta).toEqual(expect.stringMatching(/^2026-09-15T/));
    expect(l.rows[0]!.jobNumber).toBe(jn);
    expect(l.counts.late).toBe(1);
    expect((await list({ tab: 'late' })).rows.map((r) => r.jobNumber)).toEqual([jn]);
    expect(l.rows.find((r) => r.jobNumber === closed)).toMatchObject({ status: 'done', needsAttention: false, timing: null });
    // a done job with no technician is not in the Unassigned tab
    expect((await list({ tab: 'unassigned' })).rows.map((r) => r.jobNumber)).not.toContain(closed);
    await set(jn, 'status', 'canceled');
    await set(closed, 'status', 'canceled');
  });

  // why: FR-DISP-24 UD-52: a Scheduled job with an unhandled offline conflict needs attention; once handled it does not
  it('flags a Scheduled job with an unhandled offline conflict and stops flagging it once handled', async () => {
    const jn = planted.later;
    const key = (await sql<{ key: string }>(
      `INSERT INTO world.tech_item (key, technician_id, job_number, kind, world_epoch, device_time_real, offset_saved_real, demo_time, since_save_ms, received_at, result)
       VALUES (uuidv7(), $2, $1, 'arrived', 1, now(), now(), now(), 0, now(), 'conflict') RETURNING key`, [jn, tech('Luis Ortega')]))[0]!.key;
    await sql(
      `INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
       VALUES ($1, $2, 'columbus', 'conflict.test', '{}', '2026-09-15T06:00:00Z', '2026-09-15T06:30:00Z')`, [jn, key]);
    expect((await list()).rows.find((r) => r.jobNumber === jn)!.needsAttention).toBe(true);
    await sql(`UPDATE world.offline_conflict SET handled_at = '2026-09-15T07:00:00Z' WHERE job_number = $1`, [jn]);
    expect((await list()).rows.find((r) => r.jobNumber === jn)!.needsAttention).toBe(false);
  });

  // why: CTL-OFC-30-20 F-293: the row says how it was booked: online, office with the person, or the old system
  it('answers bookedVia and bookedBy: online, office with the person who booked it, and seed', async () => {
    const online = await book('2026-09-17', 'two_hour 08:00', 'Jamal Carter');
    const seed = await book('2026-09-17', 'two_hour 10:00', 'Jamal Carter');
    await set(online, 'booked_via', 'online');
    await set(online, 'booked_by', null);
    await set(seed, 'booked_via', 'seed');
    await set(seed, 'booked_by', null);
    const rows = (await list({ date: '2026-09-17' })).rows;
    expect(rows.find((r) => r.jobNumber === planted.later)).toMatchObject({ bookedVia: 'office', bookedBy: 'Keisha Thompson' });
    expect(rows.find((r) => r.jobNumber === online)).toMatchObject({ bookedVia: 'online', bookedBy: null });
    expect(rows.find((r) => r.jobNumber === seed)).toMatchObject({ bookedVia: 'seed', bookedBy: null });
  });

  // why: FR-DISP-24 UD-44: Not in billing lists the retrying and waiting jobs whatever their day, and no other job
  it('lists every retrying and waiting_person job on Not in billing whatever its day, and counts them though the day is out of range', async () => {
    const old = await book('2026-09-21', 'two_hour 10:00', 'Luis Ortega');
    const waiting = await book('2026-09-17', 'two_hour 12:00', 'Jamal Carter');
    const fine = await book('2026-09-17', 'two_hour 14:00', 'Jamal Carter');
    await set(old, 'billing_state', 'retrying');
    await set(waiting, 'billing_state', 'waiting_person');
    await set(fine, 'billing_state', 'in_billing');
    await sql(`INSERT INTO world.billing_item (job_number, state, tries) VALUES ($1, 'retrying', 3)`, [old]);
    const nib = await list({ tab: 'not-in-billing' });
    expect(nib.rows.map((r) => r.jobNumber).sort()).toEqual([old, waiting].sort());
    expect(nib.counts.notInBilling).toBe(2);
    expect(nib.rows.find((r) => r.jobNumber === old)).toMatchObject({ billingState: 'retrying', billingTries: 3 });
    // the out-of-range one is not on the All tab
    expect((await list()).rows.map((r) => r.jobNumber)).not.toContain(old);
    expect((await list()).counts.all).toBe((await list()).total);
  });

  // why: F-1652 CTL-OFC-30-10 a job with problem words lists them beside its service id; a job without lists null, so the page shows the catalog name
  it('returns the job\'s own problem words and null when it has none', async () => {
    const withWords = await book('2026-09-18', 'four_hour 10:00', null, 'plumbing_repair');
    const without = await book('2026-09-18', 'four_hour 10:00', null, 'plumbing_repair');
    await set(withWords, 'problem', 'Water softener service');
    const rows = (await list({ date: '2026-09-18' })).rows as Array<Row & { problem: string | null }>;
    expect(rows.find((r) => r.jobNumber === withWords)).toMatchObject({ service: 'plumbing_repair', problem: 'Water softener service' });
    expect(rows.find((r) => r.jobNumber === without)).toMatchObject({ service: 'plumbing_repair', problem: null });
  });

  // why: F-1652 the approved Jobs page says Clintonville for a Clintonville ZIP and the street's city for any other
  it('answers Clintonville as the area of a Clintonville ZIP and the city otherwise', async () => {
    const c = nextCustomer();
    const jn = await book('2026-09-18', 'four_hour 10:00', null, 'furnace_tune_up', c);
    const st = (await sql<{ id: string; zip: string; city: string }>(`SELECT s.id, s.zip, s.city FROM world.customer cu JOIN world.street s ON s.id = cu.street_id WHERE cu.id = $1`, [c]))[0]!;
    const area = async () => (await list({ date: '2026-09-18' })).rows.find((r) => r.jobNumber === jn)?.area;
    try {
      await sql(`UPDATE world.street SET zip = '43202' WHERE id = $1`, [st.id]);
      expect(await area()).toBe('Clintonville');
      await sql(`UPDATE world.street SET zip = '43215' WHERE id = $1`, [st.id]);
      expect(await area()).toBe(st.city);
    } finally {
      await sql(`UPDATE world.street SET zip = $2 WHERE id = $1`, [st.id, st.zip]);
    }
  });

  // why: NFR-05 FR-DISP-24 the search finds a job number, a customer, a street and a phone; the text is sent in the body only, so the GET form is refused
  it('searches by job number, customer, street with a house number and phone, and has no GET form', async () => {
    const c = nextCustomer();
    await sql(`UPDATE world.customer SET name = 'Hendricks Quill', name_search = 'hendricks quill', mobile = '+16145550142', home_phone = '(614) 555-0177' WHERE id = $1`, [c]);
    const jn = await book('2026-09-18', 'four_hour 10:00', 'Luis Ortega', 'furnace_tune_up', c);
    const street = (await sql<{ name: string; house_number: number }>(
      `SELECT s.name, cu.house_number FROM world.customer cu JOIN world.street s ON s.id = cu.street_id WHERE cu.id = $1`, [c]))[0]!;
    const only = async (query: string) => (await list({ query })).rows.map((r) => r.jobNumber);
    expect(await only(String(jn))).toEqual([jn]);
    expect(await only('  hendricks  ')).toEqual([jn]);
    expect(await only('Hendricks')).toEqual([jn]);
    expect(await only('555-0142')).toEqual([jn]);
    expect(await only('(614) 555-0177')).toEqual([jn]);
    expect(await only(`${street.house_number} ${street.name}`)).toContain(jn);
    expect(await only('zzzz no such')).toEqual([]);
    // the counts follow the search
    const hit = await list({ query: 'hendricks' });
    expect(hit.counts).toMatchObject({ all: 1, unassigned: 0 });
    expect((await api.get('/job-searches?query=hendricks&branch=columbus', keisha)).status).toBeGreaterThanOrEqual(404);
  });

  // why: FR-DISP-24 the technician, status and service filters narrow the rows and the counts
  it('filters by technician, status and service', async () => {
    const bell = await list({ technicianId: tech('Marcus Bell') });
    expect(bell.rows.length).toBeGreaterThan(0);
    expect(bell.rows.every((r) => r.technicianId === tech('Marcus Bell'))).toBe(true);
    expect((await list({ status: 'done' })).rows.every((r) => r.status === 'done')).toBe(true);
    const heaters = await list({ serviceId: 'water_heater' });
    expect(heaters.rows.length).toBeGreaterThan(0);
    expect(heaters.rows.every((r) => r.service === 'water_heater')).toBe(true);
    expect(heaters.total).toBe(heaters.counts.all);
  });

  // why: FR-DISP-24 CTL-OFC-30-12 the list pages 50 at a time with the page count and the total
  it('pages 50 rows at a time and answers pages and total', async () => {
    await sql(
      `INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, technician_id, status, version,
                              expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
       SELECT $1, 'columbus', 'furnace_tune_up', '2026-09-18', 'America/New_York', $2, '2026-09-18T12:00:00-04:00', '2026-09-18T14:00:00-04:00', $3,
              'scheduled', 1, 60, 'online', '2026-09-10T12:00:00Z', 'not_sent', false, false, false FROM generate_series(1, 60)`,
      [nextCustomer(), win('two_hour 12:00'), tech('Ryan Mitchell')]);
    const first = await list();
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBeGreaterThan(60);
    expect(first.pages).toBe(Math.ceil(first.total / 50));
    const second = await list({ page: 2 });
    expect(second.rows.length).toBe(Math.min(50, first.total - 50));
    expect(second.rows.map((r) => r.jobNumber).filter((n) => first.rows.some((x) => x.jobNumber === n))).toEqual([]);
    expect((await list({ tab: 'late' })).pages).toBe(0);
  });

  // why: K-08 row 1 a page past the last page answered an empty list, so a list that shrank under a page number showed nothing; it answers the last page
  it('answers the last page for a page past the last', async () => {
    const first = await list();
    const last = await list({ page: first.pages });
    expect(last.rows.length).toBe(first.total - 50 * (first.pages - 1));
    const past = await list({ page: first.pages + 5 });
    expect(past.rows.map((r) => r.jobNumber)).toEqual(last.rows.map((r) => r.jobNumber));
    expect((await list({ tab: 'late', page: 4 })).rows).toEqual([]);
  });

  // why: FR-DISP-24 every call needs a signed-in office user; the branch exists, the tab, status and page are well formed
  it('refuses a signed-out caller, an unknown branch and a malformed body', async () => {
    const out = await world.kernel.router.handle(new Request('http://web:3000/api/v1/job-searches', {
      method: 'POST', body: JSON.stringify({ branch: 'columbus' }), headers: { 'content-type': 'application/json' },
    }), { address: '203.0.113.9' });
    expect(out.status).toBe(401);
    expect((await api.post('/job-searches', { branch: 'nowhere' }, keisha)).status).toBe(404);
    expect((await api.post('/job-searches', { branch: 'columbus', tab: 'nope' }, keisha)).status).toBe(422);
    expect((await api.post('/job-searches', { branch: 'columbus', page: 0 }, keisha)).status).toBe(422);
  });
});

describe('the jobs export (API-134)', () => {
  // why: FR-DISP-24 the export writes every row of the tab and filters with the on-screen columns, a header in the page's language, a byte order mark and CRLF
  it('writes the rows of the list as a UTF-8 CSV with a byte order mark, CRLF and a header in the page language', async () => {
    const l = await list({ tab: 'unassigned' });
    const r = await api.post('/job-searches/export', { branch: 'columbus', tab: 'unassigned', lang: 'es' }, keisha);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe('Trabajo,Cliente,Zona,Servicio,Día,Ventana de llegada,Técnico,Estado,Puntualidad,Llegada estimada,Reservado por,Facturación,Necesita atención');
    expect(lines.length - 2).toBe(l.total);
    expect(lines[1]!.split(',')[0]).toBe(String(l.rows[0]!.jobNumber));
    expect(r.headers.get('content-disposition')).toContain('jobs-columbus-2026-09-15.csv');
  });

  // why: F-1670 CTL-OFC-30-13 the export has the on-screen columns, so its service cell is the job's own problem words when it has them and the catalog name when not
  it('writes the problem words in the service column, and the catalog name when the job has none', async () => {
    const withWords = await book('2026-09-18', 'four_hour 10:00', null, 'plumbing_repair');
    const without = await book('2026-09-18', 'four_hour 10:00', null, 'plumbing_repair');
    await set(withWords, 'problem', 'Water softener service');
    const r = await api.post('/job-searches/export', { branch: 'columbus', date: '2026-09-18', lang: 'en' }, keisha);
    const lines = new TextDecoder().decode(await r.arrayBuffer()).split('\r\n');
    const rowOf = (n: number): string => lines.find((l) => l.startsWith(`${n},`)) ?? '';
    expect(rowOf(withWords)).toContain(',Water softener service,');
    expect(rowOf(withWords)).not.toContain('Plumbing repair');
    expect(rowOf(without)).toContain(',Plumbing repair,');
  });
});
