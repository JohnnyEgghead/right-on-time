// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-06 (P8-A11Y-TOOLS)
// Runs the 3 web checks of ci/a11y-tools/checks.ts on 1 engine, headless, over every wired page-inventory row of the harness app:
//   node ci/a11y-tools/run-web.ts <chromium|webkit> <out-dir>
// It first proves each check on its planted fixtures (bad flagged, clean passed; a proof that fails exits 1), then walks the rows
// and writes <out-dir>/web-<engine>.json. It judges nothing: a finding on a real page is a record for the checklist, not a failure
// of this run. Run it inside the CI browser job image (BW_WAVE_CONTAINER=1), never on a developer machine.
// Kept as evidence: ci/a11y-tools/run-container.sh runs it by hand, outside the gates; its output is the tool-run part of the accessibility checklist (reflow, 200% text, reduced motion).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, webkit, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { startWebApp } from '../web-app.ts';
import { wiringFor } from '../page-walkers/app-wiring.ts';
import { loadInventory, walkClass } from '../page-walkers/inventory.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { mapFilesPresent, serveMapFiles } from '../look-values/map-files.ts';
import { overflowPass, PHONE_VIEWPORT, type Finding } from '../page-walkers/walkers.ts';
import { fixtures, motion, reflow320, REFLOW_VIEWPORT, text200 } from './checks.ts';

const engineName = process.argv[2] ?? '';
const out = process.argv[3] ?? '';
if (!['chromium', 'webkit'].includes(engineName) || !out) {
  console.error('usage: node ci/a11y-tools/run-web.ts <chromium|webkit> <out-dir>');
  process.exit(2);
}
if (process.env.BW_WAVE_CONTAINER !== '1') {
  console.error('run-web: refusing to run outside the CI browser container (BW_WAVE_CONTAINER=1); never on a developer machine');
  process.exit(2);
}
const type = engineName === 'chromium' ? chromium : webkit;
const SLOTS = Number(process.env.A11Y_SLOTS ?? 3);
const DESKTOP = { width: 1440, height: 900 };
const desktopScreen = (s: string) => /^SCR-(OFC|PBS)-/.test(s);

type Check = 'reflow' | 'text' | 'motion';
const CHECKS: Check[] = ['reflow', 'text', 'motion'];

async function withPage<T>(browser: Browser, origins: string[], opts: BrowserContextOptions, open: (p: Page) => Promise<void>, fn: (p: Page) => Promise<T>, maps = false): Promise<T> {
  const g = await guardedContext(browser, origins, opts);
  try {
    if (maps) await serveMapFiles(g.context);
    const p = await g.context.newPage();
    await open(p);
    return await fn(p);
  } finally {
    await g.context.close();
  }
}

// 14.1 item 12 (F-1628): desktop rows are zoomed to 200% (the viewport halved), phone rows have their text doubled; see checks.ts.
const runCheck = (c: Check, p: Page, desktop: boolean): Promise<Finding[]> =>
  c === 'reflow' ? reflow320(p) : c === 'text' ? text200(p, desktop ? DESKTOP : PHONE_VIEWPORT, desktop ? 'page-zoom' : 'text-only') : motion(p);

const optsFor = (c: Check, desktop: boolean): BrowserContextOptions =>
  c === 'reflow' ? { viewport: REFLOW_VIEWPORT, reducedMotion: 'no-preference' }
  : c === 'text' ? { viewport: desktop ? DESKTOP : PHONE_VIEWPORT, reducedMotion: 'no-preference' }
  : { viewport: PHONE_VIEWPORT, reducedMotion: 'reduce' };

