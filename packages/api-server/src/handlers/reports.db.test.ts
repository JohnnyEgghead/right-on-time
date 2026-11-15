// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-REP-1, FR-REP-2, FR-REP-3, FR-REP-4, FR-REP-5, FR-REP-6, FR-REP-7, FR-REP-8, SC-01, SC-02, SC-03, UC-09 (API-50 and API-51 on the real database)
// API-50 Reports and API-51 Reports export (FR-REP-1 to FR-REP-8; SPECIFICATIONS SD-25) on PostgreSQL 18, the migrated schema and the reference
// seed (12 Columbus technicians, the clock at Tue, Sep 15, 7:00 AM), through the production kernel as the web process's login bw_web, with a
// manager whose session the real session layer created. Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
//
// The numbers are checked 2 ways, both written apart from the report code:
//   1. A hand-built fixture whose expected values are typed literals (never computed by the code under test): 40 visits with 2 no-one-home
//      is 5.0%; 37 of 40 arrivals on time is 92.5%; a canceled visit is in no denominator; a live No one home visit of Sep 15 adds 1; a live finished visit is in the
//      no-one-home denominator (SC-02) and in nothing else.
//   2. An independent SQL query on the raw rows (past_visit, job, pilot_call, outbox_text, not the report_visit view, and its own week
//      arithmetic) that every report figure of the whole range must equal.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertJob as insertJobRow, useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { addCustomers, caller, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let dana: Staff;
let keisha: Staff;
let cbus: string[];
let dayton: string[];
let techA: { id: string; name: string };
let techB: { id: string; name: string };
let techC: { id: string; name: string };
let windowId: string;

const admin = () => db.admin();
/** The fixture's job row on the reference seed's service. */
const insertJob = (a: ReturnType<typeof admin>, ref: { customerId: string; windowId: string }, over: Record<string, unknown>) => insertJobRow(a, ref, { service_id: 'furnace_tune_up', ...over });
const NY = '-04:00';

interface Report {
  labelKey: string; branch: string; technicianId: string | null; fromWeek: string; toWeek: string; weeks: string[];
  choices: { weeks: string[]; branches: string[]; technicians: { id: string; name: string }[] };
  goals: { onTime: { rate: number; labelKey: string }; noOneHome: { rate: number; labelKey: string } };
  totals: { visits: number };
  onTime: { branch: string; points: { week: string; rate: number | null; onTime: number; visits: number }[] }[];
  calls: { week: string; calls: number; perDay: number | null }[];
  noOneHome: { week: string; rate: number | null; count: number; visits: number }[];
  lateTexts: { week: string; count: number }[];
  headline: {
    week: string; onTime: { rate: number | null; before: number | null; after: number | null };
    calls: { count: number; perDay: number | null; before: number | null; after: number | null };
    noOneHome: { rate: number | null; count: number; visits: number; before: number | null; after: number | null }; lateTexts: number;
  };
  technicians: { technicianId: string | null; name: string; visits: number; onTimeRate: number | null; averageMinutesLate: number | null; noOneHome: number; calls: number }[];
}

async function read(query = '', who: Staff = dana): Promise<{ status: number; data: Report; meta: { labels: string[] } }> {
  const r = await api.get(`/reports${query}`, who);
  const body = (await r.json()) as { data: Report; meta: { labels: string[] } };
  return { status: r.status, ...body };
}

/** A pilot past visit with the window 8-10 AM that day; returns its id. */
async function visit(customer: string, tech: { id: string; name: string } | null, date: string, arrival: string | null, outcome = 'done'): Promise<string> {
  const r = await admin().query<{ id: string }>(
    `INSERT INTO world.past_visit (customer_id, technician_name, technician_id, date, zone, window_start, window_end, arrived_at, outcome, service_text, source_ref)
     VALUES ($1, $2, $3, $4::date, 'America/New_York', ($4::text || 'T08:00:00${NY}')::timestamptz, ($4::text || 'T10:00:00${NY}')::timestamptz,
             CASE WHEN $5::text IS NULL THEN NULL ELSE ($4::text || 'T' || $5::text || '${NY}')::timestamptz END, $6, 'Tune-up', 'fixture') RETURNING id`,
    [customer, tech?.name ?? 'Old Tech', tech?.id ?? null, date, arrival, outcome]);
  return r.rows[0]?.id as string;
}
const call = (branch: string, customer: string, tech: string, visitId: string, at: string) =>
  admin().query('INSERT INTO world.pilot_call (at, branch_id, customer_id, technician_id, past_visit_id) VALUES ($1::timestamptz, $2, $3, $4, $5)', [at, branch, customer, tech, visitId]);
