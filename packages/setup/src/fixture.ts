// SPDX-License-Identifier: AGPL-3.0-or-later
// The world seed's fixture (BUILD_PLAN D-3 step 2): the shape @bw/generator writes to fixture.json, read and checked once
// so the world seed (step 5) never writes a row from a malformed one. A fixture that does not hold this shape stops
// setup with SetupError fixture_invalid.
import { SetupError } from './errors.ts';

export interface FixtureCustomer { ref: string; name: string; nameSearch: string; street: string; city: string; zip: string; houseNumber: number }
export interface FixtureJob {
  /** null only for a demo-week job the approved Jobs page tells as Unassigned (F-292). */
  jobNumber: number; customer: string; technician: string | null; service: string; date: string; windowStart: string; windowEnd: string;
  status: 'done' | 'no_one_home' | 'scheduled'; arrivedAt: string | null; endedAt: string | null; bookedVia: string; bookedAt: string;
  /** The customer's words for the problem, where a story job's page tells them (F-292). */
  problem?: string;
  /** The branch of an Unassigned job (its customer's); absent on every other job. */
  branch?: string;
}
export type FixtureCall = { at: string; visitRef: string } | { at: string; jobNumber: number };
export interface FixtureMembership { customer: string; since: string; renews: string; benefitsKey: string }
export interface FixtureScriptRow {
  jobNumber: number; onMyWayLeadMinutes: number; arrivalDelayMinutes: number; outcome: 'finished' | 'no_one_home'; workMinutes: number; partsCount: number;
}
export interface WorldFixture {
  zone: string;
  customers: FixtureCustomer[];
  pilotJobs: FixtureJob[];
  pilotCalls: FixtureCall[];
  demoWeekJobs: FixtureJob[];
  memberships: FixtureMembership[];
  sampleDayScript: FixtureScriptRow[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function bad(what: string): never {
  throw new SetupError('fixture_invalid', `fixture.json: ${what}`);
}

/** Parse fixture.json and check every field the world seed reads. */
export function parseFixture(text: string): WorldFixture {
  let fx: WorldFixture;
  try {
    fx = JSON.parse(text) as WorldFixture;
  } catch {
    return bad('is not JSON');
  }
  for (const k of ['customers', 'pilotJobs', 'pilotCalls', 'demoWeekJobs', 'memberships', 'sampleDayScript'] as const) {
    if (!Array.isArray(fx[k])) bad(`${k} is not a list`);
  }
  if (typeof fx.zone !== 'string' || fx.zone === '') bad('zone is missing');
  const refs = new Set<string>();
  for (const c of fx.customers) {
    if (typeof c.ref !== 'string' || typeof c.name !== 'string' || !Number.isInteger(c.houseNumber)) bad(`customer ${String(c.ref)} is malformed`);
    if (refs.has(c.ref)) bad(`customer ${c.ref} is listed twice`);
    refs.add(c.ref);
  }
  const numbers = new Set<number>();
  for (const j of [...fx.pilotJobs, ...fx.demoWeekJobs]) {
    if (!Number.isInteger(j.jobNumber) || numbers.has(j.jobNumber)) bad(`job ${j.jobNumber} is malformed or listed twice`);
    numbers.add(j.jobNumber);
    if (!refs.has(j.customer)) bad(`job ${j.jobNumber} names customer ${j.customer}, which customers does not list`);
    if (!DATE.test(j.date) || !TIME.test(j.windowStart) || !TIME.test(j.windowEnd) || !LOCAL.test(j.bookedAt)) bad(`job ${j.jobNumber} has a malformed date or time`);
    if ((j.arrivedAt !== null && !TIME.test(j.arrivedAt)) || (j.endedAt !== null && !TIME.test(j.endedAt))) bad(`job ${j.jobNumber} has a malformed arrival or end`);
    if (j.problem !== undefined && (typeof j.problem !== 'string' || j.problem === '')) bad(`job ${j.jobNumber} has a malformed problem`);
  }
  for (const j of fx.pilotJobs) if (typeof j.technician !== 'string') bad(`pilot job ${j.jobNumber} has no technician`);
  for (const j of fx.demoWeekJobs) if (j.technician !== null && typeof j.technician !== 'string') bad(`job ${j.jobNumber} has a malformed technician`);
  const unassigned = new Set(fx.demoWeekJobs.filter((j) => j.technician === null).map((j) => j.jobNumber));
  for (const m of fx.memberships) {
    if (!refs.has(m.customer)) bad(`a membership names customer ${m.customer}, which customers does not list`);
    if (!DATE.test(m.since) || !DATE.test(m.renews)) bad(`the membership of ${m.customer} has a malformed date`);
  }
  for (const c of fx.pilotCalls) {
    if (!LOCAL.test(c.at)) bad(`a pilot call has a malformed time ${c.at}`);
    if ('jobNumber' in c && !numbers.has(c.jobNumber)) bad(`a pilot call names job ${c.jobNumber}, which the fixture does not hold`);
  }
  for (const s of fx.sampleDayScript) {
    if (!numbers.has(s.jobNumber)) bad(`the script names job ${s.jobNumber}, which the fixture does not hold`);
    if (unassigned.has(s.jobNumber)) bad(`the script names job ${s.jobNumber}, which no technician holds`);
  }
  return fx;
}
