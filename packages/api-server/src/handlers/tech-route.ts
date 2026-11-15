// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's map reads (P5-TWA-MAP-ME; UI-SPECIFICATION 12.2 API-100, API-104, API-163; SPECIFICATIONS 6.3 "Directions",
// "Map tab", "Drive time", "Me screen", SD-15, SD-22; FR-TECH-5, FR-TECH-11, FR-TECH-13, FR-TECH-15, FR-MAP-3).
//
// ONE leg rule (FR-TECH-13): every leg comes from SD-49's route source, legFor (the stored track, baked or live, else a live route the
// routing service answers and the source stores, else approximate; P6-LIVE-ROUTING); its drive minutes are the track's last cumulative
// second / 60 rounded up, else SD-22's approximate minutes, and the line drawn is that track or the straight line. API-104 (Directions) and API-163 (the Map tab's legs, the Next stop card's
// Directions button) both build a leg with {@link legBetween}, so the minutes on the button equal the route the map draws. A leg with no named
// start (API-104 with no fromJob, API-163's next stop) starts at the van's computed position, through 1 resolver, {@link legFromVanTo} (F-1003).
// Own jobs only (UI-SPECIFICATION 2.4, FR-AUTH-4): a job that is not the caller's answers 404.
//
// Steps (P6-ROUTE-BAKE; SPECIFICATIONS v0.13 section 6.3 Directions, SD-49; UI-SPECIFICATION v0.15 API-104; FR-TECH-5): API-104 answers
// the track's `van_track.steps` as stored, read from the same row as its line and minutes (1 read, so the steps cannot belong to another
// track than the one drawn); from the van's position on the way, from the van's step with that step's length left ({@link stepsFromVan},
// the same walk as the line left); an empty list on an approximate leg. API-163 answers no steps.
import type { dayRoute, techRoute } from '@bw/api';
import { areaSql } from '@bw/domain';
import type { Queryable } from '@bw/db';
import { Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { decodePolyline } from '../../../maps/src/tracks.ts';
import { legFromVan, stepsFromVan } from '../../../maps/src/position.ts';
import { legFor } from '../../../maps/src/route-source.ts';
import type { TrackStep } from '../../../maps/src/steps.ts';
import { readPreviousStop } from '../office-writes/day.ts';
import type { Handler, Tx } from '../types.ts';

type Leg = z.output<typeof techRoute.response>['leg'];
/** A leg with its steps: API-104 answers both, API-163 the leg only. */
interface Route {
  leg: Leg;
  steps: TrackStep[];
}
type Point = { lon: number; lat: number };

const wire = (d: Date, zone: string): string => toWire(Temporal.Instant.fromEpochMilliseconds(d.getTime()), zone);

/** One leg between 2 stops from the route source (SD-49): its track when it has one, baked or live, else the straight line with SD-22's minutes. */
export async function legBetween(tx: Queryable, branch: string, from: { job: number | null } & Point, to: { job: number } & Point): Promise<Leg> {
  return (await routeBetween(tx, branch, from, to)).leg;
}

/** {@link legBetween} with the track's steps as stored (none on the straight line): line, minutes, length and steps from 1 answer. */
async function routeBetween(tx: Queryable, branch: string, from: { job: number | null } & Point, to: { job: number } & Point): Promise<Route> {
  const a = { lon: from.lon, lat: from.lat };
  const b = { lon: to.lon, lat: to.lat };
  const { track: t, minutes } = await legFor(tx, branch, { job: from.job, ...a }, { job: to.job, ...b });
  if (!t) return { leg: { from: a, to: b, track: null, minutes, distanceMeters: null }, steps: [] };
  return { leg: { from: a, to: b, track: decodePolyline(t.polyline), minutes, distanceMeters: t.distance_m }, steps: t.steps };
}

/** A job as the leg into it needs it: its point, its status and its On my way time (the van's position, SD-22). */
interface Dest extends Point {
  job: number;
  status: string;
  onTheWayAt: Date | null;
}

/**
 * The leg into a job with no named start (API-104 with no fromJob, API-163's next stop): from the van's computed position (F-1003;
 * UI-SPECIFICATION API-104 "fromJob absent: from the van's position", 12.4; SPECIFICATIONS 6.3 Drive time). While the job is on the way,
 * the van is on the leg from the previous stop (the last ended stop that day, else the depot) at `now - on_the_way_at` seconds, the point
 * positionAt and the live map compute; the leg is the track left from there, its minutes and its length. Otherwise the van is at that
 * previous stop and the leg is its whole leg. One resolver for both reads, so Directions and the Map tab cannot disagree (FR-TECH-13).
 */
async function legFromVanTo(tx: Queryable, me: Me & { technician: NonNullable<Me['technician']> }, date: string, to: Dest, now: Temporal.Instant): Promise<Leg> {
  return (await routeFromVanTo(tx, me, date, to, now)).leg;
}

/** {@link legFromVanTo} with its steps: on the way, the steps left from the van's point ({@link stepsFromVan}); otherwise the whole leg's. */
async function routeFromVanTo(tx: Queryable, me: Me & { technician: NonNullable<Me['technician']> }, date: string, to: Dest, now: Temporal.Instant): Promise<Route> {
  const prev = await readPreviousStop(tx, me.technician.id, date, to.job);
  const from: { job: number | null } & Point = prev ? { job: prev.jobNumber, lon: prev.lon, lat: prev.lat } : { job: null, ...me.depot };
  if (to.status !== 'on_the_way' || to.onTheWayAt === null) return routeBetween(tx, me.branch, from, to);
  const b = { lon: to.lon, lat: to.lat };
  const { track: t } = await legFor(tx, me.branch, from, { job: to.job, ...b });
  const elapsed = (now.epochMilliseconds - to.onTheWayAt.getTime()) / 1000;
  const v = legFromVan(t ? { polyline: t.polyline, seconds: t.seconds } : null, { lon: from.lon, lat: from.lat }, b, elapsed);
  return { leg: { from: v.from, to: b, track: v.track, minutes: v.minutes, distanceMeters: v.distanceMeters }, steps: t ? stepsFromVan(t, elapsed) : [] };
}

interface Me {
  userId: string;
  name: string;
  employeeNumber: string | null;
  branch: string;
  zone: string;
  officePhone: string;
  depot: Point;
  /** The technician row, or null for a technician-role user with none (the App Reviewer sample user, F-252). */
  technician: { id: string; skill: string; van: { number: string; vehicle: string } | null } | null;
}

async function readMe(tx: Tx, userId: string): Promise<Me | null> {
  const r = (await tx.query<{
    name: string; employee_number: string | null; branch_id: string; zone: string; office_phone: string; depot_lon: number; depot_lat: number;
    tech_id: string | null; skill: string | null; van_number: string | null; vehicle: string | null;
  }>(
    `SELECT u.name, u.employee_number, u.branch_id, b.zone, b.office_phone, b.depot_lon, b.depot_lat, t.id AS tech_id, t.primary_skill AS skill,
            v.number AS van_number, v.vehicle
       FROM world."user" u JOIN world.branch b ON b.id = u.branch_id
       LEFT JOIN world.technician t ON t.user_id = u.id LEFT JOIN world.van v ON v.id = t.van_id
      WHERE u.id = $1`, [userId])).rows[0];
  if (!r) return null;
  return {
    userId, name: r.name, employeeNumber: r.employee_number, branch: r.branch_id, zone: r.zone, officePhone: r.office_phone,
    depot: { lon: r.depot_lon, lat: r.depot_lat },
    technician: r.tech_id ? { id: r.tech_id, skill: r.skill ?? '', van: r.van_number ? { number: r.van_number, vehicle: r.vehicle ?? '' } : null } : null,
  };
}

interface StopRow {
  job_number: number; version: number; status: string; on_the_way_at: Date | null; ended_at: Date | null; window_start: Date; window_end: Date; customer: string; area: string;
  address: string; label_key: string; lon: number; lat: number;
}

/** A technician's jobs of 1 day in the day's order (window, then planned arrival, then job number); a canceled job leaves the list. */
async function dayJobs(tx: Queryable, technicianId: string, date: string): Promise<StopRow[]> {
  return (await tx.query<StopRow>(
    `SELECT j.job_number, j.version, j.status, j.on_the_way_at, j.ended_at, j.window_start, j.window_end, c.name AS customer, ${areaSql('s.city', 's.zip')} AS area,
            c.house_number || ' ' || s.name || ', ' || s.city AS address, st.screen_label_key AS label_key, c.lon, c.lat
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street s ON s.id = c.street_id JOIN world.service_type st ON st.id = j.service_id
      WHERE j.technician_id = $1 AND j.date = $2::date AND j.status <> 'canceled'
      ORDER BY j.window_start, j.planned_arrival NULLS LAST, j.job_number`, [technicianId, date])).rows;
}

const ENDED = new Set(['done', 'no_one_home']);
const AT_WORK = new Set(['on_the_way', 'on_site']);
const todayOf = (now: Temporal.Instant, zone: string): string => now.toZonedDateTimeISO(zone).toPlainDate().toString();

/** API-104: the leg to a job of the caller's, from another job of theirs or, with none given, from the van's computed position ({@link legFromVanTo}). */
export const techRouteHandler: Handler<z.output<typeof techRoute.response>> = async (req, tx) => {
  if (req.caller.kind !== 'staff') return { ok: false, status: 401, code: 'unauthenticated' };
  const p = req.params as z.output<typeof techRoute.request>;
  const me = await readMe(tx, req.caller.userId);
  if (!me?.technician) return { ok: false, status: 404, code: 'not_found' };
  const own = async (job: number) => (await tx.query<{
    job_number: number; date: string; status: string; on_the_way_at: Date | null; window_start: Date; window_end: Date; lon: number; lat: number;
  }>(
    `SELECT j.job_number, j.date::text AS date, j.status, j.on_the_way_at, j.window_start, j.window_end, c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id
      WHERE j.job_number = $1 AND j.technician_id = $2 AND j.status <> 'canceled'`, [job, me.technician!.id])).rows[0];
  const to = await own(p.toJob);
  if (!to) return { ok: false, status: 404, code: 'not_found' };
  const dest: Dest = { job: to.job_number, lon: to.lon, lat: to.lat, status: to.status, onTheWayAt: to.on_the_way_at };
  let route: Route;
  if (p.fromJob !== undefined) {
    const f = await own(p.fromJob);
    if (!f) return { ok: false, status: 404, code: 'not_found' };
    route = await routeBetween(tx, me.branch, { job: f.job_number, lon: f.lon, lat: f.lat }, dest);
  } else {
    route = await routeFromVanTo(tx, { ...me, technician: me.technician }, to.date, dest, req.demoNow);
  }
  const { leg, steps } = route;
  const arrive = req.demoNow.epochMilliseconds + leg.minutes * 60_000;
  return {
    ok: true, status: 200,
    data: { branch: me.branch, leg, insideWindow: arrive >= to.window_start.getTime() && arrive <= to.window_end.getTime(), steps },
  };
};

/** API-163: today's stops numbered in the day's order, each Done, Next or Later, and the leg into each (FR-TECH-11). */
export const dayRouteHandler: Handler<z.output<typeof dayRoute.response>> = async (req, tx) => {
  if (req.caller.kind !== 'staff') return { ok: false, status: 401, code: 'unauthenticated' };
  const me = await readMe(tx, req.caller.userId);
  if (!me) return { ok: false, status: 404, code: 'not_found' };
  const date = todayOf(req.demoNow, me.zone);
  const rows = me.technician ? await dayJobs(tx, me.technician.id, date) : [];
  // F-1005: a stop's state comes from its status, not its place in the list. An ended job is done wherever it sits; the next stop is
  // the job the technician is on the way to or at (the first such), else the first one not ended; the rest are later.
  const working = rows.findIndex((r) => AT_WORK.has(r.status));
  const nextIdx = working !== -1 ? working : rows.findIndex((r) => !ENDED.has(r.status));
  const stops = rows.map((r, i) => ({
    jobNumber: r.job_number, number: i + 1, customer: r.customer, area: r.area, address: r.address,
    window: { start: wire(r.window_start, me.zone), end: wire(r.window_end, me.zone) }, serviceLabelKey: r.label_key,
    state: (ENDED.has(r.status) ? 'done' : i === nextIdx ? 'next' : 'later') as 'done' | 'next' | 'later', at: { lon: r.lon, lat: r.lat },
  }));
  const legs: z.output<typeof dayRoute.response>['legs'] = [];
  for (const [i, r] of rows.entries()) {
    const from: { job: number | null } & Point = i === 0 ? { job: null, ...me.depot } : { job: rows[i - 1]!.job_number, lon: rows[i - 1]!.lon, lat: rows[i - 1]!.lat };
    const dest: Dest = { job: r.job_number, lon: r.lon, lat: r.lat, status: r.status, onTheWayAt: r.on_the_way_at };
    // the next stop's leg is the one Directions opens with no fromJob (FR-TECH-13), from the van's position (F-1003)
    const leg = i === nextIdx && me.technician
      ? await legFromVanTo(tx, { ...me, technician: me.technician }, date, dest, req.demoNow)
      : await legBetween(tx, me.branch, from, dest);
    legs.push({ ...leg, toJob: r.job_number });
  }
  return { ok: true, status: 200, data: { date, branch: me.branch, stops, legs, next: nextIdx === -1 ? null : rows[nextIdx]!.job_number } };
};