const text = (customer: string, kind: string, status: string, deliveredAt: string | null) =>
  admin().query(
    `INSERT INTO world.outbox_text (customer_id, kind, language, encoding, body, characters, status, due_at, created_at, delivered_at)
     VALUES ($1, $2, 'en', 'gsm7', 'fixture', 7, $3, '2026-07-14T09:00:00-04:00', '2026-07-14T09:00:00-04:00', $4::timestamptz)`, [customer, kind, status, deliveredAt]);

beforeAll(async () => {
  world = await officeWorld(db, 40);
  api = caller(world.kernel);
  dana = world.staff.dana;
  keisha = world.staff.keisha;
  const a = admin();
  cbus = world.customers;
  dayton = await addCustomers(a, 'dayton', 4);
  const t = (await a.query<{ id: string; name: string }>(`SELECT id, name FROM world.technician WHERE branch_id = 'columbus' ORDER BY name LIMIT 3`)).rows;
  techA = t[0] as typeof techA;
  techB = t[1] as typeof techB;
  techC = t[2] as typeof techC;
  windowId = world.windows.get('two_hour 08:00') as string;

  // Columbus, week of Mon, Jul 6 (Jul 6 to 10, 8 visits a day = 40): technician A has 25, technician B 15.
  //   no one home: 1 of A's and 1 of B's, both on Jul 6 (no arrival). A: 2 late (10:25 and 10:35: 25 and 35 minutes). B: 3 late (10:10, 10:20, 10:30).
  const week1: string[] = [];
  for (let d = 0; d < 5; d++) {
    for (let i = 0; i < 8; i++) {
      const date = `2026-07-${String(6 + d).padStart(2, '0')}`;
      const tech = i < 5 ? techA : techB;
      const first = d === 0 && (i === 0 || i === 5);
      const late = d === 1 && i === 0 ? '10:25' : d === 1 && i === 1 ? '10:35' : d === 2 && i === 5 ? '10:10' : d === 2 && i === 6 ? '10:20' : d === 2 && i === 7 ? '10:30' : '09:30';
      week1.push(await visit(cbus[(d * 8 + i) % cbus.length] as string, tech, date, first ? null : late, first ? 'no_one_home' : 'done'));
    }
  }
  // 15 calls in that week: 9 about technician A's visits and 6 about B's. 1 call of the week before and 2 of the week after are in other weeks.
  for (let i = 0; i < 9; i++) await call('columbus', cbus[0] as string, techA.id, week1[i] as string, `2026-07-${String(6 + (i % 5)).padStart(2, '0')}T11:00:00-04:00`);
  for (let i = 0; i < 6; i++) await call('columbus', cbus[0] as string, techB.id, week1[5 + i] as string, `2026-07-${String(6 + (i % 5)).padStart(2, '0')}T12:00:00-04:00`);
  await call('columbus', cbus[0] as string, techA.id, week1[0] as string, '2026-06-30T11:00:00-04:00');
  await call('columbus', cbus[0] as string, techA.id, week1[0] as string, '2026-07-13T11:00:00-04:00');
  await call('columbus', cbus[0] as string, techB.id, week1[5] as string, '2026-07-19T23:30:00-04:00');
  // Dayton, the same week: 4 visits of an old-system technician with no seeded id; 3 on time, 1 late by 5 minutes.
  for (const [i, arrival] of ['09:00', '09:10', '09:20', '10:05'].entries()) await visit(dayton[i] as string, null, '2026-07-08', arrival);

  // Columbus, week of Mon, Jul 13: 40 visits of technician A, every one with an arrival; 37 at or before the window's end (3 exactly at it), 3 after it.
  for (let i = 0; i < 40; i++) {
    const date = `2026-07-${String(13 + (i % 5)).padStart(2, '0')}`;
    await visit(cbus[i % cbus.length] as string, techA, date, i < 3 ? '10:00' : i < 37 ? '09:15' : '10:20');
  }
  // A canceled visit that same week, with an arrival inside its window: it is no visit of the reports and in no denominator (SC-03).
  await insertJob(a, { customerId: cbus[0] as string, windowId }, { date: '2026-07-15', pilot: true, status: 'canceled', technician_id: techA.id, window_start: `2026-07-15T08:00:00${NY}`, window_end: `2026-07-15T10:00:00${NY}`, arrived_at: `2026-07-15T09:00:00${NY}` });
  // Late texts: 3 delivered in the week of Jul 13; a retrying one, a delivered confirmation and a late one of another week are not counted.
  for (const at of ['2026-07-13T10:00:00-04:00', '2026-07-15T10:00:00-04:00', '2026-07-19T22:00:00-04:00']) await text(cbus[1] as string, 'late', 'delivered', at);
  await text(cbus[1] as string, 'late', 'retrying', null);
  await text(cbus[1] as string, 'confirmation', 'delivered', '2026-07-14T10:00:00-04:00');
  await text(cbus[1] as string, 'late', 'delivered', '2026-07-20T00:30:00-04:00');

  // Columbus, week of Mon, Sep 14: 10 seeded pilot jobs of technician A that ended done and on time, all on Sep 14, and 4 calls that day;
  // 1 live No one home on Tue, Sep 15 (counts for no one home only);
  // 2 live finished visits on Sep 15, A's and those of technician C, who has no pilot visit, each 60 minutes late (SC-02's population: the no-one-home denominator and nothing else);
  // a live No one home and a live done job of Sep 14 (before the live period: not counted).
  // Columbus, week of Mon, Sep 21: 1 live finished visit of technician B and nothing else.
  for (let i = 0; i < 10; i++) await insertJob(a, { customerId: cbus[i] as string, windowId }, { date: '2026-09-14', pilot: true, status: 'done', technician_id: techA.id, window_start: `2026-09-14T08:00:00${NY}`, window_end: `2026-09-14T10:00:00${NY}`, arrived_at: `2026-09-14T09:00:00${NY}` });
  await insertJob(a, { customerId: cbus[0] as string, windowId }, { date: '2026-09-15', status: 'no_one_home', technician_id: techA.id, arrived_at: `2026-09-15T09:00:00${NY}` });
  for (const tech of [techA, techC]) await insertJob(a, { customerId: cbus[0] as string, windowId }, { date: '2026-09-15', status: 'done', technician_id: tech.id, arrived_at: `2026-09-15T11:00:00${NY}` });
  await insertJob(a, { customerId: cbus[0] as string, windowId }, { date: '2026-09-14', status: 'no_one_home', technician_id: techA.id });
  await insertJob(a, { customerId: cbus[0] as string, windowId }, { date: '2026-09-14', status: 'done', technician_id: techA.id, arrived_at: `2026-09-14T09:00:00${NY}` });
  await insertJob(a, { customerId: cbus[0] as string, windowId }, { date: '2026-09-22', status: 'done', technician_id: techB.id, window_start: `2026-09-22T08:00:00${NY}`, window_end: `2026-09-22T10:00:00${NY}`, arrived_at: `2026-09-22T09:00:00${NY}` });
  for (let i = 0; i < 4; i++) await call('columbus', cbus[0] as string, techA.id, week1[0] as string, '2026-09-14T11:00:00-04:00');
  // F-742: 36 calls in the whole after week of Aug 3, so the after average over the 8 whole weeks (4.5) differs from one over all 9 ((36 + 4) / 9 = 4.4)
  for (let i = 0; i < 36; i++) await call('columbus', cbus[0] as string, techA.id, week1[0] as string, '2026-08-04T11:00:00-04:00');
}, 180_000);
afterAll(async () => {
  await world?.close();
});

