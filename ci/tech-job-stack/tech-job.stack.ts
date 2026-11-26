// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-3, FR-TECH-8, FR-TECH-14, FR-AUTH-4, FR-DISP-27, FR-BILL-3 (BUILD_PLAN P5-TWA-JOB Acceptance: Playwright on WebKit and Chromium at 520 x 980 against the Compose stack)
// The web technician app's job screens in the real browser engines against the Compose stack at its default settings (real PostgreSQL 18,
// real handlers, pbs and the worker running), through its proxy, every page opened through the outside-origin guard, signed in as Maria
// Santos and the dispatcher Keisha Thompson (ci/tech-job-stack/fixture.sql):
//   1. FR-AUTH-4: Maria sees Harold's number on his Sep 15 job and not on his Oct 20 job, where it is not sent at all;
//   2. FR-DISP-27 (F-703): an office note saved with Add note (API-140) on Harold's Sep 15 job shows on SCR-TEC-04 with its author and time;
//   3. FR-TECH-3 and SD-32 (F-978, F-69): a note typed on SCR-TEC-05 (its draft kept through a reload) and a photo attached on SCR-TEC-06
//      reach the office job page; the photo picked is a PNG over 10 MB, and the one that reaches API-103 is a JPEG of at most 2048 px within
//      the cap; a file the browser cannot decode (a 14,394,749-byte image/x-adobe-dng, F-69) leaves the phone flagged and is listed for the
//      dispatcher;
//   4. FR-BILL-3 and FR-TECH-14: a finish with neither parts nor No parts used is refused on the screen; parts found by search with a
//      quantity, the edited work-done lines and the customer's signature are kept through closing and reopening the app with no signal;
//      Clear empties the signature; the finish makes 1 invoice on the pretend billing screen with the work-done lines and no signature,
//      and the office job page shows the work done and who signed, with the signature image. On the second engine's job the finish has no
//      signature and is accepted.
// Status moves the job screen hands to P5-TWA-TODAY's confirm sheets (On my way, Arrived) are entered through the page's own engine
// (window.__bwTechOutbox: the enter() those sheets call). Run by ci/tech-job-stack.sh.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { BrowserContext, BrowserType, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, guardedPersistentContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_TECH_JOB_STACK_URL;
const db = process.env.BW_TECH_JOB_DB_CONTAINER;
const web = process.env.BW_TECH_JOB_WEB_CONTAINER;
const people = { maria: process.env.BW_TECH_JOB_MARIA, keisha: process.env.BW_TECH_JOB_KEISHA };
if (!base || !db || !web || Object.values(people).some((v) => !v)) throw new Error('BW_TECH_JOB_STACK_URL, _DB_CONTAINER, _WEB_CONTAINER and the session tokens are not set: run ci/tech-job-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so the page's writes are resent with the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const PHONE = { viewport: { width: 520, height: 980 }, colorScheme: 'light' as const };
const DESKTOP = { viewport: { width: 1440, height: 1100 } };
const HAROLD = 24830;
const HAROLD_MOBILE = '(614) 555-0148';
const PHOTO_MAX = 10 * 1024 * 1024;

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const version = (job: number) => Number(psql(`SELECT version FROM world.job WHERE job_number = ${job}`));
const later = Number(psql(`SELECT j.job_number FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE c.name = 'Harold Jenkins' AND j.date = '2026-10-20'`));
// F-1369: Directions on a job is the route from the van to THAT job; the van is at the last ended stop of the day (else the depot), and only the
// legs between stops are baked, so the stop before Harold's is ended (No one home: Done needs a billing item) for the route into his job to be baked.
psql(`UPDATE world.job SET status = 'no_one_home', ended_at = window_start WHERE status NOT IN ('done', 'no_one_home') AND job_number = (
  SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id
   WHERE t.name = 'Maria Santos' AND j.date = '2026-09-15' AND j.window_start < (SELECT window_start FROM world.job WHERE job_number = ${HAROLD})
   ORDER BY j.window_start DESC, j.job_number DESC LIMIT 1)`);

/** A PNG of noise, width x height RGB: it compresses to nothing, so its file is about 3 bytes a pixel (a non-JPEG over the cap). */
function noisePng(width: number, height: number): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  let x = 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    if (i % row === 0) { raw[i] = 0; continue; }
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    raw[i] = x & 0xff;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}
const BIG_PNG = noisePng(2400, 1600);
/** F-69: the owner's iPhone handed Safari Take Photo a 14,394,749-byte image/x-adobe-dng file; no engine here decodes these bytes. */
const DNG = Buffer.alloc(14_394_749, 0x4d);

/** A call as Keisha, the dispatcher (API-140 is a write: the default origin). */
function asKeisha<T>(method: string, p: string, body?: unknown): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${origin}/api/v1${p}`, {
      method,
      headers: { cookie: `bw_session=${people.keisha}`, origin: APP_ORIGIN, ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, data: (JSON.parse(text) as { data?: T }).data as T });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: text as unknown as T });
        }
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, read: () => Promise<T> | T, cond: (v: T) => boolean, tries = 240): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (cond(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 500)}`);
}

interface Net { off: boolean; uploads: { key: string; type: string; bytes: number }[] }
interface Hook { enter(i: unknown): Promise<{ key: string }>; sync(): Promise<unknown>; state(): { ready: boolean; waiting: { key: string }[]; online: boolean; lastSent: { key: string; result: string; code: string | null }[] } }

