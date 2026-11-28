// SPDX-License-Identifier: AGPL-3.0-or-later
// The job page's reads and its 2 small writes (P4-JOB; UI-SPECIFICATION 12.2 API-23, API-29, API-37, API-107, API-110,
// API-135, API-140, API-142). Each read runs in the handler's 1 transaction (SD-6) and answers wall times in the job's
// branch zone (12.1 item 5). The job page's history (API-23) follows SPECIFICATIONS section 6.2: the old system's past visits together
// with the customer's done jobs, newest first, the last 3 and the count. The on-the-way read (API-135) answers the van only while the job is On
// the way (invariant 5, NFR-04): the point is computed from the leg's track (SD-49: baked, else live) and the clock (SD-22, @bw/maps).
import type {
  addEquipment as addEquipmentRow, addOfficeNote as addOfficeNoteRow, editEquipment as editEquipmentRow, inboxLink as inboxLinkRow, jobDetail as jobDetailRow,
  jobOnTheWay as jobOnTheWayRow, officeAvailability as availabilityRow, partsList as partsListRow, services as servicesRow,
} from '@bw/api';
import { publishEvent } from '@bw/db';
import { areaName } from '@bw/domain';
// @bw/maps is a workspace package no app lists as a dependency; it is imported by path, as packages/setup does.
import { visitPosition } from '../../../maps/src/position.ts';
import { legFor } from '../../../maps/src/route-source.ts';
import { addDays, localDateOf, Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { branchWindows, officeDays, readDayKinds, readPreviousStop, roomInWindow, serviceIsInstall, skilledRoomCounter, windowOffered } from '../office-writes/day.ts';
import { OFFICE_HORIZON_DAYS } from '../office-writes/service.ts';
import type { ApiResult, Handler, Tx } from '../types.ts';
import { initialsOf } from './board.ts';
import { officeContext } from './job-page.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

const instant = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const w = (d: Date, zone: string) => toWire(instant(d), zone);
const wn = (d: Date | null, zone: string) => (d ? w(d, zone) : null);
const notFound = { ok: false as const, status: 404, code: 'not_found' as const };

interface JobRow {
  job_number: number; version: number; status: Out<typeof jobDetailRow>['job']['status']; branch_id: string; zone: string; date: string;
  window_id: string; window_start: Date; window_end: Date; service_id: string; screen_label_key: string; job_type: string; expected_minutes: number;
  problem: string | null; equipment_id: string | null; booked_via: string; booked_at: Date; technician_id: string | null; tech_name: string | null;
  van: string | null; skill: string | null; planned_arrival: Date | null; confirmed_at: Date | null; on_the_way_at: Date | null;
  arrived_at: Date | null; ended_at: Date | null; labor_minutes: number | null; no_parts_used: boolean; billing_state: Out<typeof jobDetailRow>['billing']['state'];
  customer_id: string;
}

/** API-23: the job, its customer, equipment, history, notes, photos, timeline, texts, finish lines, signature and billing. */
export const jobDetailHandler: Handler<Out<typeof jobDetailRow>> = async (req, tx: Tx) => {
  const { jobNumber } = req.params as In<typeof jobDetailRow>;
  const j = (await tx.query<JobRow>(
    `SELECT j.job_number, j.version, j.status, j.branch_id, j.zone, j.date::text AS date, j.window_id, j.window_start, j.window_end,
            j.service_id, s.screen_label_key, s.job_type, j.expected_minutes, j.problem, j.equipment_id, j.booked_via, j.booked_at,
            j.technician_id, t.name AS tech_name, v.number AS van, t.primary_skill AS skill, j.planned_arrival, j.confirmed_at,
            j.on_the_way_at, j.arrived_at, j.ended_at, j.labor_minutes, j.no_parts_used, j.billing_state, j.customer_id
       FROM world.job j JOIN world.service_type s ON s.id = j.service_id
       LEFT JOIN world.technician t ON t.id = j.technician_id LEFT JOIN world.van v ON v.id = t.van_id
      WHERE j.job_number = $1`, [jobNumber])).rows[0];
  if (!j) return notFound;
  const z0 = j.zone;
  const c = (await tx.query<{
    id: string; name: string; mobile: string | null; home_phone: string | null; texts_on: boolean; text_language: 'en' | 'es'; zone: string;
    house_number: number; street: string; city: string; zip: string; customer_since: string; member: boolean;
  }>(`SELECT c.id, c.name, c.mobile, c.home_phone, c.texts_on, c.text_language, c.zone, c.house_number, st.name AS street, st.city, st.zip,
             c.customer_since::text AS customer_since, (m.customer_id IS NOT NULL) AS member
        FROM world.customer c JOIN world.street st ON st.id = c.street_id LEFT JOIN world.membership m ON m.customer_id = c.id
       WHERE c.id = $1`, [j.customer_id])).rows[0]!;
  const equipment = (await tx.query<{ id: string; type: string; year: number | null; location: string | null; details: string | null }>(
    'SELECT id, type, year, location, details FROM world.equipment WHERE customer_id = $1 ORDER BY type, id', [c.id])).rows;
  const visits = (await tx.query<{ date: string; what: string | null; label: string | null; technician: string | null; old: boolean; job_number: number | null; work_done: string[] }>(
    `SELECT date::text AS date, service_text AS what, NULL AS label, technician_name AS technician, true AS old, NULL::int AS job_number,
            CASE WHEN btrim(coalesce(work_done, '')) = '' THEN ARRAY[]::text[] ELSE ARRAY[work_done] END AS work_done
       FROM world.past_visit WHERE customer_id = $1
     UNION ALL
     SELECT j.date::text, NULL, s.screen_label_key, t.name, false, j.job_number,
            coalesce((SELECT array_agg(w.text ORDER BY w.seq) FROM world.work_done_line w WHERE w.job_number = j.job_number), ARRAY[]::text[])
       FROM world.job j JOIN world.service_type s ON s.id = j.service_id LEFT JOIN world.technician t ON t.id = j.technician_id
      WHERE j.customer_id = $1 AND j.status = 'done' AND j.job_number <> $2
     ORDER BY 1 DESC, 6 DESC NULLS LAST`, [c.id, j.job_number])).rows;
  const readNotes = async (where: string, key: number | string) => (await tx.query<{ id: string; author_kind: 'office' | 'technician'; author: string | null; body: string; entered_at: Date; sent_at: Date; entered_offline: boolean }>(
    `SELECT n.id, n.author_kind, u.name AS author, n.body, n.entered_at, n.sent_at, n.entered_offline
       FROM world.note n LEFT JOIN world."user" u ON u.id = n.author_user_id
      WHERE ${where} = $1 ORDER BY n.entered_at DESC, n.id DESC`, [key])).rows
    .map((n) => ({ id: n.id, kind: n.author_kind, author: n.author, body: n.body, at: w(n.entered_at, z0), sentAt: w(n.sent_at, z0), enteredOffline: n.entered_offline }));
  const notes = await readNotes('n.job_number', j.job_number);
  const customerNotes = await readNotes('n.customer_id', c.id);
  const photos = (await tx.query<{ key: string; by: string | null; entered_at: Date }>(
    `SELECT p.key, t.name AS by, p.entered_at FROM world.photo p LEFT JOIN world.technician t ON t.id = p.technician_id
      WHERE p.job_number = $1 ORDER BY p.entered_at, p.key`, [j.job_number])).rows;
  const changes = (await tx.query<{ kind: string; at: Date; by: string | null; actor_kind: Out<typeof jobDetailRow>['timeline'][number]['byKind']; data: Record<string, unknown> }>(
    `SELECT c.kind, c.at, u.name AS by, c.actor_kind, c.data FROM world.job_change c LEFT JOIN world."user" u ON u.id = c.actor_user_id
      WHERE c.job_number = $1 ORDER BY c.at, c.id`, [j.job_number])).rows;
  const texts = (await tx.query<{ id: string; kind: string; status: string; created_at: Date; body: string }>(
    'SELECT id, kind, status, created_at, body FROM world.outbox_text WHERE job_number = $1 ORDER BY created_at, id', [j.job_number])).rows;
  const parts = (await tx.query<{ part_id: string; name: string; code: string; quantity: number }>(
    `SELECT p.id::text AS part_id, p.name, p.code, jp.quantity FROM world.job_part jp JOIN world.part p ON p.id = jp.part_id
      WHERE jp.job_number = $1 ORDER BY p.code`, [j.job_number])).rows;
  const workDone = (await tx.query<{ text: string }>('SELECT text FROM world.work_done_line WHERE job_number = $1 ORDER BY seq', [j.job_number])).rows;
  const signature = (await tx.query<{ key: string; signed_by_name: string; signed_at: Date }>('SELECT key::text AS key, signed_by_name, signed_at FROM world.signature WHERE job_number = $1 LIMIT 1', [j.job_number])).rows[0];
  const billing = (await tx.query<{ reason_key: string | null }>('SELECT reason_key FROM world.billing_item WHERE job_number = $1', [j.job_number])).rows[0];

  const noOneHome = j.status === 'no_one_home'
    ? (() => { const r = [...changes].reverse().find((x) => x.data?.['to'] && (x.data['to'] as Record<string, unknown>)['status'] === 'no_one_home'); return { by: r?.by ?? j.tech_name, at: w(j.ended_at ?? j.window_start, z0) }; })()
    : null;
  const flat = (data: Record<string, unknown>): Record<string, string | number | boolean | null> => {
    const out: Record<string, string | number | boolean | null> = {};
    const put = (k: string, v: unknown) => { if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v as string | number | boolean | null; };
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) put(`${k}.${k2}`, v2);
      else put(k, v);
    }
    return out;
  };
  const done = j.status === 'done';
  return {
    ok: true, status: 200, data: {
      job: {
        jobNumber: j.job_number, version: j.version, status: j.status, branch: j.branch_id, zone: z0, date: j.date, windowId: j.window_id,
        window: { start: w(j.window_start, z0), end: w(j.window_end, z0) }, serviceId: j.service_id, serviceLabelKey: j.screen_label_key,
        jobType: j.job_type, expectedMinutes: j.expected_minutes, problem: j.problem, equipmentId: j.equipment_id, bookedVia: j.booked_via,
        bookedAt: w(j.booked_at, z0),
        technician: j.technician_id ? { id: j.technician_id, name: j.tech_name ?? '', initials: initialsOf(j.tech_name ?? ''), van: j.van, skill: j.skill ?? '' } : null,
        plannedArrival: wn(j.planned_arrival, z0), confirmed: j.confirmed_at !== null, onTheWayAt: wn(j.on_the_way_at, z0),
        arrivedAt: wn(j.arrived_at, z0), endedAt: wn(j.ended_at, z0), noOneHome,
      },
      customer: {
        id: c.id, name: c.name, mobile: c.mobile, phone: c.mobile ?? c.home_phone, textsOn: c.texts_on, language: c.text_language, zone: c.zone,
        address: `${c.house_number} ${c.street}, ${c.city} ${c.zip}`, area: areaName(c.city, c.zip), customerSince: c.customer_since,
        pastVisitCount: visits.length, plan: c.member ? 'comfort_club' : null, notes: customerNotes,
      },
      equipment,
      history: {
        count: visits.length, fromOldSystem: visits.some((v) => v.old),
        visits: visits.slice(0, 3).map((v) => ({ date: v.date, what: v.what, serviceLabelKey: v.label, technician: v.technician, oldSystem: v.old, jobNumber: v.job_number, workDone: v.work_done })),
      },
      notes,
      photos: photos.map((p) => ({ key: p.key, by: p.by, at: w(p.entered_at, z0) })),
      timeline: changes.map((x) => ({ kind: x.kind, at: w(x.at, z0), by: x.by, byKind: x.actor_kind, values: flat(x.data) })),
      texts: texts.map((t) => ({ id: t.id, kind: t.kind, status: t.status, at: w(t.created_at, z0), body: t.body })),
      finish: done ? { parts: parts.map((p) => ({ partId: p.part_id, name: p.name, code: p.code, quantity: p.quantity })), noPartsUsed: j.no_parts_used, laborMinutes: j.labor_minutes, workDone: workDone.map((x) => x.text) } : null,
      signature: signature ? { key: signature.key, signedBy: signature.signed_by_name, at: w(signature.signed_at, z0) } : null,
      billing: { state: j.billing_state, reasonKey: billing?.reason_key ?? null },
    },
  };
};

