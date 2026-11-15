// SPDX-License-Identifier: AGPL-3.0-or-later
// D-3 step 5, the world seed: after the real import has written every customer and past visit, write the pilot jobs
// (Mon, Aug 31 to Mon, Sep 14, 2026, with their outcomes; SD-25, OI-59), the demo-week jobs, the sample block, the
// memberships, the sample day's autopilot steps (SD-21) and the first sweep and alert-check events, the SD-30 alert
// switches (1 alert_setting row per type; section 3 gives both to the seed, never the worker: F-444), and LAST the
// simulated pilot_call rows, once the past visits and pilot jobs they point at exist (OI-57).
//
// Customers are found by the import's exact-match key that customer already stores: name_search (the folded name),
// street_id and house_number (R-BP1). Every lookup must return exactly 1 active row, else setup stops with a named error
// (customer_not_found, customer_not_unique, customer_merged) before any row of this step is written; the caller runs
// this step and the snapshot in 1 transaction, so a stop leaves no world-seed row and no snapshot.
//
// It also seeds Marco P. as an office user (F-272, manager ruling 2026-11-01): the approved billing, jobs and customer
// search pages name him as an actor in customer history, which the reference seed must not write.
import { foldStreetName, hashPassword, legTrackSeconds, samplePassword, type LegWanted, type Queryable } from '@bw/db';
import { alertSettingDefaults, isLateEnoughToText, planDay, trackedDriveMinutes } from '@bw/domain';
import { arrivalLabel, catalogTexts, planReminder, renderTemplate, type TextLanguage } from '@bw/outbox';
import { atLocal, Temporal } from '@bw/time';
import { partCodeForLine } from '../../db/src/seed/reference-data.ts';
import { catalogs } from '../../i18n/src/catalog.ts';
import { SetupError } from './errors.ts';
import type { FixtureJob, WorldFixture } from './fixture.ts';
import { pastJobVersion, planPastJob, writePastJobs, type PastJob, type PbsHistory } from './past-jobs.ts';
import { sampleDay, type SampleDayJob } from './sample-day.ts';

/** F-272: the office user the approved pages' customer history names ("Marco P."), seeded with the sample world. */
export const MARCO = { name: 'Marco P.', email: 'marco.p@brightwater.example', role: 'office', branch: 'columbus', title: 'Customer service', language: 'en' } as const;

/** F-1132, F-1151: how many delivered late texts the seed plants in each whole pilot week of the after period (the reports frame's Late texts sent figure, 74). */
const LATE_TEXTS = 74;

/**
 * F-293 (owner ruling b23b26d9 "Match the page"): the office people the approved pages name, all seeded users (Keisha and Dana by
 * the reference seed, Marco above). An office job's booked_by is one of the first 2, by job number (even Marco, odd Keisha), so
 * 2 setups write the same rows; the approved Jobs page (office-jobs.html, DK-88) shows 24800 as Office - Marco P. and 24805 as
 * Office - Keisha T., which the rule gives, and the pins below keep so; F-555: it also shows 24791 and 24840 as Office - Keisha T.
 * (24840 is even, so the rule alone gives Marco).
 */
export const KEISHA_EMAIL = 'keisha.t@brightwater.example';
export const DANA_EMAIL = 'dana.ruiz@brightwater.example';
export const BOOKER_PINS: Readonly<Record<number, string>> = { 24_800: MARCO.email, 24_805: KEISHA_EMAIL, 24_791: KEISHA_EMAIL, 24_840: KEISHA_EMAIL };
export const bookerEmail = (jobNumber: number): string => BOOKER_PINS[jobNumber] ?? (jobNumber % 2 === 0 ? MARCO.email : KEISHA_EMAIL);

/**
 * The job history the approved pages name a person in (mockups/pages/office-billing.html, the Fixed in the last 7 days table):
 * Sent again by Marco P. (24671), Corrected and sent again by Keisha T. (24755), Entered in billing by hand, Dana R. (24688).
 * Each is a job_change row of the pilot job with that number, written on the day the job ended; a correction takes the job to
 * version 2 as API-62 does. F-554: each also has the billing record the page reads, as the live writers leave it: try 1 at the finish
 * refused by billing with `refused` (the frame's Reason), then the person's step an hour later (BILLING_RECORD below).
 */
export const BILLING_HISTORY: readonly {
  jobNumber: number; kind: 'sent_again' | 'finish_corrected' | 'marked_fixed'; by: string; data: Record<string, unknown>; refused: string;
}[] = [
  { jobNumber: 24_671, kind: 'sent_again', by: MARCO.email, data: {}, refused: 'Refused customer account' },
  { jobNumber: 24_755, kind: 'finish_corrected', by: KEISHA_EMAIL, data: {}, refused: 'Refused part code' },
  { jobNumber: 24_688, kind: 'marked_fixed', by: DANA_EMAIL, data: { reason: 'Entered in billing by hand' }, refused: 'Account closed' },
];

/**
 * What each history kind leaves on the job's billing record (F-554; SPECIFICATIONS section 6.6): Send again and a correction send it again
 * and billing stores it on try 2 (in_billing, left_how sent_again or corrected: apps/worker/src/billing/queue.ts requeueByPerson, then
 * link.ts record); Mark fixed takes it off the list with the person and the reason, after its 1 refused try (fixed.ts leaveList).
 */
