// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-HLTH-1, FR-HLTH-2, FR-HLTH-3, FR-HLTH-4, FR-DISP-12, FR-TEXT-16, FR-AUTH-8, UC-06, F-1156 (P4-HEALTH Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// System health and the alert bell against the Compose stack at its default settings (real PostgreSQL 18, real handlers, the worker and pbs
// running), set up by the setup service (the seeded world), through its proxy, every page opened through the outside-origin guard. UC-06 runs for
// real: the manager sets the text simulator to "All sends fail" on the page, a text is written into the outbox as the booking writes it, and the
// clock is jumped so the worker makes its 5 tries; the 5th failure opens the text_gave_up alert, which raises the bell on an open page. The people
// are ci/health-stack/fixture.sql's sessions. Run by ci/health-stack.sh. The suite shares 1 world and 1 clock: each engine writes its own texts.
import { spawnSync } from 'node:child_process';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_HEALTH_STACK_URL;
const db = process.env.BW_HEALTH_DB_CONTAINER;
const people = { keisha: process.env.BW_HEALTH_KEISHA, dana: process.env.BW_HEALTH_DANA };
if (!base || !db || Object.values(people).some((v) => !v)) throw new Error('BW_HEALTH_STACK_URL, _DB_CONTAINER and the session tokens are not set: run ci/health-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 1100 } };
type Who = keyof typeof people;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner (reads, and the outbox rows a booking would write). */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}

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
const health = async () => (await api('dana', 'GET', '/system/health')).body.data as Json;
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
  await until('the clock to reach the target', async () => (await api('dana', 'GET', '/clock')).body, (b) => !b.data.replay?.running && ms(b.data.demoNow) >= ms(to) - 1_000 && Math.abs(ms(b.meta.demoNow) - ms(b.data.demoNow)) < 1_000, 400);
}

/** Jump the shared clock forward by `minutes`: every due try runs at its own time. */
async function clockForward(minutes: number): Promise<void> {
  const now = (await api('dana', 'GET', '/clock')).body.data.demoNow as string;
  const target = new Date(ms(now) + minutes * 60_000);
  // The wire form: the same local clock in the branch zone (the suite's clock is in America/New_York).
  await jumpTo(`${new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'medium' }).format(target).replace(' ', 'T')}${offsetOf(target)}[America/New_York]`);
}
function offsetOf(d: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName')!.value;
  return part === 'GMT' ? '+00:00' : part.replace('GMT', '');
}

/** The seeded customers who take texts, in the branch zone, not yet used by this suite. */
function customers(n: number, skip = 0): { id: string; name: string }[] {
  const rows = JSON.parse(psql(`SELECT json_agg(c) FROM (SELECT id, name FROM world.customer WHERE branch_id = 'columbus' AND length(name) > 5 AND name !~ '[^A-Za-z .-]' AND texts_on AND mobile IS NOT NULL AND zone = 'America/New_York' ORDER BY name, id OFFSET ${skip} LIMIT ${n}) c`)) as { id: string; name: string }[];
  for (const r of rows) expect(r.name.length).toBeGreaterThan(2);
  return rows;
}