/** API-107: the fixed seeded parts list in full (OA-54); the client searches it by name or code. */
export const partsListHandler: Handler<Out<typeof partsListRow>> = async (_req, tx: Tx) => {
  const r = await tx.query<{ id: string; name: string; code: string; price_cents: number }>('SELECT id::text AS id, name, code, price_cents FROM world.part ORDER BY name, code');
  return { ok: true, status: 200, data: { parts: r.rows.map((p) => ({ partId: p.id, name: p.name, code: p.code, priceCents: p.price_cents })) } };
};

/** API-110: the services, each by its catalog keys (FR-BOOK-1). */
export const servicesHandler: Handler<Out<typeof servicesRow>> = async (_req, tx: Tx) => {
  const r = await tx.query<{ id: string; screen_label_key: string; price_text_key: string; typical_length_key: string; bookable_online: boolean }>(
    'SELECT id, screen_label_key, price_text_key, typical_length_key, bookable_online FROM world.service_type ORDER BY id');
  return { ok: true, status: 200, data: { services: r.rows.map((s) => ({ serviceId: s.id, screenLabelKey: s.screen_label_key, priceTextKey: s.price_text_key, typicalLengthKey: s.typical_length_key, bookableOnline: s.bookable_online })) } };
};

const MAX_AVAILABILITY_DAYS = OFFICE_HORIZON_DAYS + 1;

