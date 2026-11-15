// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-4 (G-CI5 inv5-location-window, preview case of P5-INBOX, moved from P5-LIVEMAP, F-703: the live map preview of the inbox, API-164, answers 410 with no picture and no coordinates once the link has ended)
// Invariant 5 (BUILD_PLAN section 7 gate map; FR-TEXT-4, FR-TEXT-21, NFR-04): the live map and what previews it exist from On my way to arrival and at
// no other time. P3-POSITIONS holds the server's position function (server.test.ts, beside this file), P5-LIVEMAP the page and data cases; this is the
// preview case: API-164 (GET /m/<token>/preview) answers 410 after arrival and after the office cancels, reassigns or reschedules an On the way job,
// with no picture and no coordinates, through the production kernel over real PostgreSQL 18 as the web login.
// API-164's handler is handlers/live-map.ts liveMapPreviewHandler, over the same rule as API-116 and the link page (liveMapLinkState, F-949).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../packages/config/src/index.ts';
import { createPool, inTransaction } from '../../../packages/db/src/index.ts';
import { createLogger } from '../../../packages/log/src/index.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { assignJob, cancelJob, rescheduleJob } from '../../../packages/api-server/src/office-writes/service.ts';
import { createWebKernel, type WebKernel } from '../../../packages/api-server/src/web.ts';
import { addCustomer, addJob, seedOutboxWorld, type OutboxRef } from '../../../packages/outbox/src/testing/world.ts';

const db = useMigratedDatabase();
const NOW = '2026-09-15T14:00:00Z'; // Tue, Sep 15, 10:00 AM EDT
const loginUrl = (url: string, login: string) => {
  const u = new URL(url);
  u.username = login;
  return u.toString();
};
let kernel: WebKernel;
let web: ReturnType<typeof createPool>;
let ref: OutboxRef;
let n = 0;
let techId = '';

const ctx = () => ({ actor: { kind: 'office' as const, userId: ref.userId }, at: new Date(NOW) });

/** A job On the way, with its live map link (SD-17): the shape On my way writes. */
async function onTheWay(): Promise<{ job: number; token: string; version: number }> {
  const a = db.admin();
  const customer = await addCustomer(a, ref);
  const job = await addJob(a, ref, customer, '2026-09-15', { status: 'on_the_way', technician_id: techId, on_the_way_at: NOW });
  const token = `Lm${String(++n).padStart(6, '0')}`;
  await a.query(`INSERT INTO world.link_token (token, kind, job_number, created_at) VALUES ($1, 'live_map', $2, $3)`, [token, job, NOW]);
  const version = (await a.query('SELECT version FROM world.job WHERE job_number = $1', [job])).rows[0]!.version as number;
  return { job, token, version };
}
const ended = async (token: string) => (await db.admin().query('SELECT ended_at FROM world.link_token WHERE token = $1', [token])).rows[0]!.ended_at !== null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function preview(token: string): Promise<{ status: number; json: any }> {
  const res = await kernel.router.handle(new Request(`http://web:3000/m/${token}/preview`), { address: '203.0.113.9' });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}
/** No picture and no position: nothing in an ended answer names a map picture or a coordinate (NFR-04). */
const bare = (json: unknown) => expect(JSON.stringify(json)).not.toMatch(/"(svg|image|lon|lat|lng|latitude|longitude|position|coordinates)"/i);

beforeAll(async () => {
  const a = db.admin();
  ref = await seedOutboxWorld(a, NOW);
  techId = (await a.query<{ id: string }>('SELECT id FROM world.technician LIMIT 1')).rows[0]!.id;
  web = createPool({ connectionString: loginUrl(db.url(), 'bw_web'), max: 4 });
  kernel = createWebKernel({
    settings: loadConfig({
      DATABASE_URL: loginUrl(db.url(), 'bw_web'), ACCESS_CODE_ON: 'off', PBS_URL: 'http://127.0.0.1:9', BACKUP_TARGET: 'lightsail',
      DATA_LOCATION_APP: 'AWS Lightsail, US East (Virginia)', DATA_LOCATION_BACKUPS: 'AWS Lightsail object storage, US East (Virginia)',
    }),
    log: createLogger({ process: 'web', write: () => undefined }),
  });
});
afterAll(async () => {
  await kernel?.close();
  await web?.end();
});

