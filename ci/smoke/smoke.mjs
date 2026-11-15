// SPDX-License-Identifier: AGPL-3.0-or-later
// The smoke check of smoke-public-tag (FR-DIST-8, UC-11): inside the harness container, which shares the engine's network, so the copy is at
// http://127.0.0.1:8080 as an own copy's owner sees it. Sign in as Maria Santos on the technician sign-in and find her 10:00 AM to 12:00 PM
// Harold Jenkins job on Today. A request to any origin but the copy's own is aborted and fails the run: the context is opened through
// guardedContext, the outside-origin guard every Playwright file uses (F-40; ci/browser-test-guard.test.ts fails a file that opens one another way).
// Environment: SMOKE_SEED (the published sample password seed), SMOKE_BASE (default http://127.0.0.1:8080), SMOKE_IGNORE_HTTPS_ERRORS.
// Files beside it (the job copies them into the harness; node strips their types): passwords.ts (copied from the copy under test, so the
// password is the copy's own rule, SD-9) and origin-guard.ts (ci/page-walkers/origin-guard.ts of this checkout).
import { chromium } from 'playwright';
import { guardedContext } from './origin-guard.ts';
import { samplePassword, showSamplePassword } from './passwords.ts';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8080';
const seed = process.env.SMOKE_SEED;
if (!seed) throw new Error('SMOKE_SEED is not set');
const MARIA = 'maria.santos@brightwater.example';
const origin = new URL(base).origin;

const browser = await chromium.launch();
let code = 1;
let guarded;
try {
  // Service workers are blocked (the guard's default); an outside request, a worker's or a WebSocket included, is aborted and recorded in outside.
  // SMOKE_IGNORE_HTTPS_ERRORS=1 (P8-RESTORE-DRILL only): the drill's temporary copy serves a self-signed certificate for its address,
  // reached from the 1 Mac its firewall admits; the smoke job never sets it.
  const tls = process.env.SMOKE_IGNORE_HTTPS_ERRORS === '1' ? { ignoreHTTPSErrors: true } : {};
  guarded = await guardedContext(browser, [origin], { viewport: { width: 520, height: 980 }, ...tls });
  const { context, outside } = guarded;
  const page = await context.newPage();
  await page.goto(`${base}/tech/sign-in`, { waitUntil: 'load' });
  await page.fill('#ts-login', MARIA);
  await page.fill('#ts-password', showSamplePassword(samplePassword(seed, MARIA)));
  await page.click('[data-ctl="CTL-TEC-01-04"]');
  await page.waitForURL('**/tech', { timeout: 60_000 });
  await page.waitForSelector('[data-screen="SCR-TEC-02"]', { timeout: 60_000 });
  const rows = await page.locator('.list [data-job]').evaluateAll((els) => els.map((e) => ({ job: e.getAttribute('data-job'), text: e.innerText })));
  // Harold Jenkins's job is found by its number (the generator pins it, packages/generator/src/generate.ts), never by the surname alone (F-1456):
  // the surname is in the generator's random pool. Today names a customer by surname and place, so the row's text must also hold it.
  const found = rows.find((r) => r.job === '24830');
  const row = found && /\bJenkins\b/.test(found.text) ? found.text : undefined;
  if (!row) throw new Error(`Maria Santos's Today has no Harold Jenkins job 24830; rows: ${JSON.stringify(rows.map((r) => `${r.job} ${r.text.replace(/\s+/g, ' ').slice(0, 80)}`))}`);
  const text = row.replace(/\s+/g, ' ');
  if (!/10(:00)? ?AM\s*(-|–|—|to)\s*12(:00)? ?PM/i.test(text)) throw new Error(`Harold Jenkins's job is not 10:00 AM to 12:00 PM: ${text.slice(0, 160)}`);
  console.log(`smoke.mjs: Maria Santos signed in; found: ${text.slice(0, 160)}`);
  // The plant of FR-DIST-8's proof (F-1450): the page asks for an outside origin, and the job must fail below.
  // (A page of the copy has a content security policy that stops the request before the guard sees it, so the plant is a page of the same context with none.)
  if (process.env.SMOKE_PLANT_PAGE_CALL === '1') {
    const planted = await context.newPage();
    await planted.setContent('<img src="https://example.com/planted.png">');
    await planted.waitForTimeout(1500);
  }
  if (outside.length > 0) throw new Error(`the page asked for outside origins: ${outside.join(', ')}`);
  code = 0;
} catch (e) {
  console.error(`smoke.mjs: FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  // Closing the context is the guard's own assert (it throws when anything outside was recorded), so a pass must survive it too.
  try {
    await guarded?.context.close();
  } catch (e) {
    if (code === 0) console.error(`smoke.mjs: FAIL ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  }
  await browser.close();
}
process.exit(code);
