// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-3, FR-TECH-14 (BUILD_PLAN P6-PHOTO-THUMBS Acceptance: integration tests and Playwright against the Compose stack)
// The photo small copy (SPECIFICATIONS SD-32; UI-SPECIFICATION API-175 size thumb, UD-55; F-1235) on the Compose stack at its default
// settings, through its proxy, with the release web image (so sharp and its libvips run inside the server image): the people of
// ci/tech-job-stack/fixture.sql (Maria Santos and Kevin Doyle, technicians; Keisha Thompson, a dispatcher; Dana Ruiz, a manager).
// Photos are sent to API-103 as the web technician app sends them, on Maria's jobs of Wed, Sep 16 (the job suite's Sep 15 jobs are left
// alone), and real JPEGs are made with sharp here. A photo stored before the rule is one whose small copy is removed from the photo
// volume inside the web container. Run by ci/tech-job-stack.sh, with tech-job.stack.ts, on 1 shared world.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
// sharp is api-server's dependency; its test images module resolves it there.
import { bluish, halvesJpeg, pixel, reddish, sizeOf, whitePng } from '../../packages/api-server/src/tech-items/test-images.ts';

const base = process.env.BW_TECH_JOB_STACK_URL;
const db = process.env.BW_TECH_JOB_DB_CONTAINER;
const web = process.env.BW_TECH_JOB_WEB_CONTAINER;
const people = {
  maria: process.env.BW_TECH_JOB_MARIA, keisha: process.env.BW_TECH_JOB_KEISHA, dana: process.env.BW_TECH_JOB_DANA, kevin: process.env.BW_TECH_JOB_KEVIN,
};
type Who = keyof typeof people;
if (!base || !db || !web || Object.values(people).some((v) => !v)) throw new Error('BW_TECH_JOB_STACK_URL, _DB_CONTAINER, _WEB_CONTAINER and the 4 session tokens are not set: run ci/tech-job-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const WINDOWS = [{ label: '520 x 980', width: 520, height: 980 }, { label: '1280 x 800', width: 1280, height: 800 }] as const;

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
/** A shell command in the web container (the photo volume is PHOTOS_DIR, /data/photos). */
function inWeb(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('docker', ['exec', web!, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

interface Answer { status: number; type: string; cache: string; body: Buffer }
/** 1 call as a person (or signed out): a write carries the default origin. */
function call(who: Who | null, method: string, p: string, body?: Buffer, contentType?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { origin: APP_ORIGIN };
    if (who) headers['cookie'] = `bw_session=${people[who]}; bw_lang=en`;
    if (body) Object.assign(headers, { 'content-type': contentType ?? 'application/octet-stream', 'content-length': body.byteLength });
    const req = http.request(`${origin}/api/v1${p}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), cache: String(res.headers['cache-control'] ?? ''), body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A JPEG of w x h: left half red, right half blue, with EXIF orientation `orientation`. */
const halves = async (w: number, h: number, orientation = 1): Promise<Buffer> => Buffer.from(await halvesJpeg(w, h, orientation));
const dims = async (img: Buffer) => { const m = await sizeOf(img); return [m.width, m.height, m.orientation]; };

const wireNow = () => `${new Date().toISOString().replace('Z', '+00:00')}[UTC]`;
/** Send a photo or signature as the web app does (API-103), as `who`; answers the item's key and API-103's answer. */
async function send(who: Who, kind: 'photo' | 'signature', jobNumber: number, bytes: Buffer): Promise<{ key: string; result: string; code: string | null }> {
  const clock = JSON.parse((await call('keisha', 'GET', '/clock')).body.toString('utf8')) as { data: { demoNow: string; worldEpoch: number } };
  const key = crypto.randomUUID();
  const q = new URLSearchParams({
    kind, jobNumber: String(jobNumber), worldEpoch: String(clock.data.worldEpoch), deviceTime: wireNow(), offsetSavedReal: wireNow(), sinceSaveMs: '0', demoTime: clock.data.demoNow,
  });
  const r = await call(who, 'PUT', `/tech/photos/${key}?${q}`, bytes, kind === 'photo' ? 'image/jpeg' : 'image/png');
  if (r.status !== 200) throw new Error(`API-103 answered ${r.status}: ${r.body.toString('utf8').slice(0, 300)}`);
  const a = JSON.parse(r.body.toString('utf8')) as { data: { result: string; code: string | null } };
  return { key, result: a.data.result, code: a.data.code };
}
const fileOf = (key: string) => psql(`SELECT file FROM world.photo WHERE key = '${key}' UNION ALL SELECT payload->>'file' FROM world.tech_item WHERE key = '${key}' AND payload ? 'file' LIMIT 1`);
const hasFile = (rel: string) => inWeb(['test', '-f', `/data/photos/${rel}`]).status === 0;

const mariaJobs = psql(`SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id
  WHERE t.name = 'Maria Santos' AND j.date = '2026-09-16' AND j.status = 'scheduled' ORDER BY j.window_start, j.job_number LIMIT 2`).split('\n').map(Number);
const kevinJob = Number(psql(`SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id
  WHERE t.name = 'Kevin Doyle' AND j.date = '2026-09-16' AND j.status = 'scheduled' ORDER BY j.window_start, j.job_number LIMIT 1`));
const [tileJob, apiJob] = mariaJobs as [number, number];

describe('the photo small copy on the stack (SD-32, API-175 size thumb)', () => {
  beforeAll(() => {
    expect(mariaJobs.length, 'Maria Santos has 2 scheduled jobs on Sep 16').toBe(2);
    expect(kevinJob, 'Kevin Doyle has a scheduled job on Sep 16').toBeGreaterThan(0);
  });

  // why: FR-TECH-3 (SD-32, UD-55, F-1235) the request that stores a sent photo writes its small copy beside it: longest side 320 px, upright by its EXIF orientation
  it('writes a sent photo\'s small copy beside it, 320 px on its longest side and upright by its EXIF orientation', async () => {
    const photo = await halves(2048, 1536, 6);
    const s = await send('maria', 'photo', apiJob, photo);
    expect([s.result, s.code]).toEqual(['applied', null]);
    expect(hasFile(`${fileOf(s.key)}.thumb.jpg`)).toBe(true);
    const r = await call('maria', 'GET', `/files/${s.key}?size=thumb`);
    expect([r.status, r.type, r.cache]).toEqual([200, 'image/jpeg', 'no-store']);
    expect(await dims(r.body)).toEqual([240, 320, 1]);
    // Orientation 6 is a quarter turn clockwise: the stored left half (red) is the upright copy's top, the right half (blue) its foot.
    expect(reddish(await pixel(r.body, 120, 20))).toBe(true);
    expect(bluish(await pixel(r.body, 120, 300))).toBe(true);
    expect((await call('maria', 'GET', `/files/${s.key}`)).body.equals(photo)).toBe(true);
  });

  // why: FR-TECH-3 (SD-32) a photo already smaller than 320 px is copied at its own size, never enlarged
  it('copies a 200 px photo at 200 px', async () => {
    const s = await send('maria', 'photo', apiJob, await halves(200, 150));
    expect(await dims((await call('keisha', 'GET', `/files/${s.key}?size=thumb`)).body)).toEqual([200, 150, 1]);
  });

  // why: FR-TECH-3 (SD-32) a photo stored before this rule has no small copy; its first thumb read makes it and keeps it
  it('makes and keeps the small copy on the first thumb read of a photo stored without one', async () => {
    const s = await send('maria', 'photo', apiJob, await halves(1600, 1200));
    const thumb = `${fileOf(s.key)}.thumb.jpg`;
    expect(inWeb(['rm', `/data/photos/${thumb}`]).status).toBe(0);
    expect(hasFile(thumb)).toBe(false);
    const r = await call('keisha', 'GET', `/files/${s.key}?size=thumb`);
    expect(r.status).toBe(200);
    expect(await dims(r.body)).toEqual([320, 240, 1]);
    expect(hasFile(thumb)).toBe(true);
  });

  // why: FR-TECH-3, FR-AUTH-4 (API-175) the small copy is served under the full file's rules: the office, managers and the job's technician; never another technician or a signed-out caller; no-store
  it('answers size thumb to office staff, managers and the job\'s technician, and refuses everyone the full file refuses', async () => {
    const s = await send('maria', 'photo', apiJob, await halves(640, 480));
    for (const who of ['keisha', 'dana', 'maria'] as const) {
      const r = await call(who, 'GET', `/files/${s.key}?size=thumb`);
      expect([who, r.status, r.type, r.cache]).toEqual([who, 200, 'image/jpeg', 'no-store']);
    }
    for (const who of ['kevin', null] as const) {
      const full = await call(who, 'GET', `/files/${s.key}`);
      const thumb = await call(who, 'GET', `/files/${s.key}?size=thumb`);
      expect([who, thumb.status]).toEqual([who, full.status]);
      expect(thumb.status).toBeGreaterThanOrEqual(400);
    }
    expect((await call('keisha', 'GET', `/files/${crypto.randomUUID()}?size=thumb`)).status).toBe(404);
  });

  // why: FR-TECH-3 (API-175; owner ruling 21ce2f73) a refused photo the server kept has its small copy, and only office staff and managers read it
  it('keeps a refused photo\'s small copy for office staff and managers only', async () => {
    const s = await send('maria', 'photo', kevinJob, await halves(1024, 768));
    expect([s.result, s.code]).toEqual(['flagged', 'not_found']);
    expect(hasFile(`${fileOf(s.key)}.thumb.jpg`)).toBe(true);
    try {
      for (const who of ['keisha', 'dana'] as const) {
        const r = await call(who, 'GET', `/files/${s.key}?size=thumb`);
        expect([who, r.status, r.type, r.cache]).toEqual([who, 200, 'image/jpeg', 'no-store']);
        expect(await dims(r.body)).toEqual([320, 240, 1]);
      }
      for (const who of ['maria', 'kevin'] as const) expect([who, (await call(who, 'GET', `/files/${s.key}?size=thumb`)).status]).toEqual([who, 403]);
    } finally {
      psql(`UPDATE world.offline_conflict SET handled_at = now() WHERE item_key = '${s.key}'`);
    }
  });

  // why: FR-TECH-14 (API-175) a signature read with size thumb answers its PNG
  it('answers a signature\'s PNG to a thumb read', async () => {
    const sig = Buffer.from(await whitePng(600, 200));
    const s = await send('maria', 'signature', apiJob, sig);
    expect(s.result).toBe('applied');
    const r = await call('keisha', 'GET', `/files/${s.key}?size=thumb`);
    expect([r.status, r.type]).toEqual([200, 'image/png']);
    expect(r.body.equals(sig)).toBe(true);
  });
});

describe.each(engines)('every web photo tile reads size thumb on %s', (_engine, type) => {
  let browser: Browser;
  let photos: string[] = [];
  let kept = '';
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    // The first engine sends the job's 2 photos; a later engine reads the same job (1 shared world). Listed as the screens order them.
    const listed = () => psql(`SELECT key FROM world.photo WHERE job_number = ${tileJob} ORDER BY entered_at, key`).split('\n').filter(Boolean);
    if (listed().length === 0) for (const w of [1200, 900]) await send('maria', 'photo', tileJob, await halves(w, (w * 3) / 4));
    photos = listed();
    expect(photos).toHaveLength(2);
    const k = await send('maria', 'photo', kevinJob, await halves(800, 600));
    expect(k.result).toBe('flagged');
    kept = k.key;
  }, 120_000);
  afterAll(async () => {
    if (kept) psql(`UPDATE world.offline_conflict SET handled_at = now() WHERE item_key = '${kept}'`);
    await browser?.close();
  });

  /** A page as `who` whose requests for stored files are logged as path and query. */
  async function open(who: Who, win: { width: number; height: number }) {
    const g = await guardedContext(browser, [origin], { viewport: { width: win.width, height: win.height }, colorScheme: 'light' });
    await g.context.addCookies([{ name: 'bw_session', value: people[who]!, url: origin, httpOnly: true }, { name: 'bw_lang', value: 'en', url: origin }]);
    // The page's writes carry the default origin (the proxy listens on a free port).
    await g.context.route(`${origin}/api/v1/**`, async (r) => {
      const req = r.request();
      try {
        await r.fulfill({ response: await r.fetch(req.method() === 'GET' ? {} : { headers: { ...(await req.allHeaders()), origin: APP_ORIGIN } }) });
      } catch {
        // the page closed while the call was in flight
      }
    });
    const page = await g.context.newPage();
    const files: string[] = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.pathname.startsWith('/api/v1/files/')) files.push(`${u.pathname.slice('/api/v1/files/'.length)}${u.search}`);
    });
    return { g, page, files };
  }
  /** Wait until every image in `sel` has loaded with pixels (a tile that failed would show its placeholder instead). */
  const loaded = (page: Page, sel: string, n: number) => page.waitForFunction(([s, count]) => {
    const imgs = Array.from((globalThis as unknown as { document: { querySelectorAll(x: string): ArrayLike<{ complete: boolean; naturalWidth: number }> } }).document.querySelectorAll(s as string));
    return imgs.length >= (count as number) && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, [sel, n] as const, { timeout: 30_000 });
  const thumbs = (keys: string[]) => keys.map((k) => `${k}?size=thumb`);

  describe.each(WINDOWS)('at $label', (win) => {
    // why: FR-TECH-3 (UD-55, F-1235) the technician's job strip and finish thumbnails read each photo's small copy; only the viewer reads the full file
    it('the technician job screen and finish screen tiles read size thumb, the photo viewer the full file', async () => {
      const o = await open('maria', win);
      try {
        await o.page.goto(`${origin}/tech/jobs/${tileJob}`, { waitUntil: 'load' });
        await loaded(o.page, '[data-ctl="CTL-TEC-04-10"] img', photos.length);
        expect([...new Set(o.files)].sort()).toEqual(thumbs(photos).sort());
        o.files.length = 0;
        await o.page.locator('[data-ctl="CTL-TEC-04-11"]').first().click();
        await loaded(o.page, '[data-ctl="CTL-TEC-04-11"][role="dialog"] img, .r1-sheet[data-ctl="CTL-TEC-04-11"] img', 1);
        expect(o.files).toEqual([photos[0]]);
        o.files.length = 0;
        await o.page.goto(`${origin}/tech/jobs/${tileJob}/finish`, { waitUntil: 'load' });
        await loaded(o.page, '.phs img', photos.length);
        expect([...new Set(o.files)].sort()).toEqual(thumbs(photos).sort());
      } finally {
        await o.g.context.close();
      }
    }, 180_000);

    // why: FR-TECH-3 (UD-55) the office job page's photo tiles read each photo's small copy; its viewer reads the full file
    it('the office job page tiles read size thumb, the viewer the full file', async () => {
      const o = await open('keisha', win);
      try {
        await o.page.goto(`${origin}/office/jobs/${tileJob}`, { waitUntil: 'load' });
        await loaded(o.page, '[data-ctl="CTL-OFC-03-15"] img', photos.length);
        expect([...new Set(o.files)].sort()).toEqual(thumbs(photos).sort());
        o.files.length = 0;
        await o.page.locator(`[data-ctl="CTL-OFC-03-15"][data-photo="${photos[0]}"]`).click();
        await loaded(o.page, '[data-ctl="CTL-OFC-03-16"] img', 1);
        expect(o.files).toEqual([photos[0]]);
      } finally {
        await o.g.context.close();
      }
    }, 180_000);

    // why: FR-TECH-3 (CTL-OFC-02-15, owner ruling 21ce2f73) the board's kept refused photo shows as a tile from its small copy, linking to the full file
    it('the board\'s kept refused photo tile reads size thumb and links to the full file', async () => {
      const o = await open('keisha', win);
      try {
        await o.page.goto(`${origin}/office/board?branch=columbus&date=2026-09-16`, { waitUntil: 'load' });
        const link = o.page.locator(`a[data-entry-file="photo"][href="/api/v1/files/${kept}"]`);
        await link.waitFor({ state: 'attached', timeout: 60_000 });
        await loaded(o.page, `a[data-entry-file="photo"][href="/api/v1/files/${kept}"] img`, 1);
        expect(o.files).toEqual([`${kept}?size=thumb`]);
      } finally {
        await o.g.context.close();
      }
    }, 180_000);
  });
});