export const BILLING_RECORD: Readonly<Record<(typeof BILLING_HISTORY)[number]['kind'], { state: 'in_billing' | 'marked_fixed'; leftHow: 'sent_again' | 'corrected' | 'marked_fixed'; tries: 1 | 2 }>> = {
  sent_again: { state: 'in_billing', leftHow: 'sent_again', tries: 2 },
  finish_corrected: { state: 'in_billing', leftHow: 'corrected', tries: 2 },
  marked_fixed: { state: 'marked_fixed', leftHow: 'marked_fixed', tries: 1 },
};

/** The office note on Sean O'Brien's customer page (mockups/pages/office-customer-search.html): "Office note - Marco P., Mar 2, 2026". */
export const OFFICE_NOTE = { customer: "Sean O'Brien", houseNumber: 287, date: '2026-03-02', time: '10:00', body: 'Dog in the back yard; call before going to the outdoor unit.' } as const;

/**
 * Harold Jenkins's 2 notes as DK-87 Success draws them (mockups/pages/office-job.html): job notes on his Sep 15 job, as that frame shows
 * them on the job page; the customer page reads a customer's job notes too. FR-DISP-5's "and his notes". The frame gives dates only.
 */
export const HAROLD_NOTES = [
  { jobNumber: 24_830, author: 'Keisha Thompson', kind: 'office', date: '2026-09-10', time: '09:00', body: 'Please use the side door. The front steps are being repaired. Knock firmly; the doorbell does not work.' },
  { jobNumber: 24_830, author: 'Maria Santos', kind: 'technician', date: '2025-10-14', time: '11:00', body: 'Bring a 16x25x4 filter. Flame sensor was dirty last year; check it again.' },
] as const;

/**
 * The sample day's seeded parts pickup block (FR-DISP-16: labeled "Pickup" and "Supply house"), placed as the approved
 * board frame places it: on Jamal Carter's row (40702), Tue, Sep 15, 7:10 to 7:55 AM.
 */
export const SAMPLE_BLOCK = { technician: '40702', date: '2026-09-15', start: '07:10', end: '07:55', label: 'Pickup', place: 'Supply house' } as const;

/** The first eta.sweep and alert.check events (SPECIFICATIONS section 3 enum table: the seed writes the first). */
export const FIRST_SWEEP_AT = { date: '2026-09-15', time: '07:00' } as const;

export interface WorldSeedOptions {
  fixture: WorldFixture;
  /** SAMPLE_PASSWORD_SEED (SD-9), for Marco P.'s sample password. */
  sampleSeed: string;
}

export interface WorldSeedResult {
  pilotJobs: number;
  demoWeekJobs: number;
  memberships: number;
  autopilotSteps: number;
  pilotCalls: number;
}

type Col = readonly [name: string, type: string];

/** Insert rows with 1 statement per 2,000 rows (unnest of 1 array per column), as the import's writer does (C13). */
async function insertMany(tx: Queryable, table: string, cols: readonly Col[], rows: readonly unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    const names = cols.map(([n]) => `"${n}"`).join(', ');
    const params = cols.map(([, t], k) => `$${k + 1}::${t}[]`).join(', ');
    await tx.query(`INSERT INTO ${table} (${names}) SELECT * FROM unnest(${params})`, cols.map((_, k) => chunk.map((r) => r[k])));
  }
}

const sample = <T>(xs: readonly T[], n: number): string => xs.slice(0, n).map(String).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '');