describe('the report read (API-50)', () => {
  // why: SC-02 40 visits with 2 no-one-home is 5.0% (typed values, the week of Jul 6 at Columbus); FR-REP-2 the count and the visits it comes from are in the answer
  it('gives 5.0% no one home for 40 visits with 2 no-one-home', async () => {
    const r = await read('?branch=columbus&fromWeek=2026-07-06&toWeek=2026-07-06');
    expect(r.status).toBe(200);
    expect(r.data.noOneHome).toEqual([{ week: '2026-07-06', rate: 5.0, count: 2, visits: 40 }]);
    expect(r.data.headline.noOneHome).toMatchObject({ rate: 5.0, count: 2, visits: 40 });
    expect(r.data.totals.visits).toBe(40);
  });

  // why: SC-03 37 of 40 arrivals at or before the window's end is 92.5%, and the canceled visit that week is in no denominator (typed values, the week of Jul 13 at Columbus)
  it('gives 92.5% on time for 37 of 40 and leaves the canceled visit out of the denominator', async () => {
    const r = await read('?branch=columbus&fromWeek=2026-07-13&toWeek=2026-07-13');
    expect(r.data.onTime).toEqual([{ branch: 'columbus', points: [{ week: '2026-07-13', rate: 92.5, onTime: 37, visits: 40 }] }]);
    expect(r.data.headline.onTime.rate).toBe(92.5);
    // a canceled visit counted once would make it 38 of 41 and 92.7%: the fixture holds exactly 1 canceled job, with an arrival inside its window
    expect(r.data.totals.visits).toBe(40);
  });

  // why: SC-01 and FR-REP-1 the on-time rate per week and branch (typed values): Columbus Jul 6 is 33 of 38 with arrivals, Dayton 3 of 4; an exact arrival at the window's end is on time
  it('gives the on-time rate per week and branch', async () => {
    const r = await read('?fromWeek=2026-07-06&toWeek=2026-07-13');
    const by = (b: string) => r.data.onTime.find((x) => x.branch === b)?.points;
    expect(r.data.onTime.map((x) => x.branch)).toEqual(['columbus', 'dayton', 'springfield']);
    expect(by('columbus')).toEqual([
      { week: '2026-07-06', rate: 86.8, onTime: 33, visits: 38 },
      { week: '2026-07-13', rate: 92.5, onTime: 37, visits: 40 },
    ]);
    expect(by('dayton')).toEqual([{ week: '2026-07-06', rate: 75.0, onTime: 3, visits: 4 }, { week: '2026-07-13', rate: null, onTime: 0, visits: 0 }]);
    expect(by('springfield')?.map((p) => p.rate)).toEqual([null, null]);
  });

  // why: FR-REP-5 the week range and the branch and technician filters apply to every card, chart and table
  it('applies the branch, technician and week range to every figure', async () => {
    const dayton1 = await read('?branch=dayton&fromWeek=2026-07-06&toWeek=2026-07-06');
    expect(dayton1.data).toMatchObject({ branch: 'dayton', totals: { visits: 4 }, noOneHome: [{ rate: 0.0, count: 0, visits: 4 }], calls: [{ calls: 0, perDay: 0 }] });
    expect(dayton1.data.choices.technicians.length).toBeGreaterThan(0);
    expect(dayton1.data.choices.technicians.map((x) => x.id)).not.toContain(techA.id);
    const one = await read(`?branch=columbus&technicianId=${techB.id}&fromWeek=2026-07-06&toWeek=2026-07-06`);
    expect(one.data.technicianId).toBe(techB.id);
    expect(one.data.totals.visits).toBe(15);
    expect(one.data.calls).toEqual([{ week: '2026-07-06', calls: 6, perDay: 1 }]);
    expect(one.data.technicians.map((x) => x.name)).toEqual([techB.name]);
    expect(one.data.choices.technicians.map((x) => x.name)).toContain(techA.name);
    expect(one.data.weeks).toEqual(['2026-07-06']);
    const none = await read('?branch=springfield&fromWeek=2026-07-06&toWeek=2026-07-06');
    expect(none.data.totals.visits).toBe(0);
    expect(none.data.technicians).toEqual([]);
  });

  // why: FR-REP-2 calls per week are the pilot_call rows of that week, and FR-REP-8 the per-day figure is the week's calls over the days that had a visit (typed: 15 calls over 5 days is 3)
  it('counts the calls of the week and divides them by the days that had a visit', async () => {
    const r = await read('?branch=columbus&fromWeek=2026-06-29&toWeek=2026-07-20');
    expect(r.data.calls).toEqual([
      { week: '2026-06-29', calls: 1, perDay: null },
      { week: '2026-07-06', calls: 15, perDay: 3 },
      { week: '2026-07-13', calls: 2, perDay: 0 },
      { week: '2026-07-20', calls: 0, perDay: null },
    ]);
    expect(r.data.headline.calls).toMatchObject({ count: 0, perDay: null });
  });

  // why: FR-REP-8 late texts sent are the late-kind texts delivered that week: not a retrying one, another kind or another week
  it('counts the late texts delivered in the week', async () => {
    const r = await read('?branch=columbus&fromWeek=2026-07-06&toWeek=2026-07-20');
    expect(r.data.lateTexts).toEqual([{ week: '2026-07-06', count: 0 }, { week: '2026-07-13', count: 3 }, { week: '2026-07-20', count: 1 }]);
    expect(r.data.headline.lateTexts).toBe(1);
  });

  // why: FR-REP-2 and SC-02 a live No one home visit of Sep 15 raises its week's count by 1 and SC-02's population holds the live finished visits (typed: 10 pilot, 1 live No one home and 2 live finished visits are 13, and 1 of 13 is 7.7%); neither counts anywhere else; the live ones of Sep 14 do not count
  it('counts a live No one home visit of Sep 15 for no one home only, over the live finished visits too', async () => {
    const r = await read('?branch=columbus&fromWeek=2026-09-14&toWeek=2026-09-14');
    expect(r.data.noOneHome).toEqual([{ week: '2026-09-14', rate: 7.7, count: 1, visits: 13 }]);
    expect(r.data.onTime).toEqual([{ branch: 'columbus', points: [{ week: '2026-09-14', rate: 100.0, onTime: 10, visits: 10 }] }]);
    // 4 calls over the 1 day with a pilot visit: the live visits of Sep 15 would make it 2 days
    expect(r.data.calls).toEqual([{ week: '2026-09-14', calls: 4, perDay: 4 }]);
  });

  // why: SC-02 FR-REP-1 FR-REP-7 FR-REP-3 a live finished visit is in the no-one-home denominator and in nothing else: not the visits the page lists (typed: the 10 pilot visits and the live No one home), not the by-technician table (no late minutes, no row for a technician with only live finished visits)
  it('leaves a live finished visit out of the listed visits and the technician table', async () => {
    const r = await read('?branch=columbus&fromWeek=2026-09-14&toWeek=2026-09-14');
    expect(r.data.totals.visits).toBe(11);
    expect(r.data.technicians).toEqual([{ technicianId: techA.id, name: techA.name, visits: 10, onTimeRate: 100.0, averageMinutesLate: null, noOneHome: 1, calls: 4 }]);
    // technician C has only a live finished visit that week: the denominator holds it, and no row or Empty-breaking visit does
    const c = await read(`?branch=columbus&technicianId=${techC.id}&fromWeek=2026-09-14&toWeek=2026-09-14`);
    expect(c.data.noOneHome).toEqual([{ week: '2026-09-14', rate: 0.0, count: 0, visits: 1 }]);
    expect(c.data.totals.visits).toBe(0);
    expect(c.data.technicians).toEqual([]);
    // a week with only a live finished visit
    const only = await read('?branch=columbus&fromWeek=2026-09-21&toWeek=2026-09-21');
    expect(only.data.noOneHome).toEqual([{ week: '2026-09-21', rate: 0.0, count: 0, visits: 1 }]);
    expect(only.data.onTime).toEqual([{ branch: 'columbus', points: [{ week: '2026-09-21', rate: null, onTime: 0, visits: 0 }] }]);
    expect(only.data.calls).toEqual([{ week: '2026-09-21', calls: 0, perDay: null }]);
    expect(only.data.totals.visits).toBe(0);
    expect(only.data.technicians).toEqual([]);
  });

  // why: FR-REP-7 per technician: visits, on-time rate, mean minutes late over the late visits only (1 decimal), no-one-home visits and the calls about their visits, highest on-time rate first
  it('gives the by-technician table sorted by on-time rate with typed values', async () => {
    const r = await read('?branch=columbus&fromWeek=2026-07-06&toWeek=2026-07-06');
    expect(r.data.technicians).toEqual([
      { technicianId: techA.id, name: techA.name, visits: 25, onTimeRate: 91.7, averageMinutesLate: 30.0, noOneHome: 1, calls: 9 },
      { technicianId: techB.id, name: techB.name, visits: 15, onTimeRate: 78.6, averageMinutesLate: 20.0, noOneHome: 1, calls: 6 },
    ]);
    const all = await read('?fromWeek=2026-07-06&toWeek=2026-07-06');
    expect(all.data.technicians.map((x) => [x.name, x.visits, x.onTimeRate])).toEqual([[techA.name, 25, 91.7], [techB.name, 15, 78.6], ['Old Tech', 4, 75.0]]);
    expect(all.data.technicians.find((x) => x.name === 'Old Tech')).toMatchObject({ technicianId: null, calls: 0, averageMinutesLate: 5.0 });
  });

  // why: F-1157 FR-REP-5 with no range given the report ends at the last whole pilot week (Sep 7), never the 1-day week of Sep 14, which stays a choice; the headline reads a whole week
  it('defaults the range to Jun 1 to the last whole pilot week', async () => {
    const r = await read('?branch=columbus');
    expect(r.data.fromWeek).toBe('2026-06-01');
    expect(r.data.toWeek).toBe('2026-09-07');
    expect(r.data.weeks.at(-1)).toBe('2026-09-07');
    expect(r.data.choices.weeks.at(-1)).toBe('2026-09-14');
    // a from week after Sep 7 pulls the default to itself
    const late = await read('?branch=columbus&fromWeek=2026-09-14');
    expect(late.data.toWeek).toBe('2026-09-14');
  });

  // why: FR-REP-6 the goals 90% and 3% come with label keys; FR-REP-4 the label is on the response; the periods are SD-25's
  it('answers the goals, the periods and the Simulated pilot data label', async () => {
    const r = await read('?branch=columbus&toWeek=2026-09-14');
    expect(r.meta.labels).toContain('simulated_pilot_data');
    expect(r.data.labelKey).toBe('simulated_pilot_data');
    expect(r.data.goals).toEqual({ onTime: { rate: 90, labelKey: 'reports.goal.onTime' }, noOneHome: { rate: 3, labelKey: 'reports.goal.noOneHome' } });
    expect(r.data.fromWeek).toBe('2026-06-01');
    expect(r.data.toWeek).toBe('2026-09-14');
    expect(r.data.weeks).toHaveLength(16);
    expect(r.data.choices.weeks).toEqual(r.data.weeks);
  });

  // why: FR-REP-1 and FR-REP-2 the before and after period figures are over the range's weeks of that period (typed: the fixture's before weeks, no after week with visits but Sep 14)
  it('gives the headline figures for the before and the after period', async () => {
    const r = await read('?branch=columbus&toWeek=2026-09-14');
    // before weeks Jun 1 to Jul 13 hold the Jul 6 and Jul 13 visits: arrived 38 + 40, on time 33 + 37 = 70 of 78
    expect(r.data.headline.onTime).toEqual({ rate: 100.0, before: 89.7, after: 100.0 });
    // calls per week averaged over the 7 before weeks: (1 + 15 + 2) / 7 = 2.57; the 9 after weeks hold 4 calls: 0.44
    // F-742: after = 36 calls over the 8 whole weeks (Jul 20 to Sep 7) = 4.5, rounded 5; the Sep 14 part week (4 calls) is left out and not divided by
    expect(r.data.headline.calls).toMatchObject({ before: 3, after: 5 });
    // no one home before: 2 of 80 visits; after: 1 of 13 (SC-02: the live finished visits are in it)
    expect(r.data.headline.noOneHome).toMatchObject({ rate: 7.7, count: 1, visits: 13, before: 2.5, after: 7.7 });
  });

  // why: FR-REP-5 a week range that ends before it starts, a day that is not a Monday and an unknown branch are refused
  it('refuses an inverted range, a non-Monday week and an unknown branch', async () => {
    expect((await api.get('/reports?fromWeek=2026-07-13&toWeek=2026-07-06', dana)).status).toBe(422);
    expect((await api.get('/reports?fromWeek=2026-07-07', dana)).status).toBe(422);
    expect((await api.get('/reports?branch=nowhere', dana)).status).toBe(404);
  });

  // why: F-740 a Monday that Feb 30 rolls to answered 500, and a week far past the pilot answered 200 with 416,042 choices
  it('refuses a day the calendar lacks and a week far past the pilot', async () => {
    expect((await api.get('/reports?fromWeek=2026-02-30', dana)).status).toBe(422);
    expect((await api.get('/reports?toWeek=2026-02-30', dana)).status).toBe(422);
    expect((await api.get('/reports?fromWeek=9999-12-27', dana)).status).toBe(422);
    expect((await api.get('/reports?fromWeek=2026-07-06&toWeek=9999-12-27', dana)).status).toBe(422);
    expect((await api.get('/reports/export?fromWeek=2026-02-30', dana)).status).toBe(422);
  });

  // why: FR-REP-1 managers only: an office dispatcher is refused, a signed-out caller is not let in
  it('is for managers only', async () => {
    expect((await api.get('/reports', keisha)).status).toBe(403);
    const anon = await world.kernel.router.handle(new Request('http://web:3000/api/v1/reports', { headers: { origin: 'http://localhost:8080' } }), { address: '203.0.113.9' });
    expect(anon.status).toBe(401);
  });
});