/** The page's writes carry the default origin, the network switch, and a record of each API-103 body as it left the phone. */
async function wire(context: BrowserContext, net: Net, session: string): Promise<void> {
  await context.addCookies([{ name: 'bw_session', value: session, url: origin, httpOnly: true }, { name: 'bw_lang', value: 'en', url: origin }]);
  await context.route(`${origin}/api/v1/**`, async (r) => {
    const req = r.request();
    if (net.off) return r.abort('internetdisconnected');
    if (req.method() === 'PUT' && req.url().includes('/tech/photos/')) {
      const body = req.postDataBuffer();
      net.uploads.push({ key: new URL(req.url()).pathname.split('/').pop()!, type: (await req.allHeaders())['content-type'] ?? '', bytes: body?.byteLength ?? 0 });
    }
    try {
      const response = await r.fetch(req.method() === 'GET' ? {} : { headers: { ...(await req.allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the call was in flight
    }
  });
}
const ready = (page: Page) => page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
const sync = (page: Page) => page.evaluate(async () => {
  await (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox.sync();
});
const waitingCount = (page: Page) => page.evaluate(() => (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox.state().waiting.length);
/** On my way and Arrived, as the confirm sheets of the Today screen enter them (the page's own engine), then 1 sync. */
const onSite = (page: Page, job: number, v: number) => page.evaluate(async ([n, base]) => {
  const h = (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox;
  await h.enter({ jobNumber: n, baseVersion: base, body: { kind: 'on_my_way' } });
  await h.enter({ jobNumber: n, baseVersion: base + 1, body: { kind: 'arrived' } });
  await h.sync();
  return JSON.stringify((h.state() as unknown as { waiting: { kind: string; lastTry?: unknown }[] }).waiting.map((w) => [w.kind, w.lastTry]));
}, [job, v] as const);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
/** A phone: a browser profile (a new one, or `dir` again: the same phone opened again). */
const phone = async (type: BrowserType, net: Net, serviceWorkers: 'allow' | 'block' = 'block', dir = ''): Promise<GuardedContext & { dir: string }> => {
  if (!dir) {
    dir = mkdtempSync(path.join(tmpdir(), 'bw-techjob-profile-'));
    dirs.push(dir);
  }
  const g = await guardedPersistentContext(type, dir, [origin], { ...PHONE, serviceWorkers });
  await wire(g.context, net, people.maria!);
  return { ...g, dir };
};
async function office(type: BrowserType): Promise<GuardedContext> {
  const g = await guardedContext(await type.launch({ headless: true }), [origin], DESKTOP);
  await wire(g.context, { off: false, uploads: [] }, people.keisha!);
  return g;
}
const closeOffice = async (g: GuardedContext) => {
  const b = g.context.browser();
  await g.context.close();
  await b?.close();
};
/** Open a technician screen and wait for the item engine; with `synced`, 1 sync, so the clock offset and the caller are saved. */
async function open(page: Page, href: string, synced = true): Promise<void> {
  await page.goto(`${origin}${href}`, { waitUntil: 'load' });
  await page.waitForSelector('.r1-screen .tabbar');
  await ready(page);
  if (synced) await sync(page);
}

/** The customer signs the pad with a finger stroke (a mouse drag). */
const sign = async (page: Page) => {
  const pad = page.locator('canvas.bw-sig-pad');
  // The pad in the middle of the window, clear of the sticky Finish job bar.
  await pad.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: 'center' }));
  const b = (await pad.boundingBox())!;
  await page.mouse.move(b.x + 20, b.y + b.height * 0.7);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + 20 + i * 14, b.y + b.height * (0.7 - 0.4 * Math.abs(Math.sin(i))));
  await page.mouse.up();
  await page.locator('[data-ctl="CTL-TEC-07-14"][data-signed="1"]').waitFor();
};

describe.each(engines)('the job screens on %s', (engine, type) => {
  const first = engine === engines[0]![0];
  // The job each engine finishes: Maria's next untouched Sep 15 job on the first engine (no signature), Harold's Sep 15 job (signed) on the
  // last, so every engine's Harold cases run while his job is still open.
  const signs = !first || engines.length === 1;
  const finishJob = () => (signs ? HAROLD : Number(psql(`SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id
     WHERE t.name = 'Maria Santos' AND j.date = '2026-09-15' AND j.status = 'scheduled' AND j.window_start > (SELECT window_start FROM world.job WHERE job_number = ${HAROLD}) ORDER BY j.window_start, j.job_number LIMIT 1`)));

  // why: FR-AUTH-4 Maria sees Harold's number on Sep 15 and not on his Oct 20 job, where API-101 does not send it
  it('shows Harold\'s number on his Sep 15 job and not on his Oct 20 job', async () => {
    const net: Net = { off: false, uploads: [] };
    const g = await phone(type, net);
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${HAROLD}`);
      await page.waitForSelector('[data-ctl="CTL-TEC-04-02"] h1');
      expect(await page.locator('[data-ctl="CTL-TEC-04-02"] h1').innerText()).toBe('Harold Jenkins');
      await page.locator('.acts [data-ctl="CTL-CMP-16-01"]').click();
      await expect.poll(async () => (await page.locator('[data-call-number]').innerText()).replace(/\D/g, '')).toMatch(new RegExp(`${HAROLD_MOBILE.replace(/\D/g, '')}$`));
      const answer = page.waitForResponse((r) => r.url().endsWith(`/api/v1/tech/jobs/${later}`));
      await page.goto(`${origin}/tech/jobs/${later}`, { waitUntil: 'load' });
      const body = await (await answer).text();
      await page.waitForSelector('[data-ctl="CTL-TEC-04-03"]');
      expect(await page.locator('p[data-ctl="CTL-TEC-04-03"]').innerText()).toBe('The phone number shows on the day of the visit.');
      expect(await page.locator('[data-ctl="CTL-CMP-16-01"]').count()).toBe(0);
      expect(body.replace(/\D/g, '')).not.toContain('6145550148');
      expect((JSON.parse(body) as { data: { customer: { phone: string | null } } }).data.customer.phone).toBeNull();
      expect((await page.content()).replace(/\D/g, '')).not.toContain('6145550148');
    } finally {
      await g.context.close();
    }
  });

  describe('the job follows the demo day of the phone', () => {
    const at = (day: string) => `${day}T10:00:00-04:00[America/New_York]`;
    const net: Net = { off: false, uploads: [] };
    let g: GuardedContext | null = null;
    let page: Page;
    let now = at('2026-09-15');
    let epoch = 0;
    let fails = false;
    const reads = { clock: 0, job: 0 };
    /** 12 API reads the case sends one after the other: a page that reads back to back reads many times while they run. */
    const readWindow = () => page.evaluate(async () => {
      for (let i = 0; i < 12; i += 1) await (await fetch('/api/v1/app-info')).text();
    });
    const hidden = () => page.locator('p[data-ctl="CTL-TEC-04-03"]').count();
    /** The job opened on its own day with its number shown. */
    const onItsDay = async () => {
      now = at('2026-09-15');
      await sync(page);
      const sent = reads.job;
      await open(page, `/tech/jobs/${HAROLD}`);
      await expect.poll(() => reads.job, { timeout: 15_000 }).toBeGreaterThan(sent);
      await page.locator('.acts [data-ctl="CTL-CMP-16-01"]').waitFor();
      await expect.poll(hidden).toBe(0);
    };
    beforeAll(async () => {
      g = await phone(type, net);
      page = g.context.pages()[0] ?? (await g.context.newPage());
      page.on('request', (r) => {
        const path = new URL(r.url()).pathname;
        if (path === '/api/v1/clock') reads.clock += 1;
        if (path === `/api/v1/tech/jobs/${HAROLD}`) reads.job += 1;
      });
      await page.route(`${origin}/api/v1/clock`, async (r) => {
        if (net.off) return r.abort('internetdisconnected');
        if (fails) return r.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'refused', status: 500, code: 'server_error' }) });
        try {
          const response = await r.fetch();
          const json = (await response.json()) as { data: { worldEpoch: number } };
          Object.assign(json.data, { demoNow: now, paused: true, worldEpoch: json.data.worldEpoch + epoch });
          return await r.fulfill({ response, json });
        } catch {
          return undefined; // the page closed under the request
        }
      });
      await open(page, `/tech/jobs/${HAROLD}`);
    });
    afterAll(async () => {
      await g?.context.close();
    });

    // why: FR-AUTH-4, F-1930 the customer's number shows only on the demo day of the visit: an open job hides it when a clock jump moves the phone's demo day, with no reset and no reload, and asks the server once what is today now
    it('hides the number when the clock moves to another day with no reset', async () => {
      await onItsDay();
      const sent = reads.job;
      now = at('2026-09-16');
      await sync(page);
      await expect.poll(hidden, { timeout: 15_000 }).toBe(1);
      await expect.poll(() => reads.job - sent, { timeout: 15_000 }).toBe(1);
    });

    // why: FR-AUTH-4, F-1930 a phone that missed the clock's move while it had no signal shows the new day once the signal is back
    it('hides the number when the signal comes back after a missed clock move', async () => {
      await onItsDay();
      net.off = true;
      await page.context().setOffline(true);
      now = at('2026-09-16');
      net.off = false;
      await page.context().setOffline(false);
      await expect.poll(hidden, { timeout: 15_000 }).toBe(1);
    });

    // why: FR-AUTH-4, FR-DEMO-4 a world reset that sets another demo day reaches the open job: the number of a visit on another day is hidden
    it('hides the number when a world reset sets another day', async () => {
      await onItsDay();
      epoch += 1;
      now = at('2026-09-16');
      await page.evaluate(() => {
        const w = globalThis as unknown as { dispatchEvent(e: unknown): void; Event: new (n: string) => unknown };
        w.dispatchEvent(new w.Event('focus'));
      });
      await expect.poll(hidden, { timeout: 15_000 }).toBe(1);
    });

    // why: F-1930 a failed clock read keeps the day the job shows and starts no run of reads
    it('keeps its day and reads a bounded number of times while the clock does not answer', async () => {
      await onItsDay();
      const before = { ...reads };
      now = at('2026-09-16');
      fails = true;
      try {
        await sync(page);
        await readWindow();
        expect(reads.clock - before.clock, 'clock reads').toBeLessThanOrEqual(3);
        expect(reads.job - before.job, 'job reads').toBe(0);
        expect(await hidden()).toBe(0);
      } finally {
        fails = false;
      }
    });

    // why: SD-16, F-1931 the job is read again once for each send that was answered, and an engine state change that sends nothing reads nothing
    it('reads the job once for a send, and not at all for 5 syncs that send nothing', async () => {
      await onItsDay();
      const jobReads = async (what: () => Promise<unknown>) => {
        const before = reads.job;
        await what();
        await readWindow();
        return reads.job - before;
      };
      const note = async () => {
        const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/tech/items');
        await page.evaluate(async ([n, v]) => {
          const h = (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox;
          await h.enter({ jobNumber: n, baseVersion: v, body: { kind: 'note', payload: { text: 'A note of the read count' } } });
          await h.sync();
        }, [HAROLD, version(HAROLD)] as const);
        await answered;
        await expect.poll(() => waitingCount(page)).toBe(0);
        await expect.poll(() => reads.job).toBeGreaterThan(0);
      };
      const first = await jobReads(note);
      const quiet = await jobReads(async () => {
        for (let i = 0; i < 5; i += 1) await sync(page);
      });
      const second = await jobReads(note);
      console.log(`F-1931 (${engine}): job reads after the first send ${first}, over 5 syncs that send nothing ${quiet}, after the next send ${second}`);
      expect(quiet).toBe(0);
      expect(first).toBe(1);
      expect(second).toBe(1);
    });
  });

  // why: FR-TECH-4, F-1932 the finish and its signature are 2 entries: when the second cannot be kept the screen says so and stays, and the next press keeps the signature with no second finish; when the first cannot be kept neither is
  it('keeps the finish screen open with its error until the signature is kept, with 1 finish and 1 signature', async () => {
    const net: Net = { off: false, uploads: [] };
    const g = await phone(type, net);
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${HAROLD}/finish`);
      await page.locator('[data-ctl="CTL-TEC-07-05"] input').waitFor({ state: 'attached' });
      // No call reaches the server from here: nothing this case enters is ever sent.
      net.off = true;
      await page.locator('[data-ctl="CTL-TEC-07-05"] input').check({ force: true });
      await page.locator('[data-ctl="CTL-TEC-07-07"] input').first().fill('1');
      await page.locator('[data-ctl="CTL-TEC-07-07"] input').nth(1).fill('5');
      await sign(page);
      /** From here the phone's item database refuses writes to this table ('' takes them again). */
      const refuse = (table: string) => page.evaluate((name) => {
        type Store = { name: string; transaction: { db: { name: string } } };
        type Write = (this: Store, ...a: unknown[]) => unknown;
        const w = globalThis as unknown as { IDBObjectStore: { prototype: Record<'add' | 'put', Write> }; __bwRefuse?: string };
        if (w.__bwRefuse === undefined) {
          for (const op of ['add', 'put'] as const) {
            const real = w.IDBObjectStore.prototype[op];
            w.IDBObjectStore.prototype[op] = function (this: Store, ...a: unknown[]) {
              if (this.transaction.db.name === 'bw-tech-items' && this.name === w.__bwRefuse) throw new DOMException('full', 'QuotaExceededError');
              return real.apply(this, a);
            };
          }
        }
        w.__bwRefuse = name;
      }, table);
      const kinds = () => page.evaluate(() => (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox.state().waiting.map((w) => (w as unknown as { kind: string }).kind).sort());
      const finish = async () => {
        await page.locator('[data-ctl="CTL-TEC-07-06"]').click();
        await page.locator('.cstep [data-ctl="CTL-TEC-07-08"]').click();
      };
      const says = page.locator('.fmsg[role="alert"][data-ctl="CTL-TEC-07-14"]');

      await refuse('items');
      await finish();
      await says.first().waitFor();
      expect(await kinds()).toEqual([]);

      await refuse('blobs');
      await finish();
      await expect.poll(kinds).toEqual(['finished']);
      console.log(`F-1932 (${engine}): with the signature not kept, the phone holds ${JSON.stringify(await kinds())} at ${new URL(page.url()).pathname}`);
      await says.first().waitFor();
      expect(new URL(page.url()).pathname).toBe(`/tech/jobs/${HAROLD}/finish`);
      expect(await page.locator('[data-ctl="CTL-TEC-07-14"][data-signed="1"]').count()).toBe(1);

      await refuse('');
      await finish();
      await page.waitForURL(`**/tech/jobs/${HAROLD}?finished=1`);
      await ready(page);
      await expect.poll(kinds).toEqual(['finished', 'signature']);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-8 (F-1031) Harold's job on the phone shows his gas furnace (2014, basement) in CTL-TEC-04-06 and his past visits in CTL-TEC-04-07, read live from API-101
  it('shows Harold\'s gas furnace, 2014, basement and his past visits on his job', async () => {
    const net: Net = { off: false, uploads: [] };
    const g = await phone(type, net);
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${HAROLD}`);
      await page.waitForSelector('[data-ctl="CTL-TEC-04-06"] .eq');
      // FR-TECH-8 (F-1125): the card's equipment row is the gas furnace, 2014, basement, together (the API lists the furnace first)
      const row = (await page.locator('[data-ctl="CTL-TEC-04-06"] .eq').innerText()).toLowerCase();
      expect(row).toContain('furnace');
      expect(row).toContain('2014');
      expect(row).toContain('basement');
      const answer = await page.evaluate(async (n) => ((await (await fetch(`/api/v1/tech/jobs/${n}`)).json()) as { data: { equipment: { type: string; year: number | null; location: string | null }[] } }).data.equipment, HAROLD);
      expect(answer[0]).toMatchObject({ type: 'furnace', year: 2014, location: 'basement' });
      // the past visits are the server's (past_visit and his finished jobs, newest first, at most 3): the same count on the screen
      const customer = psql(`SELECT customer_id FROM world.job WHERE job_number = ${HAROLD}`);
      const expected = Number(psql(`SELECT least(3, (SELECT count(*) FROM world.past_visit WHERE customer_id = '${customer}')
        + (SELECT count(*) FROM world.job WHERE customer_id = '${customer}' AND status = 'done' AND job_number <> ${HAROLD}))`));
      expect(expected, 'the seed gives Harold past visits').toBeGreaterThan(0);
      await page.waitForSelector('[data-ctl="CTL-TEC-04-07"] .hrow');
      expect(await page.locator('[data-ctl="CTL-TEC-04-07"] .hrow').count()).toBe(expected);
      expect(await page.locator('[data-ctl="CTL-TEC-04-07"] .r1-note').count()).toBe(0);
    } finally {
      await g.context.close();
    }
  });

  // why: F-1369 FR-TECH-13 on Harold's job card the Directions button shows a minutes figure equal to the drive time of the route from the van to
  // his job (API-104 toJob, no fromJob: the route FR-TECH-5 draws), and 1 tap opens that route, not the one to the job after his (owner answer fa9c9833)
  it('shows on Harold\'s Directions button the drive minutes of API-104 from the van to his job, and opens that route', async () => {
    const net: Net = { off: false, uploads: [] };
    const g = await phone(type, net);
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${HAROLD}`);
      const route = await page.evaluate(async (to) => (await (await fetch(`/api/v1/tech/route?toJob=${to}`)).json()) as { data: { leg: { minutes: number; track: unknown } } }, HAROLD);
      expect(route.data.leg.track).not.toBeNull(); // a baked route: its minutes are the drive time FR-TECH-13 names
      const btn = page.locator('.acts [data-ctl="CTL-TEC-04-04"]');
      await expect.poll(async () => btn.getAttribute('data-minutes')).toBe(String(route.data.leg.minutes));
      expect(await btn.locator('small').innerText()).toBe(`${route.data.leg.minutes} min`);
      await btn.click();
      await page.waitForURL(`${origin}/tech/jobs/${HAROLD}/directions`);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-2 On my way on Harold's job opens Today's confirm sheet for his job (SCR-TEC-03, P5-TWA-TODAY); Cancel saves nothing
  it('opens Today\'s On my way sheet for Harold from his job, and Cancel saves nothing', async () => {
    const net: Net = { off: false, uploads: [] };
    const g = await phone(type, net);
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${HAROLD}`);
      // Harold is Scheduled here on every engine: each engine's finish case runs after this one (see finishJob).
      await page.locator('[data-ctl="CTL-TEC-04-13"]').click();
      await page.waitForURL(`${origin}/tech`);
      const sheet = page.locator('.bw-sheet-host[data-dialog="SCR-TEC-03"]');
      await sheet.waitFor();
      expect(await sheet.locator('h2').innerText()).toContain('Harold');
      await sheet.locator('[data-ctl="CTL-TEC-03-03"]').click();
      await expect.poll(() => sheet.count()).toBe(0);
      await ready(page);
      expect(await waitingCount(page)).toBe(0);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-4, FR-TECH-10, NFR-09 (F-1083) with no signal, every page the app links to during the day opens from what the phone holds,
  // starting from Today as the owner's iPhone run did: Harold's job, Add note (saved, Waiting to send), Add photo (saved), Directions, the
  // tabs, Waiting and Finish; a job never opened shows the job screen's own "not on this phone"; a page the phone does not hold shows the
  // app's no-signal page, never the browser's error page
  it('opens every page of the day with no signal, starting from Today, as on the owner\'s iPhone (F-1083)', async () => {
    const net: Net = { off: false, uploads: [] };
    const g = await phone(type, net, 'allow');
    const other = Number(psql(`SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id
      WHERE t.name = 'Maria Santos' AND j.date = '2026-09-15' AND j.job_number <> ${HAROLD} ORDER BY j.window_start DESC, j.job_number DESC LIMIT 1`));
    const failed: string[] = [];
    const note = `Basement test note (${engine})`;
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      page.on('requestfailed', (r) => {
        if (r.isNavigationRequest()) failed.push(`${new URL(r.url()).pathname} ${r.failure()?.errorText ?? ''}`);
      });
      /**
       * A move with no signal: the screen it opens (its .r1-screen id, and `more` anywhere in the page: a sheet such as SCR-TEC-06's sits
       * beside the screen), or the browser's failure (WebKit: "FetchEvent.respondWith received an error").
       */
      const opens = async (what: string, act: () => Promise<unknown>, screen: string, more = '') => {
        const before = failed.length;
        const thrown = await act().then(() => '', (e: unknown) => String((e as Error).message).split('\n')[0]!);
        const want = [`.r1-screen[data-screen="${screen}"]`, ...(more ? [more] : [])];
        const there = async () => (await Promise.all(want.map((s) => page.locator(s).count().catch(() => 0)))).every((n) => n > 0);
        for (let i = 0; ; i += 1) {
          if (failed.length > before || thrown) throw new Error(`F-1083: ${what} with no signal did not open: ${[...failed.slice(before), thrown].filter(Boolean).join('; ')}`);
          if (await there()) return;
          if (i >= 150) throw new Error(`F-1083: ${what} with no signal: no ${want.join(' with ')} at ${page.url()}`);
          await sleep(200);
        }
      };
      // With signal: Today under the worker, Harold's job opened (owner steps 4 and 5), then back on Today, where steps 6 and 7 end.
      await open(page, '/tech', false);
      await page.waitForFunction(async () => Boolean(await (globalThis as unknown as { navigator: { serviceWorker: { ready: Promise<unknown> } } }).navigator.serviceWorker.ready), undefined, { timeout: 30_000 });
      await page.reload({ waitUntil: 'load' });
      await ready(page);
      await page.locator(`a[href="/tech/jobs/${HAROLD}"]`).first().click();
      await page.waitForURL(`**/tech/jobs/${HAROLD}`);
      await page.locator('[data-ctl="CTL-TEC-04-02"] h1').waitFor();
      await ready(page);
      await page.locator('[data-ctl="CTL-TEC-04-01"]').click();
      await page.waitForURL(`${origin}/tech`);
      await ready(page);
      // The minutes the owner spends on steps 6 and 7: what the phone holds of the day's pages by then (bounded; not asserted here, the
      // moves below are).
      const pages = [`/tech/jobs/${HAROLD}/note`, `/tech/jobs/${HAROLD}/photo`, `/tech/jobs/${HAROLD}/finish`, `/tech/jobs/${other}`, '/tech/map', '/tech/parts', '/tech/me', '/tech/waiting'];
      const held = async () => page.evaluate(async (list) => {
        const w = globalThis as unknown as { caches: { open(n: string): Promise<{ match(u: string): Promise<unknown> }> }; location: { origin: string } };
        const shell = await w.caches.open('bw-tech-shell-v1');
        const out: string[] = [];
        for (const p of list) if (await shell.match(`${w.location.origin}${p}`)) out.push(p);
        return out;
      }, pages).catch(() => [] as string[]);
      let have: string[] = [];
      for (let i = 0; i < 60 && have.length < pages.length; i += 1) {
        have = await held();
        if (have.length < pages.length) await sleep(1000);
      }
      console.log(`F-1083 (${engine}): the phone holds ${have.length} of ${pages.length} of the day's pages before the signal goes: ${have.join(' ') || 'none'}`);

      // Step 8: no signal. Step 9 from Today: Harold's job, Add note, Save note.
      net.off = true;
      await g.context.setOffline(true);
      await opens('Harold\'s job from Today', () => page.locator(`a[href="/tech/jobs/${HAROLD}"]`).first().click(), 'SCR-TEC-04', '[data-ctl="CTL-TEC-04-02"] h1');
      await ready(page);
      await opens('Add note', () => page.locator('[data-ctl="CTL-TEC-04-09"]').click(), 'SCR-TEC-05', '[data-ctl="CTL-TEC-05-01"]');
      await ready(page);
      await page.locator('[data-ctl="CTL-TEC-05-01"]').fill(note);
      await page.waitForSelector('[data-ctl="CTL-TEC-05-04"]');
      await opens('Save note', () => page.locator('[data-ctl="CTL-TEC-05-02"]').click(), 'SCR-TEC-04', `.note[data-kind="technician"]:has-text("${note}") .r1p-wait`);
      await ready(page);
      expect(await waitingCount(page)).toBe(1);
      // Step 10: Add photo, a photo picked, Save photo.
      await opens('Add photo', () => page.locator('[data-ctl="CTL-TEC-04-12"]').click(), 'SCR-TEC-06', '[data-ctl="CTL-TEC-06-01"]');
      await ready(page);
      await page.locator('input[type="file"]').setInputFiles({ name: 'wall.png', mimeType: 'image/png', buffer: noisePng(64, 48) });
      await page.waitForSelector('[data-ctl="CTL-TEC-06-02"] img', { timeout: 60_000 });
      await opens('Save photo', () => page.locator('button[data-ctl="CTL-TEC-06-03"]').click(), 'SCR-TEC-04', '.r1p-notice[data-ctl="CTL-CMP-11-01"]');
      await ready(page);
      expect(await waitingCount(page)).toBe(2);
      // The day's other links: Directions and its Back, the tabs (client moves that fall back to a page load), Waiting, Finish.
      await opens('Directions', () => page.locator('.acts [data-ctl="CTL-TEC-04-04"]').click(), 'SCR-TEC-08', '[data-ctl="CTL-TEC-08-02"]');
      await opens('Back to Today from Directions', () => page.locator('.dh .nav [role="link"]').click(), 'SCR-TEC-02'); // Back (the header's link; CTL-TEC-08-05 is the Next turn card)
      await opens('the Map tab', () => page.locator('.tabbar [data-ctl="CTL-CMP-09-03"]').click(), 'SCR-TEC-15');
      await opens('the Parts tab', () => page.locator('.tabbar [data-ctl="CTL-CMP-09-04"]').click(), 'SCR-TEC-16', '[data-ctl="CTL-TEC-16-01"]');
      await opens('the Me tab', () => page.locator('.tabbar [data-ctl="CTL-CMP-09-02"]').click(), 'SCR-TEC-10', '[data-ctl="CTL-TEC-10-02"]');
      await opens('Waiting to send from Me', () => page.locator('[data-ctl="CTL-TEC-10-02"]').click(), 'SCR-TEC-09');
      await opens('the Today tab', () => page.locator('.tabbar [data-ctl="CTL-CMP-09-01"]').click(), 'SCR-TEC-02');
      await opens('Finish job', () => page.goto(`${origin}/tech/jobs/${HAROLD}/finish`, { waitUntil: 'load' }), 'SCR-TEC-07', '[data-ctl="CTL-TEC-07-06"]');
      await opens('Today', () => page.goto(`${origin}/tech`, { waitUntil: 'load' }), 'SCR-TEC-02');
      // A job of the day never opened on this phone: the page opens with the job screen's own state (UI-SPECIFICATION, Offline, not saved).
      await opens('a job never opened, from Today', () => page.locator(`a[href="/tech/jobs/${other}"]`).first().click(), 'SCR-TEC-04', '[data-state="not_on_phone"]');
      // A page the phone does not hold (Harold's Oct 20 job is not on the day): the app's no-signal page, with the way back to Today.
      const before = failed.length;
      await page.goto(`${origin}/tech/jobs/${later}/note`, { waitUntil: 'load' }).catch((e: unknown) => failed.push(`/tech/jobs/${later}/note ${String((e as Error).message).split('\n')[0]}`));
      expect(failed.slice(before), 'a page the phone does not hold opened the browser\'s error page').toEqual([]);
      await page.locator('[data-bw-offline] a[href="/tech"]').waitFor({ timeout: 10_000 });
      expect(await page.locator('[data-bw-offline] h1').innerText()).toBe('No signal');
      expect(failed).toEqual([]);
    } finally {
      await g.context.setOffline(false).catch(() => undefined);
      await g.context.close();
    }
  });

  // why: FR-DISP-27 (F-703) on Harold's Sep 15 job an office note saved with Add note (API-140) shows on SCR-TEC-04 with its author and time
  it('shows an office note saved with Add note on Harold\'s Sep 15 job, with its author and time', async () => {
    const body = `The gate code is 4417 (${engine})`;
    const saved = await asKeisha<{ note: { id: string; author: string; at: string } }>('POST', '/notes', { jobNumber: HAROLD, body });
    expect(saved.status).toBe(201);
    const g = await phone(type, { off: false, uploads: [] });
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${HAROLD}`);
      const note = page.locator(`[data-ctl="CTL-TEC-04-08"] .note[data-kind="office"]`, { hasText: body });
      await note.waitFor();
      expect(await note.locator('.by').innerText()).toMatch(/^Office, Keisha Thompson - \d{1,2}:\d\d [AP]M$/);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-DEMO-2, FR-TECH-3 the note screen draws the demo clock in its header while the job loads and when the job is not the technician's, as the job and finish screens do (F-1981)
  it('draws the clock in the header of the note screen when the job is not the technician\'s', async () => {
    const other = Number(psql(`SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id
      WHERE t.name <> 'Maria Santos' AND j.date = '2026-09-15' ORDER BY j.job_number LIMIT 1`));
    expect(other, 'a job of another technician on Sep 15').toBeGreaterThan(0);
    const g = await phone(type, { off: false, uploads: [] });
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await page.goto(`${origin}/tech/jobs/${other}/note`, { waitUntil: 'load' });
      await page.waitForSelector('[data-screen="SCR-TEC-05"] .r1p-empty');
      expect(await page.locator('[data-screen="SCR-TEC-05"] .apphead .r1p-clk').count()).toBe(1);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-3 a note typed on SCR-TEC-05 and a photo attached on SCR-TEC-06 of Harold's job appear on the office job detail (FR-DISP-5)
  // why: F-978, F-69 the photo picked is a PNG over 10 MB; the one that reaches API-103 is a JPEG of at most 2048 px within the cap, and a file the phone cannot decode leaves it flagged and listed
  it('adds a note and a photo to Harold\'s job from the screens; the office sees both; an over-cap PNG goes as a JPEG, a DNG leaves flagged', async () => {
    const net: Net = { off: false, uploads: [] };
    const g = await phone(type, net);
    const text = `Flame sensor dirty again; cleaned it (${engine})`;
    let photoKey = '';
    let dngKey = '';
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${HAROLD}`);
      await page.locator('[data-ctl="CTL-TEC-04-09"]').click();
      await page.waitForURL(`**/tech/jobs/${HAROLD}/note`);
      await ready(page);
      await page.locator('[data-ctl="CTL-TEC-05-01"]').fill(text);
      await page.waitForSelector('[data-ctl="CTL-TEC-05-04"]');
      // The draft is on the phone as typed: a reload brings it back (CTL-TEC-05-01, Restored).
      await sleep(300);
      await page.reload({ waitUntil: 'load' });
      await ready(page);
      await expect.poll(() => page.locator('[data-ctl="CTL-TEC-05-01"]').inputValue()).toBe(text);
      await page.locator('[data-ctl="CTL-TEC-05-02"]').click();
      await page.waitForURL(`**/tech/jobs/${HAROLD}`);
      await ready(page);
      await page.locator('.note', { hasText: text }).waitFor();

      await page.locator('[data-ctl="CTL-TEC-04-12"]').click();
      await page.waitForURL(`**/tech/jobs/${HAROLD}/photo`);
      await ready(page);
      await page.locator('input[type="file"]').setInputFiles({ name: 'burner.png', mimeType: 'image/png', buffer: BIG_PNG });
      await page.waitForSelector('[data-ctl="CTL-TEC-06-02"] img', { timeout: 60_000 });
      await page.locator('button[data-ctl="CTL-TEC-06-03"]').click();
      // SCR-TEC-06 Saved: the sheet closes to the job, which says the photo is kept on this phone and shows it Waiting to send (DK-110).
      await page.waitForURL(`**/tech/jobs/${HAROLD}?photo=saved`);
      await page.locator('.r1p-notice[data-ctl="CTL-CMP-11-01"]').waitFor();
      await page.locator('[data-ctl="CTL-TEC-04-11"][data-waiting="1"]').first().waitFor();
      await ready(page);
      await sync(page);
      await expect.poll(() => waitingCount(page)).toBe(0);
      const up = net.uploads.at(-1)!;
      photoKey = up.key;
      const row = psql(`SELECT bytes || ' ' || width || ' ' || height FROM world.photo WHERE key = '${photoKey}'`).split(' ').map(Number);
      console.log(`F-978 proof (${engine}): picked image/png ${BIG_PNG.byteLength} bytes 2400 x 1600; API-103 got ${up.type} ${up.bytes} bytes; stored ${row[0]} bytes ${row[1]} x ${row[2]}`);
      expect(BIG_PNG.byteLength).toBeGreaterThan(PHOTO_MAX);
      expect(up.type).toBe('image/jpeg');
      expect(up.bytes).toBeGreaterThan(0);
      expect(up.bytes).toBeLessThanOrEqual(PHOTO_MAX);
      expect(row).toEqual([up.bytes, 2048, 1365]);

      await page.locator('[data-ctl="CTL-TEC-04-12"]').click();
      await page.waitForURL(`**/tech/jobs/${HAROLD}/photo`);
      await ready(page);
      await page.locator('input[type="file"]').setInputFiles({ name: 'IMG_0001.DNG', mimeType: 'image/x-adobe-dng', buffer: DNG });
      await page.waitForSelector('[data-ctl="CTL-TEC-06-02"]', { timeout: 60_000 });
      await page.locator('button[data-ctl="CTL-TEC-06-03"]').click();
      await page.waitForURL(`**/tech/jobs/${HAROLD}?photo=saved`);
      await ready(page);
      await sync(page);
      await expect.poll(() => waitingCount(page)).toBe(0);
      const dng = net.uploads.at(-1)!;
      dngKey = dng.key;
      console.log(`F-978 proof (${engine}): picked image/x-adobe-dng ${DNG.byteLength} bytes (not decodable here); API-103 got ${dng.type} ${dng.bytes} bytes; answered ${psql(`SELECT result FROM world.tech_item WHERE key = '${dngKey}'`)}`);
      expect(dng.bytes).toBe(0);
      expect(psql(`SELECT result FROM world.tech_item WHERE key = '${dngKey}'`)).toBe('flagged');
      expect(psql(`SELECT count(*) FROM world.offline_conflict WHERE item_key = '${dngKey}' AND handled_at IS NULL AND message_key = 'offline.flag.validation_failed'`)).toBe('1');
    } finally {
      await g.context.close();
    }
    expect(psql(`SELECT count(*) FROM world.note WHERE job_number = ${HAROLD} AND body = '${text.replace(/'/g, "''")}' AND author_kind = 'technician'`)).toBe('1');

    const o = await office(type);
    try {
      const p = await o.context.newPage();
      await p.goto(`${origin}/office/jobs/${HAROLD}`, { waitUntil: 'load' });
      await p.locator('[data-ctl="CTL-OFC-03-14"] .note', { hasText: text }).waitFor({ timeout: 60_000 });
      const thumb = p.locator(`[data-ctl="CTL-OFC-03-15"][data-photo="${photoKey}"] img`);
      await thumb.waitFor();
      // P6-PHOTO-THUMBS (SD-32, UD-55): the tile draws the photo's small copy, 320 px on the 2048 px photo's longest side.
      await expect.poll(() => thumb.evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth)).toBe(320);
      await thumb.click();
      await p.locator('[data-ctl="CTL-OFC-03-16"] img').waitFor();
    } finally {
      await closeOffice(o);
    }
    psql(`UPDATE world.offline_conflict SET handled_at = now() WHERE item_key = '${dngKey}'`);
  });

  // why: FR-BILL-3 a finish with neither parts nor No parts used is refused on the screen; a part is found by its code and added with a quantity; a text that is no listed part adds nothing
  // why: FR-TECH-14 the work-done lines and the signature are kept with no signal through closing and reopening the app; Clear empties the signature; the invoice lists the work-done lines and no signature; the office job page shows the work done and who signed; a finish with no signature is accepted
  it('refuses a finish with neither, keeps the entries offline through a closed app, and a finish makes 1 invoice with the work done', async () => {
    const job = finishJob();
    const customer = psql(`SELECT c.name FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = ${job}`);
    const lines = [`Cleaned the flame sensor (${engine})`, 'Replaced the 16x25x4 filter'];
    const net: Net = { off: false, uploads: [] };
    // 3 opens of 1 phone: the entries are made (A); with the service worker on, the app is opened with signal, then closed and opened
    // again with no signal (B); then with signal again it finishes (C). WebKit hands a page's calls under a service worker to the network
    // without the suite's routes (no default origin, so the server refuses writes), so the writes run in A and C, with the worker off.
    let g = await phone(type, net);
    const dir = g.dir;
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${job}`);
      const left = await onSite(page, job, version(job));
      if (left !== '[]') console.log(`on site (${engine}): still waiting ${left}`);
      await until(`job ${job} on site`, () => psql(`SELECT status || ' ' || coalesce((SELECT string_agg(kind || ':' || result, ',') FROM world.tech_item WHERE job_number = ${job} AND kind IN ('on_my_way', 'arrived')), '') || ' ' || coalesce((SELECT string_agg(message_key, ',') FROM world.offline_conflict WHERE job_number = ${job} AND handled_at IS NULL), '') FROM world.job WHERE job_number = ${job}`), (s) => s.startsWith('on_site'), 60);
      await open(page, `/tech/jobs/${job}`);
      await page.locator('a[data-ctl="CTL-TEC-04-15"]').click();
      await page.waitForURL(`**/tech/jobs/${job}/finish`);
      await ready(page);

      await page.locator('[data-ctl="CTL-TEC-07-06"]').click();
      expect(await page.locator('.fmsg[data-msg="parts"]').innerText()).toBe('Add the parts you used, or tick No parts used.');
      expect(await page.locator('.cstep').count()).toBe(0);

      const find = page.locator('[data-ctl="CTL-TEC-07-02"] input');
      await find.fill('nothing-like-a-part');
      await page.getByText('No part matches nothing-like-a-part. Search by name or code.').waitFor();
      await find.fill('FLT-16254');
      await page.locator('#bw-part-res [role="option"][data-part="FLT-16254"]').click();
      await page.locator('[data-ctl="CTL-TEC-07-01"] .pt[data-part="FLT-16254"]').waitFor();
      await page.locator('[data-ctl="CTL-TEC-07-01"] .pt[data-part="FLT-16254"] [aria-label="More"]').click();
      await expect.poll(() => page.locator('.pt[data-part="FLT-16254"] .step b').innerText()).toBe('2');
      expect(await page.locator('[data-ctl="CTL-TEC-07-01"] .pt').count()).toBe(1);

      await page.locator('[data-ctl="CTL-TEC-07-11"] input').first().fill(lines[0]!);
      await page.locator('[data-ctl="CTL-TEC-07-12"]').click();
      await page.locator('[data-ctl="CTL-TEC-07-11"] input').nth(1).fill(lines[1]!);
      // Labor: prefilled from Arrived to now (the stack's clock may not have moved since Arrived); the technician types it.
      await page.locator('[data-ctl="CTL-TEC-07-07"] input').first().fill('1');
      await page.locator('[data-ctl="CTL-TEC-07-07"] input').nth(1).fill('5');
      if (signs) {
        await sign(page);
        expect(await page.locator('[data-ctl="CTL-TEC-07-14"] .who').innerText()).toMatch(new RegExp(`^${customer} signed \\d{1,2}:\\d\\d [AP]M$`));
      }
      await sleep(400); // the last change's write
    } finally {
      await g.context.close();
    }

    g = await phone(type, net, 'allow', dir);
    try {
      let page = g.context.pages()[0] ?? (await g.context.newPage());
      await page.goto(`${origin}/tech/jobs/${job}/finish`, { waitUntil: 'load' });
      await ready(page);
      // The service worker controls the page from here, so an open with no signal opens the kept finish screen.
      await page.waitForFunction(async () => Boolean(await (globalThis as unknown as { navigator: { serviceWorker: { ready: Promise<unknown> } } }).navigator.serviceWorker.ready), undefined, { timeout: 30_000 });
      await page.reload({ waitUntil: 'load' });
      await ready(page);
      // No signal: the app is closed and opened again; the kept entries, lines and signature are back.
      net.off = true;
      await g.context.setOffline(true);
      // The new page opens (blank) before the old one closes: Linux WebKit ends a persistent context when its last page closes
      // (Playwright 1.64.1, WebKit 2370; macOS WebKit and Chromium do not), so newPage after close found the browser gone (F-1166).
      const reopened = await g.context.newPage();
      await page.close();
      page = reopened;
      await page.goto(`${origin}/tech/jobs/${job}/finish`, { waitUntil: 'load' });
      await ready(page);
      await page.locator('[data-ctl="CTL-CMP-11-01"]').waitFor();
      await expect.poll(() => page.locator('[data-ctl="CTL-TEC-07-11"] input').evaluateAll((els) => els.map((e) => (e as unknown as { value: string }).value))).toEqual(lines);
      expect(await page.locator('.pt[data-part="FLT-16254"] .step b').innerText()).toBe('2');
      expect(await page.locator('[data-ctl="CTL-TEC-07-07"] input').evaluateAll((els) => els.map((e) => (e as unknown as { value: string }).value))).toEqual(['1', '5']);
      if (signs) {
        await page.locator('[data-ctl="CTL-TEC-07-14"][data-signed="1"]').waitFor();
        await page.locator('[data-ctl="CTL-TEC-07-15"]').click();
        await page.locator('[data-ctl="CTL-TEC-07-14"][data-signed="0"]').waitFor();
        await sign(page);
      } else {
        expect(await page.locator('[data-ctl="CTL-TEC-07-14"]').getAttribute('data-signed')).toBe('0');
      }
      await sleep(400);
    } finally {
      await g.context.close();
    }
    net.off = false;

    g = await phone(type, net, 'block', dir);
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await open(page, `/tech/jobs/${job}/finish`, false);
      // The worker B registered still controls this profile's pages in WebKit: unregister it, so the writes go through the suite's routes.
      await page.evaluate(async () => {
        const sw = (globalThis as unknown as { navigator: { serviceWorker?: { getRegistrations(): Promise<{ unregister(): Promise<boolean> }[]> } } }).navigator.serviceWorker;
        if (!sw) return;
        await Promise.all((await sw.getRegistrations()).map((r) => r.unregister()));
      });
      await open(page, `/tech/jobs/${job}/finish`);
      await expect.poll(() => page.locator('[data-ctl="CTL-TEC-07-11"] input').evaluateAll((els) => els.map((e) => (e as unknown as { value: string }).value))).toEqual(lines);
      await page.locator('[data-ctl="CTL-TEC-07-06"]').click();
      await page.locator('.cstep').waitFor();
      expect(await page.locator('.cstep li').allInnerTexts()).toContain('Labor 1 hr 5 min');
      await page.locator('[data-ctl="CTL-TEC-07-08"]').click();
      await page.waitForURL(`**/tech/jobs/${job}?finished=1`);
      await ready(page);
      await sync(page);
      await expect.poll(() => waitingCount(page)).toBe(0);
    } finally {
      await g.context.close();
    }
    expect(psql(`SELECT status FROM world.job WHERE job_number = ${job}`)).toBe('done');
    expect(psql(`SELECT string_agg(text, '|' ORDER BY seq) FROM world.work_done_line WHERE job_number = ${job}`)).toBe(lines.join('|'));
    expect(psql(`SELECT p.code || ' x ' || jp.quantity FROM world.job_part jp JOIN world.part p ON p.id = jp.part_id WHERE jp.job_number = ${job}`)).toBe('FLT-16254 x 2');
    expect(psql(`SELECT count(*) FROM world.signature WHERE job_number = ${job}`)).toBe(signs ? '1' : '0');

    // 1 invoice on the pretend billing screen, with the work-done lines and no signature (FR-TECH-14: never sent to billing).
    await until(`job ${job} at billing`, async () => (await asKeisha<{ invoices: { jobNumber: number }[] }>('GET', '/pretend-billing/invoices')).data,
      (d) => d.invoices.some((i) => i.jobNumber === job));
    const invoices = (await asKeisha<{ invoices: { jobNumber: number }[] }>('GET', '/pretend-billing/invoices')).data.invoices.filter((i) => i.jobNumber === job);
    expect(invoices).toHaveLength(1);
    const inv = JSON.stringify((await asKeisha('GET', `/pretend-billing/invoices/${job}`)).data);
    for (const l of lines) expect(inv).toContain(l);
    expect(inv.toLowerCase()).not.toMatch(/signature|signed/);

    const o = await office(type);
    try {
      const p = await o.context.newPage();
      await p.goto(`${origin}/billing-system/invoices/${job}`, { waitUntil: 'load' });
      await p.waitForSelector('table.lines');
      const shown = await p.locator('body').innerText();
      for (const l of lines) expect(shown).toContain(l);
      // The invoice carries no signature: only the page's own note says none is sent (pbs.nosign); no signer, no image.
      expect(shown).toContain('No signature is sent to billing.');
      expect(shown).not.toMatch(/signed/i);
      expect(await p.locator('img[src*="/files/"]').count()).toBe(0);
      await p.goto(`${origin}/office/jobs/${job}`, { waitUntil: 'load' });
      const wd = p.locator('[data-ctl="CTL-OFC-03-30"]');
      await wd.waitFor({ timeout: 60_000 });
      expect(await wd.locator('li').allInnerTexts()).toEqual(lines);
      if (signs) {
        expect(await wd.locator('p').first().innerText()).toMatch(new RegExp(`^${customer} signed at \\d{1,2}:\\d\\d [AP]M$`));
        const img = wd.locator('img.bw-sig-img');
        await img.waitFor();
        await expect.poll(() => img.evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth)).toBe(1200);
      } else {
        expect(await wd.locator('p').first().innerText()).toBe('Not signed');
      }
    } finally {
      await closeOffice(o);
    }
  });
});
