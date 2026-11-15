// SPDX-License-Identifier: AGPL-3.0-or-later
// The customer's live map (P5-LIVEMAP; UI-SPECIFICATION SCR-CUS-04, SCR-CUS-05, API-115, API-116; SPECIFICATIONS SD-17, 6.4 "Live map ends at
// arrival"; FR-TEXT-4, FR-TEXT-22, FR-TEXT-23; NFR-04, invariant 5).
//
// {@link liveMapLinkState} is the 1 rule that says whether a live map link is live or ended, and why. Every reader of a live map link goes
// through it: API-116 here, the page gate's status for the link page (kernel/pages.ts, wired in web.ts), and P5-INBOX's preview picture
// (API-164). A coordinate is read only after it says `live`, so before On my way, after arrival and after an office change nothing about
// the van leaves the database (G-CI5, ci/gates/G-CI5/).
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { liveMapData, liveMapEndedDetail, liveMapPreview } from '@bw/api';
import { Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { loadMapManifest, MAPS_DIR } from '../../../maps/src/manifest.ts';
import { visitPosition } from '../../../maps/src/position.ts';
import { legFor } from '../../../maps/src/route-source.ts';
import { renderPreviewSvg } from '../../../maps/src/preview.ts';
import { decodePolyline } from '../../../maps/src/tracks.ts';
import { readPreviousStop } from '../office-writes/day.ts';
import type { Handler, TokenCheck, Tx } from '../types.ts';
import { initialsOf } from './board.ts';

type Out = z.output<typeof liveMapData.response>;
type In = z.output<typeof liveMapData.request>;

/** Why a link ended: the technician arrived, or the office changed the visit (or the link is not yet, or no longer, a trip in progress). */
export type LinkEnd = 'arrived' | 'changed';
export type LinkState = { live: true } | { live: false; reason: LinkEnd };

/** What the rule reads: the link's own stamps and the job's status and stamps (all epoch milliseconds, null when unset). */
export interface LinkFacts {
  endedAt: number | null;
  job: { status: string; onTheWayAt: number | null; arrivedAt: number | null; technicianId: string | null };
}

/**
 * THE link-ended rule (FR-TEXT-4, NFR-04). A live map link is live only from On my way until arrival: the job is `on_the_way`, the demo clock
 * has reached the moment it left, and nothing ended the link. It is ended when
 *   - `ended_at` is set (an arrival sets it; so does the office's cancel, reassign or reschedule of a trip in progress, owner ruling 2142ce69), or
 *   - the job is no longer `on_the_way`, or
 *   - the job has no technician or no departure stamp (nobody is driving, F-949), or
 *   - the clock is before the moment the technician left (before On my way, after a clock jump back).
 * The reason is `arrived` only when the job's arrival is stamped at or before the end; every other end is `changed`, so a link that ended
 * by an office change never claims an arrival, and a visit never shows a van that was not this link's.
 */
export function liveMapLinkState(f: LinkFacts, now: number): LinkState {
  const arrived = f.job.arrivedAt !== null && (f.endedAt === null || f.job.arrivedAt <= f.endedAt);
  const reason: LinkEnd = arrived ? 'arrived' : 'changed';
  if (f.endedAt !== null) return { live: false, reason };
  if (f.job.status !== 'on_the_way') return { live: false, reason };
  if (f.job.technicianId === null || f.job.onTheWayAt === null || now < f.job.onTheWayAt) return { live: false, reason: 'changed' };
  return { live: true };
}

interface LinkRead {
  token: string;
  createdAt: Date;
  endedAt: Date | null;
  job: {
    jobNumber: number; status: string; zone: string; branchId: string; date: string; serviceLabelKey: string; windowStart: Date; windowEnd: Date;
    onTheWayAt: Date | null; arrivedAt: Date | null; textedArrival: Date | null; plannedArrival: Date | null; technicianId: string | null;
    techName: string | null; van: string | null; officePhone: string;
  };
}

/** The link and its job, by token; null for no such live map link. No coordinate is read here. */
export async function readLiveMapLink(tx: Tx, token: string): Promise<LinkRead | null> {
  const r = (await tx.query<{
    token: string; created_at: Date; ended_at: Date | null; job_number: number; status: string; zone: string; branch_id: string; date: string;
    screen_label_key: string; window_start: Date; window_end: Date; on_the_way_at: Date | null; arrived_at: Date | null; texted_arrival: Date | null;
    planned_arrival: Date | null; technician_id: string | null; tech_name: string | null; van: string | null; office_phone: string;
  }>(
    `SELECT l.token, l.created_at, l.ended_at, j.job_number, j.status, j.zone, j.branch_id, j.date::text AS date, s.screen_label_key, j.window_start, j.window_end,
            j.on_the_way_at, j.arrived_at, j.texted_arrival, j.planned_arrival, j.technician_id, t.name AS tech_name, v.number AS van, b.office_phone
       FROM world.link_token l JOIN world.job j ON j.job_number = l.job_number JOIN world.service_type s ON s.id = j.service_id
       JOIN world.branch b ON b.id = j.branch_id LEFT JOIN world.technician t ON t.id = j.technician_id LEFT JOIN world.van v ON v.id = t.van_id
      WHERE l.token = $1 AND l.kind = 'live_map'`, [token])).rows[0];
  if (!r) return null;
  return {
    token: r.token, createdAt: r.created_at, endedAt: r.ended_at,
    job: {
      jobNumber: r.job_number, status: r.status, zone: r.zone, branchId: r.branch_id, date: r.date, serviceLabelKey: r.screen_label_key,
      windowStart: r.window_start, windowEnd: r.window_end, onTheWayAt: r.on_the_way_at, arrivedAt: r.arrived_at, textedArrival: r.texted_arrival,
      plannedArrival: r.planned_arrival, technicianId: r.technician_id, techName: r.tech_name, van: r.van, officePhone: r.office_phone,
    },
  };
}

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());
const wire = (d: Date, zone: string): string => toWire(Temporal.Instant.fromEpochMilliseconds(d.getTime()), zone);

