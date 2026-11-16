// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1541 (owner ruling 9796c392, Nov 13, 2026: "Fill them in"): the world seed's past pilot jobs (Mon, Aug 31 to Mon, Sep 14,
// 2026; SD-25) carry the whole record a live visit leaves, not only their outcome, so the office job page and the customer
// page of any of them read as a real visit. Each row copies the shape its live writer writes:
//
//   - the visit steps, as the technician app's status items leave them (packages/api-server/src/tech-items/apply.ts
//     applyStatus, the autopilot's ctx): 1 tech_item ledger row per item (result applied), 1 job_change row of kind status
//     by the technician (data from, to, itemKey, item, offlineAt, sentAt, rebased), the job's version + 1 per step, its
//     on_the_way_at (arrived_at is the fixture's and ended_at the fixture's as fitPastVisitEnds fits it, F-1546, both already
//     written), and the technician_day start;
//     done: On my way, Arrived, Finished; no one home: On my way, No one home (a forward move from on the way, so the
//     fixture's null arrival stays null and the report view reads the same rows);
//   - the finish (FR-BILL-3, finishLines): job_part rows from the seeded parts list by partCodeForLine (aggregated by part,
//     as the autopilot's finishOf does) or No parts used, the work_done_line rows, labor_minutes and no_parts_used;
//   - the sent bill (section 6.6): billFinishedJob's billing_item, the link's first-try success (billing_attempt 1, the
//     item in_billing with no left_at, job.billing_state, the system's billing_sent history row), and pbs's receipt
//     (pbs.call stored, pbs.invoice received, pbs.invoice_line), composed by composeInvoice from the job as
//     composeFromJob reads it, with the Comfort Club discount for a member (FR-BILL-13);
//   - about 1 job in 5 a note: an office note before the visit (API-140's rows: the note and an office note_added
//     history row) or a technician's note during it (the note item: its ledger row, the note and a technician
//     note_added row).
//
// The 3 billing history jobs (world-seed.ts BILLING_HISTORY) keep their billing records; they get their steps and finish
// here, and pbs's side of their tries: a data_error call at the finish, then a stored invoice on the second try, or
// for Mark fixed the invoice entered by hand (apps/pbs/src/store.ts enterByHand).
//
// Nothing here changes a column the report view reads (status, arrived_at, window, pilot) or a late-text row, so every
// SD-25 figure stays the same. Every value is a function of the fixture and the seeded reference rows; every id is a
// name-derived uuid (seedUuid), so 2 setups write identical rows.
import { createHash } from 'node:crypto';
import type { Queryable } from '@bw/db';
import { composeInvoice, finishLines, type InvoiceLine } from '@bw/domain';
import { Temporal, toWire } from '@bw/time';
import { partCodeForLine } from '../../db/src/seed/reference-data.ts';
import { SetupError } from './errors.ts';
import type { FixtureJob } from './fixture.ts';

/** An integer in [0, n) from a name: the 1 source of every choice below, so a choice never depends on row order. */
export const pick = (name: string, n: number): number => createHash('sha256').update(`bw-past-jobs:${name}`).digest().readUInt32BE(0) % n;

