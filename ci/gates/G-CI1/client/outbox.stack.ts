// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-4, FR-TECH-7, FR-DISP-9, UC-03 (G-CI1's client cases; BUILD_PLAN P5-TWA-OUTBOX Acceptance: Playwright on WebKit and Chromium at 520 x 980 against the Compose stack)
// The web technician app's item store (SPECIFICATIONS section 4.6, section 5.1; UI-SPECIFICATION 4.5; invariant 1) in the real browser
// engines against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs and the worker running), through its
// proxy, every page opened through the outside-origin guard, signed in as Maria Santos (ci/gates/G-CI1/client/fixture.sql):
//   1. exactly once (FR-TECH-4, UC-03): with the network off a note is typed on SCR-TEC-05 and a photo attached on SCR-TEC-06 and saved,
//      and the app is closed (the browser profile closed); opened again on the same profile it finds both and, with the network on, sends each exactly once (the server's ledger,
//      note and photo rows); a send whose answer is lost on the way is sent again and answered duplicate, still once on the server;
//   2. the refusals the phone cannot fix (F-562, owner ruling 546d6f1e): a finish with a part not on the list (validation_failed) and an
//      arrival for a job number the server does not hold (not_found) are each answered, leave the store and the waiting count, and are
//      listed on the flagged items list of Maria's branch, where Keisha Thompson marks each handled on the board (FR-DISP-9);
//   3. the waiting count and the 24-hour banner (FR-TECH-7): 3 offline items show "3 waiting"; the device clock moved 25 hours with the
//      demo clock unchanged shows the banner;
//   4. the shell (SD-47): with the service worker on, an open with no signal opens the kept shell with its waiting items.
// Case 1 types its note and attaches its photo on the real screens (F-936). The other cases enter items no screen can make (a part not on
// the list, a job number the server does not hold, 3 notes at once) through the page's own engine (window.__bwTechOutbox,
// src/tech/useOutbox.ts: the same enter() the screens call). Run by ci/outbox-stack.sh.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { BrowserContext, BrowserType, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { guardedContext, guardedPersistentContext, type GuardedContext } from '../../../page-walkers/origin-guard.ts';
import { engines } from '../../../pw-engines.ts';