/**
 * API-29 (office channel, FR-DISP-8): each day's mode and room and each offered window's room, from demo today to the horizon. A window's
 * `left` is the technicians with the service's skill and room in it, at most its windowRoom; a day's is dayRoom for the service (F-801).
 * `state` stays windowRoom's, the same room API-28 and API-24 refuse on: a window no skilled technician has room in can still take the job
 * with no technician yet (FR-DISP-8), so it answers open with 0 left.
 */
export const officeAvailabilityHandler: Handler<Out<typeof availabilityRow>> = async (req, tx: Tx) => {
  const p = req.params as In<typeof availabilityRow>;
  const b = (await tx.query<{ zone: string }>('SELECT zone FROM world.branch WHERE id = $1', [p.branch])).rows[0];
  if (!b) return { ok: false, status: 422, code: 'validation_failed' };
  const install = await serviceIsInstall(tx, p.serviceId);
  if (install === null) return { ok: false, status: 422, code: 'validation_failed' };
  const today = localDateOf(req.demoNow, b.zone);
  const last = addDays(today, OFFICE_HORIZON_DAYS);
  const windows = await branchWindows(tx, p.branch);
  const first = p.from < today ? today : p.from;
  const exclude = p.jobNumber ? { excludeJob: p.jobNumber } : {};
  const skilledWithRoom = await skilledRoomCounter(tx, { branch: p.branch, serviceId: p.serviceId, from: first, to: p.to < last ? p.to : last, ...exclude });
  const days: Out<typeof availabilityRow>['days'] = [];
  // K-09.6: the range's dates are known up front, so day kinds and day plans are read in 1 query each, not 1 per day.
  const dates: string[] = [];
  for (let d = first, i = 0; d <= p.to && d <= last && i < MAX_AVAILABILITY_DAYS; d = addDays(d, 1), i++) dates.push(d);
  const kinds = await readDayKinds(tx, p.branch, dates);
  const plans = await officeDays(tx, { branch: p.branch, kinds, install, ...exclude });
  for (const d of dates) {
    const kind = kinds.get(d)!;
    const day = plans.get(d)!;
    const offered = windows.filter((x) => windowOffered(x, kind));
    const out = [];
    for (const x of offered) {
      const room = roomInWindow(day, x);
      out.push({ windowId: x.id, start: toWire(Temporal.ZonedDateTime.from(`${d}T${x.startLocal.slice(0, 5)}:00[${b.zone}]`).toInstant(), b.zone),
        end: toWire(Temporal.ZonedDateTime.from(`${d}T${x.endLocal.slice(0, 5)}:00[${b.zone}]`).toInstant(), b.zone), state: room > 0 ? 'open' as const : 'full' as const,
        left: Math.min(skilledWithRoom(d, x, kind), room) });
    }
    const closed = kind === 'sunday';
    const open = out.some((x) => x.state === 'open');
    days.push({ date: d, mode: kind, state: closed ? 'closed' : open ? 'open' : 'full', reason: closed ? 'sunday' : open ? null : 'full', left: day.room, windows: out });
  }
  return { ok: true, status: 200, data: { days } };
};

