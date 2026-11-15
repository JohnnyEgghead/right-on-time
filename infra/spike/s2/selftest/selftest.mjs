// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S2 (G-S2-TWA-OFFLINE): THROWAWAY self-test of the owner's script, driven in WebKit.
// Runs only inside the Spectre container started by run-on-spectre.sh. A persistent profile stands
// in for the home-screen install: closing the browser context is "close from the app switcher".
//   A. open online: the service worker installs and controls the page, the shell is cached
//   B. signal off: save 1 note and 1 photo; both wait on the phone; the server has neither
//   C. close the app, reopen with signal still off: the shell opens from cache, both still wait
//   D. close, reopen with signal on: both send; the server holds each key exactly once
//   E. replay: the same 2 keys sent again (twice each, at the same time) are answered "duplicate"
//      and the server's item count does not change
import { webkit } from 'playwright';

const BASE = process.env.BASE || 'https://bw.j7l.io/spike/s2/';
const PROFILE = '/tmp/s2-profile';
const RUN = `selftest-${Date.now()}`;
// 1x1 PNG
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const results = [];
let failed = false;

function step(name, ok, detail) {
  const line = { t: new Date().toISOString(), step: name, ok, ...detail };
  results.push(line);
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
}

async function serverItems() {
  const r = await fetch(BASE + 'api/items');
  return (await r.json()).items;
}

async function launch(offline) {
  const ctx = await webkit.launchPersistentContext(PROFILE, { offline });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

const rows = (page) =>
  page.$$eval('#items li', (lis) => lis.map((li) => ({ key: li.dataset.key, state: li.dataset.state })));

async function waitRows(page, state, n, ms = 30000) {
  await page.waitForFunction(
    ([s, k]) => document.querySelectorAll(`#items li[data-state="${s}"]`).length >= k,
    [state, n],
    { timeout: ms },
  );
}

async function main() {
  const before = await serverItems();
  step('0 server reachable', true, { itemsBefore: before.length, run: RUN });

  // A
  let { ctx, page } = await launch(false);
  await page.goto(BASE);
  await page.evaluate(() => navigator.serviceWorker.ready);
  try {
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  } catch {
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
  }
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys[0]);
    return { caches: keys, entries: (await c.keys()).map((r) => new URL(r.url).pathname) };
  });
  step('A online open: service worker controls the page, shell cached', cached.entries.length >= 6, cached);

  // B
  await ctx.setOffline(true);
  const probe = await page.evaluate(() => fetch('api/health').then(() => 'reached', (e) => 'blocked: ' + e.name));
  await page.fill('#note', `${RUN} note`);
  await page.click('#save-note');
  await page.setInputFiles('#photo', { name: `${RUN}.png`, mimeType: 'image/png', buffer: PHOTO });
  await waitRows(page, 'queued', 2);
  const queuedB = await rows(page);
  const keys = queuedB.map((r) => r.key);
  const onServerB = (await serverItems()).filter((i) => keys.includes(i.key)).length;
  step('B signal off: note and photo saved and waiting; server has neither',
    probe.startsWith('blocked') && queuedB.length === 2 && onServerB === 0, { probe, rows: queuedB, onServerB });
  await ctx.close();

  // C
  ({ ctx, page } = await launch(true));
  let openedC = 'ok';
  try {
    await page.goto(BASE);
    await waitRows(page, 'queued', 2, 10000);
  } catch (e) {
    openedC = String(e.message).split('\n')[0];
  }
  const rowsC = openedC === 'ok' ? await rows(page) : [];
  const netC = openedC === 'ok' ? await page.textContent('#net') : null;
  step('C reopen with signal off: shell opens from cache, both items still waiting',
    openedC === 'ok' && rowsC.filter((r) => r.state === 'queued').length === 2, { openedC, net: netC, rows: rowsC });
  await ctx.close();

  // D
  ({ ctx, page } = await launch(false));
  await page.goto(BASE);
  let sentD = 'ok';
  try {
    await waitRows(page, 'sent', 2, 30000);
  } catch (e) {
    sentD = String(e.message).split('\n')[0];
  }
  const rowsD = await rows(page);
  const after = await serverItems();
  const perKey = keys.map((k) => ({ key: k, count: after.filter((i) => i.key === k).length,
    kind: (after.find((i) => i.key === k) || {}).kind, bytes: (after.find((i) => i.key === k) || {}).bytes }));
  step('D reopen with signal on: both sent; server holds each key exactly once',
    sentD === 'ok' && perKey.every((p) => p.count === 1), { sentD, rows: rowsD, perKey });
  await ctx.close();

  // E
  const note = Buffer.from(`${RUN} note`);
  const send = (key, kind, type, body) => fetch(BASE + 'api/items', { method: 'POST',
    headers: { 'Idempotency-Key': key, 'X-Item-Kind': kind, 'Content-Type': type }, body })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const [noteKey, photoKey] = [rowsD[0].key, rowsD[1].key];
  const replay = await Promise.all([
    send(noteKey, 'note', 'text/plain; charset=utf-8', note), send(noteKey, 'note', 'text/plain; charset=utf-8', note),
    send(photoKey, 'photo', 'image/png', PHOTO), send(photoKey, 'photo', 'image/png', PHOTO),
  ]);
  const afterE = await serverItems();
  step('E replay of both keys (2 concurrent each): all duplicate, item count unchanged',
    replay.every((r) => r.status === 200 && r.result === 'duplicate') && afterE.length === after.length,
    { replay, itemsAfterD: after.length, itemsAfterE: afterE.length });
}

main()
  .catch((e) => step('unexpected error', false, { error: String(e.stack || e).slice(0, 600) }))
  .finally(() => {
    console.log('RESULT ' + JSON.stringify({ run: RUN, pass: !failed, results }));
    process.exit(failed ? 1 : 0);
  });