/** A uuid derived from a name (RFC 9562 version 8, the custom layout): the seeded rows' ids and item keys. */
export function seedUuid(name: string): string {
  const h = createHash('sha256').update(`bw-past-jobs-id:${name}`).digest('hex');
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The status items of a technician's visit, with the status each moves from and to (domain STATUS_ITEM_TARGET). */
export type StepItem = 'on_my_way' | 'arrived' | 'finished' | 'no_one_home';
const TARGET: Record<StepItem, string> = { on_my_way: 'on_the_way', arrived: 'on_site', finished: 'done', no_one_home: 'no_one_home' };

/** The status steps a past job's outcome takes: done goes On my way, Arrived, Finished; no one home goes On my way, No one home. */
export const pastJobItems = (j: Pick<FixtureJob, 'status'>): readonly StepItem[] =>
  j.status === 'done' ? ['on_my_way', 'arrived', 'finished'] : j.status === 'no_one_home' ? ['on_my_way', 'no_one_home'] : [];

/** A past job's version after its steps: created at 1, then + 1 per status step (a note or a billing send changes no version). */
export const pastJobVersion = (j: Pick<FixtureJob, 'status'>): number => 1 + pastJobItems(j).length;

/** What a technician writes as work done, by service: lines that name no part, and lines for a finish that used parts. */
export const WORK_DONE: Readonly<Record<string, { checks: readonly string[]; repairs: readonly string[] }>> = {
  furnace_tune_up: {
    checks: ['Cleaned the flame sensor and the burners.', 'Checked the heat exchanger; no cracks.', 'Tested the safety controls; all normal.',
      'Checked gas pressure and temperature rise; both in range.', 'Cleared the condensate drain and checked the inducer motor.'],
    repairs: ['Replaced the worn parts listed below and ran a full heating cycle.', 'Replaced the filter and the part listed; heat is steady at the vents.'],
  },
  ac_tune_up: {
    checks: ['Cleaned the outdoor coil.', 'Checked the refrigerant charge; normal.', 'Flushed the condensate line.', 'Checked the amp draw on the compressor and fan; normal.',
      'Cleared leaves and grass from around the outdoor unit.'],
    repairs: ['Replaced the part listed below; cooling well, 18 degrees across the coil.', 'Replaced the weak part listed and retested; system cooling normally.'],
  },
  heating_or_ac_fix: {
    checks: ['Found a tripped breaker on the outdoor unit; reset it and tested a full cycle.', 'Cleared a clogged condensate drain that had shut the system off.',
      'Reset the limit switch and cleaned the flame sensor; running normally.'],
    repairs: ['Found the failed part, replaced it and tested a full cycle.', 'Replaced the failed part listed below; system running normally.',
      'Diagnosed a no-start, replaced the part listed and checked all safeties.'],
  },
  plumbing_repair: {
    checks: ['Cleared the drain line with a snake; draining freely.', 'Tightened the compression fitting under the sink; no more leak.',
      'Adjusted the toilet fill valve; it no longer runs.'],
    repairs: ['Replaced the leaking part listed below and checked for drips.', 'Replaced the shutoff valve and tested at full pressure.',
      'Fixed the leak under the sink with the parts listed.'],
  },
  water_heater: {
    checks: ['Flushed sediment from the tank; anode rod still good.', 'Relit the pilot and checked the thermostat setting.', 'Tested the relief valve; working.'],
    repairs: ['Replaced the part listed below; hot water back in 40 minutes.', 'Replaced the failed part and tested the burner through a full cycle.'],
  },
  thermostat: {
    checks: ['Reset the thermostat schedule with the customer.', 'Replaced the batteries and recalibrated the thermostat.', 'Checked the wiring at the furnace board; all tight.'],
    repairs: ['Installed the new thermostat and set up the schedule with the customer.', 'Replaced the thermostat and tested heat, cool and fan.'],
  },
  boiler_repair: {
    checks: ['Bled the radiators on both floors.', 'Checked the expansion tank and the system pressure; normal.', 'Cleaned the burner and checked the flue.'],
    repairs: ['Replaced the part listed below and bled the system.', 'Replaced the failed part; all zones heating.'],
  },
  tankless_heater_flush: {
    checks: ['Flushed the heat exchanger with descaler.', 'Cleaned the inlet water filter.', 'Checked the error log; no codes.'],
    repairs: ['Flushed the unit and replaced the part listed below.', 'Replaced the worn isolation valve part listed and flushed the unit.'],
  },
  sump_pump_install: {
    checks: ['Tested the pump with a full pit of water.', 'Checked the discharge line outside; draining away from the house.'],
    repairs: ['Installed the new sump pump with a check valve.', 'Installed the pump and the parts listed; tested with a full pit.'],
  },
};

/** The share of a service's finishes with No parts used, in percent: a tune-up or a flush often uses none, an install always uses some. */
const NO_PARTS_PERCENT: Readonly<Record<string, number>> = {
  furnace_tune_up: 50, ac_tune_up: 55, heating_or_ac_fix: 15, plumbing_repair: 20, water_heater: 30, thermostat: 25, boiler_repair: 20,
  tankless_heater_flush: 60, sump_pump_install: 0,
};

/** Office notes written before a visit (a dispatcher or customer service), and the technician's notes during one. */
export const OFFICE_NOTES = [
  'Customer asked for a call 30 minutes before arrival.',
  'Park in the driveway; street parking is permit only.',
  'Customer works from home; use the side door.',
  'Two dogs in the house; customer will put them in the back room.',
  'Customer says the unit makes a rattling noise when it starts.',
  'Tenant will be home; the owner approved the visit by phone.',
  'Customer prefers texts to calls.',
  'Please use shoe covers; new carpet upstairs.',
] as const;
export const TECHNICIAN_NOTES = [
  'Showed the customer how to change the filter.',
  'Unit is about 18 years old; talked with the customer about a replacement quote.',
  'Customer asked about the Comfort Club; left a brochure.',
  'Recommend a duct cleaning at the next visit.',
  'Water heater is near the end of its life; customer will think about a new one.',
  'Checked the upstairs thermostat too; working fine.',
  'Customer was happy with the work.',
  'Outdoor unit sits low; suggested a pad before winter.',
] as const;
export const NO_ONE_HOME_NOTES = [
  'No answer at the door or by phone. Left a door tag.',
  'Knocked and called twice; no one home. Door tag on the front door.',
  'Gate was locked and no one answered. Left a voicemail.',
] as const;

/** 1 job in NOTE_EVERY has a note (the brief's "about 1 in 5"). */
export const NOTE_EVERY = 5;

export interface PastStep { item: StepItem; key: string; at: Date; from: string; to: string; fromVersion: number; toVersion: number }
export interface PastNote { id: string; key: string | null; kind: 'office' | 'technician'; at: Date; body: string; version: number }
export interface PastFinish { laborMinutes: number; partCodes: string[]; noPartsUsed: boolean; workDone: string[] }
export interface PastJob { jobNumber: number; steps: PastStep[]; finish: PastFinish | null; note: PastNote | null; onTheWayAt: Date }

/** A no-one-home visit's minutes at the door before its end: 10 to 20, from its job number. */
export const knockMinutes = (jobNumber: number): number => 10 + pick(`door:${jobNumber}`, 11);

const hm = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** The minute of the day a pilot visit reached the door: its arrival, else (no one home) its knock. */
export const doorMinute = (j: Pick<FixtureJob, 'jobNumber' | 'arrivedAt' | 'endedAt'>): number =>
  j.arrivedAt !== null ? hm(j.arrivedAt) : hm(j.endedAt as string) - knockMinutes(j.jobNumber);
/** The most minutes fitPastVisitEnds leaves between a fitted end and the next door. */
export const FIT_GAP_MAX = 20;
/** F-1802: the least minutes of work a fitted done visit keeps (arrival to end). */
export const FIT_WORK_MIN = 30;
/**
 * F-1797: the drive minutes fitPastVisitEnds leaves between a fitted end and the next door at least. The planner's real drive minutes
 * need the resolved customers and the routing legs, which exist only after this fit runs (world-seed.ts reads the fitted rows), so
 * this is the proxy the owner's answer 25550018 was measured with.
 */
export const FIT_DRIVE_MIN = 10;

/**
 * F-1546: the generator draws each pilot visit's length apart from the next one's arrival, so in about 1 technician-day in 4 a
 * visit "ended" after the same technician had reached the next door. The SD-25 figures read the arrivals, outcomes and
 * technicians, so those stay (but for the doors F-1797 moves, below); a visit that ends at or after the next door ends instead
 * FIT_GAP_MAX minutes before it, or half the time from its own door to the next door if that is less (at least 1 minute). A
 * no-one-home visit's end never needs it in the fixture, and is refused if it would (its knock would move with it); so is a
 * day whose 2 visits are less than 2 minutes apart at the door.
 *
 * F-1797 and F-1802 (owner answer 25550018, "Move 26 arrivals"): a fitted done visit keeps at least FIT_WORK_MIN minutes of work
 * and leaves at least FIT_DRIVE_MIN before the next door. When the doors are closer than that, the NEXT visit's arrival moves
 * later (and its end by the same minutes, so its work stays), the smallest move that makes room; per technician-day, in door
 * order, so a visit moved onto the one after it moves that one in turn. A no-one-home next visit moves too (F-1827): its knock is its
 * end less a drawn number of minutes (knockMinutes), so moving its end by the same minutes moves its knock with it, and the done
 * visit before it keeps its 30 minutes. A move past 23:59 is refused. Returns the jobs in their order, changed rows copied, the rest the same objects.
 */
export function fitPastVisitEnds<J extends FixtureJob>(jobs: readonly J[]): J[] {
  const ran = (j: J): boolean => j.endedAt !== null && (j.status === 'done' || j.status === 'no_one_home');
  const days = new Map<string, J[]>();
  for (const j of jobs) if (ran(j)) days.set(`${j.technician}|${j.date}`, [...(days.get(`${j.technician}|${j.date}`) ?? []), j]);
  const arrivedAt = new Map<number, string>();
  const endedAt = new Map<number, string>();
  const arr = (j: J): string | null => arrivedAt.get(j.jobNumber) ?? j.arrivedAt;
  const end = (j: J): string => endedAt.get(j.jobNumber) ?? (j.endedAt as string);
  const door = (j: J): number => (arr(j) !== null ? hm(arr(j) as string) : hm(end(j)) - knockMinutes(j.jobNumber));
  for (const day of days.values()) {
    day.sort((x, y) => doorMinute(x) - doorMinute(y) || x.jobNumber - y.jobNumber);
    // Forward: make room for each fitted done visit's work and drive by moving the next arrival later.
    for (let i = 0; i < day.length - 1; i++) {
      const a = day[i] as J;
      const b = day[i + 1] as J;
      if (arr(a) === null || hm(end(a)) < door(b)) continue;
      const delta = door(a) + FIT_WORK_MIN + FIT_DRIVE_MIN - door(b);
      if (delta <= 0) continue;
      const movedEnd = hm(end(b)) + delta;
      if (movedEnd > 23 * 60 + 59) throw new SetupError('fixture_invalid', `job ${b.jobNumber}: moving its arrival ${delta} minute(s) later for the visit before it ends it past the day`);
      if (arr(b) !== null) arrivedAt.set(b.jobNumber, hhmm(hm(arr(b) as string) + delta));
      endedAt.set(b.jobNumber, hhmm(movedEnd));
    }
    // Backward (latest first, so each end fits a door that no longer moves).
    for (let i = day.length - 1; i >= 1; i--) {
      const a = day[i - 1] as J;
      const nextDoor = door(day[i] as J);
      const room = nextDoor - door(a);
      if (room < 2) throw new SetupError('fixture_invalid', `jobs ${a.jobNumber} and ${(day[i] as J).jobNumber}: ${room} minute(s) apart at the door`);
      if (hm(end(a)) < nextDoor) continue;
      if (arr(a) === null) throw new SetupError('fixture_invalid', `job ${a.jobNumber}: a no-one-home visit ends after the next door`);
      let gap = Math.max(1, Math.min(FIT_GAP_MAX, Math.floor(room / 2)));
      if (room >= FIT_WORK_MIN + FIT_DRIVE_MIN) gap = Math.min(Math.max(gap, FIT_DRIVE_MIN), room - FIT_WORK_MIN);
      endedAt.set(a.jobNumber, hhmm(nextDoor - gap));
    }
  }
  return jobs.map((j) => (arrivedAt.has(j.jobNumber) || endedAt.has(j.jobNumber)
    ? { ...j, arrivedAt: arr(j), endedAt: end(j) } : j));
}

/**
 * The record of 1 past pilot job, a pure function of the fixture row and its visit facts. `at` turns a local date and time into
 * an instant; `drive` is the planner's drive minutes from the stop before (the technician's previous visit that day, else the
 * depot); `prevEnd` is when that previous visit ended (null for the day's first). On my way is the drive before the arrival
 * (done) or before the knock (no one home: 10 to 20 minutes at the door before the ending), never before the previous visit
 * ended and always before the next step.
 */
export function planPastJob(j: FixtureJob, input: { at: (date: string, time: string) => Date; drive: number; prevEnd: Date | null }): PastJob {
  const items = pastJobItems(j);
  if (items.length === 0 || j.endedAt === null) throw new SetupError('fixture_invalid', `job ${j.jobNumber}: not an ended pilot job`);
  const ended = input.at(j.date, j.endedAt);
  const arrived = j.arrivedAt === null ? null : input.at(j.date, j.arrivedAt);
  const atDoor = arrived ?? new Date(ended.getTime() - knockMinutes(j.jobNumber) * 60_000);
  const minute = 60_000;
  let onTheWay = atDoor.getTime() - Math.max(1, input.drive) * minute;
  if (input.prevEnd !== null) onTheWay = Math.max(onTheWay, input.prevEnd.getTime());
  onTheWay = Math.min(onTheWay, atDoor.getTime() - minute);
  const times: Record<StepItem, number> = { on_my_way: onTheWay, arrived: arrived?.getTime() ?? 0, finished: ended.getTime(), no_one_home: ended.getTime() };
  let status = 'scheduled';
  const steps = items.map((item, i): PastStep => {
    const s = { item, key: seedUuid(`item:${j.jobNumber}:${item}`), at: new Date(times[item]), from: status, to: TARGET[item], fromVersion: 1 + i, toVersion: 2 + i };
    status = TARGET[item];
    return s;
  });

  let finish: PastFinish | null = null;
  if (j.status === 'done' && arrived !== null) {
    const pool = WORK_DONE[j.service];
    if (!pool) throw new SetupError('reference_missing', `job ${j.jobNumber}: no work-done lines for service ${j.service}`);
    const noParts = pick(`noparts:${j.jobNumber}`, 100) < (NO_PARTS_PERCENT[j.service] ?? 20);
    const r = pick(`count:${j.jobNumber}`, 10);
    const count = noParts ? 0 : r < 6 ? 1 : r < 9 ? 2 : 3;
    const partCodes = Array.from({ length: count }, (_, k) => partCodeForLine(j.jobNumber, k, j.service));
    const first = noParts ? pool.checks : pool.repairs;
    const workDone = [first[pick(`done1:${j.jobNumber}`, first.length)] as string];
    if (pick(`done2:${j.jobNumber}`, 2) === 0) {
      const second = pool.checks.filter((t) => t !== workDone[0]);
      workDone.push(second[pick(`done2line:${j.jobNumber}`, second.length)] as string);
    }
    finish = { laborMinutes: Math.round((ended.getTime() - arrived.getTime()) / minute), partCodes, noPartsUsed: noParts, workDone };
  }

  let note: PastNote | null = null;
  if (pick(`note:${j.jobNumber}`, NOTE_EVERY) === 0) {
    const office = pick(`notekind:${j.jobNumber}`, 5) < 2;
    if (office) {
      // Before the visit: 30 minutes to 2.5 hours before the window opens, never before the job was booked.
      const booked = input.at(j.bookedAt.slice(0, 10), j.bookedAt.slice(11)).getTime();
      const windowStart = input.at(j.date, j.windowStart).getTime();
      const at = new Date(Math.max(booked + 10 * minute, windowStart - (30 + pick(`noteat:${j.jobNumber}`, 121)) * minute));
      note = { id: seedUuid(`note:${j.jobNumber}`), key: null, kind: 'office', at, body: OFFICE_NOTES[pick(`notebody:${j.jobNumber}`, OFFICE_NOTES.length)] as string, version: 1 };
    } else {
      // During the visit: halfway through a finished one; at the door, a minute before No one home, otherwise.
      const pool = j.status === 'done' ? TECHNICIAN_NOTES : NO_ONE_HOME_NOTES;
      const at = arrived !== null ? new Date(arrived.getTime() + Math.floor((ended.getTime() - arrived.getTime()) / (2 * minute)) * minute) : new Date(ended.getTime() - minute);
      const during = steps.filter((s) => s.at.getTime() <= at.getTime()).at(-1) as PastStep;
      note = {
        id: seedUuid(`note:${j.jobNumber}`), key: seedUuid(`item:${j.jobNumber}:note`), kind: 'technician', at,
        body: pool[pick(`notebody:${j.jobNumber}`, pool.length)] as string, version: during.toVersion,
      };
    }
  }
  return { jobNumber: j.jobNumber, steps, finish, note, onTheWayAt: new Date(onTheWay) };
}

type Col = readonly [name: string, type: string];
async function insertMany(tx: Queryable, table: string, cols: readonly Col[], rows: readonly unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    const names = cols.map(([n]) => `"${n}"`).join(', ');
    const params = cols.map(([, t], k) => `$${k + 1}::${t}[]`).join(', ');
    await tx.query(`INSERT INTO ${table} (${names}) SELECT * FROM unnest(${params})`, cols.map((_, k) => chunk.map((r) => r[k])));
  }
}