/** API-135: the van while the job is On the way, its minutes away and arrival; nothing about the van otherwise (NFR-04). */
export const jobOnTheWayHandler: Handler<Out<typeof jobOnTheWayRow>> = async (req, tx: Tx) => {
  const { jobNumber } = req.params as In<typeof jobOnTheWayRow>;
  const j = (await tx.query<{ status: string; zone: string; branch_id: string; on_the_way_at: Date | null; texted_arrival: Date | null; window_start: Date; window_end: Date;
    planned_arrival: Date | null; lon: number; lat: number; technician_id: string | null; date: string; name: string | null; phone: string | null; skill: string | null; van: string | null;
    depot_lon: number; depot_lat: number }>(
    `SELECT j.status, j.zone, j.branch_id, j.on_the_way_at, j.texted_arrival, j.window_start, j.window_end, j.planned_arrival, c.lon, c.lat, j.technician_id,
            j.date::text AS date, t.name, t.phone, t.primary_skill AS skill, v.number AS van, b.depot_lon, b.depot_lat
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.branch b ON b.id = j.branch_id
       LEFT JOIN world.technician t ON t.id = j.technician_id LEFT JOIN world.van v ON v.id = t.van_id
      WHERE j.job_number = $1`, [jobNumber])).rows[0];
  if (!j) return notFound;
  const none = { onTheWay: false, van: null, destination: null, eta: null, minutesAway: null, insideWindow: null, technician: null, linkSentAt: null };
  // UI-SPECIFICATION 12.2 API-135 (F-868, NFR-04): after arrival the answer is 410 with no coordinates; before On the way, nothing about the van.
  if (j.status === 'on_site' || j.status === 'done' || j.status === 'no_one_home') return { ok: false, status: 410, code: 'gone' };
  if (j.status !== 'on_the_way' || !j.technician_id) return { ok: true, status: 200, data: none };
  const prev = await readPreviousStop(tx, j.technician_id, j.date, jobNumber);
  // SD-49: the leg's track from the route source (baked, else live), else approximate.
  const from = prev ? { lon: prev.lon, lat: prev.lat } : { lon: j.depot_lon, lat: j.depot_lat };
  const to = { lon: j.lon, lat: j.lat };
  const track = (await legFor(tx, j.branch_id, { job: prev?.jobNumber ?? null, ...from }, { job: jobNumber, ...to })).track;
  const now = req.demoNow.epochMilliseconds;
  const point = visitPosition({ status: j.status, onTheWayAt: j.on_the_way_at?.getTime() ?? null, now, from, to, track });
  const eta = j.texted_arrival ?? j.planned_arrival;
  const minutesAway = eta ? Math.max(0, Math.ceil((eta.getTime() - now) / 60_000)) : null;
  const link = (await tx.query<{ created_at: Date }>(`SELECT created_at FROM world.link_token WHERE job_number = $1 AND kind = 'live_map' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`, [jobNumber])).rows[0];
  return {
    ok: true, status: 200, data: {
      onTheWay: true, van: point ? { lon: point.lon, lat: point.lat, source: track ? 'track' : 'approximate' } : null, destination: { lon: j.lon, lat: j.lat },
      eta: wn(eta, j.zone), minutesAway, insideWindow: eta ? eta.getTime() >= j.window_start.getTime() && eta.getTime() <= j.window_end.getTime() : null,
      technician: { name: j.name ?? '', initials: initialsOf(j.name ?? ''), van: j.van, skill: j.skill ?? '', phone: j.phone ?? '' },
      linkSentAt: link ? w(link.created_at, j.zone) : null,
    },
  };
};