/**
 * Independent query (SC-01, SC-02, SC-03): the figures of the whole range from the raw tables, not the report_visit view and not the report
 * code's weeks: a week is date_trunc('week', date). Every report number must equal it.
 */
describe('every report number equals an independent SQL query on the rows (SC-01, SC-02, SC-03)', () => {
  const rows = async <T>(sql: string, params: unknown[] = []) => (await admin().query<T>(sql, params)).rows;
  const PILOT = `SELECT c.branch_id, pv.date, pv.technician_id, pv.technician_name, pv.arrived_at, pv.window_end, pv.outcome, false AS live
                   FROM world.past_visit pv JOIN world.customer c ON c.id = pv.customer_id WHERE pv.date BETWEEN '2026-06-01' AND '2026-08-30'
                 UNION ALL
                 SELECT j.branch_id, j.date, j.technician_id, t.name, j.arrived_at, j.window_end, j.status, false
                   FROM world.job j LEFT JOIN world.technician t ON t.id = j.technician_id WHERE j.pilot AND j.status IN ('done', 'no_one_home')`;
  const liveJobs = (status: string) => `SELECT j.branch_id, j.date, j.technician_id, t.name, j.arrived_at, j.window_end, j.status, true
                   FROM world.job j LEFT JOIN world.technician t ON t.id = j.technician_id WHERE NOT j.pilot AND j.status = '${status}' AND j.date >= '2026-09-15'`;
  /** The visits the page lists. */
  const VISITS = `(${PILOT} UNION ALL ${liveJobs('no_one_home')}) v`;
  /** SC-02's Population, from its own words: the completed visits of the pilot data, together with the live visits that were finished or recorded as No one home. */
  const SC02 = `(${PILOT} UNION ALL ${liveJobs('done')} UNION ALL ${liveJobs('no_one_home')}) v`;
  const WEEK = `to_char(date_trunc('week', date::timestamp), 'YYYY-MM-DD')`;

  // why: SC-01 and SC-03 the on-time figures of every week and branch equal the independent query
  it('on time per week and branch', async () => {
    const r = await read();
    const q = await rows<{ wk: string; branch_id: string; arrived: string; ontime: string }>(
      `SELECT ${WEEK} AS wk, branch_id, count(*) AS arrived, count(*) FILTER (WHERE arrived_at <= window_end) AS ontime
         FROM ${VISITS} WHERE arrived_at IS NOT NULL AND NOT live GROUP BY 1, 2`);
    expect(q.length).toBeGreaterThan(0);
    for (const line of r.data.onTime) {
      for (const p of line.points) {
        const e = q.find((x) => x.wk === p.week && x.branch_id === line.branch);
        expect([p.visits, p.onTime]).toEqual([Number(e?.arrived ?? 0), Number(e?.ontime ?? 0)]);
        expect(p.rate).toBe(e ? Number((await rows<{ r: string }>('SELECT round(100.0 * $1::numeric / $2::numeric, 1) AS r', [e.ontime, e.arrived]))[0]?.r) : null);
      }
    }
  });

  // why: SC-02 the no-one-home counts, visits and rates of every week equal the independent query over SC-02's population, live finished and live No one home visits of Sep 15 included
  it('no one home per week', async () => {
    const r = await read('?toWeek=2026-09-14');
    const q = await rows<{ wk: string; visits: string; noh: string }>(
      `SELECT ${WEEK} AS wk, count(*) AS visits, count(*) FILTER (WHERE outcome = 'no_one_home') AS noh FROM ${SC02} GROUP BY 1`);
    for (const w of r.data.noOneHome) {
      const e = q.find((x) => x.wk === w.week);
      expect([w.visits, w.count]).toEqual([Number(e?.visits ?? 0), Number(e?.noh ?? 0)]);
      expect(w.rate).toBe(e ? Number((await rows<{ r: string }>('SELECT round(100.0 * $1::numeric / $2::numeric, 1) AS r', [e.noh, e.visits]))[0]?.r) : null);
    }
    expect(q.reduce((s, x) => s + Number(x.noh), 0)).toBe(r.data.noOneHome.reduce((s, x) => s + x.count, 0));
  });

  // why: SC-01 the calls per week, the late texts per week and the per-technician table equal the independent query
  it('calls, late texts and the technician table', async () => {
    const r = await read('?toWeek=2026-09-14');
    const calls = await rows<{ wk: string; n: string }>(`SELECT to_char(date_trunc('week', (at AT TIME ZONE 'America/New_York')), 'YYYY-MM-DD') AS wk, count(*) AS n FROM world.pilot_call GROUP BY 1`);
    for (const c of r.data.calls) expect(c.calls).toBe(Number(calls.find((x) => x.wk === c.week)?.n ?? 0));
    const late = await rows<{ wk: string; n: string }>(
      `SELECT to_char(date_trunc('week', (delivered_at AT TIME ZONE 'America/New_York')), 'YYYY-MM-DD') AS wk, count(*) AS n FROM world.outbox_text WHERE kind = 'late' AND status = 'delivered' GROUP BY 1`);
    for (const l of r.data.lateTexts) expect(l.count).toBe(Number(late.find((x) => x.wk === l.week)?.n ?? 0));
    const tech = await rows<{ name: string; visits: string; arrived: string; ontime: string; late_avg: string | null; noh: string }>(
      `SELECT technician_name AS name, count(*) FILTER (WHERE NOT live) AS visits, count(*) FILTER (WHERE arrived_at IS NOT NULL AND NOT live) AS arrived,
              count(*) FILTER (WHERE arrived_at <= window_end AND NOT live) AS ontime,
              round(avg(extract(epoch FROM arrived_at - window_end) / 60) FILTER (WHERE arrived_at > window_end AND NOT live), 1) AS late_avg,
              count(*) FILTER (WHERE outcome = 'no_one_home') AS noh
         FROM ${VISITS} WHERE technician_name IS NOT NULL GROUP BY technician_name`);
    expect(r.data.technicians).toHaveLength(tech.length);
    for (const t of r.data.technicians) {
      const e = tech.find((x) => x.name === t.name);
      expect([t.visits, t.noOneHome]).toEqual([Number(e?.visits), Number(e?.noh)]);
      expect(t.averageMinutesLate).toBe(e?.late_avg == null ? null : Number(e.late_avg));
      const rate = (await rows<{ r: string | null }>('SELECT round(100.0 * $1::numeric / nullif($2::numeric, 0), 1) AS r', [e?.ontime, e?.arrived]))[0]?.r;
      expect(t.onTimeRate).toBe(rate == null ? null : Number(rate));
    }
  });
});