const base = process.env.BW_OUTBOX_STACK_URL;
const db = process.env.BW_OUTBOX_DB_CONTAINER;
const people = { maria: process.env.BW_OUTBOX_MARIA, keisha: process.env.BW_OUTBOX_KEISHA };
if (!base || !db || Object.values(people).some((v) => !v)) throw new Error('BW_OUTBOX_STACK_URL, _DB_CONTAINER and the session tokens are not set: run ci/outbox-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so the page's writes are resent with the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const PHONE = { viewport: { width: 520, height: 980 }, colorScheme: 'light' as const };
const DESKTOP = { viewport: { width: 1440, height: 1100 } };
/** The page's Cache Storage, as the service worker test reads it (the suite's own typings carry no DOM). */
interface Caches { keys(): Promise<string[]>; open(name: string): Promise<{ keys(): Promise<{ url: string }[]> }> }
const UNHELD_JOB = 999_999;

/** A 16 x 16 PNG the browsers decode: Add photo compresses it to the SD-32 JPEG, which API-103 measures (16 x 16). */
function smallPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(16 * (16 * 3 + 1), 0x7f);
  for (let r = 0; r < 16; r++) raw[r * 49] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const version = (job: number) => Number(psql(`SELECT version FROM world.job WHERE job_number = ${job}`));
const ledger = (key: string) => psql(`SELECT result FROM world.tech_item WHERE key = '${key}'`);

/** The network as the phone sees it: off makes every API call fail as a dropped connection; loseNext drops 1 answer after the server took it. */
interface Net { off: boolean; loseNext: boolean; calls: string[] }

/** The page's writes carry the default origin (Playwright resends them; a browser will not let a route set Origin), and the network switch. */
async function wire(context: BrowserContext, net: Net): Promise<void> {
  await context.addCookies([{ name: 'bw_session', value: people.maria!, url: origin, httpOnly: true }, { name: 'bw_lang', value: 'en', url: origin }]);
  await context.route(`${origin}/api/v1/**`, async (r) => {
    const req = r.request();
    net.calls.push(`${req.method()} ${new URL(req.url()).pathname}`);
    if (net.off) return r.abort('internetdisconnected');
    try {
      const response = await r.fetch(req.method() === 'GET' ? {} : { headers: { ...(await req.allHeaders()), origin: APP_ORIGIN } });
      if (net.loseNext && req.method() === 'POST' && req.url().includes('/tech/items')) {
        net.loseNext = false;
        return await r.abort('connectionreset');
      }
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the call was in flight: nothing to hand back
    }
  });
}

type Entry = { jobNumber: number; baseVersion: number | null; body: Record<string, unknown>; bytes?: number[] };
interface Hook { enter(i: unknown): Promise<{ key: string }>; sync(): Promise<unknown>; state(): { ready: boolean; waiting: { key: string }[]; online: boolean; oldCount: number; lastSent: { key: string; result: string; code: string | null }[] } }
const enter = (page: Page, e: Entry) => page.evaluate(async (x) => {
  const h = (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox;
  const item = await h.enter({ jobNumber: x.jobNumber, baseVersion: x.baseVersion, body: x.body, ...(x.bytes ? { blob: new Uint8Array(x.bytes) } : {}) });
  return item.key;
}, e);
const sync = (page: Page) => page.evaluate(async () => {
  await (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox.sync();
});
const state = (page: Page) => page.evaluate(() => (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox.state());
const waitingKeys = async (page: Page) => (await state(page)).waiting.map((w) => w.key);

/** Open /tech and wait for the shell and its engine; with `synced`, run 1 sync so the clock offset is saved. */
async function openApp(context: BrowserContext, synced: boolean): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${origin}/tech`, { waitUntil: 'load' });
  await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-02"] .tabbar');
  await page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
  if (synced) await sync(page);
  return page;
}
const countText = (page: Page) => page.locator('.apphead [data-ctl="CTL-CMP-10-02"]').innerText();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const profile = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'bw-outbox-profile-'));
  dirs.push(d);
  return d;
};
const phone = async (type: BrowserType, dir: string, net: Net, serviceWorkers: 'allow' | 'block' = 'block'): Promise<GuardedContext> => {
  const g = await guardedPersistentContext(type, dir, [origin], { ...PHONE, serviceWorkers });
  await wire(g.context, net);
  return g;
};

describe.each(engines)('G-CI1 client cases on %s', (engine, type) => {
  // why: FR-TECH-4, UC-03 Playwright goes offline, saves a note and a photo, closes the app, reopens, finds both, goes online, and the server has each exactly once
  // why: F-936 the note is typed on SCR-TEC-05 and the photo attached on SCR-TEC-06, the screens the technician uses, not the engine's seam
  it('keeps a note and a photo saved with no signal through a closed app, and the server has each exactly once', async () => {
    const dir = profile();
    const net: Net = { off: false, loseNext: false, calls: [] };
    let g = await phone(type, dir, net);
    let note = '';
    let photo = '';
    try {
      const page = await openApp(g.context, true);
      // The job and the note screen load with signal (the job is then kept on the phone); the API goes dark before anything is typed.
      await page.goto(`${origin}/tech/jobs/24830/note`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
      await page.locator('[data-ctl="CTL-TEC-05-01"]').waitFor();
      net.off = true;
      const text = `Flame sensor cleaned (${engine})`;
      await page.locator('[data-ctl="CTL-TEC-05-01"]').fill(text);
      await page.locator('[data-ctl="CTL-TEC-05-02"]').click();
      await page.waitForURL('**/tech/jobs/24830');
      await page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
      await page.locator('[data-ctl="CTL-TEC-04-12"]').click();
      await page.waitForURL('**/tech/jobs/24830/photo');
      await page.locator('input[type="file"]').setInputFiles({ name: 'burner.png', mimeType: 'image/png', buffer: smallPng() });
      await page.waitForSelector('[data-ctl="CTL-TEC-06-02"] img');
      await page.locator('button[data-ctl="CTL-TEC-06-03"]').click();
      // SCR-TEC-06 Saved: the sheet closes to the job, which says the photo is kept on this phone (DK-110).
      await page.waitForURL('**/tech/jobs/24830?photo=saved');
      await page.locator('.r1p-notice[data-ctl="CTL-CMP-11-01"]').waitFor();
      await page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
      const keys = (await state(page)).waiting as unknown as { key: string; kind: string }[];
      note = keys.find((k) => k.kind === 'note')?.key ?? '';
      photo = keys.find((k) => k.kind === 'photo')?.key ?? '';
      expect([note !== '', photo !== '', keys.length]).toEqual([true, true, 2]);
      await page.locator('.note', { hasText: text }).waitFor();
      // Today, whose header carries the waiting count, with no signal.
      await page.goto(`${origin}/tech`, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
      await g.context.setOffline(true);
      await sync(page);
      await page.waitForSelector('[data-ctl="CTL-CMP-10-01"]');
      expect(await countText(page)).toBe('2 waiting');
    } finally {
      await g.context.close();
    }
    expect([ledger(note), ledger(photo)]).toEqual(['', '']);

    // The app opens again on the same profile with the network still off for the API: it finds both, then sends once the signal is back.
    g = await phone(type, dir, net);
    try {
      const page = await openApp(g.context, false);
      await sync(page);
      expect(await waitingKeys(page)).toEqual([note, photo]);
      expect(await countText(page)).toBe('2 waiting');
      net.off = false;
      await sync(page);
      expect(await waitingKeys(page)).toEqual([]);
      expect(await countText(page)).toBe('All synced');
      await page.waitForSelector('[data-ctl="CTL-CMP-10-04"]');
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
      await sync(page);
    } finally {
      await g.context.close();
    }
    expect([ledger(note), ledger(photo)]).toEqual(['applied', 'applied']);
    expect(psql(`SELECT count(*) FROM world.tech_item WHERE key IN ('${note}', '${photo}')`)).toBe('2');
    expect(psql(`SELECT count(*) FROM world.note WHERE item_key = '${note}' AND job_number = 24830`)).toBe('1');
    expect(psql(`SELECT count(*) FROM world.photo WHERE key = '${photo}' AND job_number = 24830 AND width = 16`)).toBe('1');
  });

  // why: FR-TECH-4 (invariant 1) a send whose answer is lost on the way is sent again under its key and answered duplicate: still once on the server
  it('resends an item whose answer was lost and the server keeps it once', async () => {
    const net: Net = { off: false, loseNext: false, calls: [] };
    const g = await phone(type, profile(), net);
    try {
      const page = await openApp(g.context, true);
      net.off = true;
      const key = await enter(page, { jobNumber: 24830, baseVersion: version(24830), body: { kind: 'note', payload: { text: `Answer lost (${engine})` } } });
      net.off = false;
      net.loseNext = true;
      await sync(page);
      expect([await waitingKeys(page), ledger(key)]).toEqual([[key], 'applied']);
      await sync(page);
      expect(await waitingKeys(page)).toEqual([]);
      expect((await state(page)).lastSent.map((a) => [a.key, a.result])).toEqual([[key, 'duplicate']]);
      expect(psql(`SELECT count(*) FROM world.note WHERE item_key = '${key}'`)).toBe('1');
    } finally {
      await g.context.close();
    }
  });

  // why: FR-DISP-9, F-562 a part not on the list and a job number the server does not hold are each answered, leave the phone, and are listed for the dispatcher with Mark handled
  it('lists a validation_failed finish and a not_found arrival on the branch\'s flagged items, and the dispatcher marks each handled', async () => {
    const net: Net = { off: false, loseNext: false, calls: [] };
    const g = await phone(type, profile(), net);
    let keys: string[] = [];
    try {
      const page = await openApp(g.context, true);
      net.off = true;
      const bad = await enter(page, { jobNumber: 24825, baseVersion: version(24825), body: { kind: 'finished', payload: { parts: [{ partId: 'not-a-listed-part', quantity: 1 }], noPartsUsed: false, laborMinutes: 30, workDone: ['Replaced the filter'] } } });
      const gone = await enter(page, { jobNumber: UNHELD_JOB, baseVersion: 1, body: { kind: 'arrived' } });
      keys = [bad, gone];
      expect(await countText(page)).toBe('2 waiting');
      net.off = false;
      await sync(page);
      const s = await state(page);
      expect([s.waiting, s.lastSent.map((a) => [a.key, a.result, a.code])]).toEqual([[], [[bad, 'flagged', 'validation_failed'], [gone, 'flagged', 'not_found']]]);
      expect(await countText(page)).toBe('All synced');
      await expect.poll(() => page.locator('[data-ctl="CTL-CMP-10-04"][data-result="flagged"]').allInnerTexts())
        .toEqual(['The server could not accept your update to job 24825. It was sent to the dispatcher.', `Job ${UNHELD_JOB} is not on your list. Your update was sent to the dispatcher.`]);
    } finally {
      await g.context.close();
    }
    const ids = keys.map((k) => psql(`SELECT id FROM world.offline_conflict WHERE item_key = '${k}' AND branch_id = 'columbus' AND handled_at IS NULL`));
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(psql(`SELECT job_number IS NULL FROM world.offline_conflict WHERE id = '${ids[1]}'`)).toBe('t');

    const o = await guardedContext(await type.launch({ headless: true }).then((b) => b), [origin], DESKTOP);
    try {
      await o.context.addCookies([{ name: 'bw_session', value: people.keisha!, url: origin, httpOnly: true }, { name: 'bw_lang', value: 'en', url: origin }]);
      await o.context.route(`${origin}/api/v1/**`, async (r) => {
        if (r.request().method() === 'GET') return r.continue();
        try {
          await r.fulfill({ response: await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } }) });
        } catch {
          // closed while in flight
        }
      });
      const board = await o.context.newPage();
      await board.goto(`${origin}/office/board?branch=columbus&date=today`, { waitUntil: 'load' });
      for (const id of ids) await board.waitForSelector(`[data-conflict="${id}"]`, { timeout: 60_000 });
      // why: F-953 a row for a job the world does not hold names the number the phone sent as plain text, with no link to a job page
      expect(await board.locator(`[data-conflict="${ids[1]}"] .tx`).innerText()).toContain(`job ${UNHELD_JOB}`);
      expect(await board.locator(`[data-conflict="${ids[1]}"] .tx a`).count()).toBe(0);
      expect(await board.locator(`[data-conflict="${ids[0]}"] .tx a`).count()).toBe(1);
      for (const id of ids) {
        await board.locator(`[data-conflict="${id}"] [data-ctl="CTL-OFC-02-16"]`).click();
        await board.waitForSelector(`[data-conflict="${id}"]`, { state: 'detached', timeout: 15_000 });
      }
    } finally {
      const b = o.context.browser();
      await o.context.close();
      await b?.close();
    }
    for (const id of ids) expect(psql(`SELECT u.name FROM world.offline_conflict c JOIN world."user" u ON u.id = c.handled_by WHERE c.id = '${id}'`)).toBe('Keisha Thompson');
    expect(psql(`SELECT count(*) FROM world.job_change WHERE job_number = 24825 AND kind = 'flag_handled' AND data->>'conflictId' = '${ids[0]}'`)).toBe('1');
  });

  // why: FR-TECH-7 3 offline items show 3 waiting; moving the device clock 25 hours, with the demo clock unchanged and the items unsent, shows the banner
  it('shows 3 waiting for 3 offline items and the 24-hour banner only after the device clock moves 25 hours', async () => {
    const net: Net = { off: false, loseNext: false, calls: [] };
    const g = await phone(type, profile(), net);
    try {
      const page = g.context.pages()[0] ?? (await g.context.newPage());
      await page.clock.install();
      await openApp(g.context, true);
      net.off = true;
      await g.context.setOffline(true);
      for (let i = 0; i < 3; i++) await enter(page, { jobNumber: 24830, baseVersion: version(24830), body: { kind: 'note', payload: { text: `Offline ${i} (${engine})` } } });
      await sync(page);
      expect(await countText(page)).toBe('3 waiting');
      const demoBefore = psql('SELECT demo_anchor FROM system.demo_clock WHERE id = 1');
      expect(await page.locator('[data-ctl="CTL-CMP-10-03"]').count()).toBe(0);
      await page.clock.setSystemTime(Date.now() + 23 * 60 * 60 * 1000); // the page's fake device clock moves; no time passes
      await sync(page);
      expect(await page.locator('[data-ctl="CTL-CMP-10-03"]').count()).toBe(0);
      await page.clock.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); // the page's fake device clock moves; no time passes
      await sync(page);
      await page.waitForSelector('[data-ctl="CTL-CMP-10-03"]');
      expect(await page.locator('[data-ctl="CTL-CMP-10-03"]').innerText()).toBe('3 items have waited more than 24 hours to send. Open the app with signal to send them.');
      expect(psql('SELECT demo_anchor FROM system.demo_clock WHERE id = 1')).toBe(demoBefore);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-4, SD-47 the service worker keeps the shell, so the app opens with no signal and shows what waits; it never keeps an API answer
  it('opens the kept shell with no signal through the service worker, with the waiting count from the phone\'s store', async () => {
    const net: Net = { off: false, loseNext: false, calls: [] };
    const g = await phone(type, profile(), net, 'allow');
    try {
      const page = await openApp(g.context, true);
      await page.waitForFunction(async () => Boolean(await (globalThis as unknown as { navigator: { serviceWorker?: { ready: Promise<unknown> } } }).navigator.serviceWorker?.ready), undefined, { timeout: 30_000 });
      // A second open with signal goes through the worker, which keeps the page and its static files.
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
      const kept = await page.evaluate(async () => (await (await (globalThis as unknown as { caches: Caches }).caches.open('bw-tech-shell-v1')).keys()).map((r) => new URL(r.url).pathname));
      expect(kept).toContain('/tech');
      const apiKept = await page.evaluate(async () => {
        const c = (globalThis as unknown as { caches: Caches }).caches;
        return (await Promise.all((await c.keys()).map(async (n) => (await (await c.open(n)).keys()).map((r) => r.url)))).flat().filter((u) => u.includes('/api/'));
      });
      expect(apiKept).toEqual([]);
      net.off = true;
      await g.context.setOffline(true);
      await enter(page, { jobNumber: 24830, baseVersion: version(24830), body: { kind: 'note', payload: { text: `Kept shell (${engine})` } } });
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-02"] .tabbar');
      await page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready));
      await sync(page);
      expect(await countText(page)).toBe('1 waiting');
      await page.waitForSelector('[data-ctl="CTL-CMP-10-01"]');
    } finally {
      await g.context.close();
    }
  });
});
