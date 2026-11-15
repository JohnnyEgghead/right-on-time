// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-8, FR-DISP-28, FR-DISP-29, FR-DISP-32, UC-16 (P4-NEWJOB Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The new job page (SCR-OFC-04) against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running, the
// worker delivering texts), set up by the setup service (the seeded world), through its proxy, every page opened through the outside-origin
// guard. The people are ci/job-stack/fixture.sql's sessions. Run by ci/job-stack.sh after the job page suite (the same stack, no second
// bring-up). The suite shares 1 world: each engine makes its own customers and jobs. The demo clock is set by SQL for the Sep 14 case
// (the world starts at Sep 15, 7:00 AM and the clock API only moves forward) and put back after.
//   FR-DISP-8: at 5:01 PM on Sep 14, after online booking closed, the office creates a Sep 15 job.
//   UC-16 and FR-DISP-29: the office makes a customer from the page (a listed Columbus street, Spanish texts), takes the top suggested
//   technician, and the confirmation reaches the customer's inbox in Spanish.
//   FR-DISP-28: the technicians are listed in SD-26's order, each with its skill, minutes and load as API-30 answers; one who lacks
//   the skill is Not suggested with the reason; No technician yet makes an Unassigned job.
//   F-671: an office reschedule through API-24 delivers a new confirmation for the new day and window.
//   FR-DISP-32: "Comfort Club member" on the job page, the customer page, customer search, and this page's results.
//   F-798: the page Schedule opens reads Jobs / Job <n>, and any other way to that page keeps the Board trail.
//   F-799: a confirmation held to 8:00 AM reaches the inbox only when it is still true: canceled, moved, moved twice.
//   F-801: each window prints the technicians with the skill and room that API-30 lists.
//   F-802: the live list of days scrolls in its own box and the windows stay beside the pick.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Browser, Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_JOB_STACK_URL;
const db = process.env.BW_JOB_DB_CONTAINER;
const worker = process.env.BW_JOB_WORKER_CONTAINER;
const people = { keisha: process.env.BW_JOB_KEISHA, dana: process.env.BW_JOB_DANA };
if (!base || !db || !worker || Object.values(people).some((v) => !v)) {
  throw new Error('BW_JOB_STACK_URL, _DB_CONTAINER, _WORKER_CONTAINER and the session tokens are not set: run ci/job-stack.sh');
}
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const SCREEN = '.r1-screen[data-screen="SCR-OFC-04"]';
type Lang = 'en' | 'es';
const CATALOG = {
  en: JSON.parse(readFileSync('packages/i18n/catalog/en.json', 'utf8')) as Record<string, string>,
  es: JSON.parse(readFileSync('packages/i18n/catalog/es.json', 'utf8')) as Record<string, string>,
};
const msg = (key: string, values: Record<string, string | number> = {}, lang: Lang = 'en') => (CATALOG[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner. */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ms = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { cookie: `bw_session=${token}`, ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const api = (who: keyof typeof people, method: string, path: string, body?: unknown) => call(people[who]!, method, path, body);

/** Writes this suite's resend could not deliver, kept for the failure message: 1 of them would read as a slow page (F-810). */
const lostWrites: string[] = [];
/** The page's API writes carry the default origin: Playwright resends them itself (a browser will not let a route set Origin). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch (e) {
      // F-810: the page may be gone, or the resend failed. Either way the request gets an answer, so it can never hang with no trace.
      if (!p.isClosed()) lostWrites.push(`${new URL(r.request().url()).pathname}: ${(e as Error).message.slice(0, 160)}`);
      await r.abort('failed').catch(() => undefined);
    }
  });
}
interface Open { page: Page; g: GuardedContext }
async function open(browser: Browser, path: string, ready: string, lang: Lang = 'en'): Promise<Open> {
  const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 1100 } });
  await g.context.addCookies([{ name: 'bw_session', value: people.keisha!, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  const page = await g.context.newPage();
  await writeOrigin(page);
  const res = await page.goto(origin + path, { waitUntil: 'load' });
  expect(res?.status()).toBe(200);
  await page.waitForSelector(ready, { timeout: 60_000 });
  return { page, g };
}
/** What the page showed when a wait ran out, and any write that was lost, so a red says what happened instead of reading as load (F-810). */
async function shown(p: Page): Promise<string> {
  const text = await p.locator('main, body').first().innerText({ timeout: 2_000 }).catch(() => 'unreadable');
  return `\n  the page at ${p.url()} showed: ${text.replace(/\s+/g, ' ').slice(0, 400)}\n  writes lost: ${lostWrites.join('; ') || 'none'}`;
}
/** Runs a wait; when it runs out, its message gains what the page showed. */
const telling = async <T>(loc: Locator, wait: () => Promise<T>): Promise<T> => {
  try {
    return await wait();
  } catch (e) {
    (e as Error).message += await shown(loc.page());
    throw e;
  }
};
/** The text now, or nothing: each read waits 1 s, so a poll tries many times in its window instead of once (F-810). */
const textNow = (loc: Locator) => loc.first().innerText({ timeout: 1_000 }).catch(() => '');
/** Waits for what a locator shows (the matchers of Playwright's own runner are not this runner's): polls up to 30 s. */
const see = (loc: Locator) => ({
  containsText: (text: string) => telling(loc, () => expect.poll(() => textNow(loc), { timeout: 30_000 }).toContain(text)),
  hasText: (text: string) => telling(loc, () => expect.poll(async () => (await textNow(loc)).trim(), { timeout: 30_000 }).toBe(text)),
  count: (n: number) => telling(loc, () => expect.poll(() => loc.count(), { timeout: 30_000 }).toBe(n)),
  visible: () => telling(loc, () => loc.first().waitFor({ state: 'visible', timeout: 30_000 })),
});
const close = (o: Open) => o.g.context.close();

/** SD-26 over the facts of API-30's own answer, computed here and not by the handler (the independent function). */
function sd26(list: Json[], need: string): string[] {
  const match = (t: Json) => (t.skills[0] === need ? 0 : t.skills.includes(need) ? 1 : 2);
  const ratio = (t: Json) => (t.load.capacity > 0 ? t.load.jobs / t.load.capacity : 1);
  const group = (t: Json) => (match(t) === 2 ? 2 : t.room ? 0 : 1);
  return [...list].sort((a, b) => group(a) - group(b) || match(a) - match(b) || a.minutesFromStopBefore - b.minutesFromStopBefore || ratio(a) - ratio(b)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1)).map((t) => t.id);
}

const dayText = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const hour12 = (h: number, m = 0) => `${h % 12 === 0 ? 12 : h % 12}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`}`;
/** "8-10 AM", "12-2 PM", "10 AM-12 PM" from a window's wire times (windowText of apps/web/src/customers/model.ts). */
function windowLabel(start: string, end: string): string {
  const p = (w: string) => ({ h: Number(/T(\d\d):/.exec(w)![1]), m: Number(/T\d\d:(\d\d)/.exec(w)![1]) });
  const a = p(start);
  const b = p(end);
  const ap = (h: number) => (h < 12 ? 'AM' : 'PM');
  return `${hour12(a.h, a.m)}${ap(a.h) === ap(b.h) ? '' : ` ${ap(a.h)}`}-${hour12(b.h, b.m)} ${ap(b.h)}`;
}

/** An open day and window of a service, from API-29 (office channel) from `from` on: the first with room. */
async function firstRoom(serviceId: string, from: string, to = '2026-12-31'): Promise<{ date: string; windowId: string; label: string; days: Json[] }> {
  const days = (await api('keisha', 'GET', `/availability?branch=columbus&serviceId=${serviceId}&from=${from}&to=${to}&channel=office`)).body.data.days as Json[];
  for (const d of days) {
    const w = d.state === 'open' ? (d.windows as Json[]).find((x) => x.state === 'open' && x.left > 0) : undefined;
    if (w) return { date: d.date, windowId: w.windowId, label: windowLabel(w.start, w.end), days };
  }
  throw new Error(`no open window for ${serviceId} from ${from}`);
}

const confirmations = (n: number) => psql(`SELECT id || '|' || status || '|' || language || '|' || body FROM world.outbox_text WHERE job_number = ${n} AND kind = 'confirmation' ORDER BY created_at, id`)
  .split('\n').filter(Boolean).map((l) => { const [id, status, language, ...b] = l.split('|'); return { id: id!, status: status!, language: language!, body: b.join('|') }; });
const inboxBodies = (textId: string) => psql(`SELECT body FROM world.inbox_message WHERE text_id = '${textId}'`).split('\n').filter(Boolean);
const jobRow = (n: number) => JSON.parse(psql(`SELECT json_build_object('date', date::text, 'technician', technician_id, 'via', booked_via, 'status', status, 'customer', customer_id, 'service', service_id,
  'bookedAt', to_char(booked_at AT TIME ZONE zone, 'YYYY-MM-DD HH24:MI'), 'window', to_char(window_start AT TIME ZONE zone, 'HH24:MI')) FROM world.job WHERE job_number = ${n}`)) as Json;
/** The job goes back off the day, so the other engine's run finds the same room. */
const cancelJob = async (n: number) => {
  const version = psql(`SELECT version FROM world.job WHERE job_number = ${n}`);
  const r = await api('keisha', 'POST', `/jobs/${n}/cancellation`, { baseVersion: Number(version) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
/** The trail's words, the page's own line breaks and the slash's spaces as 1 space. */
const trail = async (loc: Locator) => (await loc.innerText()).replace(/\s+/g, ' ').trim();
const JOB_SCREEN = '.r1-screen[data-screen="SCR-OFC-03"]';

let clockSaved = '';
beforeAll(async () => {
  clockSaved = psql(`SELECT json_build_object('demo', demo_anchor, 'real', real_anchor, 'rate', rate, 'paused', paused) FROM system.demo_clock WHERE id = 1`);
});
afterAll(() => {
  // The clock goes back as the job page suite left it, so a later suite on the stack reads the time it expects.
  if (!clockSaved) return;
  const c = JSON.parse(clockSaved) as Json;
  psql(`UPDATE system.demo_clock SET demo_anchor = ${q(c.demo)}, real_anchor = ${q(c.real)}, rate = ${c.rate}, paused = ${c.paused} WHERE id = 1`);
});

/** The demo clock to a demo time, held there (SQL: the clock API moves forward only), read back through API-10. */
async function holdClockAt(iso: string): Promise<void> {
  psql(`UPDATE system.demo_clock SET demo_anchor = ${q(iso)}, real_anchor = now(), paused = true WHERE id = 1`);
  const deadline = performance.now() + 30_000;
  for (;;) {
    const now = (await api('dana', 'GET', '/clock')).body.data;
    if (Math.abs(ms(now.demoNow) - Date.parse(iso)) < 1_000) return;
    if (performance.now() > deadline) throw new Error(`the clock did not read ${iso}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
async function until<T>(what: string, read: () => T | Promise<T>, ok: (v: T) => boolean, timeout = 90_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (performance.now() > deadline) throw new Error(`${what}: not within ${timeout / 1000} s (last: ${JSON.stringify(v)})`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

describe.each(engines)('the new job page on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    // The worker delivers the confirmations: it runs (the job page suite starts it again after its own stop).
    spawnSync('docker', ['start', worker!], { encoding: 'utf8' });
  });
  afterAll(async () => {
    await browser?.close();
  });
  const harold = () => psql(`SELECT id FROM world.customer WHERE name = 'Harold Jenkins' AND branch_id = 'columbus' LIMIT 1`);

  // why: FR-DISP-8 (at 5:01 PM on Sep 14, after online booking closed, the office creates a Sep 15 job and its booked_at reads 5:01 PM; the date the board sent is picked)
  it('creates a Sep 15 job at 5:01 PM on Sep 14, with the day the link named already picked', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    const id = harold();
    psql(`UPDATE world.customer SET mobile = '+16145550148', texts_on = true, text_language = 'en' WHERE id = '${id}'`);
    const room = await firstRoom('furnace_tune_up', '2026-09-15', '2026-09-15');
    expect(room.date).toBe('2026-09-15');
    const o = await open(browser, `/office/jobs/new?customer=${id}&date=2026-09-15`, `${SCREEN} .cust`);
    try {
      const p = o.page;
      // The picked customer's line is API-35's: the address, the mobile and the language of the texts (CTL-OFC-04-13).
      const detail = (await api('keisha', 'GET', `/customers/${id}`)).body.data as Json;
      const line = await p.locator(`${SCREEN} .cust .d`).innerText();
      expect(line).toContain(`${detail.address.houseNumber} ${detail.address.street}, ${detail.address.city}, OH ${detail.address.zip}`);
      expect(line).toContain('(614) 555-0148');
      expect(line).toContain('texts in English');
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.furnace_tune_up.screen') }).click();
      await see(p.locator(`${SCREEN} .days [role="radio"][aria-checked="true"]`)).containsText(dayText('2026-09-15'));
      await p.locator(`${SCREEN} .wins [data-window-id="${room.windowId}"]`).click();
      // No technician yet is the standing pick until another is taken (the summary says so below).
      await see(p.locator(`${SCREEN} .sug .tc.no`)).containsText(msg('newjob.tech.picked'));
      const sum = await p.locator(`${SCREEN} [data-ctl="CTL-OFC-04-18"]`).innerText();
      expect(sum).toContain('Furnace tune-up visit for Harold Jenkins');
      expect(sum).toContain(`${dayText('2026-09-15')}, arrival ${room.label}, with no technician yet`);
      await p.locator(`${SCREEN} button[data-ctl="CTL-OFC-04-09"]`).click();
      await p.waitForURL(/\/office\/jobs\/\d+$/, { timeout: 60_000 });
      const n = Number(new URL(p.url()).pathname.split('/').pop());
      // The job was written at that moment: 5:01 PM on Sep 14 in the branch's zone, after online booking closed for Sep 15.
      expect(jobRow(n)).toMatchObject({ date: '2026-09-15', via: 'office', status: 'scheduled', technician: null, bookedAt: '2026-09-14 17:01' });
      // CMP-11 on the job page that opened states the server's answer about the confirmation text (GAP-10).
      await see(p.locator('.r1-toast').last()).containsText(msg('newjob.done.sent', { n, name: 'Harold' }));
      expect(confirmations(n)).toHaveLength(1);
    } finally {
      await close(o);
    }
  });

  // why: UC-16, FR-DISP-28, FR-DISP-29 (the office makes the customer from this page, takes the top suggested technician in SD-26's order with the skill and facts API-30 answers, and a Spanish confirmation reaches the customer's inbox)
  it('makes a customer from the page, takes the top suggestion, and the Spanish confirmation reaches the inbox', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    // A street name no other branch has, so the street the dialog lists is the Columbus one. F-917: 1 grouped pass over the 42,834 streets;
    // the correlated count it replaces ran 64.8 s on a Mac, and psql blocks this process's event loop (spawnSync) for that long, past the
    // proxy's 65 s keep-alive: the next API call then went out on a connection nginx had closed ("other side closed" in 19 ms, WebKit nightly).
    const street = psql(`SELECT name FROM world.street GROUP BY name HAVING count(*) = 1 AND bool_and(branch_id = 'columbus') ORDER BY name LIMIT 1`);
    const name = `Lucia Moreno ${engine}`;
    const room = await firstRoom('furnace_tune_up', '2026-10-01');
    const o = await open(browser, '/office/jobs/new', `${SCREEN} input.bw-nj-find`);
    try {
      const p = o.page;
      // The page is hydrated once its services have loaded (the server draws their skeleton).
      await p.waitForSelector(`${SCREEN} .svcs [role="radio"]`, { timeout: 60_000 });
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-04-11"]`).click();
      const dlg = p.locator('.r1-dlg[data-screen="SCR-OFC-38"]');
      await dlg.waitFor();
      await dlg.locator('#cu-name-new').fill(name);
      await dlg.locator('#cu-mobile-new').fill('(614) 555-0172');
      await dlg.locator('#cu-lang-new').selectOption('es');
      await dlg.locator('#cu-street-new').fill(street.slice(0, 4));
      await dlg.locator('.ddl [role="option"]', { hasText: street }).first().click();
      await dlg.locator('#cu-house-new').fill('2310');
      await dlg.locator('button[data-ctl="CTL-OFC-38-08"]').click();
      // The customer it saves is picked here: the page stays, its customer card names them.
      await see(p.locator(`${SCREEN} .cust .nm`)).containsText(name);
      expect(new URL(p.url()).pathname).toBe('/office/jobs/new');
      const id = psql(`SELECT id FROM world.customer WHERE name = ${q(name)}`);
      const detail = (await api('keisha', 'GET', `/customers/${id}`)).body.data as Json;
      expect(detail).toMatchObject({ branch: 'columbus', language: 'es', source: 'office' });
      expect(await p.locator(`${SCREEN} .cust .d`).innerText()).toContain('texts in Spanish');
      // The notice says what the customer gets, in the customer's text language (CTL-OFC-04-19).
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.furnace_tune_up.screen') }).click();
      await p.locator(`${SCREEN} .days [data-date="${room.date}"]`).click();
      await p.locator(`${SCREEN} .wins [data-window-id="${room.windowId}"]`).click();
      await see(p.locator(`${SCREEN} [data-ctl="CTL-OFC-04-19"]`)).containsText(msg('newjob.notice.texts', { name: 'Lucia', language: 'Spanish' }));
      // API-30's answer for this customer, day and window: the page lists exactly its technicians with room, in SD-26's order.
      const suggest = (await api('keisha', 'GET', `/technicians/room?branch=columbus&date=${room.date}&windowId=${room.windowId}&serviceId=furnace_tune_up&customerId=${id}`)).body.data as Json;
      const list = suggest.technicians as Json[];
      expect(list.map((t) => t.id)).toEqual(sd26(list, suggest.serviceSkill));
      const shown = list.filter((t) => t.room);
      const cards = p.locator(`${SCREEN} .sug .tc:not(.no)`);
      await see(cards).count(shown.length);
      for (let i = 0; i < shown.length; i++) {
        const t = shown[i]!;
        const text = await cards.nth(i).innerText();
        expect(text).toContain(t.name);
        // Each row shows the technician's skill (FR-DISP-28), under the name.
        expect(await cards.nth(i).locator('.nm small').innerText()).toContain(msg(`skill.${t.skills[0]}`));
        if (t.suggested) {
          expect(text).toContain(`${t.minutesFromStopBefore} min`);
          expect(text).toContain(msg('newjob.tech.loadOf', { jobs: t.load.jobs, capacity: t.load.capacity }));
          expect(text).toContain(t.stopBefore ? t.stopBefore.area : 'the branch');
        } else {
          expect(text).toContain(msg('newjob.tech.notSuggested'));
        }
      }
      const top = list.find((t) => t.room && t.suggested)!;
      await cards.first().locator('.btn.pick').click();
      await p.locator(`${SCREEN} button[data-ctl="CTL-OFC-04-09"]`).click();
      await p.waitForURL(/\/office\/jobs\/\d+$/, { timeout: 60_000 });
      const n = Number(new URL(p.url()).pathname.split('/').pop());
      expect(jobRow(n)).toMatchObject({ date: room.date, via: 'office', technician: top.id, customer: id });
      await see(p.locator('.r1-toast').last()).containsText(msg('newjob.done.sent', { n, name: 'Lucia' }, 'en'));
      const conf = confirmations(n);
      expect(conf).toHaveLength(1);
      expect(conf[0]).toMatchObject({ language: 'es' });
      expect(conf[0]!.body).toContain('Cita reservada');
      // The worker delivers it and it lands in the customer's inbox (the same Spanish words).
      await until('the confirmation delivered', () => confirmations(n)[0]!.status, (s) => s === 'delivered');
      expect(inboxBodies(conf[0]!.id)).toEqual([conf[0]!.body]);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-28 (a technician with room who lacks the service's skill is Not suggested with the reason; saving with No technician yet makes an Unassigned job; Cancel asks before leaving)
  it('lists a technician without the skill as Not suggested with the reason, and saves with no technician as an Unassigned job', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    const id = harold();
    // The first service and window where a technician with room lacks the skill (the seeded technicians' skills differ).
    let pick: { service: string; room: Awaited<ReturnType<typeof firstRoom>>; unskilled: Json } | null = null;
    for (const service of ['plumbing_repair', 'furnace_tune_up', 'ac_tune_up', 'water_heater']) {
      const room = await firstRoom(service, '2026-10-05');
      const s = (await api('keisha', 'GET', `/technicians/room?branch=columbus&date=${room.date}&windowId=${room.windowId}&serviceId=${service}&customerId=${id}`)).body.data as Json;
      const unskilled = (s.technicians as Json[]).find((t) => t.room && !t.suggested);
      if (unskilled) {
        pick = { service, room, unskilled: { ...unskilled, serviceSkill: s.serviceSkill, order: (s.technicians as Json[]).filter((t) => t.room).map((t) => t.name) } };
        break;
      }
    }
    expect(pick, 'no service has a technician with room and without the skill').not.toBeNull();
    const { service, room, unskilled } = pick!;
    const o = await open(browser, `/office/jobs/new?customer=${id}`, `${SCREEN} .cust`);
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg(`service.${service}.screen`) }).click();
      await p.locator(`${SCREEN} .days [data-date="${room.date}"]`).click();
      await p.locator(`${SCREEN} .wins [data-window-id="${room.windowId}"]`).click();
      const row = p.locator(`${SCREEN} .sug .tc`, { hasText: unskilled.name });
      await see(row).count(1);
      await see(row).containsText(msg('newjob.tech.notSuggested'));
      await see(row).containsText(msg('newjob.tech.noSkill', { skill: msg(`newjob.skill.${unskilled.serviceSkill}`) }));
      // It is listed after every suggested technician.
      const names = await p.locator(`${SCREEN} .sug .tc:not(.no) .nm`).evaluateAll((els) => els.map((e) => (e.firstChild?.textContent ?? '').trim()));
      expect(names).toEqual(unskilled.order);
      // Cancel asks before leaving a page that holds input; Keep editing keeps every pick.
      await p.locator(`${SCREEN} .jh .acts [data-ctl="CTL-OFC-04-10"]`).click();
      await see(p.getByRole('dialog', { name: msg('newjob.leave.title') })).visible();
      await p.getByRole('button', { name: msg('newjob.leave.stay') }).click();
      await see(p.locator(`${SCREEN} .wins [role="radio"][aria-checked="true"]`)).visible();
      // Take a technician, then No technician yet: the job still saves as Unassigned.
      await p.locator(`${SCREEN} .sug .tc:not(.no) .btn.pick`).first().click();
      await p.locator(`${SCREEN} .sug .tc.no .btn.pick`).click();
      await p.locator(`${SCREEN} button[data-ctl="CTL-OFC-04-09"]`).click();
      await p.waitForURL(/\/office\/jobs\/\d+$/, { timeout: 60_000 });
      const n = Number(new URL(p.url()).pathname.split('/').pop());
      expect(jobRow(n)).toMatchObject({ technician: null, date: room.date });
      const board = (await api('keisha', 'GET', `/board?branch=columbus&date=${room.date}`)).body.data as Json;
      expect((board.unassigned as Json[]).map((j) => j.jobNumber)).toContain(n);
    } finally {
      await close(o);
    }
  });

  // why: F-671 (an office reschedule through API-24 delivers a new confirmation for the new day and window: SD-45)
  it('delivers a new confirmation for the new day and window when the office reschedules through API-24', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    const id = harold();
    psql(`UPDATE world.customer SET mobile = '+16145550148', texts_on = true, text_language = 'en' WHERE id = '${id}'`);
    const first = await firstRoom('furnace_tune_up', '2026-10-06');
    const made = await api('keisha', 'POST', '/jobs', { customerId: id, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: first.date, windowId: first.windowId, technicianId: null });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.data.confirmationText).toMatchObject({ status: expect.stringMatching(/^(queued|held)$/) });
    const n = made.body.data.job.jobNumber as number;
    // The first is delivered before the move, as the office's own day goes: one still unsent ends canceled instead (F-799, the case below).
    await until('the first confirmation delivered', () => confirmations(n), (r) => r.length === 1 && r[0]!.status === 'delivered');
    const later = (first.days as Json[]).find((d) => d.date > first.date && d.state === 'open' && d.windows.some((w: Json) => w.state === 'open' && w.left > 0))!;
    const w = later.windows.find((x: Json) => x.state === 'open' && x.left > 0) as Json;
    const moved = await api('keisha', 'POST', `/jobs/${n}/schedule`, { date: later.date, windowId: w.windowId, baseVersion: made.body.data.job.version });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data.outcome.textSent).toBe(true);
    const rows = await until('both confirmations delivered', () => confirmations(n), (r) => r.length === 2 && r.every((x) => x.status === 'delivered'));
    expect(rows[1]!.body).toContain(dayText(later.date).replace(/^\w+, /, ''));
    expect(rows[1]!.body).toContain(windowLabel(w.start, w.end));
    expect(rows[1]!.body).not.toBe(rows[0]!.body);
    expect(inboxBodies(rows[1]!.id)).toEqual([rows[1]!.body]);
  });

  // why: FR-DISP-32 (a seeded member shows "Comfort Club member" on the job page, the customer page, customer search and this page's results; a customer with no membership does not)
  it('shows a member as Comfort Club on the job page, the customer page, customer search and the new job page\'s results', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    const member = psql(`SELECT c.id || '|' || c.name FROM world.membership m JOIN world.customer c ON c.id = m.customer_id
      WHERE c.branch_id = 'columbus' AND c.status = 'active' AND c.name ~ '^[A-Z][a-z]+ [A-Z][a-z]+$' ORDER BY c.name LIMIT 1`).split('|');
    const [id, name] = [member[0]!, member[1]!];
    const room = await firstRoom('furnace_tune_up', '2026-10-07');
    const made = await api('keisha', 'POST', '/jobs', { customerId: id, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: room.date, windowId: room.windowId, technicianId: null });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const n = made.body.data.job.jobNumber as number;
    const none = psql(`SELECT c.name FROM world.customer c WHERE c.branch_id = 'columbus' AND c.status = 'active' AND c.name ~ '^[A-Z][a-z]+ [A-Z][a-z]+$'
      AND NOT EXISTS (SELECT 1 FROM world.membership m WHERE m.customer_id = c.id) ORDER BY c.name LIMIT 1`);
    // SCR-OFC-03: CTL-OFC-03-10.
    let o = await open(browser, `/office/jobs/${n}`, '.r1-screen[data-screen="SCR-OFC-03"] .jh h1');
    try {
      await see(o.page.locator('[data-ctl="CTL-OFC-03-10"]')).containsText('Comfort Club member');
    } finally {
      await close(o);
    }
    // SCR-OFC-06: the plan chip under the name.
    o = await open(browser, `/office/customers/${id}`, '.r1-screen[data-screen="SCR-OFC-06"] .chip.club');
    try {
      await see(o.page.locator('[data-ctl="CTL-OFC-06-24"]').first()).containsText('Comfort Club member');
    } finally {
      await close(o);
    }
    // SCR-OFC-05: the row's plan, the words of FR-DISP-32 and CTL-OFC-05-03 (DK-90 draws "Comfort Club"; REQUIREMENTS wins, F-797); a customer with none reads "None".
    o = await open(browser, '/office/customers', '.r1-screen[data-screen="SCR-OFC-05"] input.bw-cu-q');
    try {
      await o.page.fill('.r1-screen[data-screen="SCR-OFC-05"] input.bw-cu-q', name);
      const row = o.page.locator('.r1-screen[data-screen="SCR-OFC-05"] table[data-ctl="CTL-OFC-05-03"] tbody tr', { hasText: name }).first();
      await see(row.locator('.chip.club')).hasText('Comfort Club member');
      await o.page.fill('.r1-screen[data-screen="SCR-OFC-05"] input.bw-cu-q', none);
      await see(o.page.locator('.r1-screen[data-screen="SCR-OFC-05"] table[data-ctl="CTL-OFC-05-03"] tbody tr', { hasText: none }).first()).containsText('None');
    } finally {
      await close(o);
    }
    // SCR-OFC-04: the results list of the customer search (CTL-OFC-04-01).
    o = await open(browser, '/office/jobs/new', `${SCREEN} input.bw-nj-find`);
    try {
      // F-917: the page is hydrated once its services have loaded (the server draws the search box before that), as the other cases wait.
      await o.page.waitForSelector(`${SCREEN} .svcs [role="radio"]`, { timeout: 60_000 });
      await o.page.fill(`${SCREEN} input.bw-nj-find`, name);
      const hit = o.page.locator(`${SCREEN} .bw-nj-hits .cust.hit`, { hasText: name }).first();
      await see(hit).containsText('Comfort Club member');
      await o.page.fill(`${SCREEN} input.bw-nj-find`, none);
      const other = o.page.locator(`${SCREEN} .bw-nj-hits .cust.hit`, { hasText: none }).first();
      await see(other).visible();
      expect(await other.locator('.chip.club').count()).toBe(0);
      // The query stays out of the address bar (NFR-05).
      expect(o.page.url()).not.toContain(encodeURIComponent(none));
      await hit.waitFor({ state: 'detached' });
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-8 (the office creates a water heater visit for Harold Jenkins on Thu, Sep 17, 12-2 PM with Kevin Doyle)
  it('creates the water heater visit for Harold Jenkins on Thu, Sep 17, 12-2 PM with Kevin Doyle', async () => {
    await holdClockAt('2026-09-15T09:00:00-04:00');
    const id = harold();
    const day = (await api('keisha', 'GET', '/availability?branch=columbus&serviceId=water_heater&from=2026-09-17&to=2026-09-17&channel=office')).body.data.days[0] as Json;
    const win = (day.windows as Json[]).find((w) => /T12:00/.test(w.start)) as Json;
    const o = await open(browser, `/office/jobs/new?customer=${id}`, `${SCREEN} .cust`);
    let n = 0;
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.water_heater.screen') }).click();
      await p.locator(`${SCREEN} .days [data-date="2026-09-17"]`).click();
      await p.locator(`${SCREEN} .wins [data-window-id="${win.windowId}"]`).click();
      await p.locator(`${SCREEN} .sug .tc:not(.no)`, { hasText: 'Kevin Doyle' }).locator('.btn.pick').click();
      await see(p.locator(`${SCREEN} [data-ctl="CTL-OFC-04-18"]`)).containsText('Thu, Sep 17, arrival 12-2 PM, with Kevin Doyle');
      await p.locator(`${SCREEN} button[data-ctl="CTL-OFC-04-09"]`).click();
      await p.waitForURL(/\/office\/jobs\/\d+$/, { timeout: 60_000 });
      n = Number(new URL(p.url()).pathname.split('/').pop());
      const kevin = psql(`SELECT id FROM world.technician WHERE name = 'Kevin Doyle' AND branch_id = 'columbus'`);
      expect(jobRow(n)).toMatchObject({ date: '2026-09-17', service: 'water_heater', window: '12:00', technician: kevin, customer: id, via: 'office' });
    } finally {
      await close(o);
      if (n) await cancelJob(n);
    }
  });

  // why: FR-DISP-8 (a same-day job on Sep 15 at 11:00 AM: the office creates it for that day and it is booked at that time)
  it('creates a same-day job on Sep 15 at 11:00 AM', async () => {
    await holdClockAt('2026-09-15T11:00:00-04:00');
    const id = harold();
    const room = await firstRoom('furnace_tune_up', '2026-09-15', '2026-09-15');
    const o = await open(browser, `/office/jobs/new?customer=${id}`, `${SCREEN} .cust`);
    let n = 0;
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.furnace_tune_up.screen') }).click();
      const notice = p.locator(`${SCREEN} [data-ctl="CTL-OFC-04-19"]`);
      await expect.poll(() => notice.innerText()).toContain('the evening before'); // no day picked yet
      await p.locator(`${SCREEN} .days [data-date="2026-09-15"]`).click();
      // why: F-804 (a same-day job gets no reminder, so the notice does not promise one)
      await expect.poll(() => notice.innerText()).not.toContain('the evening before');
      await p.locator(`${SCREEN} .wins [data-window-id="${room.windowId}"]`).click();
      await p.locator(`${SCREEN} button[data-ctl="CTL-OFC-04-09"]`).click();
      await p.waitForURL(/\/office\/jobs\/\d+$/, { timeout: 60_000 });
      n = Number(new URL(p.url()).pathname.split('/').pop());
      expect(jobRow(n)).toMatchObject({ date: '2026-09-15', bookedAt: '2026-09-15 11:00', via: 'office', status: 'scheduled' });
      // why: F-807 (the frame's relative word on live data: a visit on the demo day reads today, never its date)
      await p.goto(`${origin}/office/jobs/new?customer=${id}`);
      await expect.poll(() => p.locator(`${SCREEN} .cust .side[data-ctl="CTL-OFC-04-13"]`).first().innerText(), { timeout: 30_000 }).toMatch(/^Visit today, /);
    } finally {
      await close(o);
      if (n) await cancelJob(n);
    }
  });

  // why: F-805 (2 quick service picks: API-29's older answer arrives last and does not replace the newest service's days)
  it('keeps the newest service\'s days when the older API-29 answer lands last', async () => {
    await holdClockAt('2026-09-15T11:00:00-04:00');
    const o = await open(browser, `/office/jobs/new?customer=${harold()}`, `${SCREEN} .cust`);
    try {
      const p = o.page;
      let release = () => undefined as void;
      const held = new Promise<void>((r) => { release = r; });
      await p.route(/\/api\/v1\/availability/, async (route) => {
        if (!(route.request().postData() ?? route.request().url()).includes('furnace_tune_up')) return route.fallback();
        const answer = await route.fetch();
        const body = (await answer.json()) as Json;
        for (const d of body.data.days) d.left = 77;
        await held;
        await route.fulfill({ response: answer, json: body });
      });
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.furnace_tune_up.screen') }).click();
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.water_heater.screen') }).click();
      const days = p.locator(`${SCREEN} .days`);
      await expect.poll(() => days.locator('[data-date]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
      release();
      await p.waitForTimeout(500);
      expect(await days.innerText()).not.toContain('77');
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-8, FR-DISP-32 (CTL-OFC-04-01: picking a result fills the customer step, and the next step opens for that customer)
  it('fills the customer step when a search result is clicked', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    const o = await open(browser, '/office/jobs/new', `${SCREEN} input.bw-nj-find`);
    try {
      const p = o.page;
      await p.waitForSelector(`${SCREEN} .svcs [role="radio"]`, { timeout: 60_000 });
      expect(await p.locator(`${SCREEN} .svcs [role="radio"]`).first().isDisabled()).toBe(true);
      await p.fill(`${SCREEN} input.bw-nj-find`, 'Harold Jenkins');
      await p.locator(`${SCREEN} .bw-nj-hits .cust.hit`, { hasText: 'Harold Jenkins' }).first().click();
      await see(p.locator(`${SCREEN} .cust .nm`)).containsText('Harold Jenkins');
      await see(p.locator(`${SCREEN} [data-ctl="CTL-OFC-04-02"]`)).visible();
      await see(p.locator(`${SCREEN} input.bw-nj-find`)).count(0);
      await see(p.locator(`${SCREEN} .card-h .stepn.ok`)).count(1);
      expect(await p.locator(`${SCREEN} .svcs [role="radio"]`).first().isDisabled()).toBe(false);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-28 (distance from the stop before: a card whose technician has a job before the window names that stop's time and area, as API-30 answers)
  it('names the stop before on the card of a technician with an earlier job that day', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    const id = harold();
    const room = await firstRoom('furnace_tune_up', '2026-10-08');
    const day = (room.days as Json[]).find((d) => d.date === room.date) as Json;
    const [early, later] = [day.windows[0] as Json, day.windows[2] as Json];
    const list = (await api('keisha', 'GET', `/technicians/room?branch=columbus&date=${room.date}&windowId=${early.windowId}&serviceId=furnace_tune_up&customerId=${id}`)).body.data.technicians as Json[];
    const tech = list.find((t) => t.room && t.suggested) as Json;
    const other = psql(`SELECT c.id FROM world.customer c JOIN world.street s ON s.id = c.street_id WHERE c.branch_id = 'columbus' AND c.status = 'active' AND c.id <> '${id}' ORDER BY s.city DESC, c.id LIMIT 1`);
    const made = await api('keisha', 'POST', '/jobs', { customerId: other, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: room.date, windowId: early.windowId, technicianId: tech.id });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const n = made.body.data.job.jobNumber as number;
    const o = await open(browser, `/office/jobs/new?customer=${id}`, `${SCREEN} .cust`);
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.furnace_tune_up.screen') }).click();
      await p.locator(`${SCREEN} .days [data-date="${room.date}"]`).click();
      await p.locator(`${SCREEN} .wins [data-window-id="${later.windowId}"]`).click();
      const now = (await api('keisha', 'GET', `/technicians/room?branch=columbus&date=${room.date}&windowId=${later.windowId}&serviceId=furnace_tune_up&customerId=${id}`)).body.data.technicians as Json[];
      const answer = now.find((t) => t.id === tech.id) as Json;
      expect(answer.stopBefore).toMatchObject({ jobNumber: n });
      const clock = /T(\d\d):(\d\d)/.exec(answer.stopBefore.plannedArrival as string)!;
      const [h, m] = [Number(clock[1]), clock[2]];
      const time = `${h % 12 === 0 ? 12 : h % 12}${m === '00' ? '' : `:${m}`} ${h < 12 ? 'AM' : 'PM'}`;
      const minutes = `${answer.minutesFromStopBefore} minute${answer.minutesFromStopBefore === 1 ? '' : 's'}`;
      const why = p.locator(`${SCREEN} .sug .tc:not(.no)`, { hasText: tech.name }).locator('.why');
      await see(why).containsText(`${minutes} from the ${time} job in ${answer.stopBefore.area}`);
    } finally {
      await close(o);
      await cancelJob(n);
    }
  });

  // why: F-801 (the page's rule is the number beside it: each window prints the technicians with the skill and room that API-30 lists, at most the window's room)
  it('prints each window\'s left from the technicians with the skill and room', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    const id = harold();
    const date = '2026-09-22';
    const day = (await api('keisha', 'GET', `/availability?branch=columbus&serviceId=water_heater&from=${date}&to=${date}&channel=office`)).body.data.days[0] as Json;
    const o = await open(browser, `/office/jobs/new?customer=${id}`, `${SCREEN} .cust`);
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.water_heater.screen') }).click();
      await p.locator(`${SCREEN} .days [data-date="${date}"]`).click();
      await see(p.locator(`${SCREEN} .wins [role="radio"]`)).count((day.windows as Json[]).length);
      for (const w of day.windows as Json[]) {
        const list = (await api('keisha', 'GET', `/technicians/room?branch=columbus&date=${date}&windowId=${w.windowId}&serviceId=water_heater&customerId=${id}`)).body.data.technicians as Json[];
        const skilled = list.filter((t) => t.room && t.suggested).length;
        expect(w.left).toBe(skilled);
        await see(p.locator(`${SCREEN} .wins [data-window-id="${w.windowId}"] .cap`)).hasText(`${skilled} left`);
      }
    } finally {
      await close(o);
    }
  });

  // why: F-802 (the live 53 days scroll in their own box: a late day is picked from the keyboard or the board's link, and the windows and Schedule stay beside it)
  it('keeps the windows and Schedule beside a late day on the live list', async () => {
    await holdClockAt('2026-09-15T09:00:00-04:00');
    const id = harold();
    const o = await open(browser, `/office/jobs/new?customer=${id}`, `${SCREEN} .cust`);
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.furnace_tune_up.screen') }).click();
      const rows = p.locator(`${SCREEN} .days [role="radio"]`);
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(40);
      const box = p.locator(`${SCREEN} .days`);
      const size = await box.evaluate((e) => ({ client: e.clientHeight, scroll: e.scrollHeight, width: e.scrollWidth - e.clientWidth }));
      expect(size.client).toBeLessThanOrEqual(302);
      expect(size.scroll).toBeGreaterThan(size.client * 3);
      expect(size.width).toBe(0);
      // From the keyboard: the last open day takes focus (the box scrolls to it), Enter picks it.
      const last = p.locator(`${SCREEN} .days [role="radio"]:not([aria-disabled="true"])`).last();
      const date = (await last.getAttribute('data-date'))!;
      await last.focus();
      await p.keyboard.press('Enter');
      await see(p.locator(`${SCREEN} .days [role="radio"][aria-checked="true"]`)).containsText(dayText(date));
      await see(p.locator(`${SCREEN} .wins [role="radio"]`).first()).visible();
      const rect = async (page: Page, q: string) => (await page.locator(`${SCREEN} ${q}`).first().boundingBox())!;
      const inBox = async (page: Page) => {
        const [r, b] = [await rect(page, '.days [aria-checked="true"]'), await rect(page, '.days')];
        return r.y >= b.y - 1 && r.y + r.height <= b.y + b.height + 1;
      };
      const [pick, days, wins, schedule] = [await rect(p, '.days [aria-checked="true"]'), await rect(p, '.days'), await rect(p, '.wins'), await rect(p, 'button[data-ctl="CTL-OFC-04-09"]')];
      // The pick is inside the box at its frame height, the windows start level with the box, and Schedule is not a list away.
      expect(pick.height).toBeGreaterThanOrEqual(40);
      expect(await inBox(p)).toBe(true);
      expect(Math.abs(wins.y - days.y)).toBeLessThanOrEqual(4);
      expect(schedule.y - (pick.y + pick.height)).toBeLessThan(600);
      expect(await box.evaluate((e) => e.ownerDocument.documentElement.scrollHeight)).toBeLessThan(1800);
      // The day a link names is picked and scrolled into the box, and the page itself stays where it opened.
      const again = await open(browser, `/office/jobs/new?customer=${id}&date=${date}`, `${SCREEN} .cust`);
      try {
        await again.page.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.furnace_tune_up.screen') }).click();
        await see(again.page.locator(`${SCREEN} .days [role="radio"][aria-checked="true"]`)).containsText(dayText(date));
        await expect.poll(() => inBox(again.page), { timeout: 30_000 }).toBe(true);
        expect(await again.page.locator(`${SCREEN} .days`).evaluate((e) => e.ownerDocument.documentElement.scrollTop)).toBe(0);
      } finally {
        await close(again);
      }
    } finally {
      await close(o);
    }
  });

  // why: F-798 (the page Schedule opens reads Jobs / Job <n> as CTL-OFC-04-12, Jobs opening the list and Job <n> the page shown; any other way to that page keeps the Board trail)
  it('draws Jobs / Job <n> on the page Schedule opens, and the Board trail on any other way there', async () => {
    await holdClockAt('2026-09-14T17:01:00-04:00');
    const id = harold();
    const room = await firstRoom('furnace_tune_up', '2026-10-09');
    const o = await open(browser, `/office/jobs/new?customer=${id}`, `${SCREEN} .cust`);
    let n = 0;
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .svcs [role="radio"]`, { hasText: msg('service.furnace_tune_up.screen') }).click();
      await p.locator(`${SCREEN} .days [data-date="${room.date}"]`).click();
      await p.locator(`${SCREEN} .wins [data-window-id="${room.windowId}"]`).click();
      await p.locator(`${SCREEN} button[data-ctl="CTL-OFC-04-09"]`).click();
      await p.waitForURL(/\/office\/jobs\/\d+$/, { timeout: 60_000 });
      n = Number(new URL(p.url()).pathname.split('/').pop());
      const done = p.locator(`${JOB_SCREEN} .jh [data-ctl="CTL-OFC-04-12"]`);
      await see(done).visible();
      expect(await trail(done)).toBe(`${msg('newjob.crumb.jobs')} / ${msg('job.crumb.job', { job: n })}`);
      expect(await done.locator('a').getAttribute('href')).toBe('/office/jobs');
      expect(await done.locator('a').count()).toBe(1);
      expect(await p.locator(`${JOB_SCREEN} [data-ctl="CTL-OFC-03-01"]`).count()).toBe(0);
      const board = `${msg('job.crumb.board')} ${dayText(room.date)} ${msg('job.crumb.job', { job: n })}`;
      const boardTrail = p.locator(`${JOB_SCREEN} .jh [data-ctl="CTL-OFC-03-01"]`);
      // The trail is this one opening's: the same tab opening the job again, the way a link does, has the Board trail.
      await p.goto(`${origin}/office/jobs/${n}`, { waitUntil: 'load' });
      await see(boardTrail).visible();
      expect(await trail(boardTrail)).toBe(board);
      expect(await p.locator(`${JOB_SCREEN} [data-ctl="CTL-OFC-04-12"]`).count()).toBe(0);
      // A reload of it, and a handoff left for another job (a Schedule that opened no page), keep the Board trail too.
      await p.evaluate(`window.sessionStorage.setItem('bw.newjob.toast', '{"jobNumber":1,"key":"newjob.done.sent","values":{}}')`);
      await p.reload({ waitUntil: 'load' });
      await see(boardTrail).visible();
      expect(await trail(boardTrail)).toBe(board);
    } finally {
      await close(o);
      if (n) await cancelJob(n);
    }
    // Opened fresh, in a tab that never saw Schedule.
    const fresh = await open(browser, `/office/jobs/${n}`, `${JOB_SCREEN} .jh [data-ctl="CTL-OFC-03-01"]`);
    try {
      expect(await fresh.page.locator(`${JOB_SCREEN} [data-ctl="CTL-OFC-04-12"]`).count()).toBe(0);
    } finally {
      await close(fresh);
    }
  });

  // why: F-799, SD-45 (at the real hold: made at 10:30 PM, changed that night, 8:00 AM comes and the worker runs. Canceled: no text. Moved, moved twice: exactly 1 confirmation, the current day and window, read from the customer's inbox)
  it('delivers a held confirmation at 8:00 AM only when it is still true: canceled, moved and moved twice', async () => {
    await holdClockAt('2026-09-15T22:30:00-04:00');
    const id = harold();
    psql(`UPDATE world.customer SET mobile = '+16145550148', texts_on = true, text_language = 'en' WHERE id = '${id}'`);
    const days = (await api('keisha', 'GET', '/availability?branch=columbus&serviceId=furnace_tune_up&from=2026-10-13&to=2026-10-24&channel=office')).body.data.days as Json[];
    const open3 = days.filter((d) => d.state === 'open' && d.windows.some((w: Json) => w.state === 'open')).slice(0, 3);
    expect(open3).toHaveLength(3);
    const windowOf = (d: Json) => (d.windows as Json[]).find((w) => w.state === 'open') as Json;
    const make = async () => {
      const r = await api('keisha', 'POST', '/jobs', { customerId: id, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: open3[0].date, windowId: windowOf(open3[0]).windowId, technicianId: null });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.data.confirmationText).toMatchObject({ status: 'held' });
      return r.body.data.job as Json;
    };
    const move = async (job: Json, d: Json) => {
      const r = await api('keisha', 'POST', `/jobs/${job.jobNumber}/schedule`, { date: d.date, windowId: windowOf(d).windowId, baseVersion: job.version });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.data.job as Json;
    };
    const canceled = await make();
    const c = await api('keisha', 'POST', `/jobs/${canceled.jobNumber}/cancellation`, { baseVersion: canceled.version });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const once = await make();
    await move(once, open3[1]);
    const twice = await make();
    await move(await move(twice, open3[1]), open3[2]);
    const short = (d: Json) => dayText(d.date).replace(/^\w+, /, '');
    const inbox = (n: number) => psql(`SELECT m.body FROM world.inbox_message m JOIN world.outbox_text t ON t.id = m.text_id WHERE t.job_number = ${n} AND m.direction = 'out' ORDER BY m.at, m.id`).split('\n').filter(Boolean);

    await holdClockAt('2026-09-16T08:02:00-04:00');
    const statuses = (n: number) => confirmations(n).map((r) => r.status);
    await until('the held confirmations settle', () => [...statuses(once.jobNumber), ...statuses(twice.jobNumber)], (s) => s.filter((x) => x === 'delivered').length === 2);
    // Canceled: nothing, and its try ended too.
    expect(inbox(canceled.jobNumber)).toEqual([]);
    expect(statuses(canceled.jobNumber)).toEqual(['canceled']);
    // Moved: 1 confirmation, the new day and window.
    const read = (n: number) => inbox(n).filter((b) => b.includes("You're booked"));
    expect(read(once.jobNumber)).toHaveLength(1);
    expect(read(once.jobNumber)[0]).toContain(short(open3[1]));
    expect(read(once.jobNumber)[0]).toContain(windowLabel(windowOf(open3[1]).start, windowOf(open3[1]).end));
    expect(statuses(once.jobNumber)).toEqual(['canceled', 'delivered']);
    // Moved twice: only the last.
    expect(read(twice.jobNumber)).toHaveLength(1);
    expect(read(twice.jobNumber)[0]).toContain(short(open3[2]));
    expect(statuses(twice.jobNumber)).toEqual(['canceled', 'canceled', 'delivered']);
    await cancelJob(once.jobNumber);
    await cancelJob(twice.jobNumber);
  });
});
