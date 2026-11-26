// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's job reads (UI-SPECIFICATION 12.2 API-101, and API-175, the stored photo and signature
// file 12.2 does not list yet: F-707, F-727). Each read runs in the handler's 1 transaction (SD-6) and answers wall times in the
// job's branch zone (12.1 item 5).
//   API-101 the technician's own job: a job that is not the caller's answers forbidden (12.2), an unknown number not_found.
//     The customer's phone is answered only when the job's date is today by the demo clock in the job's zone (FR-AUTH-4,
//     OA-29 row 16): on any other day it is null, never sent. History follows SPECIFICATIONS section 6.2 as the office job page's does (API-23).
//   API-175 1 stored file by its item key: a photo (JPEG) or the job's signature (PNG), read from PHOTOS_DIR. Office staff
//     and managers read any; a technician only a file of their own job (as API-101). A key no row holds is not_found, so
//     after a world reset a file of the earlier world is gone too (its row is). size thumb answers a photo's small copy (SD-32,
//     UD-55; P6-PHOTO-THUMBS), made on the first thumb read of a photo that has none.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { myJob as myJobRow, storedFile as storedFileRow } from '@bw/api';
import { areaName } from '@bw/domain';
import { localDateOf, Temporal, toWire } from '@bw/time';
import type { z } from 'zod';
import { readTechnician } from '../tech-items/shared.ts';
import { thumbErrorCode, thumbFile, writeThumb } from '../tech-items/thumb.ts';
import type { Handler, Tx } from '../types.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

const DEFAULT_PHOTOS_DIR = '/data/photos';
const instant = (d: Date) => Temporal.Instant.fromEpochMilliseconds(d.getTime());
const w = (d: Date, zone: string) => toWire(instant(d), zone);
const wn = (d: Date | null, zone: string) => (d ? w(d, zone) : null);
const notFound = { ok: false as const, status: 404, code: 'not_found' as const };
const forbidden = { ok: false as const, status: 403, code: 'forbidden' as const };

interface JobRow {
  job_number: number; version: number; status: Out<typeof myJobRow>['job']['status']; zone: string; date: string; window_start: Date; window_end: Date;
  screen_label_key: string; problem: string | null; on_the_way_at: Date | null; arrived_at: Date | null; ended_at: Date | null;
  technician_id: string | null; customer_id: string; equipment_id: string | null;
}

/** API-101: the job, its customer (the phone only today), equipment, the last 3 visits, the notes and the photos. */
const myJobHandler: Handler<Out<typeof myJobRow>> = async (req, tx: Tx) => {
  if (req.caller.kind !== 'staff') return forbidden;
  const { jobNumber } = req.params as In<typeof myJobRow>;
  const j = (await tx.query<JobRow>(
    `SELECT j.job_number, j.version, j.status, j.zone, j.date::text AS date, j.window_start, j.window_end, s.screen_label_key, j.problem,
            j.on_the_way_at, j.arrived_at, j.ended_at, j.technician_id, j.customer_id, j.equipment_id
       FROM world.job j JOIN world.service_type s ON s.id = j.service_id WHERE j.job_number = $1`, [jobNumber])).rows[0];
  if (!j) return notFound;
  const me = await readTechnician(tx, req.caller.userId);
  if (!me || j.technician_id !== me.id) return forbidden;
  const z0 = j.zone;
  const today = localDateOf(req.demoNow, z0).toString() === j.date;
  const c = (await tx.query<{ name: string; mobile: string | null; home_phone: string | null; getting_in: string | null; house_number: number; street: string; city: string; zip: string }>(
    `SELECT c.name, c.mobile, c.home_phone, c.getting_in, c.house_number, st.name AS street, st.city, st.zip
       FROM world.customer c JOIN world.street st ON st.id = c.street_id WHERE c.id = $1`, [j.customer_id])).rows[0]!;
  // FR-TECH-8 (F-1125): the job's own equipment first, then the order the units were entered (id is a uuidv7), the order the seed lists them in
  const equipment = (await tx.query<{ id: string; type: string; year: number | null; location: string | null; details: string | null }>(
    'SELECT id, type, year, location, details FROM world.equipment WHERE customer_id = $1 ORDER BY (id IS NOT DISTINCT FROM $2::uuid) DESC, id', [j.customer_id, j.equipment_id])).rows;
  const visits = (await tx.query<{ date: string; what: string | null; label: string | null; technician: string | null }>(
    `SELECT date::text AS date, service_text AS what, NULL AS label, technician_name AS technician, NULL::int AS job_number
       FROM world.past_visit WHERE customer_id = $1
     UNION ALL
     SELECT j.date::text, NULL, s.screen_label_key, t.name, j.job_number
       FROM world.job j JOIN world.service_type s ON s.id = j.service_id LEFT JOIN world.technician t ON t.id = j.technician_id
      WHERE j.customer_id = $1 AND j.status = 'done' AND j.job_number <> $2
     ORDER BY 1 DESC, 5 DESC NULLS LAST LIMIT 3`, [j.customer_id, j.job_number])).rows;
  const readNotes = async (where: string, key: number | string) => (await tx.query<{ id: string; author_kind: 'office' | 'technician'; author: string | null; body: string; entered_at: Date }>(
    // A technician's note answers its item key as its id, so the phone drops its own waiting copy once the server holds it.
    `SELECT coalesce(n.item_key::text, n.id::text) AS id, n.author_kind, u.name AS author, n.body, n.entered_at
       FROM world.note n LEFT JOIN world."user" u ON u.id = n.author_user_id
      WHERE ${where} = $1 ORDER BY n.entered_at DESC, n.id DESC`, [key])).rows
    .map((n) => ({ id: n.id, kind: n.author_kind, author: n.author, body: n.body, at: w(n.entered_at, z0) }));
  const photos = (await tx.query<{ key: string; by: string | null; entered_at: Date }>(
    `SELECT p.key::text AS key, t.name AS by, p.entered_at FROM world.photo p LEFT JOIN world.technician t ON t.id = p.technician_id
      WHERE p.job_number = $1 ORDER BY p.entered_at, p.key`, [j.job_number])).rows;
  let position: { index: number; of: number } | null = null;
  let nextJob: number | null = null;
  if (today) {
    const day = (await tx.query<{ job_number: number }>(
      `SELECT job_number FROM world.job WHERE technician_id = $1 AND date = $2::date AND status <> 'canceled' ORDER BY window_start, job_number`,
      [me.id, j.date])).rows.map((r) => r.job_number);
    const at = day.indexOf(j.job_number);
    position = at >= 0 ? { index: at + 1, of: day.length } : null;
    nextJob = at >= 0 ? (day[at + 1] ?? null) : null;
  }
  return {
    ok: true, status: 200, data: {
      job: {
        jobNumber: j.job_number, version: j.version, status: j.status, zone: z0, date: j.date, today,
        window: { start: w(j.window_start, z0), end: w(j.window_end, z0) }, serviceLabelKey: j.screen_label_key, problem: j.problem,
        onTheWayAt: wn(j.on_the_way_at, z0), arrivedAt: wn(j.arrived_at, z0), endedAt: wn(j.ended_at, z0), position, nextJob,
      },
      customer: {
        name: c.name, address: `${c.house_number} ${c.street}, ${c.city}`, area: areaName(c.city, c.zip),
        phone: today ? (c.mobile ?? c.home_phone) : null,
        gettingIn: c.getting_in, notes: await readNotes('n.customer_id', j.customer_id),
      },
      equipment,
      history: visits.map((v) => ({ date: v.date, what: v.what, serviceLabelKey: v.label, technician: v.technician })),
      notes: await readNotes('n.job_number', j.job_number),
      photos: photos.map((p) => ({ key: p.key, by: p.by, at: w(p.entered_at, z0) })),
    },
  };
};