/** API-37: the customer's text inbox page (SCR-INB-01, UD-12), by its inbox token. */
export const inboxLinkHandler: Handler<Out<typeof inboxLinkRow>> = async (req, tx: Tx) => {
  const { customerId } = req.params as In<typeof inboxLinkRow>;
  const r = (await tx.query<{ inbox_token: string }>('SELECT inbox_token FROM world.customer WHERE id = $1', [customerId])).rows[0];
  if (!r) return notFound;
  return { ok: true, status: 200, data: { url: `/inbox/${encodeURIComponent(r.inbox_token)}` } };
};

/** API-140: an office note on a job or a customer, append-only (D14), with its author and the demo time. */
export const addOfficeNoteHandler: Handler<Out<typeof addOfficeNoteRow>> = async (req, tx: Tx): Promise<ApiResult<Out<typeof addOfficeNoteRow>>> => {
  const p = req.params as In<typeof addOfficeNoteRow>;
  if ((p.jobNumber === undefined) === (p.customerId === undefined)) return { ok: false, status: 422, code: 'validation_failed' };
  const ctx = officeContext(req);
  let customerId = p.customerId ?? null;
  let job: { version: number; branch_id: string; zone: string } | null = null;
  if (p.jobNumber !== undefined) {
    const r = (await tx.query<{ customer_id: string; version: number; branch_id: string; zone: string }>('SELECT customer_id, version, branch_id, zone FROM world.job WHERE job_number = $1 FOR UPDATE', [p.jobNumber])).rows[0];
    if (!r) return notFound;
    customerId = r.customer_id;
    job = r;
  }
  const c = (await tx.query<{ zone: string }>(`SELECT zone FROM world.customer WHERE id = $1 AND status = 'active' FOR KEY SHARE`, [customerId])).rows[0];
  if (!c) return notFound;
  const n = (await tx.query<{ id: string }>(
    `INSERT INTO world.note (job_number, customer_id, author_user_id, author_kind, body, entered_at, sent_at, entered_offline)
     VALUES ($1, $2, $3, 'office', $4, $5, $5, false) RETURNING id`,
    [p.jobNumber ?? null, p.jobNumber === undefined ? customerId : null, ctx.actor.userId, p.body, ctx.at])).rows[0]!;
  if (job && p.jobNumber !== undefined) {
    await tx.query(`INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
                    VALUES ($1, $2, $3, 'office', 'note_added', $4, $4, $5::jsonb)`, [p.jobNumber, ctx.at, ctx.actor.userId, job.version, JSON.stringify({ noteId: n.id })]);
    await publishEvent(tx, 'job.changed', { jobNumber: p.jobNumber, branch: job.branch_id });
  }
  const author = (await tx.query<{ name: string }>('SELECT name FROM world."user" WHERE id = $1', [ctx.actor.userId])).rows[0]?.name ?? '';
  return { ok: true, status: 201, data: { note: { id: n.id, author, at: w(ctx.at, job?.zone ?? c.zone) } } };
};

