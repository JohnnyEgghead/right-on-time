// SPDX-License-Identifier: AGPL-3.0-or-later
// Test world for the technician items (database tests only; the merge set excludes *.db.test.ts): the migrated schema,
// P2-SEED's real reference seed (technicians and their users, staff, windows, parts, the clock row), the production
// kernel as the web process's login bw_web (createWebKernel: the real policy table, handlers and SQL sessions), real
// technician and dispatcher sessions, and a photo folder of the test's own. There is no stand-in text catalog: the
// on-the-way text renders the shipped text.on_the_way through P3-TEXTS's sendOnTheWay, as the live path does (F-470).
//
// The clock: a test writes the epoch's clock_move rows and the clock row itself (setClock); the clock writers
// (API-12 to API-14) are P3-REPLAY's. Real times are a fixed synthetic line (REAL0), never the wall clock.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '@bw/config';
import { createPool, type Queryable } from '@bw/db';
import { createLogger } from '@bw/log';
import { CLOCK_CACHE_MS, realNow, Temporal, toWire, type Instant, type RealTimeUse } from '@bw/time';
import type { MigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { seedReference } from '../../../import/src/testing/world.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import { addCustomers, loginUrl, ORIGIN, type Staff } from '../office-writes/testing.ts';
import { createWebKernel, type WebKernel } from '../web.ts';

export const ZONE = 'America/New_York';
/** The synthetic real line: the phone saved its offset at REAL0, when the demo clock read DEMO0 (Tue Sep 15, 9:00 AM EDT). */
export const REAL0 = Temporal.Instant.from('2026-11-02T15:00:00Z');
export const DEMO0 = Temporal.Instant.from('2026-09-15T13:00:00Z');
export const MIN = 60_000;

export const demoAt = (hhmm: string, date = '2026-09-15'): Instant => Temporal.ZonedDateTime.from(`${date}T${hhmm}:00[${ZONE}]`).toInstant();
export const wire = (at: Instant): string => toWire(at, ZONE);

export interface Tech extends Staff {
  technicianId: string;
  nameInTexts: string;
  /** How this technician's app presents its session: the native app a bearer token, the web app its cookie (SD-8). */
  auth: Record<string, string>;
}

export interface TechWorld {
  kernel: WebKernel;
  photosDir: string;
  /** Every line the web kernel logged, parsed (F-1265: the small copy's skip and failure lines). */
  logLines: Record<string, unknown>[];
  keisha: Staff;
  techs: [Tech, Tech];
  windowId: string;
  /** 3 customers with texts on and a mobile, then quiet ones (texts off). */
  texting: string[];
  quiet: string[];
  admin(): Queryable;
  rows<R>(sql: string, values?: unknown[]): Promise<R[]>;
  /** A scheduled job on `date` in the 8 to 10 AM window, the technician's, at version 1. */
  newJob(opts?: { tech?: Tech; date?: string; customerId?: string | undefined; status?: string }): Promise<number>;
  /** Replace the epoch's clock history: clock_move rows (real times on the REAL0 line) and the clock row, paused at `demoNow`. */
  setClock(input: { moves: { kind: 'jump' | 'pause' | 'resume' | 'reset'; atReal: Instant; toDemo: Instant }[]; demoNow: Instant; worldEpoch?: number }): Promise<void>;
  /** The default history: running from REAL0 at DEMO0, read at `receivedAt` (paused there, so every call sees 1 time). */
  runningClock(receivedAt: Instant): Promise<void>;
  send(items: unknown[], who: Tech): Promise<Response>;
  upload(q: Record<string, string | number>, bytes: Uint8Array, contentType: string, who: Tech): Promise<Response>;
  post(p: string, body: unknown, who: Staff | Tech): Promise<Response>;
  /** A read as that person (F-562: the board's flagged list). */
  get(p: string, who: Staff | Tech): Promise<Response>;
  close(): Promise<void>;
}

export interface ItemSpec {
  kind: string;
  jobNumber: number;
  baseVersion: number;
  /** The demo time the phone derived at entry. */
  entered: Instant;
  key?: string;
  worldEpoch?: number;
  payload?: unknown;
  /** The phone's clock error (its real time minus the server's), default 0. */
  phoneSkewMs?: number;
}

/**
 * An item as the phone builds it (section 5.1 step 1): the offset was saved at server real REAL0 (demo DEMO0); entry is
 * `entered - DEMO0` later on the phone's own clock, which may be skewed; demoTime = deviceTime + the saved offset.
 */
export function item(s: ItemSpec): Record<string, unknown> {
  const since = s.entered.epochMilliseconds - DEMO0.epochMilliseconds;
  const skew = s.phoneSkewMs ?? 0;
  const phoneAtSave = REAL0.add({ milliseconds: skew });
  const device = phoneAtSave.add({ milliseconds: since });
  const offset = DEMO0.epochMilliseconds - phoneAtSave.epochMilliseconds;
  return {
    key: s.key ?? crypto.randomUUID(), kind: s.kind, jobNumber: s.jobNumber, baseVersion: s.baseVersion, worldEpoch: s.worldEpoch ?? 1,
    deviceTime: wire(device), offsetSavedReal: wire(REAL0), sinceSaveMs: since,
    demoTime: wire(Temporal.Instant.fromEpochMilliseconds(device.epochMilliseconds + offset)),
    ...(s.payload === undefined ? {} : { payload: s.payload }),
  };
}

export const noteOf = (text = 'Replaced the filter') => ({ text });
export const noParts = { parts: [], noPartsUsed: true, laborMinutes: 45, workDone: ['Cleaned the burners'] };

/** A minimal valid JPEG (SOI, an SOF0 frame header of w x h, EOI) padded to `bytes` with a comment segment's worth of filler. */
export function jpeg(width = 640, height = 480, bytes = 64): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const out = new Uint8Array(Math.max(bytes, head.length + 2));
  out.set(head, 0);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

/** A minimal PNG header (signature and IHDR) of w x h, padded to `bytes`. */
export function png(width = 1200, height = 400, bytes = 64): Uint8Array {
  const out = new Uint8Array(Math.max(bytes, 33));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return out;
}

export async function techWorld(db: MigratedDatabase): Promise<TechWorld> {
  const a = db.admin();
  await seedReference(a);
  const quiet = await addCustomers(a, 'columbus', 30);
  const texting: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await a.query<{ id: string }>(
      `UPDATE world.customer SET texts_on = true, mobile = $2, name = $3 WHERE id = $1 RETURNING id`,
      [quiet[i], `(614) 555-01${10 + i}`, ['Harold Price', 'June Park', 'Omar Haddad'][i]]);
    texting.push(r.rows[0]!.id);
  }
  const photosDir = await mkdtemp(path.join(os.tmpdir(), 'bw-photos-'));
  const settings = loadConfig({ DATABASE_URL: loginUrl(db.url(), 'bw_web'), ACCESS_CODE_ON: 'off', PHOTOS_DIR: photosDir });
  const logLines: Record<string, unknown>[] = [];
  const kernel = createWebKernel({ settings, log: createLogger({ process: 'web', write: (line) => void logLines.push(JSON.parse(line) as Record<string, unknown>) }) });
  const web = createPool({ connectionString: loginUrl(db.url(), 'bw_web'), max: 4 });
  const store = new SqlSessionStore(web);
  const clock = { realNow: (use: RealTimeUse) => (use === 'session_idle' ? realNow('session_idle') : realNow('session_lifetime')) };
  const tokenFor = (userId: string, role: 'office' | 'manager' | 'technician', client: 'web' | 'native') =>
    startSession(store, clock, { userId, role }, { client, via: 'password', keepSignedIn: false });
  const cookieFor = async (userId: string, role: 'office' | 'manager' | 'technician', client: 'web' | 'native') =>
    sessionCookie(await tokenFor(userId, role, client), false, false).split(';')[0] as string;
  const k = (await a.query<{ id: string; name: string }>(`SELECT id, name FROM world."user" WHERE email = 'keisha.t@brightwater.example'`)).rows[0]!;
  const keisha: Staff = { userId: k.id, name: k.name, cookie: await cookieFor(k.id, 'office', 'web') };
  const t = await a.query<{ id: string; user_id: string; name: string; name_in_texts: string }>(
    `SELECT id, user_id, name, name_in_texts FROM world.technician
      WHERE branch_id = 'columbus' AND NOT installer AND 2 = ANY(working_days) AND 4 = ANY(working_days) ORDER BY name LIMIT 2`);
  // The first technician uses the native app (bearer), the second the web app (cookie, with the Origin check).
  const techs = await Promise.all(t.rows.map(async (x, i): Promise<Tech> => {
    const base = { userId: x.user_id, name: x.name, technicianId: x.id, nameInTexts: x.name_in_texts };
    if (i === 0) return { ...base, cookie: '', auth: { authorization: `Bearer ${await tokenFor(x.user_id, 'technician', 'native')}` } };
    const cookie = await cookieFor(x.user_id, 'technician', 'web');
    return { ...base, cookie, auth: { cookie, origin: ORIGIN } };
  })) as [Tech, Tech];
  const windowId = (await a.query<{ id: string }>(
    `SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' AND start_local = '08:00'`)).rows[0]!.id;
  let next = 3;

  const call = (method: string, p: string, auth: Record<string, string>, body?: string | Uint8Array, type?: string) => kernel.router.handle(new Request(`http://web:3000/api/v1${p}`, {
    method, ...(body === undefined ? {} : { body: body as NonNullable<RequestInit['body']> }),
    headers: { ...(type ? { 'content-type': type } : {}), ...auth },
  }), { address: '203.0.113.9' });
  const authOf = (who: Staff | Tech) => ('auth' in who ? who.auth : { cookie: who.cookie, origin: ORIGIN });

  const w: TechWorld = {
    kernel, photosDir, logLines, keisha, techs, windowId, texting, quiet,
    admin: () => a,
    rows: async <R>(sql: string, values: unknown[] = []) => (await a.query<R>(sql, values)).rows,
    async newJob(o = {}) {
      const date = o.date ?? '2026-09-15';
      const r = await a.query<{ job_number: number }>(
        `INSERT INTO world.job (customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, technician_id, status, version,
                                expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
         VALUES ($1, 'columbus', 'furnace_tune_up', $2, $3, $4, $5, $6, $7, $8, 1, 60, 'office', '2026-09-14T12:00:00Z', 'not_sent', false, false, false)
         RETURNING job_number`,
        [o.customerId ?? quiet[next++ % quiet.length], date, ZONE, windowId, `${date}T08:00:00-04:00`, `${date}T10:00:00-04:00`,
          (o.tech ?? techs[0]).technicianId, o.status ?? 'scheduled']);
      return r.rows[0]!.job_number;
    },
    async setClock(input) {
      const epoch = input.worldEpoch ?? 1;
      await a.query('DELETE FROM system.clock_move');
      for (const m of input.moves) {
        await a.query(`INSERT INTO system.clock_move (world_epoch, at_real, from_demo, to_demo, kind, by_name) VALUES ($1, $2, $3, $3, $4, 'Test')`,
          [epoch, m.atReal.toString(), m.toDemo.toString(), m.kind]);
      }
      await a.query('UPDATE system.demo_clock SET demo_anchor = $1, paused = true, world_epoch = $2 WHERE id = 1', [input.demoNow.toString(), epoch]);
      // The kernel's clock caches the row for CLOCK_CACHE_MS (section 4.2); wait it out so the next call reads this one.
      await new Promise((r) => setTimeout(r, CLOCK_CACHE_MS + 50));
    },
    async runningClock(receivedAt) {
      const elapsed = receivedAt.epochMilliseconds - DEMO0.epochMilliseconds;
      await w.setClock({
        moves: [{ kind: 'resume', atReal: REAL0.subtract({ hours: 1 }), toDemo: DEMO0.subtract({ hours: 1 }) },
          { kind: 'pause', atReal: REAL0.add({ milliseconds: elapsed }), toDemo: receivedAt }],
        demoNow: receivedAt,
      });
    },
    send: (items, who) => call('POST', '/tech/items', who.auth, JSON.stringify({ items }), 'application/json'),
    upload(q, bytes, contentType, who) {
      const { key, ...rest } = q;
      const qs = new URLSearchParams(Object.entries(rest).map(([x, v]) => [x, String(v)])).toString();
      return call('PUT', `/tech/photos/${String(key)}?${qs}`, who.auth, bytes, contentType);
    },
    post: (p, body, who) => call('POST', p, authOf(who), JSON.stringify(body), 'application/json'),
    get: (p, who) => call('GET', p, authOf(who)),
    async close() {
      await kernel.close();
      await web.end();
      await rm(photosDir, { recursive: true, force: true });
    },
  };
  await w.runningClock(demoAt('10:00'));
  return w;
}

/** The blob query an app sends with a photo or signature, from the same facts as an item. */
export function blobQuery(s: Omit<ItemSpec, 'baseVersion'> & { kind: 'photo' | 'signature' }): Record<string, string | number> {
  const i = item({ ...s, baseVersion: 1 });
  return {
    key: i['key'] as string, kind: s.kind, jobNumber: s.jobNumber, worldEpoch: i['worldEpoch'] as number, deviceTime: i['deviceTime'] as string,
    offsetSavedReal: i['offsetSavedReal'] as string, sinceSaveMs: i['sinceSaveMs'] as number, demoTime: i['demoTime'] as string,
  };
}

export interface ItemAnswer { key: string; result: string; code: string | null; messageKey: string | null; values: Record<string, unknown> | null }
export const answers = async (r: Response): Promise<ItemAnswer[]> => {
  if (r.status !== 200) throw new Error(`API-102 answered ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { data: { items: ItemAnswer[] } }).data.items;
};