/** The rule over a read link at demo time `now`. */
export const stateOfLink = (l: LinkRead, now: number): LinkState =>
  liveMapLinkState({ endedAt: ms(l.endedAt), job: { status: l.job.status, onTheWayAt: ms(l.job.onTheWayAt), arrivedAt: ms(l.job.arrivedAt), technicianId: l.job.technicianId } }, now);

/** The kernel's token check for a live map route: a known link passes; the handler decides gone (mount.ts). */
export const liveMapTokenCheck: TokenCheck = async (token, tx) => (await tx.query(`SELECT 1 FROM world.link_token WHERE token = $1 AND kind = 'live_map'`, [token])).rows.length > 0;

/**
 * Does the live map link `token` answer 410 at demo time `now`? The page gate's question for the link page (kernel/pages.ts). A link that does
 * not exist is not ended here (it is a 404 page).
 */
export async function liveMapLinkEnded(tx: Tx, token: string, now: number): Promise<boolean> {
  const l = await readLiveMapLink(tx, token);
  return l !== null && !stateOfLink(l, now).live;
}

/**
 * The 410 of a live map link that has ended, for API-116 and API-164 alike: no coordinate in the body (FR-TEXT-4, NFR-04). Reason `changed`: only
 * the office phone, so no old van, technician or window shows.
 */
export function endedAnswer(l: LinkRead, reason: LinkEnd): { ok: false; status: 410; code: 'gone'; detail: z.output<typeof liveMapEndedDetail> } {
  const j = l.job;
  const byArrival = reason === 'arrived';
  return {
    ok: false, status: 410, code: 'gone',
    detail: {
      reason,
      arrivedAt: byArrival && j.arrivedAt ? wire(j.arrivedAt, j.zone) : null,
      visit: byArrival ? { serviceLabelKey: j.serviceLabelKey, day: j.date, window: { start: wire(j.windowStart, j.zone), end: wire(j.windowEnd, j.zone) } } : null,
      technician: byArrival && j.techName ? { name: j.techName, initials: initialsOf(j.techName), van: j.van } : null,
      officePhone: j.officePhone,
    },
  };
}

