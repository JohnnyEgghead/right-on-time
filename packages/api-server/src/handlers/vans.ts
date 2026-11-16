// SPDX-License-Identifier: AGPL-3.0-or-later
// API-21 Van positions (P4-BOARD-MAP; UI-SPECIFICATION 12.2; SPECIFICATIONS "Van positions", SD-22, FR-DEMO-8): the branch's vans
// of the technicians working the demo clock's today, each with its position computed on read by positionAt, so nothing is
// stored and the board and the live map draw 1 position. The leg of a van on the way comes back with its track from SD-49's route
// source (baked, else live), so the map draws the road, and with null while the routing service gives no route (FR-MAP-3). No position
// is ever written (FR-DEMO-8); the only write this read can make is the route source's live van_track row for a leg it routed.
// F-817: each route carries the key of its line (routeKey), and a route whose key the board names in `have` answers track null, so a
// leg that does not change between the 10 s reads travels once.
import { createHash } from 'node:crypto';
import type { vanPositions } from '@bw/api';
import { previousStop, worksOn } from '@bw/domain';
import { localDateOf } from '@bw/time';
import type { z } from 'zod';
import { positionAt, type LegTrack } from '../../../maps/src/position.ts';
import { legsFor, type LegStop } from '../../../maps/src/route-source.ts';
import { decodePolyline } from '../../../maps/src/tracks.ts';
import { at, branchTechnicians, wire } from '../office-writes/day.ts';
import type { Handler, Tx } from '../types.ts';
import { branchOf, dayJobs, etas, initialsOf, type JobRow } from './board.ts';

type Answer = z.infer<typeof vanPositions.response>;
type Van = Answer['vans'][number];
type In = z.infer<typeof vanPositions.request>;

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());
const legKey = (from: number | null, to: number): string => `${from ?? 'depot'}|${to}`;
const stopOf = (j: JobRow) => ({
  jobNumber: j.job_number, status: j.status, point: { lon: j.lon, lat: j.lat }, onTheWayAt: ms(j.on_the_way_at), endedAt: ms(j.ended_at),
});

/** F-817 (SPECIFICATIONS 7.4 API-21): a route line's key, the first 16 lowercase hex characters of the SHA-256 of its encoded polyline. */
export const routeKey = (polyline: string): string => createHash('sha256').update(polyline).digest('hex').slice(0, 16);

/** The tracks of the legs wanted from the route source (SD-49), by {@link legKey}; a leg it answers approximate is absent. */
async function legTracks(tx: Tx, branch: string, legs: readonly { from: LegStop; to: LegStop & { job: number } }[]): Promise<Map<string, LegTrack>> {
  const out = new Map<string, LegTrack>();
  const answers = await legsFor(tx, branch, legs);
  answers.forEach((a, i) => {
    const l = legs[i]!;
    if (a.track) out.set(legKey(l.from.job, l.to.job), { polyline: a.track.polyline, seconds: a.track.seconds });
  });
  return out;
}

export const vanPositionsHandler: Handler<Answer> = async (req, tx) => {
  const p = req.params as In;
  const have = new Set(p.have ? p.have.split(',') : []);
  const branch = await branchOf(tx, p.branch);
  if (!branch) return { ok: false, status: 404, code: 'not_found' };
  const now = req.demoNow.epochMilliseconds;
  const date = localDateOf(req.demoNow, branch.zone);
  const depot = { lon: branch.depot_lon, lat: branch.depot_lat };
  const facts = new Map((await tx.query<{ id: string; phone: string; primary_skill: string; skills: string[]; van: string | null; shift_end: string }>(
    `SELECT t.id, t.phone, t.primary_skill, t.skills, v.number AS van, t.shift_end::text AS shift_end
       FROM world.technician t LEFT JOIN world.van v ON v.id = t.van_id WHERE t.branch_id = $1`, [branch.id])).rows.map((f) => [f.id, f]));
  const working = (await branchTechnicians(tx, branch.id)).filter((t) => worksOn(t, date)).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const jobs = await dayJobs(tx, branch.id, date);
  const days = working.map((t) => {
    const mine = jobs.filter((j) => j.technician_id === t.id);
    const stops = mine.map(stopOf);
    const legs = stops.filter((s) => s.status === 'on_the_way').map((s) => {
      const prev = previousStop(stops, s.jobNumber);
      return { from: { job: prev?.jobNumber ?? null, ...(prev?.point ?? depot) }, to: { job: s.jobNumber, ...s.point } };
    });
    return { t, mine, stops, legs };
  });
  const tracks = await legTracks(tx, branch.id, days.flatMap((d) => d.legs));

  const vans: Van[] = [];
  for (const { t, mine, stops } of days) {
    const f = facts.get(t.id);
    if (!f) continue;
    const position = positionAt({
      now, shiftStart: at(date, t.shiftStart, branch.zone).getTime(), shiftEnd: at(date, f.shift_end, branch.zone).getTime(), depot, stops,
      track: (from, to) => tracks.get(legKey(from, to)) ?? null,
    });
    // The van's current job, as positionAt reads it: the newest on the way, else the 1 on site.
    const onWay = stops.filter((s) => s.status === 'on_the_way').sort((x, y) => (y.onTheWayAt ?? 0) - (x.onTheWayAt ?? 0) || y.jobNumber - x.jobNumber)[0];
    const onSite = stops.find((s) => s.status === 'on_site');
    const current = onWay ?? onSite ?? null;
    const eta = current ? (await etas(tx, branch, t, date, mine, now)).get(current.jobNumber) : undefined;
    let route: Van['route'] = null;
    if (onWay) {
      const prev = previousStop(stops, onWay.jobNumber);
      const leg = tracks.get(legKey(prev?.jobNumber ?? null, onWay.jobNumber));
      const key = leg ? routeKey(leg.polyline) : null;
      route = { from: prev?.point ?? depot, to: onWay.point, key, track: leg && key !== null && !have.has(key) ? decodePolyline(leg.polyline) : null };
    }
    vans.push({
      technicianId: t.id, name: t.name, initials: initialsOf(t.name), van: f.van,
      skills: [f.primary_skill, ...f.skills.filter((s) => s !== f.primary_skill)], phone: f.phone, position,
      status: onWay ? 'on_the_way' : onSite ? 'on_site' : 'between_jobs',
      jobNumber: current?.jobNumber ?? null, eta: eta ? wire(new Date(eta.eta), branch.zone) : null, route,
    });
  }
  return { ok: true, status: 200, data: { vans } };
};