/** Read 1 stored file; null when it is gone (ENOENT). */
async function readStored(file: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return new Uint8Array(await readFile(file)) as Uint8Array<ArrayBuffer>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * API-175: 1 stored photo or signature file by its key; office staff and managers any, a technician only their own job's. With
 * size thumb a photo answers its small copy (SD-32, UD-55), under the same access rules (they run first), made and written on
 * this read when it is missing; a signature answers its PNG whatever the size.
 */
const storedFileHandler: Handler<Out<typeof storedFileRow>> = async (req, tx: Tx, hctx) => {
  if (req.caller.kind !== 'staff') return forbidden;
  const { key, size } = req.params as In<typeof storedFileRow>;
  const row = (await tx.query<{ file: string; job_number: number | null; type: 'image/jpeg' | 'image/png' }>(
    `SELECT file, job_number, 'image/jpeg' AS type FROM world.photo WHERE key = $1::uuid
     UNION ALL SELECT file, job_number, 'image/png' FROM world.signature WHERE key = $1::uuid
     UNION ALL SELECT payload->>'file', NULL, CASE kind WHEN 'signature' THEN 'image/png' ELSE 'image/jpeg' END
        FROM world.tech_item WHERE key = $1::uuid AND kind IN ('photo', 'signature') AND payload ? 'file' LIMIT 1`, [key.toLowerCase()])).rows[0];
  if (!row) return notFound;
  // F-1168: a refused upload kept for the dispatcher (no job of the technician's behind it) is the office's to see only.
  if (row.job_number === null && req.caller.role === 'technician') return forbidden;
  if (req.caller.role === 'technician') {
    const me = await readTechnician(tx, req.caller.userId);
    const own = me ? (await tx.query('SELECT 1 FROM world.job WHERE job_number = $1 AND technician_id = $2', [row.job_number, me.id])).rowCount : 0;
    if (!own) return forbidden;
  }
  const dir = path.resolve(hctx.settings.PHOTOS_DIR ?? DEFAULT_PHOTOS_DIR);
  const file = path.resolve(dir, row.file);
  // The stored name is <yyyy-mm>/<key> (blob.ts blobFile); anything that would leave the folder is a damaged row.
  if (!file.startsWith(`${dir}${path.sep}`)) throw new Error('a stored file name leaves the photo folder');
  if (size === 'thumb' && row.type === 'image/jpeg') {
    const thumb = await readStored(path.resolve(dir, thumbFile(row.file)));
    if (thumb) return { ok: true, status: 200, data: { type: 'image/jpeg', bytes: thumb } };
    // No small copy (a photo stored before the small copy rule of SD-32, or its copy lost): make it from the photo and keep it.
    const photo = await readStored(file);
    if (!photo) return notFound;
    try {
      return { ok: true, status: 200, data: { type: 'image/jpeg', bytes: await writeThumb(dir, row.file, photo) } };
    } catch (e) {
      // A photo sharp cannot decode, or one over the copy's pixel limit (F-1265, never decoded here), has no small copy: its tile
      // reads the photo itself, which draws or shows the placeholder, as its full view would.
      hctx.log.warn({ contract: 'API-175', errorCode: thumbErrorCode(e) });
      return { ok: true, status: 200, data: { type: 'image/jpeg', bytes: photo } };
    }
  }
  // A row whose file is gone (a restore without the photo volume): the photo is not there to show; the page draws its placeholder.
  const bytes = await readStored(file);
  if (!bytes) return notFound;
  return { ok: true, status: 200, data: { type: row.type, bytes } };
};

export const techJobHandlers = { 'API-101': myJobHandler as Handler<unknown>, 'API-175': storedFileHandler as Handler<unknown> };