mkdirSync(out, { recursive: true });
const browsers: Browser[] = [];
const fixtureServer = createServer((req, res) => {
  const body = fixtures[new URL(req.url ?? '/', 'http://x').pathname];
  if (body === undefined) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
});
await new Promise<void>((r) => fixtureServer.listen(0, '127.0.0.1', r));
const fixtureOrigin = `http://127.0.0.1:${(fixtureServer.address() as { port: number }).port}`;
let exit = 0;
try {
  for (let i = 0; i < SLOTS; i++) browsers.push(await type.launch({ headless: true }));
  const b0 = browsers[0]!;

  // ---- the proofs: each check flags its planted known-bad and passes its clean page --------------------------------------------------
  const proofs: { check: string; page: string; expect: 'flagged' | 'clean'; got: number; ok: boolean; findings: string[] }[] = [];
  const prove = async (check: Check, page: string, expect: 'flagged' | 'clean', opts?: BrowserContextOptions, desktop = false) => {
    const found = await withPage(b0, [fixtureOrigin], opts ?? optsFor(check, desktop), async (p) => { await p.goto(fixtureOrigin + page); }, (p) => runCheck(check, p, desktop));
    const ok = expect === 'flagged' ? found.length > 0 : found.length === 0;
    proofs.push({ check, page, expect, got: found.length, ok, findings: found.map((f) => f.message).slice(0, 4) });
  };
  await prove('reflow', '/reflow-bad.html', 'flagged');
  await prove('reflow', '/reflow-clean.html', 'clean');
  await prove('reflow', '/reflow-ypanel-bad.html', 'flagged'); // a 400 px box inside a panel that scrolls only up and down is still a reflow loss (F-1630)
  await prove('text', '/text-bad.html', 'flagged');
  await prove('text', '/text-clean.html', 'clean');
  // The page-zoom method (desktop rows, 200% = a 720 x 450 viewport): its bad page, its clean twin, and a page that only scrolls sideways (not a loss of text).
  await prove('text', '/zoom-bad.html', 'flagged', undefined, true);
  await prove('text', '/zoom-clean.html', 'clean', undefined, true);
  await prove('text', '/zoom-sideways.html', 'clean', undefined, true);
  await prove('motion', '/motion-bad.html', 'flagged');
  await prove('motion', '/motion-clean.html', 'clean');
  await prove('motion', '/motion-script-bad.html', 'flagged'); // motion driven by a script, not by CSS, must be flagged too (F-1631)
  await prove('motion', '/motion-script-clean.html', 'clean');
  // The 200% check fires because of the doubling, not because the label clips already: at 100% the bad label fits.
  const at100 = await withPage(b0, [fixtureOrigin], { viewport: DESKTOP }, async (p) => { await p.goto(fixtureOrigin + '/text-bad.html'); }, async (p) => overflowPass(p, [DESKTOP]));
  proofs.push({ check: 'text', page: '/text-bad.html at 100%', expect: 'clean', got: at100.length, ok: at100.length === 0, findings: at100.map((f) => f.message) });
  const zoomAt100 = await withPage(b0, [fixtureOrigin], { viewport: DESKTOP }, async (p) => { await p.goto(fixtureOrigin + '/zoom-bad.html'); }, async (p) => overflowPass(p, [DESKTOP]));
  proofs.push({ check: 'text', page: '/zoom-bad.html at 100%', expect: 'clean', got: zoomAt100.length, ok: zoomAt100.length === 0, findings: zoomAt100.map((f) => f.message) });
  // The motion check reads the browser's setting: the animation page under reduce is flagged, and the clean page (animation only for no-preference) is not.
  for (const p of proofs) console.log(`proof ${engineName} ${p.check} ${p.page} expect ${p.expect}: ${p.ok ? 'ok' : 'WRONG'} (${p.got} finding(s))`);
  if (proofs.some((p) => !p.ok)) exit = 1;

  // ---- the walk -----------------------------------------------------------------------------------------------------------------------
  const inv = loadInventory('acceptance/page-inventory.json');
  const walkable = inv.filter((r) => walkClass(r.type) !== 'native');
  const nativeOnly = inv.filter((r) => walkClass(r.type) === 'native');
  const { wired, unwired } = wiringFor(walkable);
  if (wired.length > 0 && !mapFilesPresent()) throw new Error('the map files are missing (node ci/data-assets.ts ensure --manifest packages/maps/MANIFEST.json --dir .build/data/maps)');
  const app = await startWebApp();
  type StateResult = { screen: string; path: string; status: number; reflow: string[]; text: string[]; motion: string[]; error?: string };
  const results: StateResult[] = [];
  try {
    const queue = [...wired];
    let done = 0;
    await Promise.all(browsers.map(async (browser) => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const desktop = desktopScreen(row.screen);
        const res: StateResult = { screen: row.screen, path: row.path, status: row.status, reflow: [], text: [], motion: [] };
        try {
          for (const c of CHECKS) {
            const found = await withPage(browser, [app.origin], optsFor(c, desktop), async (p) => {
              const r = await p.goto(app.origin + row.path, { waitUntil: 'networkidle' });
              if (r?.status() !== row.status) throw new Error(`${row.path} answered ${r?.status()}, wiring says ${row.status}`);
              await p.waitForSelector(`[data-screen="${row.screen}"]`, { state: 'attached' });
              if (/^\/shell-preview\/booking(-taken)?\//.test(row.path)) await p.waitForSelector('.bw-ph', { state: 'attached', timeout: 5000 }).catch(() => undefined);
            }, (p) => runCheck(c, p, desktop), row.maps === true);
            res[c === 'reflow' ? 'reflow' : c === 'text' ? 'text' : 'motion'] = found.map((f) => f.message);
          }
        } catch (e) {
          res.error = (e as Error).message.split('\n')[0] ?? 'error';
        }
        results.push(res);
        done += 1;
        if (done % 20 === 0) console.log(`walk ${engineName}: ${done}/${wired.length} states`);
      }
    }));
  } finally {
    await app.stop();
  }
  results.sort((a, b) => (a.screen + a.path).localeCompare(b.screen + b.path));
  const verdict = {
    engine: engineName, version: type.name(), proofs, states: results.length, errors: results.filter((r) => r.error).length,
    unwired: unwired.map((r) => ({ screen: r.screen, name: r.name, type: r.type })), nativeOnly: nativeOnly.map((r) => ({ screen: r.screen, name: r.name })),
    rows: results,
  };
  writeFileSync(path.join(out, `web-${engineName}.json`), JSON.stringify(verdict, null, 1) + '\n');
  console.log(`walk ${engineName}: ${results.length} states, ${verdict.errors} error(s), ${results.filter((r) => r.reflow.length + r.text.length + r.motion.length > 0).length} with findings`);
  if (verdict.errors > 0) exit = 1;
} finally {
  await Promise.all(browsers.map((b) => b.close()));
  fixtureServer.close();
}
process.exit(exit);