describe('the report export (API-51)', () => {
  const csv = async (query: string, who: Staff = dana) => {
    const r = await api.get(`/reports/export${query}`, who);
    // Buffer keeps the byte-order mark that Response.text() drops.
    return { status: r.status, text: Buffer.from(await r.arrayBuffer()).toString('utf8'), disposition: r.headers.get('content-disposition') ?? '', type: r.headers.get('content-type') ?? '' };
  };

  // why: FR-REP-3 and FR-REP-4 the file has the label as its first column on every row, the 6 columns of SD-31, a byte-order mark, CRLF line ends and one row per visit of the screen
  it('streams one row per visit with the Data source column, from the same rows as the page', async () => {
    const f = await csv('?branch=columbus&fromWeek=2026-07-06&toWeek=2026-07-06');
    expect(f.status).toBe(200);
    expect(f.type).toContain('text/csv');
    expect(f.disposition).toContain('reports-columbus-2026-09-15.csv');
    expect(f.text.startsWith('﻿')).toBe(true);
    const lines = f.text.slice(1).split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines[0]).toBe('Data source,Branch,Technician,Week,Booked window,Actual arrival');
    expect(lines).toHaveLength(1 + 40);
    expect(lines.slice(1).every((l) => l.startsWith('Simulated pilot data,Columbus,'))).toBe(true);
    // the screen's 40 visits and 2 no-one-home: the 2 rows with no arrival end in an empty cell
    expect(lines.slice(1).filter((l) => l.endsWith(','))).toHaveLength(2);
    expect(lines).toContain(`Simulated pilot data,Columbus,${techA.name},2026-07-06,2026-07-06 08:00 - 10:00,`);
    const page = await read('?branch=columbus&fromWeek=2026-07-06&toWeek=2026-07-06');
    expect(lines.length - 1).toBe(page.data.totals.visits);
  });

  // why: FR-REP-3 and SC-02 the file holds the visits the page lists: the live No one home visit (arrival 09:00) and the 10 pilot visits, never the live finished visits (arrival 11:00)
  it('leaves a live finished visit out of the file', async () => {
    const lines = (await csv('?branch=columbus&fromWeek=2026-09-14&toWeek=2026-09-14')).text.slice(1).split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(1 + 11);
    expect(lines.filter((l) => l.includes('2026-09-15 11:00'))).toEqual([]);
    expect(lines.filter((l) => l.endsWith('2026-09-15 09:00'))).toHaveLength(1);
    const only = (await csv('?branch=columbus&fromWeek=2026-09-21&toWeek=2026-09-21')).text.slice(1).split('\r\n');
    expect(only).toEqual(['Data source,Branch,Technician,Week,Booked window,Actual arrival', '']);
  });

  // why: FR-REP-3 and FR-LANG-3 the header row and the Data source cell are in the page's language
  it('writes the header and the label in Spanish', async () => {
    const f = await csv('?branch=dayton&fromWeek=2026-07-06&toWeek=2026-07-06&language=es');
    const lines = f.text.slice(1).split('\r\n');
    expect(lines[0]).toBe('Origen de los datos,Sucursal,Técnico,Semana,Ventana reservada,Llegada real');
    expect(lines[1]?.startsWith('Datos simulados del piloto,Dayton,Old Tech,2026-07-06,')).toBe(true);
  });

  // why: FR-REP-3 managers only; an inverted range is refused as for the page
  it('is for managers only and refuses an inverted range', async () => {
    expect((await csv('', keisha)).status).toBe(403);
    expect((await csv('?fromWeek=2026-07-13&toWeek=2026-07-06')).status).toBe(422);
  });
});