/** A confirmation text due now, as a booking writes it: 1 outbox row and its first try (SPECIFICATIONS 5.2). */
async function sendText(customerId: string): Promise<string> {
  const now = new Date(ms((await api('dana', 'GET', '/clock')).body.data.demoNow)).toISOString();
  const id = psql(`INSERT INTO world.outbox_text (customer_id, kind, language, encoding, body, characters, status, tries, due_at, created_at)
    VALUES ('${customerId}', 'confirmation', 'en', 'gsm7', 'Brightwater: your visit is booked.', 34, 'queued', 0, '${now}', '${now}') RETURNING id`).split('\n')[0]!;
  psql(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('${now}', 'text.try', '${id}', '{"textId":"${id}","number":1}', 'due')`);
  return id;
}
const textStatus = (id: string) => psql(`SELECT status || ',' || tries FROM world.outbox_text WHERE id = '${id}'`);

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

/** streamOpen: this page's event stream has answered 200 (API-09 subscribes the caller to the bus before it answers). */
interface Open { page: Page; g: GuardedContext; streamOpen: Promise<unknown> }
async function open(browser: Browser, who: Who, path: string, lang: 'en' | 'es' = 'en'): Promise<Open> {
  const g = await guardedContext(browser, [origin], DESKTOP);
  await g.context.addCookies([{ name: 'bw_session', value: people[who]!, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  const page = await g.context.newPage();
  // Armed before the page loads: the page opens its stream while it starts. A page closed first rejects it, which no one awaits.
  const streamOpen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/events' && r.status() === 200, { timeout: 60_000 });
  streamOpen.catch(() => undefined);
  await writeOrigin(page);
  await page.goto(origin + path, { waitUntil: 'load' });
  return { page, g, streamOpen };
}
const close = async (o: Open) => o.g.context.close();
const bellName = (p: Page) => p.locator('button[data-ctl="CTL-CMP-07-06"]').getAttribute('aria-label');
const bellCount = async (p: Page) => Number(/(\d+)\s*$/.exec((await bellName(p)) ?? '')?.[1] ?? 0);
/** The count once the first read has landed: the same value on 2 reads 1 s apart. */
async function settledCount(p: Page): Promise<number> {
  let last = await bellCount(p);
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const now = await bellCount(p);
    if (now === last) return now;
    last = now;
  }
  return last;
}
/** The text_gave_up alerts the bell's list holds for the dispatcher (API-43), whatever other alert types the clock jump opened. */
const bellTexts = async () => ((await api('keisha', 'GET', '/alerts?branch=columbus')).body.data.alerts as Json[]).filter((a) => a.type === 'text_gave_up').length;
const settingRow = (p: Page, name: string) => p.locator('[data-ctl="CTL-OFC-16-20"] tbody tr', { hasText: name });

describe.each(engines)('System health and the bell on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    // Texts go out in the day, not in quiet hours: the seeded clock starts at 7:00 AM, so move it to 10:00 AM once.
    const now = (await api('dana', 'GET', '/clock')).body.data.demoNow as string;
    if (Number(now.slice(11, 13)) < 9) {
      await jumpTo(`${now.slice(0, 10)}T10:00:00-04:00[America/New_York]`);
    }
  }, 300_000);
  afterAll(async () => {
    await api('dana', 'PUT', '/system/text-simulator', { mode: 'up' });
    await api('dana', 'PUT', '/system/alert-settings/text_gave_up', { bell: true, managersEmail: false });
    await browser?.close();
  });

  // why: FR-HLTH-1 the page shows the stored records and says plainly that this copy has no backup set up; FR-HLTH-2 it lists the 4 locations from the running copy's settings with the statement
  it('opens for a manager with the checks, the locations from the settings, and no backup on a copy that has none', async () => {
    const o = await open(browser, 'dana', '/office/admin/health');
    const p = o.page;
    await p.waitForSelector('[data-screen="SCR-OFC-16"] [data-ctl="CTL-OFC-16-15"]', { timeout: 60_000 });
    const loc = (await p.locator('[data-ctl="CTL-OFC-16-15"]').innerText()).replace(/\s+/g, ' ');
    expect(loc).toContain('App and database This computer');
    expect(loc).toContain('Backup copies This computer');
    expect(loc).toContain('No customer data leaves the United States.');
    expect(await p.locator('[data-ctl="CTL-OFC-16-13"]').innerText()).toContain('No backup is set up on this copy.');
    expect(await p.locator('[data-ctl="CTL-OFC-16-14"]').innerText()).toContain('No restore test has run yet.');
    expect(await p.locator('[data-ctl="CTL-OFC-16-16"]').count()).toBeGreaterThan(0);
    await close(o);
    // The dispatcher is not a manager: the page is the gate's, and the bell is hers.
    const k = await open(browser, 'keisha', '/office/admin/health');
    expect(await k.page.locator('[data-screen="SCR-OFC-16"]').count()).toBe(0);
    await close(k);
  }, 120_000);

  // why: FR-HLTH-3 after a board change its measured delay appears in the chart, and the typical and slowest values equal an independent computation on the stored measurements
  it('shows the measured delay of a board change, the typical and slowest equal to the stored samples', async () => {
    const dayboard = await open(browser, 'keisha', '/office/board?branch=columbus&date=today');
    // F-1079: the board hears only events sent after its stream is open (missed events are never replayed, D1), so the change waits for
    // the board's first read (client-drawn: it subscribes as it mounts, before that read) and the page's stream answer. The screen root
    // is server HTML and proves neither: a change made before the stream opened left the board with nothing to re-read and no sample.
    await dayboard.page.waitForSelector('[data-screen="SCR-OFC-02"] .tl-row button.job', { timeout: 60_000 });
    await dayboard.streamOpen;
    // A change from another person reaches the open board (EVT-02 board.refresh through the clock): the board re-reads and posts its sample.
    // This board's own post (API-172): the stored samples alone would also pass on the 2nd engine's run from the 1st engine's samples.
    // F-1086: the request event fires when the POST is sent, not when its sample is stored, and 1 re-read can post 1 sample per batched seq: wait for
    // this board's POST to be answered (2xx), then read until 2 health reads in a row equal the SQL values, so a sample landing between the 2 reads cannot split them.
    const posted = dayboard.page.waitForResponse((r) => r.url().endsWith('/api/v1/board-delay-samples') && r.request().method() === 'POST' && r.ok(), { timeout: 60_000 });
    await Promise.all([posted, clockForward(1)]);
    const stored = () => psql(`SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::numeric)::int || ',' || max(ms) FROM system.delay_sample WHERE acked_real > now() - interval '60 minutes'`).split(',').map(Number);
    let agreed = 0;
    const h = await until('2 health reads in a row equal to the stored samples', async () => {
      const d = await health();
      const sql = stored();
      agreed = d.delay.samples.length > 0 && d.delay.typicalMs === sql[0] && d.delay.slowestMs === sql[1] ? agreed + 1 : 0;
      return { d, agreed };
    }, (v) => v.agreed >= 2);
    expect([h.d.delay.typicalMs, h.d.delay.slowestMs]).toEqual(stored());
    await close(dayboard);
    const o = await open(browser, 'dana', '/office/admin/health');
    await o.page.waitForSelector('[data-ctl="CTL-OFC-16-17"]', { timeout: 60_000 });
    expect(await o.page.locator('svg.spark').count()).toBe(1);
    await o.page.locator('[data-ctl="CTL-OFC-16-17"]').click();
    const rows = await o.page.locator('table.bw-delay-table tbody tr').count();
    expect(rows).toBeGreaterThan(0);
    await close(o);
  }, 180_000);

  // why: FR-DISP-12 after UC-06's 5th failure the bell's count rises by 1 on an open page, its list names the customer, and a screen reader name reads the count with the word alerts; FR-TEXT-16 All sends fail makes the next send fail and Simulator up makes it go out
  it('UC-06: All sends fail, the text gives up after 5 tries, the bell rises by 1 and names the customer', async () => {
    const [lee, , mora] = customers(3, engine === 'webkit' ? 6 : 0) as [{ id: string; name: string }, unknown, { id: string; name: string }];
    const o = await open(browser, 'keisha', '/office/board?branch=columbus&date=today');
    const p = o.page;
    await p.waitForSelector('[data-screen="SCR-OFC-02"]', { timeout: 60_000 });
    await until('the bell count', () => bellName(p), (n) => n !== null);
    const before = await settledCount(p);
    expect(await bellName(p)).toMatch(/^Alerts(, \d+)?$/);

    // The manager sets the mode on the page.
    const m = await open(browser, 'dana', '/office/admin/health');
    await m.page.waitForSelector('[data-ctl="CTL-OFC-16-01"]', { timeout: 60_000 });
    await m.page.locator('[data-ctl="CTL-OFC-16-01"] [role="radio"]', { hasText: 'All sends fail' }).click();
    await m.page.locator('button[data-ctl="CTL-OFC-16-02"]').click();
    await m.page.waitForSelector('.bw-toast-host .r1-toast', { timeout: 30_000 });
    expect(await m.page.locator('.bw-toast-host .r1-toast').innerText()).toContain('All sends fail');
    expect((await health()).textSimulator).toMatchObject({ mode: 'all_fail', setBy: 'Dana Ruiz' });
    expect(await m.page.locator('[data-ctl="CTL-OFC-16-05"]').innerText()).toContain('All sends fail');

    // UC-06: the text fails its 5 tries (0, 2, 4, 9 and 19 minutes), then is reported.
    const text = await sendText(lee.id);
    await until('the first try to fail', () => textStatus(text), (s) => s.startsWith('retrying,1'));
    await clockForward(30);
    await until('the 5th failure', () => textStatus(text), (s) => s.startsWith('gave_up,5'));
    // The clock jump also runs the other alert checks, and any other text due in the jump fails too (the mode is All sends fail), so the
    // whole count is held to at least this one, this text to exactly 1 alert (Acceptance: the count rises by 1; F-667), and the label to API-43's length.
    await until(`the bell to rise from ${before}`, () => bellCount(p), (n) => n >= before + 1);
    const listed = (await api('keisha', 'GET', '/alerts?branch=columbus')).body.data.alerts as Json[];
    expect(listed.filter((a) => a.messageValues.textId === text)).toHaveLength(1);
    await until('the label to match API-43', async () => [await bellName(p), `Alerts, ${((await api('keisha', 'GET', '/alerts?branch=columbus')).body.data.alerts as Json[]).length}`], ([shown, want]) => shown === want);
    await p.locator('button[data-ctl="CTL-CMP-07-06"]').click();
    const panel = p.locator('.r1-alerts[role="dialog"]');
    await panel.waitFor({ timeout: 30_000 });
    expect(await panel.innerText()).toContain(lee.name);
    // This text is about no visit (the seed row has no job_number), so it is on no call list: its alert follows the kit frame's words and opens
    // the text log (SCR-OFC-08) at the day the text was written (F-1278 ruling, F-1277, F-1298). A text about a visit keeps "Open the call list".
    const openLink = panel.locator('li', { hasText: lee.name }).locator('a[data-ctl="CTL-OFC-28-02"]').first();
    expect(await openLink.innerText()).toBe('Open the text');
    expect(await openLink.getAttribute('href')).toMatch(/^\/office\/messages\?date=\d{4}-\d\d-\d\d$/);
    await p.keyboard.press('Escape');
    expect(await panel.count()).toBe(0);

    // System health lists the same alert Open, naming the customer, and Check now sets Last check to the demo time.
    await until('the alert on System health', async () => (await m.page.locator('#alerts .al', { hasText: lee.name }).count()), (n) => n >= 1);
    expect(await m.page.locator('#alerts .al', { hasText: lee.name }).locator('.chip').innerText()).toContain('Open');
    const hhmm = (w: string) => { const mm = /T(\d\d):(\d\d)/.exec(w)!; const hh = Number(mm[1]); return `${hh % 12 === 0 ? 12 : hh % 12}:${mm[2]} ${hh < 12 ? 'AM' : 'PM'}`; };
    const t0 = (await api('dana', 'GET', '/clock')).body.data.demoNow as string;
    await m.page.locator('button[data-ctl="CTL-OFC-16-12"]').click();
    // Last check is the demo time of the press: not before it, and the page reads what the record says.
    const last = await until('Last check at the press', async () => (await health()).lastCheck as string, (w) => ms(w) >= ms(t0) - 1_000);
    expect(ms(last)).toBeLessThanOrEqual(ms((await api('dana', 'GET', '/clock')).body.data.demoNow) + 1_000);
    await until('Last check on the page', async () => (await m.page.locator('[data-ctl="CTL-OFC-16-11"] .chk').innerText()), (t) => t === `Last check ${hhmm(last)}`);

    // Simulator up: the next send goes out.
    await m.page.locator('[data-ctl="CTL-OFC-16-01"] [role="radio"]', { hasText: 'Simulator up' }).click();
    await m.page.locator('button[data-ctl="CTL-OFC-16-02"]').click();
    await until('the mode up', async () => (await health()).textSimulator.mode, (v) => v === 'up');
    const ok = await sendText(mora.id);
    await until('the next send to go out', () => textStatus(ok), (s) => s.startsWith('delivered'));
    await close(m);
    await close(o);
  }, 300_000);

  // why: FR-HLTH-4 with that alert type's bell switch off a second UC-06 run leaves the bell count unchanged and the alert is still listed on System health; setting All sends fail changes the next send
  it('the bell switch off: a second UC-06 run leaves the count unchanged and System health still lists the alert', async () => {
    const [a, b] = customers(2, engine === 'webkit' ? 9 : 3);
    const o = await open(browser, 'keisha', '/office/board?branch=columbus&date=today');
    const p = o.page;
    await p.waitForSelector('[data-screen="SCR-OFC-02"]', { timeout: 60_000 });
    const m = await open(browser, 'dana', '/office/admin/health');
    await m.page.waitForSelector('[data-ctl="CTL-OFC-16-20"]', { timeout: 60_000 });
    const row = settingRow(m.page, 'Text could not be sent');
    await row.locator('[data-ctl="CTL-OFC-16-21"]').click();
    await until('the bell switch off', async () => (await health()).alertSettings.find((s: Json) => s.type === 'text_gave_up').bell, (v) => v === false);
    await until('the count to follow the switch', () => bellName(p), (n) => n !== null);
    const before = await bellTexts();
    expect(before).toBe(0);

    await api('dana', 'PUT', '/system/text-simulator', { mode: 'all_fail' });
    const text = await sendText(a!.id);
    await until('the first try to fail', () => textStatus(text), (s) => s.startsWith('retrying,1'));
    await clockForward(30);
    await until('the 5th failure', () => textStatus(text), (s) => s.startsWith('gave_up,5'));
    await until('the alert on System health', async () => (await m.page.locator('#alerts .al', { hasText: a!.name }).count()), (n) => n >= 1);
    expect(await bellTexts()).toBe(before);
    await p.locator('button[data-ctl="CTL-CMP-07-06"]').click();
    await p.locator('.r1-alerts[role="dialog"]').waitFor();
    expect(await p.locator('.r1-alerts').innerText()).not.toContain(a!.name);
    await p.keyboard.press('Escape');

    // Switch it back on: the alert the bell skipped is counted again.
    await row.locator('[data-ctl="CTL-OFC-16-21"]').click();
    await until('the bell switch on', async () => (await health()).alertSettings.find((s: Json) => s.type === 'text_gave_up').bell, (v) => v === true);
    // Every text_gave_up alert of the day is counted again, this run's and the earlier ones the switch had hidden.
    await until('the count with the switch on', () => bellTexts(), (n) => n >= before + 1);

    // With the managers' email switch on, a third failure puts 1 alert email in the manager's on-screen inbox, opened once by the link on the alert.
    await row.locator('[data-ctl="CTL-OFC-16-22"]').click();
    await until('the email switch on', async () => (await health()).alertSettings.find((s: Json) => s.type === 'text_gave_up').managersEmail, (v) => v === true);
    const third = await sendText(b!.id);
    await until('the first try to fail', () => textStatus(third), (s) => s.startsWith('retrying,1'));
    await clockForward(30);
    await until('the 5th failure', () => textStatus(third), (s) => s.startsWith('gave_up,5'));
    const listed = ((await health()).alerts as Json[]).find((x) => x.messageValues.customer === b!.name);
    expect(listed, JSON.stringify(((await health()).alerts as Json[]).slice(0, 3))).toBeTruthy();
    expect(listed.emailed, `emailed ${JSON.stringify(listed)}; emails ${psql("SELECT count(*) FROM world.email_message WHERE kind = 'alert'")}`).toBe(true);
    const alertRow = m.page.locator('#alerts .al', { hasText: b!.name });
    const opener = alertRow.locator('a[data-ctl="CTL-OFC-16-23"]');
    await opener.waitFor({ timeout: 30_000 });
    expect(JSON.stringify((await health()).alerts)).not.toContain('/email/'); // the alerts the health read returns hold no email link (F-660)
    const [mail] = await Promise.all([m.page.waitForEvent('popup'), opener.click()]);
    await mail.waitForSelector('[data-ctl="CTL-EML-01-02"]', { timeout: 30_000 }); // the page's read spends the link; closing at the URL would not
    await mail.close();
    await until('the row to say the email was opened', async () => {
      await m.page.reload();
      await alertRow.waitFor({ timeout: 30_000 });
      return alertRow.locator('.used[data-ctl="CTL-OFC-16-23"]').count();
    }, (n) => n === 1);
    await api('dana', 'PUT', '/system/text-simulator', { mode: 'up' });
    await close(m);
    await close(o);
  }, 360_000);

  // why: FR-HLTH-1 and FR-HLTH-4 the page reads in Spanish, with the alert named in the manager's language
  it('shows System health in Spanish', async () => {
    const o = await open(browser, 'dana', '/office/admin/health', 'es');
    await o.page.waitForSelector('[data-screen="SCR-OFC-16"] [data-ctl="CTL-OFC-16-15"]', { timeout: 60_000 });
    expect(await o.page.locator('h1').innerText()).toBe('Estado del sistema');
    expect(await o.page.locator('[data-ctl="CTL-OFC-16-15"]').innerText()).toContain('Ningún dato de clientes sale de Estados Unidos.');
    expect(await o.page.locator('button[data-ctl="CTL-OFC-16-12"]').innerText()).toBe('Revisar ahora');
    await close(o);
  }, 120_000);

  // why: F-777, FR-DISP-12 the bell on Jobs, Messages, the call list and a job page reads API-43 and shows its count (never a fixed 0): the page asks for it and the name carries API-43's length
  it('reads the bell count on the Jobs, Messages, call list and job pages', async () => {
    const subject = `health-stack-bell-${engine}`;
    const job = psql('SELECT job_number FROM world.job ORDER BY job_number LIMIT 1').trim();
    psql(`INSERT INTO world.alert (type, state, branch_id, at, at_real, subject, message_key, message_values, link_target, emailed)
          VALUES ('billing_waiting_person', 'open', 'columbus', now(), now(), '${subject}', 'alert.billing_waiting_person', '{"count":1}'::jsonb, '/office/billing', false)`);
    try {
      const open1 = ((await api('keisha', 'GET', '/alerts?branch=columbus')).body.data.alerts as Json[]).length;
      expect(open1).toBeGreaterThanOrEqual(1);
      for (const path of ['/office/jobs', '/office/messages', '/office/messages/call-list', `/office/jobs/${job}`]) {
        const o = await open(browser, 'keisha', path);
        try {
          await until(`the bell on ${path} to read API-43's count`, () => bellName(o.page), (v) => v === `Alerts, ${open1}`);
          const reads = await o.page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/alerts(\?|$)/.test(e.name)).length);
          expect(reads, `${path}: API-43 reads`).toBeGreaterThanOrEqual(1);
        } finally {
          await close(o);
        }
      }
    } finally {
      psql(`DELETE FROM world.alert WHERE subject = '${subject}'`);
    }
  }, 240_000);

  // why: F-1156, SD-30, FR-DISP-12 an alert dismissed in 1 tab shows Resolved with no Dismiss in a second open tab, in its bell and on its System health page, with no reload
  it('clears a dismissed alert in a second open tab with no reload: the bell and System health re-read on alert.dismissed', async () => {
    await api('dana', 'PUT', '/system/alert-settings/text_gave_up', { bell: true, managersEmail: false });
    const [who] = customers(1, engine === 'webkit' ? 13 : 12) as [{ id: string; name: string }];
    // An office text about no visit that gave up (the dismissible kind, SD-30); the alert check opens its alert as the outbox would.
    const now = new Date(ms((await api('dana', 'GET', '/clock')).body.data.demoNow)).toISOString();
    const textId = psql(`INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at)
      VALUES ('${who.id}', NULL, 'office', 'en', 'gsm7', 'Brightwater: a note from the office.', 36, 'gave_up', 5, '${now}', '${now}') RETURNING id`).split('\n')[0]!;
    expect((await api('dana', 'POST', '/system/checks', {})).status).toBe(200);
    await until('the dismissible alert', async () => ((await api('keisha', 'GET', '/alerts?branch=columbus')).body.data.alerts as Json[]).find((a) => a.messageValues?.textId === textId), (a) => a?.dismissible === true);

    // Tab 1: the dispatcher's board with the bell open. Tab 2: the manager's System health page with its bell open too.
    const one = await open(browser, 'keisha', '/office/board?branch=columbus&date=today');
    const two = await open(browser, 'dana', '/office/admin/health');
    try {
      await one.page.waitForSelector('[data-screen="SCR-OFC-02"]', { timeout: 60_000 });
      await two.page.waitForSelector('[data-ctl="CTL-OFC-16-01"]', { timeout: 60_000 });
      await Promise.all([one.streamOpen, two.streamOpen]);
      // A reload would drop this mark.
      await two.page.evaluate(() => { (globalThis as unknown as { f1156: number }).f1156 = 1; });
      const row2 = two.page.locator('#alerts .al', { hasText: who.name });
      await until('the alert on tab 2 System health', () => row2.count(), (n) => n === 1);
      expect(await row2.locator('button[data-ctl="CTL-OFC-16-28"]').count()).toBe(1);
      const bellItem = async (o: Open) => {
        await o.page.locator('button[data-ctl="CTL-CMP-07-06"]').click();
        const item = o.page.locator('.r1-alerts[role="dialog"] li', { hasText: who.name });
        await item.waitFor({ timeout: 30_000 });
        return item;
      };
      const item1 = await bellItem(one);
      const item2 = await bellItem(two);
      expect(await item2.locator('button[data-ctl="CTL-OFC-28-05"]').count()).toBe(1);

      // Dismiss in tab 1.
      await item1.locator('button[data-ctl="CTL-OFC-28-05"]').click();
      await until('the alert resolved', async () => ((await api('keisha', 'GET', '/alerts?branch=columbus')).body.data.alerts as Json[]).find((a) => a.messageValues?.textId === textId)?.state, (v) => v === 'resolved');

      // Tab 2, with no reload: its bell list and its System health row show Resolved and no Dismiss. F-1810: the System health row is read first and the bell second. Both must show Resolved with no reload and f1156 must be 1; the old order cannot be shown red (plants.log), so this guarantees the end state, not that each half fails on its own.
      await until('tab 2 System health to show Resolved', async () => [await row2.locator('button[data-ctl="CTL-OFC-16-28"]').count(), await row2.locator('.chip').innerText()], ([n, text]) => n === 0 && String(text).includes('Resolved'), 40);
      await until('tab 2 bell to show Resolved', async () => [await item2.locator('button[data-ctl="CTL-OFC-28-05"]').count(), await item2.innerText()], ([n, text]) => n === 0 && String(text).includes('Resolved'), 40);
      expect(await two.page.evaluate(() => (globalThis as unknown as { f1156?: number }).f1156)).toBe(1);
    } finally {
      await close(one);
      await close(two);
    }
  }, 180_000);
});