/** API-116: the van, the minutes away and the trip while the link is live; visit facts and the office phone, never a coordinate, once it is not. */
export const liveMapDataHandler: Handler<Out> = async (req, tx) => {
  const { liveMapToken } = req.params as In;
  const l = await readLiveMapLink(tx, liveMapToken);
  if (!l) return { ok: false, status: 404, code: 'not_found' };
  const now = req.demoNow.epochMilliseconds;
  const state = stateOfLink(l, now);
  const j = l.job;
  if (!state.live) return endedAnswer(l, state.reason);
  // Live: the job is on the way, its technician and departure are set (liveMapLinkState). Only now is a coordinate read.
  if (!j.technicianId || !j.onTheWayAt) throw new Error('a live link has a technician and a departure stamp');
  const where = (await tx.query<{ lon: number; lat: number; depot_lon: number; depot_lat: number }>(
    `SELECT c.lon, c.lat, b.depot_lon, b.depot_lat FROM world.job x JOIN world.customer c ON c.id = x.customer_id JOIN world.branch b ON b.id = x.branch_id WHERE x.job_number = $1`,
    [j.jobNumber])).rows[0]!;
  const prev = await readPreviousStop(tx, j.technicianId, j.date, j.jobNumber);
  const from = prev ? { lon: prev.lon, lat: prev.lat } : { lon: where.depot_lon, lat: where.depot_lat };
  const to = { lon: where.lon, lat: where.lat };
  // SD-49: the leg's track from the route source (baked, else live), else approximate.
  const track = (await legFor(tx, j.branchId, { job: prev?.jobNumber ?? null, ...from }, { job: j.jobNumber, ...to })).track;
  const point = visitPosition({ status: j.status, onTheWayAt: j.onTheWayAt.getTime(), now, from, to, track });
  const eta = j.textedArrival ?? j.plannedArrival;
  return {
    ok: true, status: 200,
    data: {
      branch: j.branchId,
      technician: { name: j.techName ?? '', initials: initialsOf(j.techName ?? ''), van: j.van },
      visit: { serviceLabelKey: j.serviceLabelKey, day: j.date, window: { start: wire(j.windowStart, j.zone), end: wire(j.windowEnd, j.zone) } },
      eta: eta ? wire(eta, j.zone) : null,
      minutesAway: eta ? Math.max(0, Math.ceil((eta.getTime() - now) / 60_000)) : null,
      leftAt: wire(j.onTheWayAt, j.zone),
      van: point ? { lon: point.lon, lat: point.lat, source: track ? 'track' : 'approximate' } : null,
      destination: to,
      route: { from, to, track: track ? decodePolyline(track.polyline) : null },
      officePhone: j.officePhone,
    },
  };
};

/** The branch's own PMTiles file around a point (the one whose box holds it), or null when none is on disk (the picture then has no roads). */
function mapFileAround(lon: number, lat: number): string | null {
  const dir = process.env.MAPS_DIR ?? MAPS_DIR;
  const a = loadMapManifest().assets.find((x) => x.kind === 'pmtiles' && x.bbox && lon >= x.bbox[0] && lon <= x.bbox[2] && lat >= x.bbox[1] && lat <= x.bbox[3]);
  const file = a ? path.join(dir, a.asset) : null;
  return file && existsSync(file) ? file : null;
}

/**
 * API-164: the inbox's picture of the destination. The same rule as API-116 decides (liveMapLinkState, F-949: no technician or no departure stamp
 * ends it too); a coordinate is read only once it says `live`, and the picture holds none (the pin is the middle of the picture, no van).
 */
export const liveMapPreviewHandler: Handler<z.output<typeof liveMapPreview.response>> = async (req, tx) => {
  const { liveMapToken } = req.params as z.output<typeof liveMapPreview.request>;
  const l = await readLiveMapLink(tx, liveMapToken);
  if (!l) return { ok: false, status: 404, code: 'not_found' };
  const state = stateOfLink(l, req.demoNow.epochMilliseconds);
  if (!state.live) return endedAnswer(l, state.reason);
  const to = (await tx.query<{ lon: number; lat: number }>('SELECT c.lon, c.lat FROM world.job x JOIN world.customer c ON c.id = x.customer_id WHERE x.job_number = $1', [l.job.jobNumber])).rows[0]!;
  return {
    ok: true, status: 200,
    data: { svg: renderPreviewSvg(mapFileAround(to.lon, to.lat), to), altKey: 'inbox.previewAlt', captionKey: 'inbox.previewCaption', technician: (l.job.techName ?? '').split(' ')[0] ?? '' },
  };
};