const CHANGE_COLS: readonly Col[] = [
  ['job_number', 'int'], ['at', 'timestamptz'], ['actor_user_id', 'uuid'], ['actor_kind', 'text'], ['kind', 'text'], ['from_version', 'int'], ['to_version', 'int'], ['data', 'jsonb'],
];

/** A billing history job's pbs side: its try 1 refused at the finish, then try 2 stored, or the invoice Mark fixed entered by hand. */
export interface PbsHistory { jobNumber: number; step: Date; how: 'sent_again' | 'marked_fixed'; reason: string | null; by: string }

export interface PastJobsInput {
  zone: string;
  jobs: readonly { j: FixtureJob; past: PastJob; customerId: string; technicianId: string; technicianUserId: string; officeUserId: string; member: boolean }[];
  /** The billing history jobs (world-seed.ts BILLING_HISTORY): they keep their billing records; pbs gets the side shown here. */
  history: ReadonlyMap<number, PbsHistory>;
}

export interface PastJobsResult { steps: number; finishes: number; parts: number; workDone: number; notes: number; invoices: number }

/** Write every past pilot job's record (see the file head). Runs in the world seed's transaction, after the jobs are written. */
export async function writePastJobs(tx: Queryable, input: PastJobsInput): Promise<PastJobsResult> {
  const epoch = (await tx.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]?.world_epoch ?? 1;
  // In the database's code order (composeFromJob reads the parts ORDER BY p.code, under the database's collation).
  const partRows = (await tx.query<{ id: string; code: string; name: string; price_cents: number }>('SELECT id::text AS id, code, name, price_cents FROM world.part ORDER BY code')).rows;
  const parts = new Map(partRows.map((p) => [p.code, p]));
  const partById = new Map(partRows.map((p, rank) => [p.id, { ...p, rank }]));
  const services = new Map((await tx.query<{ id: string; invoice_price_cents: number }>('SELECT id, invoice_price_cents FROM world.service_type')).rows.map((s) => [s.id, s.invoice_price_cents]));
  const names = new Map((await tx.query<{ id: string; name: string }>('SELECT id::text AS id, name FROM world.customer WHERE id = ANY($1::uuid[])',
    [[...new Set(input.jobs.map((x) => x.customerId))]])).rows.map((c) => [c.id, c.name]));
  const seeded = new Set([...parts.values()].map((p) => p.id));
  const wire = (d: Date): string => toWire(Temporal.Instant.fromEpochMilliseconds(d.getTime()), input.zone);
  const iso = (d: Date): string => Temporal.Instant.fromEpochMilliseconds(d.getTime()).toString();

  const items: unknown[][] = [];
  const changes: unknown[][] = [];
  const days = new Map<string, unknown[]>();
  const jobUpdates: unknown[][] = [];
  const jobParts: unknown[][] = [];
  const workLines: unknown[][] = [];
  const notes: unknown[][] = [];
  const billingItems: unknown[][] = [];
  const attempts: unknown[][] = [];
  const calls: unknown[][] = [];
  const invoices: unknown[][] = [];
  const invoiceLines: unknown[][] = [];
  const item = (x: PastJobsInput['jobs'][number], key: string, kind: string, baseVersion: number, at: Date): unknown[] =>
    [key, x.technicianId, x.j.jobNumber, kind, baseVersion, epoch, at, at, at, 0, null, at, 'applied'];

  for (const x of input.jobs) {
    const { j, past } = x;
    for (const s of past.steps) {
      items.push(item(x, s.key, s.item, s.fromVersion, s.at));
      changes.push([j.jobNumber, s.at, x.technicianUserId, 'technician', 'status', s.fromVersion, s.toVersion, JSON.stringify({
        from: { status: s.from }, to: { status: s.to }, itemKey: s.key, item: s.item, offlineAt: wire(s.at), sentAt: wire(s.at), rebased: false,
      })]);
    }
    const dayKey = `${x.technicianId}|${j.date}`;
    const start = past.steps[0]?.at as Date;
    const day = days.get(dayKey);
    if (!day || (day[2] as Date).getTime() > start.getTime()) days.set(dayKey, [x.technicianId, j.date, start]);

    const n = past.note;
    if (n) {
      notes.push([n.id, j.jobNumber, n.kind === 'office' ? x.officeUserId : x.technicianUserId, n.kind, n.body, n.at, n.at, false, n.kind === 'office' ? null : n.at, n.key]);
      if (n.kind === 'office') {
        changes.push([j.jobNumber, n.at, x.officeUserId, 'office', 'note_added', n.version, n.version, JSON.stringify({ noteId: n.id })]);
      } else {
        items.push(item(x, n.key as string, 'note', n.version, n.at));
        changes.push([j.jobNumber, n.at, x.technicianUserId, 'technician', 'note_added', n.version, n.version, JSON.stringify({
          noteId: n.id, itemKey: n.key, enteredOffline: false, offlineAt: wire(n.at), sentAt: wire(n.at), rebased: false,
        })]);
      }
    }

    const f = past.finish;
    const version = past.steps.at(-1)?.toVersion as number;
    jobUpdates.push([j.jobNumber, past.onTheWayAt, f?.laborMinutes ?? null, f?.noPartsUsed ?? false, f !== null && !input.history.has(j.jobNumber)]);
    if (!f) continue;
    // The finish lines as the technician's finish validates them (FR-BILL-3), the parts aggregated by part as the autopilot's finishOf does.
    const quantity = new Map<string, number>();
    for (const code of f.partCodes) {
      const p = parts.get(code);
      if (!p) throw new SetupError('reference_missing', `job ${j.jobNumber}: part ${code}`);
      quantity.set(p.id, (quantity.get(p.id) ?? 0) + 1);
    }
    const lines = finishLines({ parts: [...quantity].map(([partId, q]) => ({ partId, quantity: q })), noPartsUsed: f.noPartsUsed, laborMinutes: f.laborMinutes }, (id) => seeded.has(id));
    if (!lines.ok) throw new SetupError('fixture_invalid', `job ${j.jobNumber}: finish refused (${lines.problem})`);
    for (const p of lines.lines.parts) jobParts.push([j.jobNumber, p.partId, p.quantity]);
    f.workDone.forEach((text, i) => workLines.push([j.jobNumber, i + 1, text]));

    // The invoice, as composeFromJob reads the job at send time (parts by code, work done by seq) and composeInvoice composes it.
    const byCode = [...quantity].map(([id, q]) => ({ p: partById.get(id) as { code: string; name: string; price_cents: number; rank: number }, q }))
      .sort((a, b) => a.p.rank - b.p.rank);
    const ended = past.steps.at(-1)?.at as Date;
    const customerName = names.get(x.customerId) as string;
    const composed = composeInvoice({
      jobNumber: j.jobNumber, customerName, doneAt: ended.toISOString(), serviceId: j.service, servicePriceCents: services.get(j.service) as number,
      parts: byCode.map(({ p, q }) => ({ code: p.code, name: p.name, priceCents: p.price_cents, quantity: q })),
      laborMinutes: f.laborMinutes, workDone: f.workDone, member: x.member,
    });
    if (!composed.ok) throw new SetupError('fixture_invalid', `job ${j.jobNumber}: invoice not composed (${composed.reason})`);
    const store = (receivedAt: Date, how: string, hand: { reason: string; by: string } | null): void => {
      invoices.push([j.jobNumber, receivedAt, how, composed.totalCents, customerName, ended, hand?.reason ?? null, hand?.by ?? null, hand ? receivedAt : null]);
      composed.lines.forEach((l: InvoiceLine, i) => invoiceLines.push([j.jobNumber, i + 1, l.kind, l.label, l.code, l.quantity, l.unitCents, l.amountCents]));
    };
    const h = input.history.get(j.jobNumber);
    if (h) {
      // The record world-seed.ts writes for it: try 1 refused by billing at the finish, then the person's step an hour later.
      calls.push([seedUuid(`call:${j.jobNumber}:1`), j.jobNumber, iso(ended), 'data_error']);
      if (h.how === 'marked_fixed') store(h.step, 'entered_by_hand', { reason: h.reason as string, by: h.by });
      else { calls.push([seedUuid(`call:${j.jobNumber}:2`), j.jobNumber, iso(h.step), 'stored']); store(h.step, 'received', null); }
      continue;
    }
    // billFinishedJob, then the link's first try: billing stores it (accepted, 200); a first-try success never listed, so no left_at.
    billingItems.push([j.jobNumber, 'in_billing', null, 1, ended, null, null, null, null, null, null]);
    attempts.push([j.jobNumber, 1, ended, 'success', 200, null]);
    changes.push([j.jobNumber, ended, null, 'system', 'billing_sent', version, version, JSON.stringify({ try: 1 })]);
    calls.push([seedUuid(`call:${j.jobNumber}:1`), j.jobNumber, iso(ended), 'stored']);
    store(ended, 'received', null);
  }

  await insertMany(tx, 'world.tech_item', [
    ['key', 'uuid'], ['technician_id', 'uuid'], ['job_number', 'int'], ['kind', 'text'], ['base_version', 'int'], ['world_epoch', 'int'],
    ['device_time_real', 'timestamptz'], ['offset_saved_real', 'timestamptz'], ['demo_time', 'timestamptz'], ['since_save_ms', 'bigint'],
    ['demo_time_rebased', 'timestamptz'], ['received_at', 'timestamptz'], ['result', 'text'],
  ], items);
  await insertMany(tx, 'world.job_change', CHANGE_COLS, changes);
  await tx.query(
    `UPDATE world.job j SET on_the_way_at = u.on_the_way_at, labor_minutes = u.labor_minutes, no_parts_used = u.no_parts_used,
            billing_state = CASE WHEN u.billed THEN 'in_billing' ELSE j.billing_state END
       FROM unnest($1::int[], $2::timestamptz[], $3::int[], $4::boolean[], $5::boolean[]) AS u(job_number, on_the_way_at, labor_minutes, no_parts_used, billed)
      WHERE j.job_number = u.job_number`, [0, 1, 2, 3, 4].map((k) => jobUpdates.map((r) => r[k])));
  await insertMany(tx, 'world.technician_day', [['technician_id', 'uuid'], ['date', 'date'], ['started_at', 'timestamptz']], [...days.values()] as unknown[][]);
  await insertMany(tx, 'world.job_part', [['job_number', 'int'], ['part_id', 'uuid'], ['quantity', 'int']], jobParts);
  await insertMany(tx, 'world.work_done_line', [['job_number', 'int'], ['seq', 'int'], ['text', 'text']], workLines);
  await insertMany(tx, 'world.note', [
    ['id', 'uuid'], ['job_number', 'int'], ['author_user_id', 'uuid'], ['author_kind', 'text'], ['body', 'text'], ['entered_at', 'timestamptz'],
    ['sent_at', 'timestamptz'], ['entered_offline', 'boolean'], ['device_time_real', 'timestamptz'], ['item_key', 'uuid'],
  ], notes);
  await insertMany(tx, 'world.billing_item', [
    ['job_number', 'int'], ['state', 'text'], ['reason_key', 'text'], ['tries', 'int'], ['last_try_at', 'timestamptz'], ['next_try_at', 'timestamptz'],
    ['send_cause', 'text'], ['left_at', 'timestamptz'], ['left_how', 'text'], ['left_by', 'uuid'], ['left_reason', 'text'],
  ], billingItems);
  await insertMany(tx, 'world.billing_attempt', [
    ['job_number', 'int'], ['number', 'int'], ['at', 'timestamptz'], ['result', 'text'], ['http_status', 'int'], ['reason', 'text'],
  ], attempts);
  await insertMany(tx, 'pbs."call"', [['id', 'uuid'], ['job_number', 'int'], ['at', 'timestamptz'], ['answer', 'text']], calls);
  await insertMany(tx, 'pbs.invoice', [
    ['job_number', 'int'], ['received_at', 'timestamptz'], ['how', 'text'], ['total_cents', 'int'], ['customer_name', 'text'], ['done_at', 'timestamptz'],
    ['entered_by_hand_reason', 'text'], ['entered_by', 'uuid'], ['entered_at', 'timestamptz'],
  ], invoices);
  await insertMany(tx, 'pbs.invoice_line', [
    ['job_number', 'int'], ['seq', 'int'], ['kind', 'text'], ['label', 'text'], ['code', 'text'], ['quantity', 'int'], ['unit_cents', 'int'], ['amount_cents', 'int'],
  ], invoiceLines);
  return {
    steps: input.jobs.reduce((s, x) => s + x.past.steps.length, 0), finishes: input.jobs.filter((x) => x.past.finish).length,
    parts: jobParts.length, workDone: workLines.length, notes: notes.length, invoices: invoices.length,
  };
}
