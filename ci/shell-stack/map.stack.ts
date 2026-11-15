// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-MAP-1, FR-MAP-2, FR-MAP-3, HC-04 (P3-MAP-WEB Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// CMP-05 on the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running), through its proxy,
// with the 3 branch map files the proxy serves from the stack's map volume (API-106). The harness web image serves the test
// page /shell-preview/map/<config>?branch=<branch> (apps/web/app/shell-preview/map): CMP-05 mounted the way the board, the
// live map and the technician map mount it. Each page lane re-runs its own FR-MAP-1 render check later; this suite proves
// the component in the 3 configurations (F-363). Every context is the outside-origin guard's: closing it throws on a
// single request to another origin (NFR-12), which is the "0 outside requests" of the Acceptance.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';

const base = process.env.BW_SHELL_STACK_URL;
if (!base) throw new Error('BW_SHELL_STACK_URL is not set: run ci/shell-stack.sh');
const origin = new URL(base).origin;

const BRANCHES = ['columbus', 'dayton', 'springfield'] as const;
const CONFIGS = ['board', 'live', 'technician'] as const;
const DESKTOP: BrowserContextOptions = { viewport: { width: 1000, height: 800 } };
const OSM = 'https://www.openstreetmap.org/copyright';
// SPECIFICATIONS 11.5: the policy of every non-page answer, which the map's worker script is.
const WORKER_CSP = "default-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";
// Base-map features rendered on the 9 renders: measured 233 to 768 on Mac Chromium (data-map-features counts the protomaps source only, F-454).
const MIN_BASE_FEATURES = 200;
/** The bundled glyph and sprite files (F-452), a folder of the repo the image ships. */
const assetsDir = path.resolve(import.meta.dirname, '../../apps/web/src/map/assets');

describe('the map files the stack serves (API-106)', () => {
  // why: FR-MAP-1 the proxy answers a byte range of each branch file with 206, so the map reads tiles with no download of the file
  it.each(BRANCHES)('%s.pmtiles answers a range request from the app origin', async (b) => {
    const res = await fetch(`${origin}/maps/${b}.pmtiles`, { headers: { range: 'bytes=0-126' } });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 7).toString('latin1')).toBe('PMTiles');
  });
});

