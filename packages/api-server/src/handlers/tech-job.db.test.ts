// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's job reads (P5-TWA-JOB: API-101 My job, API-175 the stored photo and signature file) on the real
// database through the production kernel as bw_web, with real technician and dispatcher sessions of the reference seed
// (tech-items/testing.ts). Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { myJob } from '@bw/api';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { answers, blobQuery, demoAt, item, jpeg, png, techWorld, type TechWorld } from '../tech-items/testing.ts';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { halvesJpeg, progressiveJpeg, reddish, pixel, sizeOf } from '../tech-items/test-images.ts';

type MyJob = z.infer<(typeof myJob)['response']>;
const db = useMigratedDatabase();
let w: TechWorld;
let customerId = '';

/** The small copy's log lines since line `from`: contract and errorCode only. */
const thumbLines = (from: number) => w.logLines.slice(from)
  .filter((l) => typeof l['errorCode'] === 'string' && (l['errorCode'] as string).startsWith('photo_thumb_'))
  .map((l) => ({ contract: l['contract'], errorCode: l['errorCode'] }));

const data = async <T>(r: Response): Promise<T> => {
  if (r.status >= 300) throw new Error(`answered ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { data: T }).data;
};

beforeAll(async () => {
  w = await techWorld(db);
  customerId = w.texting[0] as string;
  const a = w.admin();
  await a.query(`UPDATE world.customer SET mobile = '(614) 555-0148', getting_in = 'Side door. Knock firmly.' WHERE id = $1`, [customerId]);
  await a.query(`INSERT INTO world.equipment (customer_id, type, year, location, details) VALUES ($1, 'furnace', 2014, 'basement', 'Gas furnace, 80,000 BTU')`, [customerId]);
  await a.query(`INSERT INTO world.equipment (customer_id, type, year, location, details) VALUES ($1, 'air_conditioner', 2014, 'outdoor unit', 'Central air conditioner')`, [customerId]);
  for (const [d, what, by] of [['2025-10-14', 'Furnace tune-up', 'Maria Santos'], ['2025-06-09', 'AC tune-up', 'Brian Schaefer'], ['2024-01-22', 'No heat (repair)', 'Tom Reinhart'], ['2023-10-03', 'Furnace tune-up', 'Tom Reinhart']]) {
    await a.query(`INSERT INTO world.past_visit (customer_id, technician_name, date, zone, window_start, window_end, outcome, service_text, source_ref)
                   VALUES ($1, $4, $2::date, 'America/New_York', $2::date + time '08:00', $2::date + time '10:00', 'done', $3, 'old-' || $2)`, [customerId, d, what, by]);
  }
}, 120_000);
afterAll(async () => {
  await w?.close();
});

describe('API-101 My job', () => {
  // why: FR-AUTH-4 the technician sees the customer's number on the day of the visit (Sep 15) and not on a later job (Oct 20): the number is not sent
  it('answers the customer\'s phone only for a job of today, by the demo clock in the job\'s zone', async () => {
    const [tech] = w.techs;
    const today = await w.newJob({ tech, customerId, date: '2026-09-15' });
    const later = await w.newJob({ tech, customerId, date: '2026-10-20' });
    const a = await data<MyJob>(await w.get(`/tech/jobs/${today}`, tech));
    expect([a.job.today, a.customer.phone]).toEqual([true, '(614) 555-0148']);
    const r = await w.get(`/tech/jobs/${later}`, tech);
    const text = await r.clone().text();
    const b = await data<MyJob>(r);
    expect([b.job.today, b.customer.phone, b.job.position]).toEqual([false, null, null]);
    expect(text).not.toContain('555-0148');
  });

  // why: FR-TECH-8 a job that names its own equipment shows that unit first, the rest in the order entered
  it('answers the job\'s own equipment first', async () => {
    const [tech] = w.techs;
    const n = await w.newJob({ tech, customerId, date: '2026-09-15' });
    const ac = (await w.admin().query<{ id: string }>(`SELECT id FROM world.equipment WHERE customer_id = $1 AND type = 'air_conditioner'`, [customerId])).rows[0]!.id;
    await w.admin().query('UPDATE world.job SET equipment_id = $1 WHERE job_number = $2', [ac, n]);
    const d = await data<MyJob>(await w.get(`/tech/jobs/${n}`, tech));
    expect(d.equipment.map((e) => e.type)).toEqual(['air_conditioner', 'furnace']);
  });

  // why: FR-TECH-8 the job screen shows the customer's notes, equipment (gas furnace, 2014, basement) and the last 3 past visits, newest first
  it('answers the customer\'s notes, the equipment and the last 3 visits, newest first', async () => {
    const [tech] = w.techs;
    const n = await w.newJob({ tech, customerId, date: '2026-09-15' });
    const d = await data<MyJob>(await w.get(`/tech/jobs/${n}`, tech));
    expect(d.customer.gettingIn).toBe('Side door. Knock firmly.');
    // the furnace was entered first and sorts after the air conditioner by type: the job shows it first (F-1125)
    expect(d.equipment.map((e) => e.type)).toEqual(['furnace', 'air_conditioner']);
    expect(d.equipment[0]).toMatchObject({ year: 2014, location: 'basement' });
    expect(d.history.map((h) => [h.date, h.what, h.technician])).toEqual([
      ['2025-10-14', 'Furnace tune-up', 'Maria Santos'], ['2025-06-09', 'AC tune-up', 'Brian Schaefer'], ['2024-01-22', 'No heat (repair)', 'Tom Reinhart'],
    ]);
  });

  // why: FR-DISP-27 an office note saved with Add note (API-140) shows on the technician's job with its author and time
  // why: FR-TECH-3 a technician's note and photo added to the job are on the job the app reads back
  it('answers the office note with its author and time, and the technician\'s own note and photo', async () => {
    const [tech] = w.techs;
    const n = await w.newJob({ tech, customerId, date: '2026-09-15' });
    expect((await w.post('/notes', { jobNumber: n, body: 'The doorbell does not work.' }, w.keisha)).status).toBe(201);
    const [note] = await answers(await w.send([item({ kind: 'note', jobNumber: n, baseVersion: 1, entered: demoAt('10:05'), payload: { text: 'Flame sensor cleaned.' } })], tech));
    expect(note?.result).toBe('applied');
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:06') });
    expect((await w.upload(q, jpeg(640, 480, 512), 'image/jpeg', tech)).status).toBe(200);
    const d = await data<MyJob>(await w.get(`/tech/jobs/${n}`, tech));
    expect(d.notes.map((x) => [x.kind, x.author, x.body])).toEqual([
      ['technician', tech.name, 'Flame sensor cleaned.'], ['office', w.keisha.name, 'The doorbell does not work.'],
    ]);
    expect(d.notes.every((x) => /^2026-09-15T\d\d:\d\d/.test(x.at))).toBe(true);
    expect(d.photos.map((p) => [p.key, p.by])).toEqual([[q['key'], tech.name]]);
  });

  // why: FR-TECH-8 CTL-TEC-04-19 the job's place in today's list (Job 2 of 3) and its number
  // why: FR-TECH-13 CTL-TEC-04-04 the job after this one, which Directions to the next job routes to (API-104 fromJob, toJob)
  it('answers the job\'s place in the technician\'s list of today, leaving a canceled job out', async () => {
    const tech = w.techs[1];
    const first = await w.newJob({ tech, date: '2026-09-15' });
    const second = await w.newJob({ tech, date: '2026-09-15' });
    await w.newJob({ tech, date: '2026-09-15', status: 'canceled' });
    const third = await w.newJob({ tech, date: '2026-09-15' });
    await w.admin().query(`UPDATE world.job SET window_start = window_start + interval '2 hours', window_end = window_end + interval '2 hours' WHERE job_number = $1`, [third]);
    const d = await data<MyJob>(await w.get(`/tech/jobs/${second}`, tech));
    expect([first < second, d.job.position, d.job.nextJob]).toEqual([true, { index: 2, of: 3 }, third]);
    const last = (await data<MyJob>(await w.get(`/tech/jobs/${third}`, tech))).job;
    expect([last.position, last.nextJob]).toEqual([{ index: 3, of: 3 }, null]);
  });

  // why: FR-TECH-8 (UI-SPECIFICATION 12.2 API-101: forbidden when not the technician's job) another technician's job is refused, an unknown number not found, the office refused
  it('refuses another technician\'s job with forbidden, an unknown number with not_found, and an office caller', async () => {
    const [mine, other] = w.techs;
    const n = await w.newJob({ tech: other, date: '2026-09-15' });
    expect((await w.get(`/tech/jobs/${n}`, mine)).status).toBe(403);
    expect((await w.get('/tech/jobs/999999', mine)).status).toBe(404);
    expect((await w.get(`/tech/jobs/${n}`, w.keisha)).status).toBe(403);
  });
});

describe('API-175 Photo or signature file', () => {
  // why: FR-TECH-3, F-707 a photo the technician sent is read back as its JPEG by the office and by its technician, and by no other technician
  // why: FR-TECH-14, F-727 the job's signature is read back as its PNG for the office job page
  it('answers a photo as its JPEG and the signature as its PNG, to the office and the job\'s technician only', async () => {
    const [tech, other] = w.techs;
    const n = await w.newJob({ tech, date: '2026-09-15' });
    const photo = jpeg(640, 480, 2048);
    const pq = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:10') });
    expect((await w.upload(pq, photo, 'image/jpeg', tech)).status).toBe(200);
    const sig = png(1200, 400, 300);
    const sq = blobQuery({ kind: 'signature', jobNumber: n, entered: demoAt('10:11') });
    expect((await w.upload(sq, sig, 'image/png', tech)).status).toBe(200);

    for (const who of [w.keisha, tech]) {
      const r = await w.get(`/files/${pq['key']}`, who);
      expect([r.status, r.headers.get('content-type'), r.headers.get('cache-control')]).toEqual([200, 'image/jpeg', 'no-store']);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(photo);
    }
    const s = await w.get(`/files/${sq['key']}`, w.keisha);
    expect([s.status, s.headers.get('content-type')]).toEqual([200, 'image/png']);
    expect(new Uint8Array(await s.arrayBuffer())).toEqual(sig);
    expect((await w.get(`/files/${pq['key']}`, other)).status).toBe(403);
    expect((await w.get(`/files/${crypto.randomUUID()}`, w.keisha)).status).toBe(404);
  });

  // why: F-707 a row whose file is gone answers not_found (the page draws its placeholder), never a server error
  it('answers not_found for a photo row whose file is missing', async () => {
    const [tech] = w.techs;
    const n = await w.newJob({ tech, date: '2026-09-15' });
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:12') });
    expect((await w.upload(q, jpeg(), 'image/jpeg', tech)).status).toBe(200);
    await w.admin().query(`UPDATE world.photo SET file = '2000-01/missing' WHERE key = $1`, [q['key']]);
    expect((await w.get(`/files/${q['key']}`, w.keisha)).status).toBe(404);
  });

  // why: FR-TECH-3 (SD-32, UD-55, F-1235) the request that stores a photo writes its small copy beside it; size thumb answers it to the office and the job's technician, no-store, upright and 320 px; the full file is unchanged
  it('writes a sent photo\'s small copy in the same request and answers it with size thumb under the full file\'s rules', async () => {
    const [tech, other] = w.techs;
    const n = await w.newJob({ tech, date: '2026-09-15' });
    const photo = await halvesJpeg(2048, 1536, 6);
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:13') });
    expect((await w.upload(q, photo, 'image/jpeg', tech)).status).toBe(200);
    const file = (await w.rows<{ file: string }>('SELECT file FROM world.photo WHERE key = $1', [q['key']]))[0]!.file;
    expect(existsSync(path.join(w.photosDir, `${file}.thumb.jpg`))).toBe(true);
    for (const who of [w.keisha, tech]) {
      const r = await w.get(`/files/${q['key']}?size=thumb`, who);
      expect([r.status, r.headers.get('content-type'), r.headers.get('cache-control')]).toEqual([200, 'image/jpeg', 'no-store']);
      const thumb = new Uint8Array(await r.arrayBuffer());
      expect(await sizeOf(thumb)).toMatchObject({ width: 240, height: 320, orientation: 1 });
      expect(reddish(await pixel(thumb, 120, 20))).toBe(true);
    }
    expect(new Uint8Array(await (await w.get(`/files/${q['key']}`, w.keisha)).arrayBuffer())).toEqual(photo);
    expect((await w.get(`/files/${q['key']}?size=thumb`, other)).status).toBe(403);
    expect((await w.get(`/files/${crypto.randomUUID()}?size=thumb`, w.keisha)).status).toBe(404);
  });

  // why: FR-TECH-3 (SD-32) a photo stored before the small copy rule (or whose copy is lost) gets its copy made and kept on its first thumb read
  it('makes and keeps the small copy on the first thumb read of a photo that has none', async () => {
    const [tech] = w.techs;
    const n = await w.newJob({ tech, date: '2026-09-15' });
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:14') });
    expect((await w.upload(q, await halvesJpeg(200, 150), 'image/jpeg', tech)).status).toBe(200);
    const file = (await w.rows<{ file: string }>('SELECT file FROM world.photo WHERE key = $1', [q['key']]))[0]!.file;
    const thumbPath = path.join(w.photosDir, `${file}.thumb.jpg`);
    rmSync(thumbPath);
    const r = await w.get(`/files/${q['key']}?size=thumb`, tech);
    expect(r.status).toBe(200);
    expect(await sizeOf(new Uint8Array(await r.arrayBuffer()))).toMatchObject({ width: 200, height: 150 });
    expect(existsSync(thumbPath)).toBe(true);
  });

  // why: FR-TECH-14 (API-175) a signature read with size thumb answers its PNG; a photo sharp cannot decode answers its own bytes to a tile
  it('answers a signature\'s PNG whatever the size, and an undecodable photo\'s own file to a thumb read', async () => {
    const [tech] = w.techs;
    const n = await w.newJob({ tech, date: '2026-09-15' });
    const sig = png(1200, 400, 300);
    const sq = blobQuery({ kind: 'signature', jobNumber: n, entered: demoAt('10:15') });
    expect((await w.upload(sq, sig, 'image/png', tech)).status).toBe(200);
    const s = await w.get(`/files/${sq['key']}?size=thumb`, w.keisha);
    expect([s.status, s.headers.get('content-type')]).toEqual([200, 'image/png']);
    expect(new Uint8Array(await s.arrayBuffer())).toEqual(sig);
    const bad = jpeg(640, 480, 2048);
    const pq = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:16') });
    const from = w.logLines.length;
    expect((await w.upload(pq, bad, 'image/jpeg', tech)).status).toBe(200);
    const r = await w.get(`/files/${pq['key']}?size=thumb`, w.keisha);
    expect([r.status, r.headers.get('content-type')]).toEqual([200, 'image/jpeg']);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bad);
    expect(thumbLines(from)).toEqual([{ contract: 'API-103', errorCode: 'photo_thumb_failed' }, { contract: 'API-175', errorCode: 'photo_thumb_failed' }]);
  });

  // why: FR-TECH-3 (SD-32, F-1265) a photo over the small copy's pixel limit is stored with no copy and a skip line, never decoded; its thumb read answers the photo itself
  it('stores a progressive photo over the pixel limit with no small copy, logs the skip on the send and the thumb read, and answers the photo itself', async () => {
    const [tech] = w.techs;
    const n = await w.newJob({ tech, date: '2026-09-15' });
    const big = await progressiveJpeg(4096, 4096);
    const q = blobQuery({ kind: 'photo', jobNumber: n, entered: demoAt('10:17') });
    const from = w.logLines.length;
    const sent = await w.upload(q, big, 'image/jpeg', tech);
    expect([sent.status, ((await sent.json()) as { data: { result: string } }).data.result]).toEqual([200, 'applied']);
    const file = (await w.rows<{ file: string }>('SELECT file FROM world.photo WHERE key = $1', [q['key']]))[0]!.file;
    expect(existsSync(path.join(w.photosDir, `${file}.thumb.jpg`))).toBe(false);
    const r = await w.get(`/files/${q['key']}?size=thumb`, w.keisha);
    expect([r.status, r.headers.get('content-type')]).toEqual([200, 'image/jpeg']);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(big);
    expect(existsSync(path.join(w.photosDir, `${file}.thumb.jpg`))).toBe(false);
    expect(thumbLines(from)).toEqual([{ contract: 'API-103', errorCode: 'photo_thumb_too_large' }, { contract: 'API-175', errorCode: 'photo_thumb_too_large' }]);
  });
});
