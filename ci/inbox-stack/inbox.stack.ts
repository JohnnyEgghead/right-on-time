// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-8, FR-TEXT-14, FR-TEXT-18, FR-TEXT-20, FR-TEXT-21, FR-TEXT-4, SD-45, UC-17, F-421, F-445, F-671, F-799, F-808, F-829 (P5-INBOX Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The customer's text inbox (SCR-INB-01) and Change your visit time (SCR-CUS-06) against the Compose stack at its default settings (real
// PostgreSQL 18, real handlers, the worker and pbs running), set up by the setup service (the seeded world), through its proxy, every page opened
// through the outside-origin guard. A reply R in the inbox gets the R-reply, whose link opens the reschedule page and moves the visit; the same link
// after that shows the ended text and moves nothing; a held confirmation ends canceled with text_reason.visit_changed when the customer moves the
// visit and the new confirmation is the 1 unsent one; an office reschedule ends a link before it is used (F-808); an office text shows in the
// inbox as 1 message. The people are ci/inbox-stack/fixture.sql's sessions. Run by ci/inbox-stack.sh. The suite shares 1 world and 1 clock.
// Every shown field comes from the real API (the inbox's name and the visit's day are read back from the database here, never from a fixture).
import { spawnSync } from 'node:child_process';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_INBOX_STACK_URL;
const db = process.env.BW_INBOX_DB_CONTAINER;
const people = { keisha: process.env.BW_INBOX_KEISHA, dana: process.env.BW_INBOX_DANA };
if (!base || !db || Object.values(people).some((v) => !v)) throw new Error('BW_INBOX_STACK_URL, _DB_CONTAINER and the session tokens are not set: run ci/inbox-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 1100 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 } };
type Who = keyof typeof people;
const INBOX = '.r1-screen[data-screen="SCR-INB-01"]';
const RESCHED = '.r1-screen[data-screen="SCR-CUS-06"]';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner (reads, and the rows the suite sets up). */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** A call as a person, with the default origin on writes (the kernel's Origin check, SD-8). */
async function api(who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { cookie: `bw_session=${people[who]}`, ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const ms = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));

/** Poll until `cond` holds. */
async function until<T>(what: string, read: () => Promise<T> | T, cond: (v: T) => boolean, tries = 120): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (cond(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 600)}`);
}

/** Jump the shared clock to a wire time (API-12, the manager): a replay still running refuses (409), so retry; then wait until it has caught up. */
async function jumpTo(to: string): Promise<void> {
  for (let i = 0; ; i += 1) {
    const r = await api('dana', 'POST', '/clock/jumps', { to });
    if (r.status === 202) break;
    if (r.status !== 409 || i > 240) expect(r.status, JSON.stringify(r.body)).toBe(202);
    await sleep(500);
  }
  await until('the clock to reach the target', async () => (await api('dana', 'GET', '/clock')).body, (b) => !b.data.replay?.running && ms(b.data.demoNow) >= ms(to) - 1_000);
}

/** A seeded customer who takes texts, with a live visit on a later day than the suite's today and no other reschedule link yet. */
function visitor(skip: number): { id: string; name: string; token: string; job: number; date: string } {
  const row = psql(`SELECT json_build_object('id', c.id, 'name', c.name, 'token', c.inbox_token, 'job', j.job_number, 'date', j.date::text)
    FROM world.customer c JOIN world.job j ON j.customer_id = c.id
    WHERE c.branch_id = 'columbus' AND c.texts_on AND c.mobile IS NOT NULL AND c.text_language = 'en' AND c.zone = 'America/New_York'
      AND j.status = 'scheduled' AND j.date >= '2026-09-17' AND j.branch_id = 'columbus'
      AND NOT EXISTS (SELECT 1 FROM world.job o WHERE o.customer_id = c.id AND o.job_number <> j.job_number AND o.status IN ('scheduled', 'on_the_way', 'on_site'))
    ORDER BY j.date, j.job_number OFFSET ${skip} LIMIT 1`);
  expect(row, 'a seeded visitor').not.toBe('');
  return JSON.parse(row);
}
const jobDate = (job: number) => psql(`SELECT date::text FROM world.job WHERE job_number = ${job}`);

/** The page's writes carry the default origin: Playwright resends them itself (a browser will not let a route set Origin). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the write was in flight: nothing to hand back
    }
  });
}
// The reschedule page's own write is POST /r/<token> (a root route, not under /api/v1): the same origin rule.
async function writeOriginRoot(p: Page): Promise<void> {
  await p.route(`${origin}/r/*`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the write was in flight: nothing to hand back
    }
  });
}

interface Open { page: Page; g: GuardedContext }
/** A customer's page: no session (the link is the access), the language in the browser's choice. */
async function openLink(browser: Browser, path: string, lang: 'en' | 'es' = 'en', view: BrowserContextOptions = PHONE): Promise<Open> {
  const g = await guardedContext(browser, [origin], view);
  await g.context.addCookies([{ name: 'bw_lang', value: lang, url: origin }]);
  const page = await g.context.newPage();
  await writeOrigin(page);
  await writeOriginRoot(page);
  await page.goto(origin + path, { waitUntil: 'load' });
  return { page, g };
}
async function openStaff(browser: Browser, who: Who, path: string): Promise<Open> {
  const g = await guardedContext(browser, [origin], DESKTOP);
  await g.context.addCookies([{ name: 'bw_session', value: people[who]!, url: origin, httpOnly: true }, { name: 'bw_lang', value: 'en', url: origin }]);
  const page = await g.context.newPage();
  await writeOrigin(page);
  await page.goto(origin + path, { waitUntil: 'load' });
  return { page, g };
}
const close = async (o: Open) => o.g.context.close();

const textsOf = (customer: string, kind: string) => psql(`SELECT coalesce(json_agg(json_build_object('status', status, 'reason', reason_key, 'body', body) ORDER BY created_at, id), '[]') FROM world.outbox_text WHERE customer_id = ${q(customer)} AND kind = ${q(kind)}`);
const unsentConfirmations = (job: number) => Number(psql(`SELECT count(*) FROM world.outbox_text WHERE job_number = ${job} AND kind = 'confirmation' AND status IN ('queued', 'held', 'retrying')`));
const linkOf = (customer: string): string | null => {
  const body = psql(`SELECT body FROM world.outbox_text WHERE customer_id = ${q(customer)} AND kind = 'r_reply' ORDER BY created_at DESC, id DESC LIMIT 1`);
  return /\/r\/([0-9A-Za-z]{8})/.exec(body)?.[1] ?? null;
};

describe.each(engines)('The text inbox and Change your visit time on %s', (engine, type) => {
  let browser: Browser;
  const skip = engine === 'webkit' ? 6 : 0;
  // The 6 visitors are chosen once, before any step moves a visit, so no step reads another's customer by a changed order.
  let pick: ReturnType<typeof visitor>[] = [];
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    // Texts go out in the day, not in quiet hours: the seeded clock starts at 7:00 AM, so move it to 10:00 AM once.
    const now = (await api('dana', 'GET', '/clock')).body.data.demoNow as string;
    if (Number(now.slice(11, 13)) < 9) await jumpTo(`${now.slice(0, 10)}T10:00:00-04:00[America/New_York]`);
    pick = [0, 1, 2, 3, 4, 5].map((i) => visitor(skip + i));
  }, 300_000);
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TEXT-14 the inbox shows the customer's name and the texts sent to them, read from the API; FR-TEXT-8 a reply R gets the R-reply with the reschedule link and the office phone
  it('opens by its token with the customer\'s own name, and a reply R brings the R-reply with its reschedule link', async () => {
    const v = pick[0]!;
    const o = await openLink(browser, `/inbox/${v.token}`);
    try {
      const p = o.page;
      await p.waitForSelector(`${INBOX} [data-ctl="CTL-INB-01-01"]`, { timeout: 60_000 });
      expect(await p.locator(`${INBOX} [data-ctl="CTL-INB-01-01"] b`).innerText()).toBe(v.name);
      await p.locator(`${INBOX} [data-ctl="CTL-INB-01-05"]`).click();
      await until('the R-reply', () => linkOf(v.id), (t) => t !== null);
      // The worker sends it (the clock runs): the page's 5 s refresh brings it, with its link and the office phone.
      const link = p.locator(`${INBOX} a[data-ctl="CTL-INB-01-03"]`).last();
      await link.waitFor({ timeout: 60_000 });
      expect(await p.locator(`${INBOX} .bub.in`).last().innerText()).toContain('(614) 555-0100');
      // The reply itself shows as the customer's bubble with Delivered under it (CTL-INB-01-08).
      expect(await p.locator(`${INBOX} .bub.out`, { hasText: /^R$/ }).count()).toBeGreaterThan(0);
      expect(psql(`SELECT handling FROM world.inbox_message WHERE customer_id = ${q(v.id)} AND direction = 'in' ORDER BY at DESC, id DESC LIMIT 1`)).toBe('reschedule_sent');
    } finally {
      await close(o);
    }
  }, 180_000);

  // why: FR-TEXT-17 the reschedule page names the zone after every window and each wrapped window radio holds its words inside its box at 375 px; FR-TEXT-18 tapping the link of a text in the inbox opens the running server's reschedule page; FR-TEXT-8 the page moves the visit; SD-45, F-799, F-829 a held confirmation ends canceled with text_reason.visit_changed and the new confirmation is the 1 unsent one
  it('opens the reschedule page from the R-reply link, moves the visit, and leaves 1 unsent confirmation; the same link then shows the ended text', async () => {
    const v = pick[0]!;
    const token = linkOf(v.id);
    expect(token, 'the R-reply of the step before').not.toBeNull();
    // A confirmation still held from the booking names the old day (set up as the booking writes one, held by quiet hours).
    psql(`INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at, next_try_at)
      VALUES (${q(v.id)}, ${v.job}, 'confirmation', 'en', 'gsm7', 'Brightwater: held for the old day.', 33, 'held', 0, now() + interval '9 hours', now(), now() + interval '9 hours')`);
    const heldBefore = unsentConfirmations(v.job);
    expect(heldBefore).toBeGreaterThan(0);
    // Every confirmation the job has before the move, so the one the move creates is told apart from them.
    const idsOf = (job: number) => psql(`SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM world.outbox_text WHERE job_number = ${job} AND kind = 'confirmation'`).split(',').filter((x) => x !== '');
    const before = idsOf(v.job);
    const o = await openLink(browser, `/inbox/${v.token}`, 'en', { ...PHONE, viewport: { width: 375, height: 812 } });
    try {
      const p = o.page;
      await p.locator(`${INBOX} a[data-ctl="CTL-INB-01-03"]`).last().waitFor({ timeout: 60_000 });
      await p.locator(`${INBOX} a[data-ctl="CTL-INB-01-03"]`).last().click();
      await p.waitForSelector(`${RESCHED} [data-ctl="CTL-CUS-06-01"]`, { timeout: 60_000 });
      expect(new URL(p.url()).pathname).toBe(`/r/${token}`);
      // The days are the online rules' (API-117): pick the first open day other than the current one, and its first open window.
      // The loading skeleton draws empty .day boxes: the real tiles are the radios.
      const day = p.locator(`${RESCHED} .day[role="radio"]:not(.now):not([aria-disabled="true"])`).first();
      await day.click();
      // FR-TEXT-17: the current visit and every window name the branch zone, and a window that wraps stays inside its radio box (375 px).
      const ZONED = /^(\d{1,2}( [AP]M)?-\d{1,2} [AP]M) E[DS]T/;
      expect(await p.locator(`${RESCHED} .cur`).first().innerText()).toMatch(/\d [AP]M E[DS]T/);
      const radios = await p.locator(`${RESCHED} .win`).evaluateAll((els) => els.map((e) => {
        const box = e.getBoundingClientRect();
        const txEl = e.querySelector('.tx')!;
        const tx = txEl.getBoundingClientRect();
        const dom = (globalThis as unknown as { document: { createRange(): { selectNodeContents(n: unknown): void; getClientRects(): { length: number } } } }).document;
        // F-1301: .tx is a column flex box holding the label and the room word, so its height says nothing about wrapping. The label is the first
        // text node: the Range over it has 1 client rect per line it is drawn on, so more than 1 means the label itself wrapped.
        const range = dom.createRange();
        range.selectNodeContents(txEl.firstChild!);
        return { text: e.textContent ?? '', inside: tx.left >= box.left && tx.right <= box.right && tx.top >= box.top && tx.bottom <= box.bottom, fits: e.scrollWidth <= e.clientWidth + 1, wraps: range.getClientRects().length > 1 };
      }));
      expect(radios.length).toBeGreaterThan(0);
      // F-1274: the 'wrapped window' half of FR-TEXT-17 needs a label that wraps; with none wrapping, the inside check above proved nothing.
      expect(radios.filter((r) => r.wraps).length, 'at least 1 window radio wraps at 375 px').toBeGreaterThan(0);
      for (const r of radios) {
        expect(r.text, 'a window radio names its zone').toMatch(ZONED);
        expect(r.inside && r.fits, `the window radio "${r.text}" holds its words inside its box`).toBe(true);
      }
      const win = p.locator(`${RESCHED} .win:not(.full)`).first();
      await win.click();
      const go = p.locator(`${RESCHED} [data-ctl="CTL-CUS-06-04"]`);
      expect(await go.innerText(), 'Confirm new time names the zone').toMatch(/E[DS]T/);
      expect(await go.getAttribute('aria-disabled')).toBeNull();
      await go.click();
      await p.locator(`${RESCHED} .msgc.ok`).waitFor({ timeout: 60_000 });
      // F-1274: the Changed message names the visit with its zone (visitText).
      expect(await p.locator(`${RESCHED} .msgc.ok`).innerText(), 'the Changed message names the zone').toMatch(/E[DS]T/);
      const moved = jobDate(v.job);
      expect(moved).not.toBe(v.date);
      // The held confirmation of the old day ended canceled with the visit-changed reason; the new confirmation is the 1 the job keeps.
      const confirmations = JSON.parse(textsOf(v.id, 'confirmation')) as { status: string; reason: string | null }[];
      expect(confirmations.filter((t) => t.status === 'canceled').map((t) => t.reason)).toContain('text_reason.visit_changed');
      // Exactly 1 non-canceled confirmation was created by the move and it names the new day; no other confirmation of the job is unsent.
      const created = (JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('id', id, 'status', status, 'body', body) ORDER BY id), '[]') FROM world.outbox_text
        WHERE job_number = ${v.job} AND kind = 'confirmation' AND status <> 'canceled' AND id::text <> ALL (${`ARRAY[${before.map(q).join(', ')}]::text[]`})`)) as { id: string; status: string; body: string }[]);
      expect(created, 'the confirmations created by the move').toHaveLength(1);
      const newDay = new Date(`${moved}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
      expect(created[0]!.body).toContain(newDay);
      expect(created[0]!.body).not.toContain('held for the old day');
      expect(Number(psql(`SELECT count(*) FROM world.outbox_text WHERE job_number = ${v.job} AND kind = 'confirmation' AND status IN ('queued', 'held', 'retrying') AND id::text <> ${q(created[0]!.id)}`))).toBe(0);
      // The link is used: opened again, it shows the ended text with the office phone, and moves nothing.
      await p.goto(`${origin}/r/${token}`, { waitUntil: 'load' });
      await p.waitForSelector(`${RESCHED} .msgc.warn`, { timeout: 60_000 });
      expect(await p.locator(`${RESCHED} .msgc.warn`).innerText()).toContain('(614) 555-0100');
      expect(await p.locator(`${RESCHED} [data-ctl="CTL-CUS-06-04"]`).count()).toBe(0);
      expect(jobDate(v.job)).toBe(moved);
    } finally {
      await close(o);
    }
  }, 240_000);

  // why: FR-TEXT-8 a link whose visit has ended shows the ended text and moves nothing; F-808 an office reschedule (API-24) ends the visit's old link before it is used
  it('shows the ended text for a link whose visit the office moved, before it is used', async () => {
    const v = pick[1]!;
    // The customer asks for a new time (R) and the office moves the visit by API-24 before the link is used.
    const reply = await fetch(`${origin}/api/v1/inbox/${v.token}/replies`, { method: 'POST', headers: { origin: APP_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'R' }) });
    expect(reply.status).toBe(201);
    const token = (await until('the reschedule link', () => psql(`SELECT token FROM world.link_token WHERE job_number = ${v.job} AND kind = 'reschedule' AND ended_at IS NULL LIMIT 1`), (t) => t !== '')) as string;
    const job = (await api('keisha', 'GET', `/jobs/${v.job}`)).body.data;
    // The same window a week later: the same weekday, so the day's kind and its windows are the visit's own.
    const nextDay = psql(`SELECT (date '${v.date}' + 7)::text`);
    const windowId = job.job.windowId;
    const moved = await api('keisha', 'POST', `/jobs/${v.job}/schedule`, { date: nextDay, windowId, baseVersion: job.job.version });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(psql(`SELECT ended_at IS NOT NULL FROM world.link_token WHERE token = ${q(token)}`)).toBe('t');
    const o = await openLink(browser, `/r/${token}`);
    try {
      await o.page.waitForSelector(`${RESCHED} .msgc.warn`, { timeout: 60_000 });
      expect(await o.page.locator(`${RESCHED} [data-ctl="CTL-CUS-06-04"]`).count()).toBe(0);
      expect(jobDate(v.job)).toBe(nextDay);
    } finally {
      await close(o);
    }
  }, 240_000);

  // why: FR-TEXT-8 a link whose visit is over (Done) shows the ended text with the office phone and moves nothing (OA-62)
  it('shows the ended text for a link whose visit is Done, and moves nothing', async () => {
    const v = pick[5]!;
    const reply = await fetch(`${origin}/api/v1/inbox/${v.token}/replies`, { method: 'POST', headers: { origin: APP_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'R' }) });
    expect(reply.status).toBe(201);
    const token = (await until('the reschedule link', () => psql(`SELECT token FROM world.link_token WHERE job_number = ${v.job} AND kind = 'reschedule' AND ended_at IS NULL LIMIT 1`), (t) => t !== '')) as string;
    // The visit is marked Done (as the finish leaves it, a status write): the open link must now read as ended.
    // The billing item goes in the same statement: a done job without one is refused (FR-BILL-1); no billing.send event is made, so nothing is sent on.
    psql(`UPDATE world.job SET status = 'done', ended_at = now(), labor_minutes = 65, no_parts_used = true WHERE job_number = ${v.job};
      INSERT INTO world.billing_item (job_number, state, tries) VALUES (${v.job}, 'sending', 0)`);
    expect(psql(`SELECT status FROM world.job WHERE job_number = ${v.job}`)).toBe('done');
    const o = await openLink(browser, `/r/${token}`);
    try {
      await o.page.waitForSelector(`${RESCHED} .msgc.warn`, { timeout: 60_000 });
      expect(await o.page.locator(`${RESCHED} .msgc.warn`).innerText()).toContain('(614) 555-0100');
      expect(await o.page.locator(`${RESCHED} [data-ctl="CTL-CUS-06-04"]`).count()).toBe(0);
      expect(jobDate(v.job)).toBe(v.date);
      expect(psql(`SELECT status FROM world.job WHERE job_number = ${v.job}`)).toBe('done');
    } finally {
      await close(o);
    }
  }, 240_000);

  // why: FR-TEXT-20 an office text sent from SCR-OFC-03 shows in the customer's inbox on SCR-INB-01 as 1 message (UC-17, F-703); FR-TEXT-14 Open text inbox on SCR-OFC-03 and SCR-OFC-06 each opens that customer's SCR-INB-01 in a new tab through API-37 (F-671)
  it('opens from the job page and the customer page in a new tab, and shows an office text as 1 message', async () => {
    const v = pick[2]!;
    const body = `Hello from the office, we will call you this afternoon (${engine}).`;
    // Sent from the text box of SCR-OFC-03 (Text customer, CTL-OFC-03-21; the dialog's Send, CTL-OFC-35-04), not by calling API-143 directly.
    const job = await openStaff(browser, 'keisha', `/office/jobs/${v.job}`);
    try {
      await job.page.waitForSelector('.r1-screen[data-screen="SCR-OFC-03"] [data-ctl="CTL-OFC-03-21"]', { timeout: 60_000 });
      await job.page.locator('.r1-screen[data-screen="SCR-OFC-03"] [data-ctl="CTL-OFC-03-21"]').click();
      await job.page.locator('#bw-tx').fill(body);
      await job.page.locator('[data-ctl="CTL-OFC-35-04"]').click();
      await job.page.locator('#bw-tx').waitFor({ state: 'detached', timeout: 60_000 });
    } finally {
      await close(job);
    }
    await until('the office text delivered', () => psql(`SELECT status FROM world.outbox_text WHERE customer_id = ${q(v.id)} AND kind = 'office' AND body = ${q(body)}`), (s) => s === 'delivered');
    for (const [path, ctl, screen] of [[`/office/jobs/${v.job}`, 'CTL-OFC-03-03', 'SCR-OFC-03'], [`/office/customers/${v.id}`, 'CTL-OFC-06-02', 'SCR-OFC-06']] as const) {
      const o = await openStaff(browser, 'keisha', path);
      try {
        await o.page.waitForSelector(`.r1-screen[data-screen="${screen}"] [data-ctl="${ctl}"]`, { timeout: 60_000 });
        const opened = o.g.context.waitForEvent('page', { timeout: 30_000 });
        await o.page.locator(`.r1-screen[data-screen="${screen}"] [data-ctl="${ctl}"]`).click();
        const tab = await opened;
        await tab.waitForSelector(`${INBOX} [data-ctl="CTL-INB-01-01"]`, { timeout: 60_000 });
        expect(new URL(tab.url()).pathname).toBe(`/inbox/${v.token}`);
        expect(await tab.locator(`${INBOX} [data-ctl="CTL-INB-01-01"] b`).innerText()).toBe(v.name);
        // The office text is 1 message in the thread (the inbox lists what was sent, once).
        await tab.locator(`${INBOX} .bub.in`, { hasText: body }).first().waitFor({ timeout: 60_000 });
        // Counted after a refresh: the thread the server holds, not the page's first draw.
        await tab.reload({ waitUntil: 'load' });
        await tab.locator(`${INBOX} .bub.in`, { hasText: body }).first().waitFor({ timeout: 60_000 });
        expect(await tab.locator(`${INBOX} .bub.in`, { hasText: body }).count()).toBe(1);
      } finally {
        await close(o);
      }
    }
  }, 240_000);

  // why: FR-TEXT-14 the inbox chrome follows the customer's language, with the switch, in both languages; FR-TEXT-13 no reply controls for a customer with no mobile phone
  it('shows the inbox in Spanish, and a customer with no mobile phone has no reply controls', async () => {
    const v = pick[3]!;
    const es = await openLink(browser, `/inbox/${v.token}`, 'es');
    try {
      await es.page.waitForSelector(`${INBOX} [data-ctl="CTL-INB-01-04"]`, { timeout: 60_000 });
      expect(await es.page.locator(`${INBOX} [data-ctl="CTL-INB-01-04"]`).innerText()).toBe('Responder C');
      expect(await es.page.locator(`${INBOX} [data-ctl="CTL-INB-01-10"]`).innerText()).toContain('8 AM');
    } finally {
      await close(es);
    }
    const none = psql(`SELECT json_build_object('id', id, 'token', inbox_token, 'name', name) FROM world.customer WHERE branch_id = 'columbus' AND status = 'active' AND mobile IS NULL ORDER BY name LIMIT 1`);
    const n = JSON.parse(none) as { id: string; token: string; name: string };
    const o = await openLink(browser, `/inbox/${n.token}`);
    try {
      await o.page.waitForSelector(`${INBOX} .imsg`, { timeout: 60_000 });
      expect(await o.page.locator(`${INBOX} [data-ctl="CTL-INB-01-04"]`).count()).toBe(0);
      expect(await o.page.locator(`${INBOX} [data-ctl="CTL-INB-01-07"]`).count()).toBe(0);
      expect(await o.page.locator(`${INBOX} .imsg`).innerText()).toContain(n.name.split(' ')[0]!);
    } finally {
      await close(o);
    }
  }, 180_000);

  // why: FR-TEXT-18 a live map link in a text opens the running server's live map path (the page is P5-LIVEMAP's, kernel method-aware, F-219); FR-TEXT-21 the preview card sits under a live map link, shows the server-drawn picture while the job is On the way (API-164) and the ended words after the office changes the visit; FR-TEXT-4 the same link then ends
  // why: F-968 a text committed after the page's last read, with an id older than the last one read, shows on the open page with no reload; F-969 the open page's card turns to the ended words when the link ends, with no reload
  it('lists a live map link as a path on this server: tapping it navigates to /m/<token> on the same origin', async () => {
    const v = pick[4]!;
    // The job is On the way with a technician and a departure stamp: the link is live (the one rule, liveMapLinkState).
    const demoNow = ((await api('dana', 'GET', '/clock')).body.data.demoNow as string).replace(/\[.*\]$/, ''); // the link is live from the demo clock's On my way, not the real one
    psql(`UPDATE world.job SET status = 'on_the_way', technician_id = (SELECT id FROM world.technician ORDER BY id LIMIT 1), on_the_way_at = ${q(demoNow)}::timestamptz - interval '1 minute' WHERE job_number = ${v.job}`);
    psql(`INSERT INTO world.link_token (token, kind, job_number, created_at) VALUES ('Zk7Qm2X${engine[0]}', 'live_map', ${v.job}, now())`);
    psql(`INSERT INTO world.inbox_message (customer_id, direction, body, at, job_number) VALUES (${q(v.id)}, 'out', 'Brightwater: Maria is on the way! Follow the van: bw.j7l.io/m/Zk7Qm2X${engine[0]} (this link stops working when Maria arrives).', now(), ${v.job})`);
    const o = await openLink(browser, `/inbox/${v.token}`);
    try {
      const p = o.page;
      const link = p.locator(`${INBOX} a[data-ctl="CTL-INB-01-03"]`).last();
      await link.waitFor({ timeout: 60_000 });
      expect(await link.getAttribute('href')).toBe(`/m/Zk7Qm2X${engine[0]}`);
      // The preview card of a live map link shows API-164's picture while the job is On the way.
      const card = p.locator(`${INBOX} [data-ctl="CTL-INB-01-11"]`);
      await card.locator('img.bw-pv').waitFor({ timeout: 60_000 });
      expect(await card.locator('img.bw-pv').getAttribute('alt')).toBeTruthy();
      // The caption names the technician: "<first name> is on the way" (FR-TEXT-21), with the OpenStreetMap credit.
      const techFirst = psql(`SELECT split_part(name, ' ', 1) FROM world.technician WHERE id = (SELECT technician_id FROM world.job WHERE job_number = ${v.job})`);
      expect(techFirst).not.toBe('');
      expect(await card.locator('.pt b').innerText()).toBe(`${techFirst} is on the way`);
      expect(await card.locator('.bw-pt-credit').innerText()).toContain('OpenStreetMap');
      expect(await card.locator('img.bw-pv').evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth > 0)).toBe(true);
      await link.click();
      await p.waitForURL((u) => u.pathname === `/m/Zk7Qm2X${engine[0]}`, { timeout: 30_000 });
      expect(new URL(p.url()).origin).toBe(origin);
      await p.waitForSelector('.r1-screen[data-screen="SCR-CUS-04"]', { timeout: 60_000 });
      // Back on the inbox with its live card: a text committed late (an id older than any the page has read) shows on the open page (F-968).
      await p.goto(`${origin}/inbox/${v.token}`);
      await card.locator('img.bw-pv').waitFor({ timeout: 60_000 });
      const late = `Late committed text ${engine}`;
      psql(`INSERT INTO world.inbox_message (id, customer_id, direction, body, at) VALUES ('00000000-0000-7000-8000-00000000000${engine === 'webkit' ? 'b' : 'a'}', ${q(v.id)}, 'out', ${q(late)}, now())`);
      await p.getByText(late).waitFor({ timeout: 60_000 });
      // The office cancels the visit: the link ends, and the open page's card holds no picture and says so with no reload (F-969); the link page is the ended page.
      psql(`UPDATE world.link_token SET ended_at = now() WHERE token = 'Zk7Qm2X${engine[0]}'`);
      psql(`UPDATE world.job SET status = 'scheduled' WHERE job_number = ${v.job}`);
      await p.locator(`${INBOX} [data-ctl="CTL-INB-01-11"].ended`).waitFor({ timeout: 60_000 });
      expect(await p.locator(`${INBOX} [data-ctl="CTL-INB-01-11"] img`).count()).toBe(0);
      expect(await p.locator(`${INBOX} [data-ctl="CTL-INB-01-11"]`).innerText()).toContain('This link has ended');
      await p.goto(`${origin}/m/Zk7Qm2X${engine[0]}`);
      await p.waitForSelector('.r1-screen[data-screen="SCR-CUS-05"]', { timeout: 60_000 });
    } finally {
      await close(o);
    }
  }, 180_000);
});