/** API-141: add a piece of equipment to a customer (FR-DISP-31; SCR-OFC-37 add mode). */
export const addEquipmentHandler: Handler<Out<typeof addEquipmentRow>> = async (req, tx: Tx) => {
  const p = req.params as In<typeof addEquipmentRow>;
  if (!(await tx.query(`SELECT 1 FROM world.customer WHERE id = $1 AND status = 'active' FOR KEY SHARE`, [p.customerId])).rows[0]) return notFound;
  const e = (await tx.query<{ id: string; type: string; year: number | null; location: string | null; details: string | null }>(
    `INSERT INTO world.equipment (customer_id, type, year, location, details) VALUES ($1, $2, $3, $4, $5) RETURNING id, type, year, location, details`,
    [p.customerId, p.type, p.year ?? null, p.location || null, p.details || null])).rows[0]!;
  return { ok: true, status: 201, data: { equipment: e } };
};

/** API-142: edit a piece of equipment (FR-DISP-27); a field left out keeps its value. */
export const editEquipmentHandler: Handler<Out<typeof editEquipmentRow>> = async (req, tx: Tx) => {
  const p = req.params as In<typeof editEquipmentRow>;
  const sets: string[] = [];
  const values: unknown[] = [p.equipmentId];
  for (const [k, v] of [['type', p.type], ['year', p.year], ['location', p.location], ['details', p.details]] as const) {
    if (v === undefined) continue;
    values.push(v === '' ? null : v);
    sets.push(`${k} = $${values.length}`);
  }
  const r = sets.length === 0
    ? await tx.query<{ id: string; type: string; year: number | null; location: string | null; details: string | null }>('SELECT id, type, year, location, details FROM world.equipment WHERE id = $1', values)
    : await tx.query<{ id: string; type: string; year: number | null; location: string | null; details: string | null }>(`UPDATE world.equipment SET ${sets.join(', ')} WHERE id = $1 RETURNING id, type, year, location, details`, values);
  const e = r.rows[0];
  if (!e) return notFound;
  return { ok: true, status: 200, data: { equipment: e } };
};
