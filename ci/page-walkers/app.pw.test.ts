// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-LANG-3, NFR-06 (the 5 walkers on every built page, in English and Spanish)
// The page walkers on the real app (BUILD_PLAN P1-PAGE-GATES, P2-SHELL): every page-inventory row run-inventory.ts
// selects (phase at or before the current one, task merged; BW_MERGED_TASKS for tests) and app-wiring.ts wires, on
// Chromium and WebKit: axe-scan, tap-target-44 and outside-origin-guard in English; spanish-fallback-pass and
// overflow-pass in Spanish. Run by ci/gates/page-walkers.sh (Chromium, the English passes: the push half) and by
// ci/gates/page-walkers-nightly.sh (WebKit: tap-target-44 and the Spanish overflow-pass; Chromium, the Spanish and overflow passes). P10-NIGHTLY-SPEED
// (owner answer 400ec3ba, Nov 27, 2026): WebKit runs no axe-scan and no spanish-fallback-pass (engine-free; Chromium keeps both); the unit-tests gate
// excludes *.pw.test.ts. BW_APP_WALK_PASSES picks the passes (P3-CI-CADENCE): english, spanish, or all (the default).
import { readFileSync } from 'node:fs';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { APP_WIRING, wiringFor } from './app-wiring.ts';
import { currentPhase, emptyWalkWhy, loadInventory, mergedFromEnv, planTaskIds, planWalk, readMergedTasks } from './inventory.ts';
import { mapFilesPresent, serveMapFiles } from '../look-values/map-files.ts';
import { guardedContext } from './origin-guard.ts';
import { walkConcurrency } from './walk-concurrency.ts';
import { axeScan, overflowPass, PHONE_VIEWPORT, spanishFallback, tapTargets, type Catalog, type Finding } from './walkers.ts';

// Ruling Nov 10, 2026 item 4a: vitest starts this many checks at a time (its default is 5); each takes a browser from the pool below.
vi.setConfig({ maxConcurrency: walkConcurrency() });

const readMerged = mergedFromEnv(process.env.BW_MERGED_TASKS, readMergedTasks);
const phase = currentPhase(process.env.BW_PHASE, readMerged);
const plan = planWalk(loadInventory('acceptance/page-inventory.json'), phase, {
  merged: new Set(readMerged()),
  knownTasks: planTaskIds(readFileSync('docs/BUILD_PLAN.md', 'utf8')),
});
const { wired } = wiringFor([...plan.walked, ...plan.hostOpened]);
const catalog: Catalog = {
  en: JSON.parse(readFileSync('packages/i18n/catalog/en.json', 'utf8')) as Record<string, string>,
  es: JSON.parse(readFileSync('packages/i18n/catalog/es.json', 'utf8')) as Record<string, string>,
};

// Which of the passes this run walks on every wired screen: the English ones (axe-scan, tap-target-44), the Spanish ones
// (spanish-fallback-pass, overflow-pass), or all. Anything else is an error, never a silent default.
const PASSES = process.env.BW_APP_WALK_PASSES ?? 'all';
if (!['english', 'spanish', 'all'].includes(PASSES)) throw new Error(`BW_APP_WALK_PASSES=${PASSES} is not english, spanish or all`);
const walkEnglish = PASSES !== 'spanish';
const walkSpanish = PASSES !== 'english';
if (PASSES !== 'all') process.stdout.write(`page-walkers app: passes ${PASSES} only (BW_APP_WALK_PASSES)\n`);