describe('G-CI5 preview: the live map link ends with the visit being on the way (rows)', () => {
  // why: FR-TEXT-4
  it('ends the link when the office cancels, reassigns or reschedules an On the way job', async () => {
    const cancel = await onTheWay();
    await inTransaction(web, (tx) => cancelJob(tx, ctx(), { jobNumber: cancel.job, baseVersion: cancel.version }));
    expect(await ended(cancel.token)).toBe(true);
    const assign = await onTheWay();
    await inTransaction(web, (tx) => assignJob(tx, ctx(), { jobNumber: assign.job, technicianId: null, baseVersion: assign.version }));
    expect(await ended(assign.token)).toBe(true);
    const move = await onTheWay();
    await inTransaction(web, (tx) => rescheduleJob(tx, ctx(), { jobNumber: move.job, date: '2026-09-16', windowId: ref.windowId, baseVersion: move.version }));
    expect(await ended(move.token)).toBe(true);
    const still = await onTheWay();
    expect(await ended(still.token)).toBe(false);
  });
});

describe('G-CI5 preview: API-164 answers 410 with no picture and no coordinates', () => {
  // why: FR-TEXT-4
  it('answers a picture while the job is On the way, and 410 after arrival', async () => {
    const j = await onTheWay();
    const live = await preview(j.token);
    expect(live.status).toBe(200);
    expect(live.json.data.svg).toMatch(/^<svg /);
    expect(live.json.data.svg).toContain('\u00a9 OpenStreetMap');
    // why: F-971 (NFR-04) the live picture the handler answers holds no decimal number (a longitude or latitude) and no van: a coordinate written into it fails here
    expect(live.json.data.svg).not.toMatch(/\d\.\d/);
    expect(live.json.data.svg).not.toMatch(/van/i);
    await db.admin().query(`UPDATE world.job SET status = 'on_site', arrived_at = $2 WHERE job_number = $1`, [j.job, NOW]);
    await db.admin().query(`UPDATE world.link_token SET ended_at = $2 WHERE token = $1`, [j.token, NOW]);
    const after = await preview(j.token);
    expect(after.status).toBe(410);
    bare(after.json);
  });

  // why: FR-TEXT-4
  it('answers 410 after the office cancels, reassigns or reschedules an On the way job', async () => {
    const cancel = await onTheWay();
    await inTransaction(web, (tx) => cancelJob(tx, ctx(), { jobNumber: cancel.job, baseVersion: cancel.version }));
    const assign = await onTheWay();
    await inTransaction(web, (tx) => assignJob(tx, ctx(), { jobNumber: assign.job, technicianId: null, baseVersion: assign.version }));
    const move = await onTheWay();
    await inTransaction(web, (tx) => rescheduleJob(tx, ctx(), { jobNumber: move.job, date: '2026-09-16', windowId: ref.windowId, baseVersion: move.version }));
    for (const j of [cancel, assign, move]) {
      const r = await preview(j.token);
      expect(r.status).toBe(410);
      bare(r.json);
    }
  });
});

describe('G-CI5 preview: a trip nobody drives is not live (F-949)', () => {
  // why: FR-TEXT-4
  it('answers 410 for an On the way job with no technician, as API-116 does', async () => {
    const j = await onTheWay();
    await db.admin().query('UPDATE world.job SET technician_id = NULL WHERE job_number = $1', [j.job]);
    const r = await preview(j.token);
    expect(r.status).toBe(410);
    bare(r.json);
    const data = await kernel.router.handle(new Request(`http://web:3000/m/${j.token}/data`), { address: '203.0.113.9' });
    expect(data.status).toBe(410);
  });
});
