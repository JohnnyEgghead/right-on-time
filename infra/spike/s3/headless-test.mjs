// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S3 (G-S3-MAP-SAFARI): THROWAWAY automated headless Chromium load of the hosted page, run on this
// Mac (headless only, never a headed browser). Loads the page, waits for tiles at zoom 10, jumps to
// zoom 15 over downtown Columbus, waits again, saves screenshots, and lists every request host.
//   node infra/spike/s3/headless-test.mjs <out-dir> [url]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { guardedContext } from '../../../ci/page-walkers/origin-guard.ts';

const out = process.argv[2];
const url = process.argv[3] || 'https://bw.j7l.io/spike/s3/';
if (!out) throw new Error('usage: headless-test.mjs <out-dir> [url]');

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
// The repo's outside-origin guard: a request to any origin but bw.j7l.io is aborted and recorded.
const g = await guardedContext(browser, ['https://bw.j7l.io'], { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 }, { assertOnClose: false });
const ctx = g.context;
const reqs = [];
ctx.on('request', (r) => reqs.push({ url: r.url(), method: r.method(), range: r.headers()['range'] || null, worker: !r.frame() }));
const resp = [];
ctx.on('response', (r) => resp.push({ url: r.url(), status: r.status() }));
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

const waitLoaded = async () => {
  try {
    await page.waitForFunction(() => window.__s3 && window.__s3.state().loaded, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => window.__s3.state().loaded, null, { timeout: 60000 });
  } catch (e) {
    console.log('WAIT FAILED', e.message.split('\n')[0], JSON.stringify(logs.slice(0, 10)), JSON.stringify(reqs.slice(-8)));
    await page.screenshot({ path: `${out}/headless-fail.png` });
    await browser.close();
    process.exit(2);
  }
};

const steps = [];
await page.goto(url + '?z=10', { waitUntil: 'load' });
await waitLoaded();
steps.push({ step: 'zoom10 Columbus', ...(await page.evaluate(() => window.__s3.state())) });
await page.screenshot({ path: `${out}/headless-z10.png` });

await page.evaluate(() => window.__s3.map.jumpTo({ center: [-83.0007, 39.9612], zoom: 15 }));
await waitLoaded();
steps.push({ step: 'zoom15 downtown Columbus', ...(await page.evaluate(() => window.__s3.state())) });
await page.screenshot({ path: `${out}/headless-z15.png` });

const pageHosts = await page.evaluate(() => window.__s3.hosts());
const blockedByCsp = await page.evaluate(() => window.__s3.blocked());
// Control: ask for another host. The page's policy must block it and the counter must go to 1.
await page.evaluate(() => fetch('https://example.invalid/control').catch(() => null));
await page.waitForTimeout(500);
const cspControlCount = await page.evaluate(() => window.__s3.blocked().length);
await page.screenshot({ path: `${out}/headless-control.png` });
const guardOutside = g.outside.slice();
await browser.close();

const hosts = [...new Set(reqs.map((r) => new URL(r.url).host).filter(Boolean))].sort();
const nonHttp = [...new Set(reqs.map((r) => new URL(r.url).protocol))].sort();
const ranged = reqs.filter((r) => r.url.endsWith('columbus.pmtiles'));
const range206 = resp.filter((r) => r.url.endsWith('columbus.pmtiles') && r.status === 206).length;
const result = {
  url,
  steps,
  requestCount: reqs.length,
  hosts,
  protocols: nonHttp,
  pageSeenHosts: pageHosts,
  blockedByCsp,
  guardOutside,
  cspControlCount,
  pmtilesRequests: ranged.length,
  pmtiles206: range206,
  sampleRanges: ranged.slice(0, 5).map((r) => r.range),
  pass: hosts.length === 1 && hosts[0] === 'bw.j7l.io' && range206 > 0 && blockedByCsp.length === 0 && guardOutside.length === 0 && cspControlCount === 1 && steps.every((s) => s.renderedFeatures > 0),
  console: logs.slice(0, 20),
};
writeFileSync(`${out}/headless-result.json`, JSON.stringify(result, null, 2));
writeFileSync(`${out}/headless-requests.txt`, reqs.map((r) => `${r.method} ${r.url} range=${r.range}`).join('\n') + '\n');
console.log(JSON.stringify({ ...result, steps: result.steps.map((s) => ({ step: s.step, zoom: s.zoom, loaded: s.loaded, renderedFeatures: s.renderedFeatures, rendered: s.rendered })) }, null, 1));
process.exit(result.pass ? 0 : 1);
