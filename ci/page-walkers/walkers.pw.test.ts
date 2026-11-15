// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling
// Browser proofs of the 5 page walkers on Chromium and WebKit: each flags its planted known-bad and passes
// its clean fixture. Run by ci/gates/page-walkers.sh through vitest.browser.config.ts (needs browsers;
// the unit-tests gate excludes *.pw.test.ts).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { engines } from '../pw-engines.ts';
import { catalog, fixtures } from './fixtures.ts';
import { guardedContext } from './origin-guard.ts';
import { axeScan, overflowPass, PHONE_VIEWPORT, spanishFallback, tapTargets, type Finding } from './walkers.ts';

let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    // F-1421: an answer that takes 1 s, so a route handler forwarding it is still fetching when its test closes the context.
    if (req.url === '/slow') {
      setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('slow'), 1_000);
      return;
    }
    const body = fixtures[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const type = req.url?.endsWith('.txt') ? 'text/plain' : req.url?.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// The engine list comes from ci/pw-engines.ts: a narrowed run must name why and prints a DROPPED notice (F-39).

describe.each(engines)('page walkers on %s', (name, type) => {
  let browser: Browser;
  const started = Date.now();
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
    process.stdout.write(`page-walkers: ${name} took ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  });

  // Every test opens its page through the guard, so no test can reach another origin unnoticed.
  async function run(path: string, walk: (p: import('playwright').Page) => Promise<Finding[]>, opts = {}) {
    const g = await guardedContext(browser, [origin], opts);
    try {
      const p = await g.context.newPage();
      await p.goto(origin + path);
      const findings = await walk(p);
      return { findings, g };
    } finally {
      await g.context.close();
    }
  }

  it('axe-scan flags an unlabeled button', async () => {
    const { findings } = await run('/axe-bad.html', axeScan);
    expect(findings.map((f) => f.message).join('\n')).toContain('button-name');
  });
  it('axe-scan passes a clean page', async () => {
    expect((await run('/axe-clean.html', axeScan)).findings).toEqual([]);
  });
  it('axe-scan does not fail a color-contrast violation (OA-84)', async () => {
    // why: OA-84
    expect((await run('/axe-contrast.html', axeScan)).findings).toEqual([]);
  });

  it('tap-target-44 flags a 40 px button', async () => {
    const { findings } = await run('/tap-bad.html', tapTargets, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('button 120x40');
  });
  it('tap-target-44 passes a 44 px button', async () => {
    const r = await run('/tap-clean.html', tapTargets, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true });
    expect(r.findings).toEqual([]);
  });

  it('tap-target-44 flags a menu item, a listbox option and a label under 44 px', async () => {
    // reason: F-38; the target selector used to skip menuitem, option and label
    const { findings } = await run('/tap-menu-bad.html', tapTargets, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true });
    const m = findings.map((f) => f.message).join('\n');
    expect(m).toContain('div 120x40');
    expect(m).toContain('label 120x40');
    expect(findings).toHaveLength(3);
  });
  it('tap-target-44 passes menu items, options and labels of 44 px', async () => {
    const r = await run('/tap-menu-clean.html', tapTargets, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true });
    expect(r.findings).toEqual([]);
  });

  it('outside-origin-guard fails a page that fetches https://example.com', async () => {
    // The test asserts itself, so the guard's own assert-on-close is switched off for this planted request.
    const g = await guardedContext(browser, [origin], {}, { assertOnClose: false });
    try {
      const p = await g.context.newPage();
      await p.goto(origin + '/origin-bad.html', { waitUntil: 'networkidle' });
      expect(() => g.assertNoOutsideRequests()).toThrow(/example\.com/);
    } finally {
      await g.context.close();
    }
  });
  it('outside-origin-guard passes a page that fetches only its own origin', async () => {
    const g = await guardedContext(browser, [origin]);
    try {
      const p = await g.context.newPage();
      await p.goto(origin + '/origin-clean.html', { waitUntil: 'networkidle' });
      expect(() => g.assertNoOutsideRequests()).not.toThrow();
    } finally {
      await g.context.close();
    }
  });

  it('outside-origin-guard fails on its own when the context closes, with no assert in the test', async () => {
    // reason: F-40; the guard must not depend on each test remembering to assert
    const g = await guardedContext(browser, [origin]);
    const p = await g.context.newPage();
    await p.goto(origin + '/origin-bad.html', { waitUntil: 'networkidle' });
    await expect(g.context.close()).rejects.toThrow(/outside-origin-guard.*example\.com/);
  });
  it('outside-origin-guard allows a file: page (a mockup frame)', async () => {
    // reason: F-40; frame pages load from file: URLs, whose origin is the string null
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-file-'));
    try {
      writeFileSync(path.join(dir, 'frame.html'), '<!doctype html><html lang="en"><body><p id="f">frame</p></body></html>');
      const g = await guardedContext(browser, []);
      const p = await g.context.newPage();
      await p.goto(pathToFileURL(path.join(dir, 'frame.html')).href);
      expect(await p.textContent('#f')).toBe('frame');
      await g.context.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // Registers /sw.js (it answers /ok.txt itself), waits for it to take control for up to 2 s, then fetches /ok.txt.
  // (When workers are blocked, ready never settles, hence the 2 s race.)
  const swFetch = (p: import('playwright').Page) =>
    p.evaluate(async () => {
      const sw = (navigator as unknown as { serviceWorker: { register(u: string): Promise<unknown>; ready: Promise<unknown>; controller: unknown } }).serviceWorker;
      // F-276: a registration the browser refuses (workers blocked) has nothing to wait for; only a registered worker is waited on.
      const registered = await sw.register('/sw.js').catch(() => null);
      if (registered !== null) {
        await Promise.race([sw.ready, new Promise((r) => setTimeout(r, 2000))]);
        for (let i = 0; i < 20 && !sw.controller; i++) await new Promise((r) => setTimeout(r, 100));
      }
      return (await fetch('/ok.txt')).text();
    });
  it('outside-origin-guard keeps service workers out of the page network, which route() cannot see', async () => {
    // reason: F-40; a request a service worker handles bypasses context.route, so the guard blocks workers by default
    const g = await guardedContext(browser, [origin]);
    const p = await g.context.newPage();
    await p.goto(origin + '/axe-clean.html');
    expect(await swFetch(p)).toBe('ok');
    await g.context.close();
  });
  it('outside-origin-guard lets a worker answer only when the test opts in (negative control)', async () => {
    // reason: F-40; proves the block test above can fail: with serviceWorkers allow the worker does answer
    const g = await guardedContext(browser, [origin], { serviceWorkers: 'allow' });
    const p = await g.context.newPage();
    await p.goto(origin + '/axe-clean.html');
    expect(await swFetch(p)).toBe('from-sw');
    await g.context.close();
  });
  // why: F-1421 a page's route handler still fetching when its test closes the context finishes first: no route callback outlives its test
  it('outside-origin-guard closes a context only once its pages\' route handlers have finished', async () => {
    const g = await guardedContext(browser, [origin]);
    const p = await g.context.newPage();
    await p.goto(origin + '/axe-clean.html');
    let entered: () => void = () => undefined;
    const inHandler = new Promise<void>((resolve) => (entered = resolve));
    let answered = false;
    // The stack suites' shape (jobs.stack.ts postOrigin): the handler forwards the call with route.fetch and hands its answer back.
    await p.route(`${origin}/slow`, async (r) => {
      entered();
      const response = await r.fetch();
      await r.fulfill({ response });
      answered = true;
    });
    void p.evaluate(() => fetch('/slow').then((x) => x.text())).catch(() => undefined);
    await inHandler;
    await g.context.close();
    expect(answered, 'the handler handed its answer back before the context closed').toBe(true);
  });
  // why: F-1429 a page's route handler that hands its call on with fallback() while its test closes the context: the guard's route continues the
  // call once, and no route call throws after its test (an unroute of the page there made Playwright continue the call itself first)
  it('outside-origin-guard closes a context while a page\'s route handler hands its call on to the guard', async () => {
    const rejections: string[] = [];
    const onRejection = (e: unknown) => rejections.push(String(e));
    process.on('unhandledRejection', onRejection);
    try {
      const g = await guardedContext(browser, [origin]);
      const p = await g.context.newPage();
      await p.goto(origin + '/axe-clean.html');
      let entered: () => void = () => undefined;
      const inHandler = new Promise<void>((resolve) => (entered = resolve));
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      // The auth suite's shape (auth.stack.ts, the held API-05): the handler holds the call, then hands it on to the next route with fallback().
      await p.route(`${origin}/ok.txt`, async (r) => {
        entered();
        await held;
        await r.fallback();
      });
      const read = p.evaluate(() => fetch('/ok.txt').then((x) => x.text())).catch(() => 'closed');
      await inHandler;
      const closed = g.context.close();
      await new Promise((r) => setTimeout(r, 100)); // the close has begun and waits for the handler
      release();
      await closed;
      await read;
      await new Promise((r) => setTimeout(r, 100)); // Node reports an unhandled rejection on a later turn
      expect(rejections, 'no route call threw after its test').toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
  it('outside-origin-guard records a WebSocket to another origin', async () => {
    // reason: F-40; route() does not see WebSockets, routeWebSocket does
    const g = await guardedContext(browser, [origin], {}, { assertOnClose: false });
    try {
      const p = await g.context.newPage();
      await p.goto(origin + '/axe-clean.html');
      await p.evaluate(
        () =>
          new Promise((resolve) => {
            const w = new WebSocket('wss://example.com/socket');
            w.onclose = w.onerror = () => resolve(null);
            setTimeout(() => resolve(null), 5000);
          }),
      );
      expect(() => g.assertNoOutsideRequests()).toThrow(/wss:\/\/example\.com/);
    } finally {
      await g.context.close();
    }
  });

  it('spanish-fallback-pass flags 1 English catalog value', async () => {
    const { findings } = await run('/es-bad.html', (p) => spanishFallback(p, catalog));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('Save changes');
  });
  it('spanish-fallback-pass passes a Spanish page (cognate Total allowed)', async () => {
    expect((await run('/es-clean.html', (p) => spanishFallback(p, catalog))).findings).toEqual([]);
  });
  it('spanish-fallback-pass flags an English ICU value with its argument filled in', async () => {
    // reason: F-41; {count} jobs today renders as 3 jobs today and never equals the raw catalog source
    const { findings } = await run('/es-icu-bad.html', (p) => spanishFallback(p, catalog));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('jobs today');
  });
  it('spanish-fallback-pass flags an English ICU value with its argument filled in inside an aria-label', async () => {
    // reason: F-49; icon buttons carry their only words in aria-label
    const { findings } = await run('/es-icu-attr-bad.html', (p) => spanishFallback(p, catalog));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('jobs today');
  });
  it('spanish-fallback-pass passes the Spanish rendering of an ICU value in an aria-label', async () => {
    expect((await run('/es-icu-attr-clean.html', (p) => spanishFallback(p, catalog))).findings).toEqual([]);
  });
  it('spanish-fallback-pass flags a stored code shown raw, as a whole word (F-713)', async () => {
    const { findings } = await run('/es-code-bad.html', (p) => spanishFallback(p, catalog));
    expect(findings.map((f) => f.message)).toEqual(['stored code shown on the page: "furnace_tune_up"']);
  });
  it('spanish-fallback-pass passes the words of a code written out (F-713)', async () => {
    expect((await run('/es-code-clean.html', (p) => spanishFallback(p, catalog))).findings).toEqual([]);
  });
  it('spanish-fallback-pass skips text inside an element whose lang is another language (F-658)', async () => {
    expect((await run('/es-lang-part.html', (p) => spanishFallback(p, catalog))).findings).toEqual([]);
  });
  it('spanish-fallback-pass still flags the same words outside the other-language element (F-658)', async () => {
    const { findings } = await run('/es-lang-part-bad.html', (p) => spanishFallback(p, catalog));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('Save changes');
  });
  it('spanish-fallback-pass flags an English value split across inline elements', async () => {
    // reason: F-41; Save, then changes inside a bold element, is 2 text nodes
    const { findings } = await run('/es-split-bad.html', (p) => spanishFallback(p, catalog));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('Save changes');
  });
  it('spanish-fallback-pass passes the Spanish rendering of an ICU value', async () => {
    expect((await run('/es-icu-clean.html', (p) => spanishFallback(p, catalog))).findings).toEqual([]);
  });
  it('spanish-fallback-pass refuses a page that is not Spanish', async () => {
    const { findings } = await run('/axe-clean.html', (p) => spanishFallback(p, catalog));
    expect(findings[0]?.message).toContain('not shown in Spanish');
  });

  it('overflow-pass flags a label clipped at 520 x 980', async () => {
    const { findings } = await run('/overflow-bad.html', (p) => overflowPass(p, [{ width: 520, height: 980 }]));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toContain('520 x 980');
    expect(findings[0]?.message).toContain('label');
  });
  // why: F-310 a label with 3 px to spare in the machine's own font passes the natural walk and is flagged by the wide-font probe, on any machine
  it('overflow-pass flags a tight label only with the wide-font probe', async () => {
    expect((await run('/overflow-tight.html', (p) => overflowPass(p, [{ width: 520, height: 980 }]))).findings).toEqual([]);
    const { findings } = await run('/overflow-tight.html', (p) => overflowPass(p, [{ width: 520, height: 980 }], 'wide'));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toContain('wide-font probe');
    expect(findings[0]?.message).toContain('label');
  });
  it('overflow-pass with the wide-font probe passes a wrapping label and leaves the page as it was', async () => {
    const { findings } = await run('/overflow-clean.html', async (p) => {
      const first = await overflowPass(p, [{ width: 520, height: 980 }], 'wide');
      expect(await p.evaluate('document.adoptedStyleSheets.length')).toBe(0);
      return first;
    });
    expect(findings).toEqual([]);
  });
  it('overflow-pass passes a wrapping label', async () => {
    expect((await run('/overflow-clean.html', (p) => overflowPass(p))).findings).toEqual([]);
  });
});