let app: WebApp | undefined;
beforeAll(async () => {
  if (wired.length > 0) app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('app walk selection', () => {
  // why: NFR-06 a wiring entry for a screen the inventory does not hold would walk nothing; an empty walk is stated (F-38)
  it('wires only real inventory rows, and states what it walks at this phase', () => {
    const screens = new Set(loadInventory('acceptance/page-inventory.json').map((r) => r.screen));
    expect(Object.keys(APP_WIRING).filter((s) => !screens.has(s))).toEqual([]);
    process.stdout.write(`page-walkers app: phase ${phase}, ${wired.length} wired row(s) walked: ${wired.map((r) => r.screen).join(', ') || 'none'}\n`);
  });
  // why: NFR-06 a named walk that reaches 0 screens stays red and says why, not "No test found in suite" (F-834)
  it('walks at least 1 screen, or says why it walks none', () => {
    expect(wired.length, emptyWalkWhy(loadInventory('acceptance/page-inventory.json'), phase, new Set(readMerged()))).toBeGreaterThan(0);
  });
});

describe.runIf(wired.length > 0).each(engines)('page walkers on the app, %s', (name, type) => {
  // Ruling Nov 10, 2026 item 4a: the checks run walkConcurrency() at a time, each on its own browser from a pool of that size (1 browser per running check).
  const slots = walkConcurrency();
  const browsers: Browser[] = [];
  const free: Browser[] = [];
  const waiting: Array<(b: Browser) => void> = [];
  const take = () => {
    const b = free.pop();
    return b ? Promise.resolve(b) : new Promise<Browser>((resolve) => waiting.push(resolve));
  };
  const give = (b: Browser) => {
    const next = waiting.shift();
    if (next) next(b);
    else free.push(b);
  };
  beforeAll(async () => {
    for (let i = 0; i < slots; i++) browsers.push(await type.launch({ headless: true }));
    free.push(...browsers);
  });
  afterAll(async () => {
    await Promise.all(browsers.map((b) => b.close()));
  });

  // Every page opens through the outside-origin guard: closing the context throws on any request to another origin.
  async function onPage<T>(path: string, status: number, screen: string, opts: BrowserContextOptions, lang: 'en' | 'es', fn: (p: Page) => Promise<T>, maps = false) {
    const origin = app!.origin;
    const browser = await take();
    let g: Awaited<ReturnType<typeof guardedContext>> | undefined;
    try {
      g = await guardedContext(browser, [origin], opts);
      if (maps) {
        expect(mapFilesPresent(), 'the map files are missing: run pnpm run setup:maps').toBe(true);
        await serveMapFiles(g.context);
      }
      if (lang === 'es') await g.context.addCookies([{ name: 'bw_lang', value: 'es', url: origin }]);
      const p = await g.context.newPage();
      const res = await p.goto(origin + path, { waitUntil: 'networkidle' });
      expect(res?.status(), `${path} status`).toBe(status);
      await p.waitForSelector(`[data-screen="${screen}"]`, { state: 'attached' });
      // F-946: the booking previews first paint the wide layout and choose the phone one by matchMedia once mounted; below 760 px the walk waits for it.
      if (/^\/shell-preview\/booking(-taken)?\//.test(path) && (opts.viewport?.width ?? Infinity) <= 760) await p.waitForSelector('.bw-ph', { state: 'attached' });
      expect(await p.locator('[data-screen]').count(), 'exactly 1 screen root').toBe(1);
      expect(await p.locator('html').getAttribute('lang')).toBe(lang);
      return await fn(p);
    } finally {
      try {
        await g?.context.close();
      } finally {
        give(browser);
      }
    }
  }
  // The checks of a pass run concurrently (up to walkConcurrency() at a time); a pass this run does not walk is skipped.
  const itEnglish = walkEnglish ? it.concurrent : it.skip;
  const itSpanish = walkSpanish ? it.concurrent : it.skip;
  const none = (f: Finding[]) => expect(f.map((x) => `${x.walker}: ${x.message}`)).toEqual([]);
  // The overflow-pass of a Spanish page, in the machine's font and again with every glyph run widened (F-310: a tight fit fails on a machine whose own font is narrow).
  const overflowChecks = async (p: Page): Promise<Finding[]> => [...(await overflowPass(p)), ...(await overflowPass(p, undefined, 'wide'))];

  for (const row of wired) {
    // P10-NIGHTLY-SPEED, owner answer 400ec3ba (Nov 27, 2026): the WebKit copy of the axe-scan case is dropped (the same axe rules run on the same DOM on Chromium); every WebKit page still opens through the outside-origin guard in the tap-target-44 and overflow-pass cases below.
    if (name === 'chromium') {
      // why: NFR-06 0 serious or critical axe violations on every built page (color-contrast off, OA-84)
      itEnglish(`${row.screen} ${row.name}: axe-scan and the outside-origin guard, in English`, async () => {
        none(await onPage(row.path, row.status, row.screen, { viewport: { width: 1440, height: 900 } }, 'en', axeScan, row.maps));
      });
    }
    // why: NFR-06 every tap target on a phone layout is at least 44 x 44 px
    itEnglish(`${row.screen} ${row.name}: tap-target-44 on a phone, in English`, async () => {
      none(await onPage(row.path, row.status, row.screen, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true }, 'en', tapTargets, row.maps));
    });
    if (name === 'chromium') {
      // why: FR-LANG-3, UC-04 a page shown in Spanish holds no English catalog value, and no text is clipped at 520 and 390 px, in the machine's font and with the wide-font probe
      itSpanish(`${row.screen} ${row.name}: spanish-fallback-pass and overflow-pass, in Spanish`, async () => {
        none(await onPage(row.path, row.status, row.screen, { viewport: { width: 520, height: 980 } }, 'es', async (p) => [...(await spanishFallback(p, catalog)), ...(await overflowChecks(p))], row.maps));
      });
    } else {
      // why: FR-LANG-3, UC-04 on WebKit no text is clipped at 520 and 390 px in WebKit's own fonts, in the machine's font and with the wide-font probe; the catalog check (spanish-fallback-pass) is engine-free and runs on Chromium only (P10-NIGHTLY-SPEED, owner answer 400ec3ba)
      itSpanish(`${row.screen} ${row.name}: overflow-pass, in Spanish`, async () => {
        none(await onPage(row.path, row.status, row.screen, { viewport: { width: 520, height: 980 } }, 'es', overflowChecks, row.maps));
      });
    }
  }
});