describe.each(engines)('CMP-05 on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** Opens a test page in a guarded context; closing the context fails the test when any request left the origin. */
  async function open<T>(path: string, fn: (p: Page, requests: string[], workers: { url: string; csp: string | undefined }[]) => Promise<T>, lang?: 'es'): Promise<T> {
    const g = await guardedContext(browser, [origin], DESKTOP);
    try {
      if (lang) await g.context.addCookies([{ name: 'bw_lang', value: lang, url: origin }]);
      const p = await g.context.newPage();
      const requests: string[] = [];
      const workers: { url: string; csp: string | undefined }[] = [];
      p.on('request', (r) => requests.push(r.url()));
      p.on('response', (r) => {
        if (/maplibre-gl-worker/.test(r.url())) workers.push({ url: r.url(), csp: r.headers()['content-security-policy'] });
      });
      const res = await p.goto(origin + path, { waitUntil: 'load' });
      expect(res?.status(), path).toBe(200);
      return await fn(p, requests, workers);
    } finally {
      await g.context.close();
    }
  }
  const map = (p: Page) => p.locator('[data-cmp="CMP-05"]');
  const ready = async (p: Page) => {
    await p.waitForSelector('[data-cmp="CMP-05"][data-map-state="ready"], [data-cmp="CMP-05"][data-map-state="failed"]', { timeout: 45_000 });
    expect(await map(p).getAttribute('data-map-state')).toBe('ready');
  };

  for (const config of CONFIGS) {
    for (const branch of BRANCHES) {
      // why: FR-MAP-1 the board map, the live map and the technician map each render the Columbus, Dayton and Springfield areas from the stack's files, no key, 0 outside requests
      it(`${config} map renders the ${branch} area from ${branch}.pmtiles with no key and no outside request`, async () => {
        await open(`/shell-preview/map/${config}?branch=${branch}`, async (p, requests) => {
          await ready(p);
          expect(await map(p).getAttribute('data-map-branch')).toBe(branch);
          expect(await map(p).getAttribute('data-map-file')).toBe(`${branch}.pmtiles`);
          // Tiles drawn from the file: base-map features were rendered on the canvas (not the route lines), and the canvas exists with a size.
          const drawn = Number(await map(p).getAttribute('data-map-features'));
          console.log(`[F-454] ${config} ${branch} base-map features ${drawn}`);
          expect(drawn).toBeGreaterThanOrEqual(MIN_BASE_FEATURES);
          const box = await p.locator('.maplibregl-canvas').boundingBox();
          expect(box?.width).toBeGreaterThan(100);
          expect(box?.height).toBeGreaterThan(100);
          // No key in any request, and every request went to the stack's own origin.
          expect(requests.filter((u) => /[?&](key|api_?key|access_token|token)=/i.test(u))).toEqual([]);
          expect(requests.filter((u) => !/^(data|blob|about):/.test(u) && new URL(u).origin !== origin)).toEqual([]);
        });
      });
    }
  }

  /** Opens a map test page and reads its name counts and every /map-assets/ answer once the map is ready. */
  async function names(path: string, settle = false, zoomIns = 0) {
    return open(path, async (p) => {
      const assets: { url: string; status: number }[] = [];
      p.on('response', (r) => {
        if (r.url().includes('/map-assets/')) assets.push({ url: r.url(), status: r.status() });
      });
      // The listener is added after goto resolves, so reload once: the second load has every asset request in view.
      await p.reload({ waitUntil: 'load' });
      await ready(p);
      const n = (a: string) => map(p).getAttribute(a).then(Number);
      const opened = await n('data-map-zoom');
      // The names are placed after the tiles load; a named map may report them a moment after the first idle.
      const settleOn = async (attrs: string[]) => {
        if (!settle) return;
        const t0 = Date.now();
        while (Date.now() - t0 < 4_000 && (await Promise.all(attrs.map(n))).some((v) => v === 0)) await p.waitForTimeout(250);
        console.log(`[F-452 ${engine}] ${path} ${attrs.join(',')} after ${Date.now() - t0} ms of settling`);
      };
      // Place names and road shields are read at the opening zoom, street names after the zoom-ins (the pinned build names ordinary streets, major_road, from zoom 12; freeway names exist at 11).
      await settleOn(['data-map-place-names', 'data-map-shields']);
      const place = await n('data-map-place-names');
      const shield = await n('data-map-shields');
      for (let i = 0; i < zoomIns; i++) {
        await p.locator('[data-ctl="CTL-CMP-05-02"]').click();
        await expect.poll(() => n('data-map-zoom'), { timeout: 20_000 }).toBe(opened + i + 1);
      }
      await settleOn(['data-map-street-names']);
      return {
        opened,
        street: await n('data-map-street-names'),
        place,
        water: await n('data-map-water-names'),
        shield,
        assets,
      };
    });
  }
  const glyphRanges = (assets: { url: string }[]) =>
    [...new Set(assets.map((a) => decodeURIComponent(new URL(a.url).pathname)).filter((u) => u.startsWith('/map-assets/fonts/') && u.endsWith('.pbf')))];

  // why: FR-MAP-1 each branch's map draws place names and road shields at the zoom the board opens at (11) and street names at zoom 12 (the pinned Protomaps build carries no ordinary street name below 12, F-528, F-535; freeway names exist at 11), and the shapes-only style draws none
  it.each(BRANCHES)('%s map draws street, place and shield names, and the shapes-only style draws 0', async (branch) => {
    const named = await names(`/shell-preview/map/board?branch=${branch}`, true, 1);
    const bare = await names(`/shell-preview/map/board?branch=${branch}&names=0`, false, 1);
    console.log(`[F-452 ${engine}] ${branch} opened z${named.opened} named street=${named.street} place=${named.place} water=${named.water} shield=${named.shield}; shapes-only street=${bare.street} place=${bare.place} water=${bare.water} shield=${bare.shield}`);
    expect(named.opened, 'opening zoom').toBe(11);
    expect(named.street, 'street names at zoom 12').toBeGreaterThan(0);
    expect(named.shield, 'road shields at the opening zoom').toBeGreaterThan(0);
    expect(named.place, 'place names').toBeGreaterThan(0);
    expect([bare.street, bare.place, bare.water, bare.shield]).toEqual([0, 0, 0, 0]);
    expect(bare.assets).toEqual([]);
  });

  // why: FR-MAP-1 every glyph and sprite request goes to the page's own origin and answers 200, and every glyph range the 3 maps ask for is in the bundled set
  it('answers every glyph and sprite request from the app origin with 200, from files in the bundled set', async () => {
    const ranges: string[] = [];
    for (const branch of BRANCHES) {
      const { assets } = await names(`/shell-preview/map/board?branch=${branch}`);
      expect(assets.length, branch).toBeGreaterThan(0);
      for (const a of assets) {
        expect(new URL(a.url).origin, a.url).toBe(origin);
        expect(a.status, a.url).toBe(200);
      }
      const sprites = assets.filter((a) => a.url.includes('/sprites/')).map((a) => new URL(a.url).pathname);
      expect(sprites.some((s) => s.endsWith('.json')), `${branch} sprite json`).toBe(true);
      expect(sprites.some((s) => s.endsWith('.png')), `${branch} sprite png`).toBe(true);
      ranges.push(...glyphRanges(assets));
    }
    const found = [...new Set(ranges)];
    console.log(`[F-452 ${engine}] glyph ranges requested: ${found.join(', ')}`);
    expect(found.length).toBeGreaterThan(0);
    for (const r of found) expect(existsSync(path.join(assetsDir, r.slice('/map-assets/'.length))), r).toBe(true);
  });

  // why: FR-MAP-2, HC-04 every map shows "© OpenStreetMap" linked to the OpenStreetMap copyright page, the data's license notice
  it.each(CONFIGS)('%s map shows the OpenStreetMap credit linking its copyright page', async (config) => {
    await open(`/shell-preview/map/${config}`, async (p) => {
      await ready(p);
      const credit = p.locator('[data-cmp="CMP-05"] a.osm');
      expect(await credit.textContent()).toBe('© OpenStreetMap');
      expect(await credit.getAttribute('href')).toBe(OSM);
      expect(await credit.getAttribute('target')).toBe('_blank');
      expect(await credit.getAttribute('rel')).toContain('noopener');
      expect(await credit.isVisible()).toBe(true);
    });
  });

  // why: HC-04, FR-MAP-1 the credit stays when the map file fails to load, and the message and the text alternative show
  it('a map whose file fails to load shows "The map could not load", the credit and the text alternative', async () => {
    await open('/shell-preview/map/live?fail=1', async (p) => {
      await p.waitForSelector('[data-cmp="CMP-05"][data-map-state="failed"]', { timeout: 45_000 });
      expect(await p.locator('[data-cmp="CMP-05"] .fail').textContent()).toBe('The map could not load');
      expect(await p.locator('[data-cmp="CMP-05"] a.osm').getAttribute('href')).toBe(OSM);
      expect(await p.locator('[data-ctl="CTL-CMP-05-06"] li').allTextContents()).toEqual(['Van, Dev Kapoor, on the way, arriving about 10:40 AM', 'Your address']);
    });
  });

  // why: FR-MAP-1, NFR-06 F-453: Zoom out ends where the bounds stop the map, not at minZoom, and the canvas's focus ring shows inside its box
  it('turns Zoom out off at the zoom the map stops at, and rings the focused canvas inside the box', async () => {
    await open('/shell-preview/map/board?branch=columbus', async (p) => {
      await ready(p);
      const out = p.locator('[data-ctl="CTL-CMP-05-03"]');
      const zoomNow = () => p.locator('[data-cmp="CMP-05"]').getAttribute('data-map-zoom');
      for (let i = 0; i < 8 && !(await out.isDisabled()); i++) {
        const before = await zoomNow();
        await out.click();
        // F-917: the button turns off during the zoom (the map's zoom event), so the next read waits for this zoom to settle (the idle
        // that writes data-map-zoom, as the other zoom cases wait), never a fixed time: a read while a slow zoom still ran saw the
        // button on, the zoom then reached the end and turned it off, and the next click waited 30 s on a button that was off.
        await expect.poll(zoomNow, { timeout: 20_000 }).not.toBe(before);
      }
      await expect.poll(() => out.isDisabled(), { timeout: 5_000 }).toBe(true);
      await expect.poll(async () => Math.abs(Number(await p.locator('[data-cmp="CMP-05"]').getAttribute('data-map-zoom')) - 8.18), { timeout: 15_000 }).toBeLessThan(0.05);
      const focused = () => p.evaluate(() => {
        const a = (globalThis as unknown as { document: { activeElement: { tagName: string } | null } }).document.activeElement;
        if (a?.tagName !== 'CANVAS') return null;
        const c = (globalThis as unknown as { getComputedStyle(e: unknown): { outlineStyle: string; outlineOffset: string } }).getComputedStyle(a);
        return `${c.outlineStyle} ${c.outlineOffset}`;
      });
      // Chromium only: headless WebKit's Tab stops only on form controls, and a scripted focus on the canvas never matches :focus-visible there.
      if (engine === 'webkit') return;
      for (let i = 0; i < 12 && (await focused()) === null; i++) await p.keyboard.press('Tab');
      expect(await focused()).toBe('solid -5px');
    });
  });

  // why: F-451, F-493 CTL-CMP-05-01 names only the file failing to load: a tile that fails after a good load leaves the map working
  it('keeps a loaded map ready when a tile read fails afterwards', async () => {
    await open('/shell-preview/map/live', async (p) => {
      await ready(p);
      const n = await p.locator('[data-cmp="CMP-05"]').getAttribute('data-map-file');
      let aborted = 0;
      await p.route(`**/maps/${n}`, (r) => {
        aborted++;
        return r.abort('failed');
      });
      await p.click('[data-ctl="CTL-CMP-05-02"]');
      await p.click('[data-ctl="CTL-CMP-05-02"]');
      await p.waitForTimeout(1_500);
      // F-819: the case proves nothing unless a read of the map file really failed, so the aborted reads are counted.
      expect(aborted, 'reads of the map file that were aborted').toBeGreaterThan(0);
      expect(await p.locator('[data-cmp="CMP-05"]').getAttribute('data-map-state')).toBe('ready');
      expect(await p.locator('[data-cmp="CMP-05"] .fail').count()).toBe(0);
    });
  });

  // why: FR-MAP-3 a leg with no baked track is drawn with the label "Approximate route", and a baked track carries none
  it('labels the planted trackless leg "Approximate route" and draws the baked leg with no label', async () => {
    await open('/shell-preview/map/board?branch=columbus', async (p) => {
      await ready(p);
      expect(await map(p).getAttribute('data-map-routes')).toBe('approximate');
      expect(await p.locator('.bw-aprx').allTextContents()).toEqual(['Approximate route']);
      expect(await p.locator('.bw-aprx').getAttribute('data-ctl')).toBe('CTL-CMP-05-05');
    });
    await open('/shell-preview/map/live?branch=columbus', async (p) => {
      await ready(p);
      expect(await map(p).getAttribute('data-map-routes')).toBe('baked');
      expect(await p.locator('.bw-aprx').count()).toBe(0);
    });
    await open('/shell-preview/map/technician?branch=dayton', async (p) => {
      await ready(p);
      expect(await map(p).getAttribute('data-map-routes')).toBe('baked approximate');
      expect(await p.locator('.bw-aprx').count()).toBe(1);
    });
  });

  // why: FR-MAP-3 the label is in the page's language
  it('says "Ruta aproximada" on a Spanish page', async () => {
    await open(
      '/shell-preview/map/board?branch=springfield',
      async (p) => {
        await ready(p);
        expect(await p.locator('.bw-aprx').allTextContents()).toEqual(['Ruta aproximada']);
        expect(await map(p).getAttribute('aria-label')).toBe('Mapa');
      },
      'es',
    );
  });

  // why: FR-MAP-1 the map's own worker script is a file of the app, answered with the page's Content-Security-Policy (F-80, SPECIFICATIONS 11.5)
  it('loads its tile worker from the app origin, and that response carries the 11.5 policy', async () => {
    await open('/shell-preview/map/board', async (p, _requests, workers) => {
      await ready(p);
      expect(workers.length).toBeGreaterThan(0);
      for (const w of workers) {
        expect(new URL(w.url).origin).toBe(origin);
        // The exact 11.5 string, an outside host in any source failing it (F-454), and no nonce: a worker script is no page (F-774).
        expect(w.csp ?? '', w.url).toBe(WORKER_CSP);
      }
    });
  });

  // why: FR-MAP-1 the zoom buttons zoom the map (CTL-CMP-05-02, CTL-CMP-05-03)
  it('zooms in and out with the buttons', async () => {
    await open('/shell-preview/map/live', async (p) => {
      await ready(p);
      const zoom = async () => Number(await map(p).getAttribute('data-map-zoom'));
      const start = await zoom();
      expect(start).toBe(11);
      await p.locator('[data-ctl="CTL-CMP-05-02"]').click();
      await expect.poll(zoom, { timeout: 20_000 }).toBe(start + 1);
      await p.locator('[data-ctl="CTL-CMP-05-03"]').click();
      await expect.poll(zoom, { timeout: 20_000 }).toBe(start);
      await p.locator('[data-ctl="CTL-CMP-05-03"]').click();
      await expect.poll(zoom, { timeout: 20_000 }).toBe(start - 1);
    });
  });

  // why: F-451 an update that arrives after the first load, during a zoom, still shows its markers and keeps the Approximate route label
  it('shows changed markers and the Approximate route label after ready, even during a zoom', async () => {
    await open('/shell-preview/map/board?branch=columbus&change=1', async (p) => {
      await ready(p);
      const before = await p.locator('.maplibregl-marker').count();
      await p.locator('[data-ctl="CTL-CMP-05-02"]').click();
      await p.locator('[data-test="change-markers"]').click();
      await expect.poll(() => p.locator('.maplibregl-marker').count(), { timeout: 20_000 }).toBe(before + 1);
      expect(await p.locator('.bw-aprx').allTextContents()).toEqual(['Approximate route']);
      expect(await map(p).getAttribute('data-map-state')).toBe('ready');
    });
  });
});