export async function seedWorld(tx: Queryable, opts: WorldSeedOptions): Promise<WorldSeedResult> {
  const fx = opts.fixture;
  const zone = fx.zone;
  const at = (date: string, time: string): Date => new Date(atLocal(date, time, zone, 'reject').epochMilliseconds);
  const plus = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * 60_000);

  // 1. Each fixture customer by its exact-match key, in 1 query; exactly 1 active row each (R-BP1).
  const keys = fx.customers;
  const found = await tx.query<{ ref: string; n: number; id: string | null; branch_id: string | null; merged: boolean; lon: number; lat: number }>(
    `SELECT f.ref, count(c.id)::int AS n, min(c.id::text) AS id, min(c.branch_id) AS branch_id, min(c.lon) AS lon, min(c.lat) AS lat,
            coalesce(bool_or(c.status <> 'active' OR c.merged_into IS NOT NULL), false) AS merged
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[]) AS f(ref, name_search, street, city, zip, house)
       LEFT JOIN world.street s ON s.name = f.street AND s.city = f.city AND s.zip = f.zip
       LEFT JOIN world.customer c ON c.name_search = f.name_search AND c.street_id = s.id AND c.house_number = f.house
      GROUP BY f.ref`,
    [keys.map((c) => c.ref), keys.map((c) => foldStreetName(c.name)), keys.map((c) => c.street), keys.map((c) => c.city),
      keys.map((c) => c.zip), keys.map((c) => c.houseNumber)]);
  const none = found.rows.filter((r) => r.n === 0).map((r) => r.ref).sort();
  const many = found.rows.filter((r) => r.n > 1).map((r) => `${r.ref} (${r.n} rows)`).sort();
  const merged = found.rows.filter((r) => r.n === 1 && r.merged).map((r) => r.ref).sort();
  if (none.length > 0) throw new SetupError('customer_not_found', `${none.length} fixture customer(s): ${sample(none, 5)}`);
  if (many.length > 0) throw new SetupError('customer_not_unique', `${many.length} fixture customer(s): ${sample(many, 5)}`);
  if (merged.length > 0) throw new SetupError('customer_merged', `${merged.length} fixture customer(s): ${sample(merged, 5)}`);
  const customer = new Map(found.rows.map((r) => [r.ref, { id: r.id as string, branch: r.branch_id as string, point: { lon: r.lon, lat: r.lat } }]));

  // 2. The reference rows the fixture names: technicians by employee number, services, the 2-hour windows.
  const techRows = await tx.query<{ employee_number: string; id: string; branch_id: string; shift_start: string }>(
    `SELECT u.employee_number, t.id, t.branch_id, t.shift_start::text AS shift_start FROM world.technician t JOIN world."user" u ON u.id = t.user_id WHERE u.employee_number IS NOT NULL`);
  const tech = new Map(techRows.rows.map((t) => [t.employee_number, { id: t.id, branch: t.branch_id, shiftStart: t.shift_start.slice(0, 5) }]));
  const svcRows = await tx.query<{ id: string; expected_minutes: number }>('SELECT id, expected_minutes FROM world.service_type');
  const minutes = new Map(svcRows.rows.map((s) => [s.id, s.expected_minutes]));
  const winRows = await tx.query<{ id: string; branch_id: string; mode: string; start: string }>(
    `SELECT id, branch_id, mode, to_char(start_local, 'HH24:MI') AS start FROM world.arrival_window WHERE mode IN ('two_hour', 'four_hour')`);
  const windowId = new Map(winRows.rows.map((w) => [`${w.branch_id}|${w.mode}|${w.start}`, w.id]));
  // A job's window by its length: 2 hours, or 4 for a story job the page tells so (24871, F-318).
  const mins = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const windowKey = (branch: string, j: FixtureJob): string => `${branch}|${mins(j.windowEnd) - mins(j.windowStart) === 240 ? 'four_hour' : 'two_hour'}|${j.windowStart}`;
  // An Unassigned job (F-292) is its customer's branch's; every other job is its technician's.
  const branchOf = (j: FixtureJob): string => (j.technician === null ? (customer.get(j.customer)?.branch as string) : (tech.get(j.technician)?.branch as string));

  const missing: string[] = [];
  const jobs = [...fx.pilotJobs.map((j) => ({ j, pilot: true })), ...fx.demoWeekJobs.map((j) => ({ j, pilot: false }))];
  for (const { j } of jobs) {
    const t = j.technician === null ? { branch: customer.get(j.customer)?.branch as string } : tech.get(j.technician);
    if (!t) missing.push(`job ${j.jobNumber}: technician ${j.technician}`);
    else if (!windowId.has(windowKey(t.branch, j))) missing.push(`job ${j.jobNumber}: window ${t.branch} ${j.windowStart}-${j.windowEnd}`);
    else if (customer.get(j.customer)?.branch !== t.branch) missing.push(`job ${j.jobNumber}: customer ${j.customer} is not in branch ${t.branch}`);
    if (!minutes.has(j.service)) missing.push(`job ${j.jobNumber}: service ${j.service}`);
  }
  if (!tech.has(SAMPLE_BLOCK.technician)) missing.push(`the sample block: technician ${SAMPLE_BLOCK.technician}`);
  if (missing.length > 0) throw new SetupError('reference_missing', `${missing.length} row(s): ${sample(missing, 5)}`);

  // 3. Marco P., an office staff user (F-272), with his sample password (SD-9).
  await tx.query(
    `INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, title, sample, reviewer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, true, false) ON CONFLICT (email) DO NOTHING`,
    [MARCO.email, MARCO.name, foldStreetName(MARCO.name), await hashPassword(samplePassword(opts.sampleSeed, MARCO.email)),
      MARCO.role, MARCO.branch, MARCO.language, MARCO.title]);

  // F-293: the seeded office people the jobs and history name, by email.
  const staffEmails = [MARCO.email, KEISHA_EMAIL, DANA_EMAIL];
  const staff = new Map((await tx.query<{ id: string; email: string }>(
    `SELECT id, email::text AS email FROM world."user" WHERE email = ANY($1::citext[])`, [staffEmails])).rows.map((u) => [u.email, u.id]));
  const staffMissing = staffEmails.filter((e) => !staff.has(e));
  if (staffMissing.length > 0) throw new SetupError('reference_missing', `${staffMissing.length} office user(s): ${sample(staffMissing, 5)}`);
  const userId = (email: string): string => staff.get(email) as string;
  const badVia = jobs.filter(({ j }) => j.bookedVia !== 'online' && j.bookedVia !== 'office').map(({ j }) => `job ${j.jobNumber}: bookedVia ${j.bookedVia}`);
  if (badVia.length > 0) throw new SetupError('fixture_invalid', `${badVia.length} job(s): ${sample(badVia, 5)}`);
  const byNumberAll = new Map(jobs.map((x) => [x.j.jobNumber, x]));
  const history = BILLING_HISTORY.map((h) => {
    const x = byNumberAll.get(h.jobNumber);
    if (!x || !x.pilot || x.j.status !== 'done' || x.j.endedAt === null) return `job ${h.jobNumber}: not a done pilot job`;
    return null;
  }).filter((m): m is string => m !== null);
  if (history.length > 0) throw new SetupError('reference_missing', `${history.length} history job(s): ${sample(history, 5)}`);
  const corrected = new Set(BILLING_HISTORY.filter((h) => h.kind === 'finish_corrected').map((h) => h.jobNumber));
  const billingState = new Map(BILLING_HISTORY.map((h) => [h.jobNumber, BILLING_RECORD[h.kind].state]));
  const noteCustomer = fx.customers.find((c) => c.name === OFFICE_NOTE.customer && c.houseNumber === OFFICE_NOTE.houseNumber);
  if (!noteCustomer) throw new SetupError('customer_not_found', `the office note customer ${OFFICE_NOTE.customer}`);

  // The demo week's days (SD-15, SD-21; owner answer 36d87aec "Chain each visit"): each technician-day's planned arrivals are the
  // ones its first office write would compute, and each scripted visit starts after the previous one ends. The baked tracks are
  // loaded already (pipeline step 5), so the drive minutes are the planner's.
  const planned = new Map<number, number>();
  const steps = new Map<number, { onMyWay: number; arrived: number; ended: number }>();
  const script = new Map(fx.sampleDayScript.map((s) => [s.jobNumber, s]));
  const depots = new Map((await tx.query<{ id: string; depot_lon: number; depot_lat: number }>('SELECT id, depot_lon, depot_lat FROM world.branch')).rows
    .map((b) => [b.id, { lon: b.depot_lon, lat: b.depot_lat }]));
  const days = new Map<string, FixtureJob[]>();
  for (const j of fx.demoWeekJobs) {
    if (j.technician === null) continue; // Unassigned: no technician-day plans it
    const key = `${j.technician}|${j.date}`;
    const day = days.get(key);
    if (day) day.push(j);
    else days.set(key, [j]);
  }
  for (const list of days.values()) {
    const first = list[0] as FixtureJob;
    const t = tech.get(first.technician as string) as { branch: string; shiftStart: string };
    const numbers = list.map((j) => j.jobNumber);
    const legs: LegWanted[] = numbers.flatMap((to) => [{ from: null, to }, ...numbers.filter((from) => from !== to).map((from) => ({ from, to }))]);
    const dayJobs: SampleDayJob[] = list.map((j) => ({
      jobNumber: j.jobNumber, windowStart: at(j.date, j.windowStart).getTime(), bookedAt: at(j.bookedAt.slice(0, 10), j.bookedAt.slice(11)).getTime(),
      expectedMinutes: minutes.get(j.service) as number, point: (customer.get(j.customer) as { point: { lon: number; lat: number } }).point,
    }));
    const out = sampleDay({
      shiftStart: at(first.date, t.shiftStart).getTime(), depot: depots.get(t.branch) as { lon: number; lat: number }, jobs: dayJobs,
      drive: trackedDriveMinutes(await legTrackSeconds(tx, t.branch, legs)), script,
    });
    for (const p of out.planned) planned.set(p.jobNumber, p.plannedArrival);
    for (const v of out.steps) steps.set(v.jobNumber, v);
  }

  // 4. The jobs: pilot jobs ended with their outcomes (SD-25), demo-week jobs scheduled; booked_via and booked_by from the fixture's
  //    channel and the office person (F-293); the history entries that name office people follow.
  const scripted = new Set(fx.sampleDayScript.map((s) => s.jobNumber));
  // F-1541: a pilot job's version after its visit steps (past-jobs.ts), and a correction's 1 more (API-62).
  const finalVersion = (j: FixtureJob): number => pastJobVersion(j) + (corrected.has(j.jobNumber) ? 1 : 0);
  const jobRow = ({ j, pilot }: { j: FixtureJob; pilot: boolean }): unknown[] => {
    const t = j.technician === null ? undefined : tech.get(j.technician);
    const branch = branchOf(j);
    const start = at(j.date, j.windowStart);
    const plan = planned.get(j.jobNumber);
    return [
      j.jobNumber, customer.get(j.customer)?.id, branch, j.service, j.date, zone, windowId.get(windowKey(branch, j)),
      start, at(j.date, j.windowEnd), t?.id ?? null, j.status, pilot ? finalVersion(j) : 1, pilot || plan === undefined ? null : new Date(plan), minutes.get(j.service),
      j.arrivedAt === null ? null : at(j.date, j.arrivedAt), j.endedAt === null ? null : at(j.date, j.endedAt),
      j.bookedVia, at(j.bookedAt.slice(0, 10), j.bookedAt.slice(11)), j.bookedVia === 'office' ? userId(bookerEmail(j.jobNumber)) : null, billingState.get(j.jobNumber) ?? 'not_sent', !pilot && scripted.has(j.jobNumber), false, pilot, j.problem ?? null,
    ];
  };
  await insertMany(tx, 'world.job', [
    ['job_number', 'int'], ['customer_id', 'uuid'], ['branch_id', 'text'], ['service_id', 'text'], ['date', 'date'], ['zone', 'text'],
    ['window_id', 'uuid'], ['window_start', 'timestamptz'], ['window_end', 'timestamptz'], ['technician_id', 'uuid'], ['status', 'text'],
    ['version', 'int'], ['planned_arrival', 'timestamptz'], ['expected_minutes', 'int'], ['arrived_at', 'timestamptz'],
    ['ended_at', 'timestamptz'], ['booked_via', 'text'], ['booked_at', 'timestamptz'], ['booked_by', 'uuid'], ['billing_state', 'text'], ['autopilot', 'boolean'],
    ['touched_by_person', 'boolean'], ['pilot', 'boolean'], ['problem', 'text'],
  ], jobs.map(jobRow));
  // The next office or online job takes the number after the highest seeded one.
  await tx.query(`SELECT setval(pg_get_serial_sequence('world.job', 'job_number'), (SELECT max(job_number) FROM world.job))`);
  // Each seeded job's history starts with its created row (section 3 enum table: kind created; the actor is the office person for an
  // office job and the customer for an online one, F-293).
  await insertMany(tx, 'world.job_change', [
    ['job_number', 'int'], ['at', 'timestamptz'], ['actor_user_id', 'uuid'], ['actor_kind', 'text'], ['kind', 'text'], ['from_version', 'int'], ['to_version', 'int'], ['data', 'jsonb'],
  ], jobs.map(({ j }) => [
    j.jobNumber, at(j.bookedAt.slice(0, 10), j.bookedAt.slice(11)), j.bookedVia === 'office' ? userId(bookerEmail(j.jobNumber)) : null,
    j.bookedVia === 'office' ? 'office' : 'customer', 'created', 0, 1, JSON.stringify({ via: j.bookedVia }),
  ]));
  // The billing history the approved billing page names a person in: a row on the job's ending day, an hour after the job ended.
  await insertMany(tx, 'world.job_change', [
    ['job_number', 'int'], ['at', 'timestamptz'], ['actor_user_id', 'uuid'], ['actor_kind', 'text'], ['kind', 'text'], ['from_version', 'int'], ['to_version', 'int'], ['data', 'jsonb'],
  ], BILLING_HISTORY.map((h) => {
    const j = (byNumberAll.get(h.jobNumber) as { j: FixtureJob }).j;
    return [h.jobNumber, plus(at(j.date, j.endedAt as string), 60), userId(h.by), 'office', h.kind, pastJobVersion(j), finalVersion(j), JSON.stringify(h.data)];
  }));
  // F-554: their billing records, as the live writers leave them. Try 1 at the finish: billing refused it (422, a data error held for a
  // person). Then, an hour later, the person's step: Send again or the correction sends it, and billing stores it on try 2 (a success
  // attempt, the item in_billing with its left_at and left_how, and the system's billing_sent history row); Mark fixed takes it off the
  // list with the person and the reason (the item keeps its 1 try and its reason_key). job.billing_state was written with the job above.
  const billed = BILLING_HISTORY.map((h) => {
    const j = (byNumberAll.get(h.jobNumber) as { j: FixtureJob }).j;
    const ended = at(j.date, j.endedAt as string);
    return { h, r: BILLING_RECORD[h.kind], ended, step: plus(ended, 60), version: finalVersion(j) };
  });
  await insertMany(tx, 'world.billing_attempt', [
    ['job_number', 'int'], ['number', 'int'], ['at', 'timestamptz'], ['result', 'text'], ['http_status', 'int'], ['reason', 'text'],
  ], billed.flatMap(({ h, r, ended, step }) => [
    [h.jobNumber, 1, ended, 'data_error', 422, h.refused],
    ...(r.tries === 2 ? [[h.jobNumber, 2, step, 'success', 200, null]] : []),
  ]));
  await insertMany(tx, 'world.billing_item', [
    ['job_number', 'int'], ['state', 'text'], ['reason_key', 'text'], ['tries', 'int'], ['last_try_at', 'timestamptz'], ['next_try_at', 'timestamptz'],
    ['send_cause', 'text'], ['left_at', 'timestamptz'], ['left_how', 'text'], ['left_by', 'uuid'], ['left_reason', 'text'],
  ], billed.map(({ h, r, ended, step }) => {
    const marked = r.state === 'marked_fixed';
    return [h.jobNumber, r.state, marked ? h.refused : null, r.tries, marked ? ended : step, null, null, step, r.leftHow,
      marked ? userId(h.by) : null, marked ? (h.data.reason as string) : null];
  }));
  await insertMany(tx, 'world.job_change', [
    ['job_number', 'int'], ['at', 'timestamptz'], ['actor_user_id', 'uuid'], ['actor_kind', 'text'], ['kind', 'text'], ['from_version', 'int'], ['to_version', 'int'], ['data', 'jsonb'],
  ], billed.filter(({ r }) => r.tries === 2).map(({ h, step, version }) => [h.jobNumber, step, null, 'system', 'billing_sent', version, version, JSON.stringify({ try: 2 })]));
  // The office note on Sean O'Brien's customer page (notes are append-only; this is the 1 seeded customer note).
  const noteAt = at(OFFICE_NOTE.date, OFFICE_NOTE.time);
  await tx.query(
    `INSERT INTO world.note (customer_id, author_user_id, author_kind, body, entered_at, sent_at, entered_offline) VALUES ($1, $2, 'office', $3, $4, $4, false)`,
    [customer.get(noteCustomer.ref)?.id, userId(MARCO.email), OFFICE_NOTE.body, noteAt]);
  for (const n of HAROLD_NOTES) {
    await tx.query(
      `INSERT INTO world.note (job_number, author_user_id, author_kind, body, entered_at, sent_at, entered_offline)
       SELECT $1::int, u.id, $3::text, $4::text, $5::timestamptz, $5::timestamptz, false FROM world."user" u WHERE u.name = $2::text`,
      [n.jobNumber, n.author, n.kind, n.body, at(n.date, n.time)]);
  }

  // 5. The sample block (FR-DISP-16).
  const b = tech.get(SAMPLE_BLOCK.technician) as { id: string };
  await tx.query(
    `INSERT INTO world.time_block (technician_id, date, zone, start, "end", label, place, version, seeded) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, true)`,
    [b.id, SAMPLE_BLOCK.date, zone, at(SAMPLE_BLOCK.date, SAMPLE_BLOCK.start), at(SAMPLE_BLOCK.date, SAMPLE_BLOCK.end), SAMPLE_BLOCK.label, SAMPLE_BLOCK.place]);

  // 6. Memberships (written only here: role app holds SELECT on membership alone, FR-DISP-32).
  await insertMany(tx, 'world.membership', [['customer_id', 'uuid'], ['since', 'date'], ['renews', 'date'], ['benefits_key', 'text']],
    fx.memberships.map((m) => [customer.get(m.customer)?.id, m.since, m.renews, m.benefitsKey]));

  // 7. The sample day's autopilot steps (SD-21): On my way, Arrived, then Finished or No one home, at the chained times
  //    above. Payloads hold ids only (section 3, NFR-05). F-815: the dispatcher runs due_at, then id, and a next On my way often falls on
  //    the very minute the visit before ends, so the rows go in chain order (`steps`), whose time-ordered ids then break that tie.
  const byNumber = new Map(jobs.map(({ j }) => [j.jobNumber, j]));
  const events: unknown[][] = [];
  const scriptOf = new Map(fx.sampleDayScript.map((s) => [s.jobNumber, s]));
  for (const [jobNumber, when] of steps) {
    const s = scriptOf.get(jobNumber) as (typeof fx.sampleDayScript)[number];
    const j = byNumber.get(jobNumber) as FixtureJob;
    const t = tech.get(j.technician as string) as { id: string };
    const base = { jobNumber: j.jobNumber, technicianId: t.id };
    const parts = Array.from({ length: s.partsCount }, (_, k) => partCodeForLine(j.jobNumber, k, j.service));
    const end = s.outcome === 'finished'
      ? { ...base, step: 'finished', laborMinutes: s.workMinutes, partCodes: parts }
      : { ...base, step: 'no_one_home' };
    for (const [due, payload] of [
      [new Date(when.onMyWay), { ...base, step: 'on_my_way' }],
      [new Date(when.arrived), { ...base, step: 'arrived' }],
      [new Date(when.ended), end],
    ] as const) events.push([due, 'autopilot.step', `job:${j.jobNumber}`, JSON.stringify(payload), 'due']);
  }
  const sweep = at(FIRST_SWEEP_AT.date, FIRST_SWEEP_AT.time);
  events.push([sweep, 'eta.sweep', 'eta', '{}', 'due'], [sweep, 'alert.check', 'alerts', '{}', 'due']);
  await insertMany(tx, 'world.scheduled_event', [['due_at', 'timestamptz'], ['kind', 'text'], ['subject', 'text'], ['payload', 'jsonb'], ['state', 'text']], events);
  // F-652: the seed is a creator of scheduled visits, so it plans each one's reminder as every other creator does (SPECIFICATIONS
  // section 3, 'job created'). A seeded visit of the first day has no evening left (already_past) and plans none.
  const seedNow = Temporal.Instant.fromEpochMilliseconds(sweep.getTime());
  for (const { j } of jobs) if (j.status === 'scheduled') await planReminder(tx, { jobNumber: j.jobNumber, now: seedNow });
  // F-1132, F-1151 (SD-25, F-744): the delivered late texts of the pilot's after period, so the Late texts sent card reads stored rows
  // near the approved reports frame's 74 in each whole pilot week instead of 0 (FR-REP-8). The after period's pilot jobs run Aug 31 to
  // Sep 14 (the before period predates the app). A visit gets one only as FR-TEXT-5's sweep would send it: arrival minus the baseline
  // reached 20 minutes, the baseline being the visit's SD-15 planned arrival (a pilot visit has no texted arrival before its late text),
  // computed per technician-day on the planner's drive minutes exactly as the demo week's are. Each week takes LATE_TEXTS per whole week,
  // and a short week (Sep 14, its Monday only) the same per-day share, from its qualifying visits, latest against the plan first (then job
  // number). Each is sent 30 minutes before the van arrived (never before the window start) and written as the rows a delivered late text
  // leaves: the outbox_text row (1 try), its text_attempt and its `out` inbox_message (so Messages shows it), and the job's late-text
  // columns (section 6.4: late_text_was_arrival is the baseline). A customer with texts off, no mobile or a demo-week visit gets none (the
  // sample day's pages name those customers).
  const demoCustomers = new Set(fx.demoWeekJobs.map((j) => j.customer));
  const lateCands = fx.pilotJobs.filter((j) => j.arrivedAt !== null && !demoCustomers.has(j.customer));
  const lateCust = (await tx.query<{ id: string; texts_on: boolean; mobile: string | null; text_language: TextLanguage }>(
    `SELECT id, texts_on, mobile, text_language FROM world.customer WHERE id = ANY($1::uuid[])`,
    [[...new Set(lateCands.map((j) => (customer.get(j.customer) as { id: string }).id))]])).rows;
  const lateCustById = new Map(lateCust.map((c) => [c.id, c]));
  const techName = new Map((await tx.query<{ id: string; name_in_texts: string }>('SELECT id, name_in_texts FROM world.technician')).rows.map((t) => [t.id, t.name_in_texts]));
  const pilotPlanned = new Map<number, number>();
  const pilotDays = new Map<string, FixtureJob[]>();
  const pilotDrive = new Map<FixtureJob[], ReturnType<typeof trackedDriveMinutes>>();
  for (const j of fx.pilotJobs) {
    const key = `${j.technician}|${j.date}`;
    const day = pilotDays.get(key);
    if (day) day.push(j);
    else pilotDays.set(key, [j]);
  }
  for (const list of pilotDays.values()) {
    const first = list[0] as FixtureJob;
    const t = tech.get(first.technician as string) as { branch: string; shiftStart: string };
    const numbers = list.map((j) => j.jobNumber);
    const legs: LegWanted[] = numbers.flatMap((to) => [{ from: null, to }, ...numbers.filter((from) => from !== to).map((from) => ({ from, to }))]);
    const drive = trackedDriveMinutes(await legTrackSeconds(tx, t.branch, legs));
    pilotDrive.set(list, drive);
    const plan = planDay({
      shiftStart: at(first.date, t.shiftStart).getTime(), depot: depots.get(t.branch) as { lon: number; lat: number },
      drive,
      stops: list.map((j) => ({
        jobNumber: j.jobNumber, windowStart: at(j.date, j.windowStart).getTime(), bookedAt: at(j.bookedAt.slice(0, 10), j.bookedAt.slice(11)).getTime(),
        expectedMinutes: minutes.get(j.service) as number, point: (customer.get(j.customer) as { point: { lon: number; lat: number } }).point,
      })),
    });
    for (const p of plan) pilotPlanned.set(p.jobNumber, p.plannedArrival);
  }
  // F-1158: every pilot job keeps its SD-15 planned arrival, so a stored late-text baseline (late_text_was_arrival, written below) can be read
  // against where it came from (SPECIFICATIONS 6.4: texted_arrival, else planned_arrival). The pilot's own jobs are ended; the sweep reads none.
  for (const [jobNumber, plannedArrival] of pilotPlanned) {
    await tx.query('UPDATE world.job SET planned_arrival = $2 WHERE job_number = $1 AND pilot', [jobNumber, new Date(plannedArrival)]);
  }
  // F-1541 (owner ruling 9796c392): every ended pilot job's visit record (past-jobs.ts): its steps, its finish, its sent bill and, for
  // about 1 in 5, a note. Each technician-day's visits in the order they ran; each On my way is the planner's drive before the visit.
  const techUser = new Map((await tx.query<{ id: string; user_id: string }>('SELECT id::text AS id, user_id::text AS user_id FROM world.technician')).rows
    .map((t) => [t.id, t.user_id]));
  const members = new Set((await tx.query<{ id: string }>('SELECT DISTINCT customer_id::text AS id FROM world.membership')).rows.map((m) => m.id));
  const pastRows: Parameters<typeof writePastJobs>[1]['jobs'][number][] = [];
  for (const [list, drive] of pilotDrive) {
    const t = tech.get((list[0] as FixtureJob).technician as string) as { id: string; branch: string };
    const door = (j: FixtureJob): number => at(j.date, (j.arrivedAt ?? j.endedAt) as string).getTime();
    const ran = list.filter((j) => j.endedAt !== null && (j.status === 'done' || j.status === 'no_one_home')).sort((x, y) => door(x) - door(y) || x.jobNumber - y.jobNumber);
    let prev: { j: FixtureJob; past: PastJob } | null = null;
    for (const j of ran) {
      const c = customer.get(j.customer) as { id: string; point: { lon: number; lat: number } };
      const from = prev ? (customer.get(prev.j.customer) as { point: { lon: number; lat: number } }).point : (depots.get(t.branch) as { lon: number; lat: number });
      const past = planPastJob(j, {
        at, drive: drive(from, c.point, prev ? prev.j.jobNumber : null, j.jobNumber), prevEnd: prev ? (prev.past.steps.at(-1)?.at as Date) : null,
      });
      pastRows.push({
        j, past, customerId: c.id, technicianId: t.id, technicianUserId: techUser.get(t.id) as string, officeUserId: userId(bookerEmail(j.jobNumber)), member: members.has(c.id),
      });
      prev = { j, past };
    }
  }
  const pbsHistory = new Map<number, PbsHistory>(billed.map(({ h, step }) => [h.jobNumber, {
    jobNumber: h.jobNumber, step, how: h.kind === 'marked_fixed' ? 'marked_fixed' : 'sent_again', reason: (h.data.reason as string | undefined) ?? null, by: userId(h.by),
  }]));
  await writePastJobs(tx, { zone, jobs: pastRows.sort((x, y) => x.j.jobNumber - y.j.jobNumber), history: pbsHistory });
  const weekOf = (date: string): string => { const d = Temporal.PlainDate.from(date); return d.subtract({ days: d.dayOfWeek - 1 }).toString(); };
  const weekDays = new Map<string, Set<string>>();
  for (const j of fx.pilotJobs) weekDays.set(weekOf(j.date), (weekDays.get(weekOf(j.date)) ?? new Set<string>()).add(j.date));
  const wholeWeekDays = Math.max(...[...weekDays.values()].map((s) => s.size));
  const lateOf = (j: FixtureJob): number => at(j.date, j.arrivedAt as string).getTime() - (pilotPlanned.get(j.jobNumber) as number);
  const qualifying = lateCands.filter((j) => {
    const c = lateCustById.get((customer.get(j.customer) as { id: string }).id);
    if (c === undefined || !c.texts_on || c.mobile === null) return false;
    const texted = arrivalLabel(Temporal.Instant.fromEpochMilliseconds(at(j.date, j.arrivedAt as string).getTime()), zone, c.text_language).rounded.epochMilliseconds;
    const baseline = pilotPlanned.get(j.jobNumber) as number;
    return isLateEnoughToText(at(j.date, j.arrivedAt as string).getTime(), baseline) && isLateEnoughToText(texted, baseline);
  });
  const latest = [...weekDays.entries()].flatMap(([week, days]) => qualifying
    .filter((j) => weekOf(j.date) === week)
    .sort((x, y) => lateOf(y) - lateOf(x) || x.jobNumber - y.jobNumber)
    .slice(0, Math.round((LATE_TEXTS * days.size) / wholeWeekDays)));
  for (const j of latest) {
    const cust = lateCustById.get((customer.get(j.customer) as { id: string }).id) as { id: string; text_language: TextLanguage };
    const arrival = at(j.date, j.arrivedAt as string);
    const sentAt = new Date(Math.max(plus(arrival, -30).getTime(), at(j.date, j.windowStart).getTime()));
    const label = arrivalLabel(Temporal.Instant.fromEpochMilliseconds(arrival.getTime()), zone, cust.text_language);
    const t = tech.get(j.technician as string) as { id: string };
    const body = renderTemplate(catalogTexts(catalogs), 'late', cust.text_language, { tech: techName.get(t.id) as string, arrival: label.label });
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at, delivered_at)
       VALUES ($1, $2, 'late', $3, $4, $5, $6, 'delivered', 1, $7, $7, $7) RETURNING id`,
      [cust.id, j.jobNumber, cust.text_language, body.encoding, body.body, body.characters, sentAt]);
    const textId = (ins.rows[0] as { id: string }).id;
    await tx.query(`INSERT INTO world.text_attempt (text_id, number, at, result) VALUES ($1, 1, $2, 'delivered')`, [textId, sentAt]);
    await tx.query(`INSERT INTO world.inbox_message (customer_id, direction, text_id, body, at) VALUES ($1, 'out', $2, $3, $4)`, [cust.id, textId, body.body, sentAt]);
    await tx.query(
      `UPDATE world.job SET late_text_was_arrival = $4, late_text_sent_at = $2, texted_arrival = $3 WHERE job_number = $1`,
      [j.jobNumber, sentAt, new Date(label.rounded.epochMilliseconds), new Date(pilotPlanned.get(j.jobNumber) as number)]);
  }
  // The alert switches: 1 alert_setting row per SD-30 type with its default bell and managers' email (section 3 writer
  // table: the seed; API-161 changes only the switches). The alert checks read them and write none (F-444).
  await insertMany(tx, 'world.alert_setting', [['type', 'text'], ['bell', 'boolean'], ['managers_email', 'boolean']],
    alertSettingDefaults().map((d) => [d.type, d.bell, d.managersEmail]));
  // The text simulator's one row, mode up (section 3 writer table: the seed; API-71 changes it). With no row the gateway sends as if up but
  // API-71 would have nothing to change (F-643).
  await tx.query(`INSERT INTO world.text_simulator (mode) VALUES ('up')`);

  // 8. Last: the simulated pilot calls (SD-25). A call takes its customer and technician from the visit it asks about: a
  //    past visit found by its source_ref (exactly 1 row, with a technician), or a pilot job written above.
  const visitCalls = fx.pilotCalls.filter((c): c is { at: string; visitRef: string } => 'visitRef' in c);
  const refs = [...new Set(visitCalls.map((c) => c.visitRef))];
  const pv = await tx.query<{ ref: string; n: number; id: string | null; customer_id: string | null; technician_id: string | null; branch_id: string | null }>(
    `SELECT f.ref, count(v.id)::int AS n, min(v.id::text) AS id, min(v.customer_id::text) AS customer_id,
            min(v.technician_id::text) AS technician_id, min(c.branch_id) AS branch_id
       FROM unnest($1::text[]) AS f(ref)
       LEFT JOIN world.past_visit v ON v.source_ref = f.ref LEFT JOIN world.customer c ON c.id = v.customer_id
      GROUP BY f.ref`, [refs]);
  const badVisits = pv.rows.filter((r) => r.n !== 1 || r.technician_id === null).map((r) => `${r.ref} (${r.n} rows${r.n === 1 ? ', no technician' : ''})`).sort();
  if (badVisits.length > 0) throw new SetupError('visit_not_found', `${badVisits.length} visit(s): ${sample(badVisits, 5)}`);
  const visit = new Map(pv.rows.map((r) => [r.ref, r]));
  const callRows = fx.pilotCalls.map((c) => {
    const when = at(c.at.slice(0, 10), c.at.slice(11));
    if ('visitRef' in c) {
      const v = visit.get(c.visitRef) as { id: string; customer_id: string; technician_id: string; branch_id: string };
      return [when, v.branch_id, v.customer_id, v.technician_id, v.id, null];
    }
    const j = byNumber.get(c.jobNumber) as FixtureJob;
    const t = tech.get(j.technician as string) as { id: string; branch: string };
    return [when, t.branch, customer.get(j.customer)?.id, t.id, null, j.jobNumber];
  });
  await insertMany(tx, 'world.pilot_call', [
    ['at', 'timestamptz'], ['branch_id', 'text'], ['customer_id', 'uuid'], ['technician_id', 'uuid'], ['past_visit_id', 'uuid'], ['job_number', 'int'],
  ], callRows);

  return {
    pilotJobs: fx.pilotJobs.length, demoWeekJobs: fx.demoWeekJobs.length, memberships: fx.memberships.length,
    autopilotSteps: events.length - 2, pilotCalls: callRows.length,
  };
}
