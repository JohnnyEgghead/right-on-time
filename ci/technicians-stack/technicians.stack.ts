// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-33, FR-TEXT-11, FR-AUTH-12, FR-DISP-10 (P4-TECHNICIANS Acceptance: Playwright on Chromium and WebKit against the Compose stack at its default settings)
// The Technicians page (SCR-OFC-07, -41, -42) against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running), through its
// proxy, outside-origin guard on: every field the table shows is the one API-31 answers (van, skills, hours, today's load, the phone app's last report and
// waiting count, the Right now chip), a name in texts that breaks 1 message is refused with the reason and nothing is saved, Add technician makes an Invited
// technician with 1 invite email and a one-time link that opens once, time off over 2 booked jobs lists both for reassignment and Remove gives the days back
// at once with the jobs left Unassigned (OI-44), and the top bar's Technicians item opens the page for the office user and the manager (a technician is
// refused). Run by ci/shell-stack.sh after the customers suite and before the clock banner suite, on the same stack: the shell fixture (the clock row at Tue,
// Sep 15, 10:41 AM, the office user and her session, whose token the script hands over as BW_SHELL_STACK_SESSION) and then ./fixture.sql (2 technicians, a
// manager and 2 technicians' own sessions: BW_TECHNICIANS_STACK_MANAGER, BW_TECHNICIANS_STACK_TECH, BW_TECHNICIANS_STACK_SYNC). A *.stack.ts file: its own config runs it.
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';

const base = process.env.BW_SHELL_STACK_URL;
if (!base) throw new Error('BW_SHELL_STACK_URL is not set: run ci/shell-stack.sh');
const origin = new URL(base).origin;
const session = process.env.BW_SHELL_STACK_SESSION;
if (!session) throw new Error('BW_SHELL_STACK_SESSION is not set: run ci/shell-stack.sh');
const managerSession = process.env.BW_TECHNICIANS_STACK_MANAGER;
const techSession = process.env.BW_TECHNICIANS_STACK_TECH;
const syncSession = process.env.BW_TECHNICIANS_STACK_SYNC;
if (!managerSession || !techSession || !syncSession) throw new Error('BW_TECHNICIANS_STACK_MANAGER, BW_TECHNICIANS_STACK_TECH and BW_TECHNICIANS_STACK_SYNC are not set: run ci/shell-stack.sh');
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the kernel refuses a cookie-carrying write from any other origin (SD-8).
const APP_ORIGIN = 'http://localhost:8080';
const SCREEN = '.r1-screen[data-screen="SCR-OFC-07"]';
const ROWS = `${SCREEN} .tbl tbody tr`;

interface Tech {
  id: string; name: string; van: { number: string } | null; skills: string[]; workingHours: { start: string; end: string }; workingDays: number[]; saturdays: string;
  todayLoad: number; capacity: number; workingToday: boolean; nameInTexts: string; since: number; userStatus: string; employeeNumber: string | null; branch: string;
  rightNow: { status: string; customerName: string | null } | null; timeOff: { id: string; from: string; to: string; note: string | null }[];
  apps: { web: { lastSyncAt: string; waitingCount: number } | null; native: unknown };
}
interface List { technicians: Tech[]; today: string; vans: unknown[] }

/** The pair of booked jobs (./fixture.sql) each engine records time off over: Zack Zeller's on Mon, Sep 21, or Zara Zinn's on Tue, Sep 22. */
const PLAN = {
  chromium: {
    tech: 'Zack Zeller', first: 'Zack', date: '2026-09-21', jobs: [27001, 27002], windows: ['10 AM-12 PM', '2-4 PM'], span: 'Mon, Sep 21', name: 'Zacky',
    van: 'T1', has: 'heating_cooling', hasWord: 'Heating & cooling', adds: 'Plumbing', hours: { tech: 'Zoe Zuber', first: 'Zoe', job: 27006 }, tag: 'C',
  },
  webkit: {
    tech: 'Zara Zinn', first: 'Zara', date: '2026-09-22', jobs: [27003, 27004], windows: ['10 AM-12 PM', '2-4 PM'], span: 'Tue, Sep 22', name: 'Zari',
    van: 'T2', has: 'plumbing', hasWord: 'Plumbing', adds: 'Heating & cooling', hours: { tech: 'Zeke Zuber', first: 'Zeke', job: 27007 }, tag: 'W',
  },
} as const;

/** A write from the page reaches the real handlers carrying the default stack's origin (the proxy's port is not APP_ORIGIN). */
async function postOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
    return r.fulfill({ response });
  });
}

describe.each(engines)('the technicians page on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  const plan = PLAN[engine as keyof typeof PLAN] ?? PLAN.chromium;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open<T>(
    fn: (p: Page, ctx: BrowserContext) => Promise<T>, who = session!, path = '/office/technicians', ready = ROWS,
  ): Promise<T> {
    const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 900 } });
    try {
      await g.context.addCookies([{ name: 'bw_session', value: who, url: origin, httpOnly: true }]);
      const p = await g.context.newPage();
      await postOrigin(p);
      const res = await p.goto(origin + path, { waitUntil: 'load' });
      expect(res?.status()).toBe(200);
      await p.waitForSelector(ready, { state: 'attached' });
      return await fn(p, g.context);
    } finally {
      await g.context.close();
    }
  }

  const list = async (ctx: BrowserContext, branch = 'columbus'): Promise<List> => {
    const r = await ctx.request.get(`${origin}/api/v1/technicians?branch=${branch}`);
    expect(r.status(), await r.text()).toBe(200);
    return ((await r.json()) as { data: List }).data;
  };
  const board = async (ctx: BrowserContext, date: string, branch = 'columbus') => {
    const r = await ctx.request.get(`${origin}/api/v1/board?branch=${branch}&date=${date}`);
    expect(r.status(), await r.text()).toBe(200);
    return ((await r.json()) as { data: { technicians: { name: string; jobs: { jobNumber: number; plannedArrival: string | null }[] }[]; unassigned: { jobNumber: number }[] } }).data;
  };
  /** A page's Working select, on All: a technician off today is reached through it. */
  const workingAll = (p: Page) => p.locator(`${SCREEN} [data-ctl="CTL-OFC-07-16"] select`).selectOption('');
  /** Add a technician through API-147 as the office would, for a case that needs someone of its own. */
  const addedBy = async (ctx: BrowserContext, name: string, email: string) => {
    const r = await ctx.request.post(`${origin}/api/v1/technicians`, {
      headers: { origin: APP_ORIGIN },
      data: { name, email, branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' } },
    });
    expect(r.status(), await r.text()).toBe(201);
  };
  /** A table row's cells as drawn: whitespace folded. */
  const cells = (p: Page, name: string) =>
    p.locator(ROWS, { hasText: name }).first().evaluate((tr) => Array.from((tr as unknown as { children: ArrayLike<{ textContent: string | null; innerText?: string }> }).children, (c) => ((c as { innerText?: string }).innerText ?? '').replace(/\s+/g, ' ').trim()));

  // why: FR-DISP-33 every field the table shows is the one API-31 answers: van, skills, hours, today's load, the phone app's last report and waiting count, and Right now
  it('shows each technician\'s van, skills, hours, load, last sync and waiting count as API-31 answers them', async () => {
    await open(async (p, ctx) => {
      const api = await list(ctx);
      const zack = api.technicians.find((t) => t.name === 'Zack Zeller')!;
      expect(zack.van?.number).toBe('T1');
      expect(zack.apps.web).toMatchObject({ waitingCount: 3, lastSyncAt: '2026-09-15T10:22:00-04:00[America/New_York]' });
      expect(zack.rightNow).toMatchObject({ status: 'on_the_way', customerName: 'Imogen Pratt' });
      expect([zack.todayLoad, zack.capacity]).toEqual([1, 5]);
      const row = await cells(p, 'Zack Zeller');
      expect(row[0]).toBe('ZZ Zack Zeller Van T1 - Active');
      expect(row[1]).toBe('Heating & cooling');
      expect(row[2]).toBe('Columbus');
      expect(row[3]).toBe('Mon-Fri, 8-5:30 No Saturdays');
      expect(row[4]).toBe('1 of 5 On the way');
      expect(row[5]).toBe('Waiting to send 3 items No signal since 10:22 AM');
      const zara = await cells(p, 'Zara Zinn');
      expect(zara[0]).toBe('ZZ Zara Zinn Van T2 - Active');
      expect(zara[1]).toBe('Plumbing');
      expect(zara[3]).toBe('Mon-Thu, 7:30-6 Alt. Saturdays');
      expect(zara[4]).toBe('0 of 5');
      expect(zara[5]).toBe('No app yet No report yet');
      // the subtitle counts the API's own list
      const working = api.technicians.filter((t) => t.workingToday).length;
      const sub = await p.locator(`${SCREEN} [data-ctl="CTL-OFC-07-25"]`).innerText();
      expect(sub).toMatch(new RegExp(`^Columbus - ${api.technicians.length} technicians, ${working === api.technicians.length ? 'all working today' : `${working} working today`}\\. Updated \\d{1,2}:\\d{2} [AP]M\\.$`));
      // the panel: the technician's own row opens in it with the details API-31 holds
      await p.locator(ROWS, { hasText: 'Zack Zeller' }).click();
      const panel = p.locator(`${SCREEN} .det`);
      await expect.poll(() => panel.getAttribute('aria-label')).toBe('Zack Zeller');
      expect(await panel.locator('.top .s').innerText()).toBe(`Technician - Van T1 - since ${zack.since}`);
      expect(await panel.locator('[data-ctl="CTL-OFC-07-19"]').innerText()).toContain('(614) 555-0196');
      expect(await panel.locator('[data-ctl="CTL-OFC-07-19"] .chip').first().innerText()).toBe('On the way');
      expect(await panel.locator('.app.wait').innerText()).toContain('Web app: last report 10:22 AM, 3 waiting');
    });
  });

  // why: FR-TEXT-11 a name in texts that breaks 1 message is refused with the reason, Save stays off and nothing is saved; a name that fits is saved
  it('refuses a name in texts with an o-acute, with the reason, and saves one that fits', async () => {
    await open(async (p, ctx) => {
      const writes: string[] = [];
      p.on('request', (r) => {
        if (r.method() === 'PATCH') writes.push(r.url());
      });
      await p.locator(ROWS, { hasText: plan.tech }).click();
      const input = p.locator(`${SCREEN} #bw-tc-name`);
      await expect.poll(() => input.inputValue()).toBe(plan.first);
      await input.fill('Ramón');
      const line = p.locator(`${SCREEN} [data-ctl="CTL-OFC-07-04"]`);
      await expect.poll(() => line.innerText(), { timeout: 15_000 }).toBe('ó is not in the standard text character set, so texts would take 2 messages. Use o.');
      const save = p.locator(`${SCREEN} [data-ctl="CTL-OFC-07-05"]`);
      expect(await save.getAttribute('aria-disabled')).toBe('true');
      await save.click({ force: true });
      expect(writes).toEqual([]);
      expect((await list(ctx)).technicians.find((t) => t.name === plan.tech)!.nameInTexts).toBe(plan.first);
      // the API itself refuses the same name with the reason (the page never sends it)
      const direct = await ctx.request.patch(`${origin}/api/v1/technicians/${(await list(ctx)).technicians.find((t) => t.name === plan.tech)!.id}`, { headers: { origin: APP_ORIGIN }, data: { nameInTexts: 'Ramón' } });
      expect(direct.status()).toBe(422);
      expect(await direct.json()).toMatchObject({ code: 'text_value_breaks_limit', problem: 'not_gsm7_basic', chars: ['ó'] });
      await input.fill(plan.name);
      await expect.poll(() => line.innerText(), { timeout: 15_000 }).toBe('Fits in 1 text.');
      await expect.poll(() => save.getAttribute('aria-disabled')).toBeNull();
      await save.click();
      await expect.poll(() => p.locator('.r1-toast').innerText(), { timeout: 15_000 }).toBe('Technician saved');
      await expect.poll(async () => (await list(ctx)).technicians.find((t) => t.name === plan.tech)!.nameInTexts).toBe(plan.name);
    }, managerSession);
  });

  // why: FR-AUTH-12 Add technician makes an Invited technician with the next employee number, 1 invite email and a one-time link that opens once, and the board lists them
  it('adds a technician as Invited, with an invite whose one-time link opens once, and the board lists them', async () => {
    await open(async (p, ctx) => {
      const email = `derek.${engine}@brightwaterair.example`;
      await p.locator(`${SCREEN} .pgh [data-ctl="CTL-OFC-07-13"]`).click();
      const dlg = p.locator('.r1-dlg[data-screen="SCR-OFC-41"]');
      await dlg.waitFor({ state: 'visible' });
      const submit = dlg.locator('[data-ctl="CTL-OFC-41-07"]');
      expect(await submit.getAttribute('aria-disabled')).toBe('true');
      await dlg.locator('#bw-ta-name').fill(`Derek Lindgren ${engine === 'webkit' ? 'W' : 'C'}`);
      await dlg.locator('#bw-ta-email').fill(email);
      await dlg.locator('.cks span', { hasText: 'Plumbing' }).click();
      await submit.click();
      await expect.poll(() => dlg.locator('p').first().innerText(), { timeout: 15_000 }).toContain('was added.');
      expect(await dlg.innerText()).toContain(`The invite went to ${email}.`);
      const link = dlg.locator('a[data-ctl="CTL-OFC-41-08"]');
      const href = await link.getAttribute('href');
      expect(href).toMatch(/^\/email\/[A-Za-z0-9_-]+$/);
      const [popup] = await Promise.all([ctx.waitForEvent('page'), link.click()]);
      await popup.waitForLoadState('load');
      expect(new URL(popup.url()).pathname).toBe(href);
      await expect.poll(() => popup.locator('body').innerText(), { timeout: 15_000 }).toMatch(/Your employee number is \d{5}/);
      await popup.close();
      await expect.poll(() => dlg.locator('[data-ctl="CTL-OFC-41-08"]').innerText()).toBe('This link was used.');
      // the same link answers no second time
      const again = await ctx.newPage();
      await again.goto(origin + (href as string), { waitUntil: 'load' });
      expect(await again.locator('body').innerText()).not.toMatch(/Your employee number is/);
      await again.close();
      await dlg.locator('.r1-dlg-f [data-ctl="CTL-OFC-41-09"]').click();
      const api = await list(ctx);
      const added = api.technicians.find((t) => t.name.startsWith('Derek Lindgren'))!;
      expect(added).toMatchObject({ userStatus: 'invited', skills: ['plumbing'], van: null });
      await expect.poll(async () => (await cells(p, added.name))[0]).toContain('Invited');
      expect((await board(ctx, api.today)).technicians.map((t) => t.name)).toContain(added.name);
    }, session);
  });

  // why: FR-DISP-33 time off over 2 booked jobs lists both for reassignment, leaves both Unassigned, and Remove gives the days back with no confirm step (OI-44)
  it('lists both booked jobs of the span for reassignment, and Remove time off has no confirm step', async () => {
    await open(async (p, ctx) => {
      await p.locator(ROWS, { hasText: plan.tech }).click();
      await p.locator(`${SCREEN} .pgh [data-ctl="CTL-OFC-07-12"]`).click();
      const dlg = p.locator('.r1-dlg[data-screen="SCR-OFC-42"]');
      await dlg.waitFor({ state: 'visible' });
      expect(await dlg.locator('h2').innerText()).toBe(`Add time off for ${plan.tech}`);
      const save = dlg.locator('[data-ctl="CTL-OFC-42-03"]');
      expect(await save.getAttribute('aria-disabled')).toBe('true');
      await dlg.locator('#bw-to-from').fill(plan.date);
      await dlg.locator('#bw-to-to').fill(plan.date);
      await dlg.locator('#bw-to-note').fill('Dentist');
      await save.click();
      const [a, b] = plan.jobs;
      await expect.poll(() => p.locator('.r1-toast').innerText(), { timeout: 15_000 }).toBe(
        `Time off saved. ${plan.first} already has 2 jobs that day: job ${a}, ${plan.windows[0]}; job ${b}, ${plan.windows[1]}. Reassign them on the board.`);
      // both jobs came off the technician and are listed on the board as Unassigned
      const day = await board(ctx, plan.date);
      expect(day.unassigned.map((j) => j.jobNumber)).toEqual(expect.arrayContaining([a, b]));
      const span = p.locator(`${SCREEN} .det .toff > div`);
      await expect.poll(() => span.count()).toBe(1);
      expect(await span.first().innerText()).toContain(`${plan.span}`);
      expect(await span.first().innerText()).toContain('Dentist');
      // Remove: 1 press, no dialog; the span leaves the list and the technician has room again
      await span.first().locator('[data-ctl="CTL-OFC-07-20"]').click();
      await expect.poll(() => p.locator(`${SCREEN} .det .toff`).innerText(), { timeout: 15_000 }).toBe('No time off recorded');
      await expect.poll(() => p.locator('.r1-toast').innerText()).toBe('Time off removed');
      expect(await p.locator('.r1-dlg').count()).toBe(0);
      expect((await list(ctx)).technicians.find((t) => t.name === plan.tech)!.timeOff).toEqual([]);
      // the jobs stay Unassigned until the office reassigns them (OI-44)
      expect((await board(ctx, plan.date)).unassigned.map((j) => j.jobNumber)).toEqual(expect.arrayContaining([a, b]));
    }, managerSession);
  });

  // why: F-768 CTL-OFC-41-01, -41-02, -41-05, -07-09 and -42-01 a refusal has its own words: Add technician says what is missing when it is pressed not ready, the panel says no skill is ticked and holds Save off, a span over 366 days says so
  it('says what is missing or too long, in the field\'s own words', async () => {
    await open(async (p) => {
      await p.locator(`${SCREEN} .pgh [data-ctl="CTL-OFC-07-13"]`).click();
      const add = p.locator('.r1-dlg[data-screen="SCR-OFC-41"]');
      await add.waitFor({ state: 'visible' });
      expect(await add.locator('.r1-fmsg').count()).toBe(0);
      await add.locator('[data-ctl="CTL-OFC-41-07"]').click({ force: true });
      await expect.poll(() => add.locator('.r1-fmsg').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(
        ["Type the technician's name.", 'That is not an email address.', 'Pick at least 1 skill.']);
      await add.locator('[data-ctl="CTL-OFC-41-09"]').first().click();
      await add.waitFor({ state: 'detached' });

      await p.locator(ROWS, { hasText: plan.tech }).click();
      const det = p.locator(`${SCREEN} .det`);
      const skills = det.locator('.cks span');
      for (const i of [...Array(await skills.count()).keys()]) if ((await skills.nth(i).getAttribute('aria-checked')) === 'true') await skills.nth(i).click();
      await expect.poll(() => det.locator('.r1-fmsg').innerText()).toBe('Pick at least 1 skill.');
      expect(await det.locator('[data-ctl="CTL-OFC-07-05"]').getAttribute('aria-disabled')).toBe('true');

      await p.locator(`${SCREEN} .pgh [data-ctl="CTL-OFC-07-12"]`).click();
      const off = p.locator('.r1-dlg[data-screen="SCR-OFC-42"]');
      await off.waitFor({ state: 'visible' });
      await off.locator('#bw-to-from').fill('2026-10-05');
      await off.locator('#bw-to-to').fill('2027-10-06');
      await expect.poll(() => off.locator('.r1-fmsg').innerText()).toBe('Time off can be at most 366 days.');
      expect(await off.locator('[data-ctl="CTL-OFC-42-03"]').getAttribute('aria-disabled')).toBe('true');
    });
  });

  // why: FR-DISP-12 the bell on this page shows API-43's open count, as on every office page: the page reads the count, it never passes a fixed one
  it('shows the open alert count on the bell', async () => {
    await open(async (p, ctx) => {
      const r = await ctx.request.get(`${origin}/api/v1/alerts?branch=columbus`);
      expect(r.status()).toBe(200);
      const alerts = ((await r.json()) as { data: { alerts: { state: string }[] } }).data.alerts.filter((a) => a.state === 'open');
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      await expect.poll(() => p.locator('button[data-ctl="CTL-CMP-07-06"]').getAttribute('aria-label'), { timeout: 15_000 }).toMatch(new RegExp(`\\b${alerts.length}$`));
    });
  });

  // why: FR-DISP-33 the page starts on Working today as the frame draws it; a technician off today is reached through the filter, and the subtitle counts everyone
  it('starts on Working today, with a technician off today one filter away and the subtitle counting all', async () => {
    await open(async (p, ctx) => {
      const api = await list(ctx);
      const pick = p.locator(`${SCREEN} [data-ctl="CTL-OFC-07-16"]`);
      expect(await pick.locator('b').innerText()).toBe('Working today');
      const working = api.technicians.filter((t) => t.workingToday).map((t) => t.name);
      expect(working).not.toContain('Zoe Zuber');
      const names = () => p.locator(`${ROWS} .who b`).allInnerTexts();
      await expect.poll(async () => (await names()).length).toBe(working.length);
      expect(await names()).not.toContain('Zoe Zuber');
      expect(await p.locator(`${SCREEN} [data-ctl="CTL-OFC-07-25"]`).innerText()).toContain(`${api.technicians.length} technicians, ${working.length} working today`);
      await workingAll(p);
      await expect.poll(async () => (await names()).length).toBe(api.technicians.length);
      await pick.locator('select').selectOption('off');
      await expect.poll(names).toEqual(api.technicians.filter((t) => !t.workingToday).map((t) => t.name));
    });
  });

  // why: SD-29 the employee number is shown on the Technicians page: the panel prints the number API-31 answers
  it('shows the employee number in the panel', async () => {
    await open(async (p, ctx) => {
      const zack = (await list(ctx)).technicians.find((t) => t.name === 'Zack Zeller')!;
      expect(zack.employeeNumber).toBe('0201');
      await p.locator(ROWS, { hasText: 'Zack Zeller' }).click();
      const line = p.locator(`${SCREEN} .det .kv`);
      await expect.poll(() => line.innerText()).toMatch(/Employee number\s+0201/);
    });
  });

  // why: FR-DISP-33 a skill added on the Technicians page shows on the technician's board row (FR-DISP-15), with the skill it already had
  it('shows a skill added in the panel on the board row', async () => {
    await open(async (p, ctx) => {
      const id = (await list(ctx)).technicians.find((t) => t.name === plan.tech)!.id;
      try {
        await p.locator(ROWS, { hasText: plan.tech }).click();
        await p.locator(`${SCREEN} .det .cks span`, { hasText: plan.adds }).click();
        await p.locator(`${SCREEN} .det [data-ctl="CTL-OFC-07-05"]`).click();
        await expect.poll(() => p.locator('.r1-toast').innerText(), { timeout: 15_000 }).toBe('Technician saved');
        await p.goto(`${origin}/office/board?branch=columbus`, { waitUntil: 'load' });
        const row = p.locator('.tl-row', { hasText: plan.tech });
        await row.waitFor({ state: 'visible', timeout: 15_000 });
        expect(await row.locator('.who .sub').innerText()).toBe(`Van ${plan.van} - ${plan.hasWord}`);
        expect(await row.locator('.who .sub2').innerText()).toBe(plan.adds);
      } finally {
        const undo = await ctx.request.patch(`${origin}/api/v1/technicians/${id}`, { headers: { origin: APP_ORIGIN }, data: { skills: [plan.has] } });
        expect(undo.status()).toBe(200);
      }
    });
  });

  // why: FR-DISP-33 after a technician's web app syncs with 2 items still waiting (API-162 with her own session), her row shows that sync time and 2 waiting, and keeps showing them while the app is offline
  it('shows the report a technician\'s own app sent through API-162, and keeps it', async () => {
    const g = await guardedContext(browser, [origin]);
    try {
      await g.context.addCookies([{ name: 'bw_session', value: syncSession!, url: origin, httpOnly: true }]);
      const r = await g.context.request.post(`${origin}/api/v1/tech/sync-reports`, {
        headers: { origin: APP_ORIGIN },
        data: { app: 'web', waitingCount: 2, lastSyncAt: '2026-09-15T10:40:00-04:00[America/New_York]', device: 'Safari on iPhone', version: '1.0.1' },
      });
      expect(r.status(), await r.text()).toBe(204);
    } finally {
      await g.context.close();
    }
    await open(async (p) => {
      await workingAll(p);
      for (const pass of ['after the report', 'after a new read with no further report']) {
        await expect.poll(async () => (await cells(p, 'Zoe Zuber'))[5], { message: pass }).toBe('Waiting to send 2 items No signal since 10:40 AM');
        await p.locator(ROWS, { hasText: 'Zoe Zuber' }).click();
        await expect.poll(() => p.locator(`${SCREEN} .det .app.wait`).innerText()).toContain('Web app: last report 10:40 AM, 2 waiting');
        await p.reload({ waitUntil: 'load' });
        await p.waitForSelector(ROWS, { state: 'attached' });
        await workingAll(p);
      }
    });
  });

  // why: FR-TEXT-11 "Ramon" is saved as the name in texts and every screen keeps showing "Ramón"
  it('saves Ramon as the name in texts and keeps Ramón on the screens', async () => {
    const name = `Ramón Cruz ${plan.tag}`;
    await open(async (p, ctx) => {
      await addedBy(ctx, name, `ramon.${engine}@brightwaterair.example`);
      await p.reload({ waitUntil: 'load' });
      await p.locator(ROWS, { hasText: name }).click();
      const input = p.locator(`${SCREEN} #bw-tc-name`);
      await input.fill('Ramon');
      const line = p.locator(`${SCREEN} [data-ctl="CTL-OFC-07-04"]`);
      await expect.poll(() => line.innerText(), { timeout: 15_000 }).toBe('Fits in 1 text.');
      await p.locator(`${SCREEN} .det [data-ctl="CTL-OFC-07-05"]`).click();
      await expect.poll(() => p.locator('.r1-toast').innerText(), { timeout: 15_000 }).toBe('Technician saved');
      await expect.poll(async () => (await list(ctx)).technicians.find((t) => t.name === name)?.nameInTexts).toBe('Ramon');
      expect(await p.locator(ROWS, { hasText: name }).locator('.who b').innerText()).toBe(name);
      expect(await p.locator(`${SCREEN} .det .top b`).innerText()).toBe(name);
      await p.goto(`${origin}/office/board?branch=columbus`, { waitUntil: 'load' });
      await expect.poll(() => p.locator('.tl-row .who .nm', { hasText: 'Ramón Cruz' }).allInnerTexts(), { timeout: 15_000 }).toContain(name);
    }, managerSession);
  });

  // why: FR-DISP-33 Save sends the working hours through API-33: each weekday is Off or a start and an end, the end not after the start is a field message, Cancel puts the saved hours back, and a start moved shows in the planned arrival
  // why: F-764 a weekday removed leaves its job assigned and the page tells the office which job
  it('edits the hours in place: 1 shift, a field message, Cancel, a settled day, and a job left on a day off named', async () => {
    const { tech: who, first, job } = plan.hours;
    await open(async (p, ctx) => {
      const patches: string[] = [];
      p.on('request', (r) => {
        if (r.method() === 'PATCH') patches.push(r.postData() ?? '');
      });
      await workingAll(p);
      await p.locator(ROWS, { hasText: who }).click();
      const panel = p.locator(`${SCREEN} .det`);
      await expect.poll(() => panel.getAttribute('aria-label')).toBe(who);
      const save = panel.locator('[data-ctl="CTL-OFC-07-05"]');
      const hours = panel.locator('[data-ctl="CTL-OFC-07-10"]');
      expect(await panel.locator('.acts a', { hasText: 'Edit' }).count()).toBe(0);
      // The hours rest as text; pressing them opens the editor in place.
      expect(await hours.locator('input').count()).toBe(0);
      await hours.click();
      await hours.getByLabel('Mon start').waitFor({ state: 'visible' });
      expect(await hours.getByLabel('Tue start').count()).toBe(0);
      await hours.getByLabel('Mon start').fill('09:30');
      expect(await hours.getByLabel('Wed start').inputValue()).toBe('09:30');
      await hours.getByLabel('Mon end').fill('09:00');
      const message = panel.locator('.r1-fmsg');
      await expect.poll(() => message.innerText()).toBe('The end must be after the start.');
      expect(await save.getAttribute('aria-disabled')).toBe('true');
      // Cancel puts the saved hours back and the text returns, with nothing sent.
      await panel.locator('[data-ctl="CTL-OFC-07-06"]').click();
      await expect.poll(() => hours.locator('input').count()).toBe(0);
      expect(await hours.innerText()).toContain('8-5:30');
      expect(patches).toEqual([]);

      await hours.click();
      await hours.getByLabel('Mon start').fill('09:30');
      await hours.getByLabel('Mon end').fill('17:00');
      await expect.poll(() => message.count()).toBe(0);
      await save.click();
      await expect.poll(() => p.locator('.r1-toast').innerText(), { timeout: 15_000 }).toBe('Technician saved');
      expect(JSON.parse(patches[0] as string).workingHours).toEqual({ start: '09:30', end: '17:00', days: [1, 3, 5], saturdays: 'none' });
      await expect.poll(async () => (await cells(p, who))[3]).toBe('Mon, Wed, Fri, 9:30-5 No Saturdays');
      const plannedOn = async () => (await board(ctx, '2026-09-21')).technicians.find((t) => t.name === who)!.jobs.find((j) => j.jobNumber === job)!.plannedArrival;
      expect(((await plannedOn()) as string).slice(11, 16) >= '09:30').toBe(true);

      // Monday off: the job comes off the technician (F-794), and the office is told which job to reassign.
      await hours.click();
      await hours.getByLabel('Mon off').click();
      await save.click();
      await expect.poll(() => p.locator('.r1-toast').innerText(), { timeout: 15_000 }).toBe(
        `Technician saved. ${first} had 1 job on a day off, now Unassigned: job ${job}, Mon, Sep 21, 10 AM-12 PM. Reassign it on the board.`);
      await expect.poll(async () => (await cells(p, who))[3]).toBe('Wed, Fri, 9:30-5 No Saturdays');
      // F-794 owner ruling ("Unassign it ... The job goes back to the unassigned list"): a technician off on Monday is not a column of that day's board, and the job is on its unassigned list.
      const monday = await board(ctx, '2026-09-21');
      expect(monday.technicians.find((t) => t.name === who)?.jobs.find((j) => j.jobNumber === job)).toBeUndefined();
      expect(monday.unassigned.map((j) => j.jobNumber)).toContain(job);
    }, managerSession);
  });

  // why: FR-DISP-33 Add technician sets the working hours (CTL-OFC-41-06): a weekday Off and a moved shift are what API-147 stores
  it('adds a technician with the hours typed in the dialog', async () => {
    const name = `Hana Reed ${plan.tag}`;
    await open(async (p, ctx) => {
      await p.locator(`${SCREEN} .pgh [data-ctl="CTL-OFC-07-13"]`).click();
      const dlg = p.locator('.r1-dlg[data-screen="SCR-OFC-41"]');
      await dlg.waitFor({ state: 'visible' });
      await dlg.locator('#bw-ta-name').fill(name);
      await dlg.locator('#bw-ta-email').fill(`hana.${engine}@brightwaterair.example`);
      await dlg.locator('.cks span', { hasText: 'Plumbing' }).click();
      await dlg.locator('.hrs').click();
      const hours = dlg.locator('[data-ctl="CTL-OFC-41-06"]');
      await hours.getByLabel('Fri off').click();
      await hours.getByLabel('Mon start').fill('07:00');
      await hours.getByLabel('Mon end').fill('06:00');
      const submit = dlg.locator('[data-ctl="CTL-OFC-41-07"]');
      await expect.poll(() => dlg.locator('.r1-fmsg').innerText()).toBe('The end must be after the start.');
      expect(await submit.getAttribute('aria-disabled')).toBe('true');
      await hours.getByLabel('Mon end').fill('15:30');
      await hours.getByLabel('Saturdays').selectOption('odd_weeks');
      await submit.click();
      await expect.poll(() => dlg.locator('p').first().innerText(), { timeout: 15_000 }).toContain('was added.');
      expect((await list(ctx)).technicians.find((t) => t.name === name)).toMatchObject({ workingHours: { start: '07:00', end: '15:30' }, workingDays: [1, 2, 3, 4], saturdays: 'odd_weeks' });
    });
  });

  // why: FR-DISP-33 a technician an office user adds to Dayton appears on the Dayton board, is listed Invited on the Technicians page and on the users page, and once the invite is accepted the page shows Active
  // why: FR-DISP-1 Her day on the board carries the technician's branch: a Dayton technician's link opens the Dayton board with their row (CTL-OFC-07-07)
  it('adds a technician to Dayton through to Active, and the board link opens their branch', async () => {
    const name = `Dee Dayton ${plan.tag}`;
    const email = `dee.${engine}@brightwaterair.example`;
    const ready = `${SCREEN} .pgh h1`;
    let link = '';
    await open(async (p, ctx) => {
      await expect.poll(() => p.locator(`${SCREEN} [data-ctl="CTL-OFC-07-25"]`).innerText(), { timeout: 15_000 }).toContain('Updated');
      await p.locator(`${SCREEN} .pgh [data-ctl="CTL-OFC-07-13"]`).click();
      const dlg = p.locator('.r1-dlg[data-screen="SCR-OFC-41"]');
      await dlg.waitFor({ state: 'visible' });
      expect(await dlg.locator('#bw-ta-branch').inputValue()).toBe('dayton');
      await dlg.locator('#bw-ta-name').fill(name);
      await dlg.locator('#bw-ta-email').fill(email);
      await dlg.locator('.cks span', { hasText: 'Plumbing' }).click();
      await dlg.locator('[data-ctl="CTL-OFC-41-07"]').click();
      await expect.poll(() => dlg.locator('p').first().innerText(), { timeout: 15_000 }).toContain('was added.');
      link = (await dlg.locator('a[data-ctl="CTL-OFC-41-08"]').getAttribute('href')) as string;
      await dlg.locator('.r1-dlg-f [data-ctl="CTL-OFC-41-09"]').click();
      expect((await list(ctx, 'dayton')).technicians.find((t) => t.name === name)).toMatchObject({ userStatus: 'invited', branch: 'dayton' });
      await expect.poll(async () => (await cells(p, name))[0]).toContain('Invited');
      await p.locator(ROWS, { hasText: name }).click();
      const go = p.locator(`${SCREEN} .det [data-ctl="CTL-OFC-07-07"]`);
      expect(await go.getAttribute('href')).toBe('/office/board?branch=dayton');
      await go.click();
      await expect.poll(() => p.url(), { timeout: 15_000 }).toContain('/office/board?branch=dayton');
      await p.locator('.tl-row', { hasText: name }).waitFor({ state: 'visible', timeout: 15_000 });
    }, session, '/office/technicians?branch=dayton', ready);

    // The users page (a manager's) lists them Invited, with Dayton.
    await open(async (p) => {
      await p.locator('[data-ctl="CTL-OFC-43-02"] input').fill(email);
      const row = p.locator('table.u tbody tr', { hasText: email });
      await row.waitFor({ state: 'visible', timeout: 15_000 });
      expect(await row.locator('.chip').textContent()).toContain('Invited');
      expect(await row.textContent()).toContain('Dayton');
    }, managerSession, '/office/admin/users', '[data-screen="SCR-OFC-43"] table.u');

    // The technician accepts: the invite email's button, then a password.
    const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 900 } });
    try {
      const mail = await g.context.newPage();
      await postOrigin(mail);
      await mail.goto(origin + link, { waitUntil: 'load' });
      await mail.locator('[data-ctl="CTL-EML-01-03"]').waitFor({ state: 'visible', timeout: 15_000 });
      await expect.poll(() => mail.evaluate(() => {
        const el = (globalThis as unknown as { document: { querySelector(s: string): object | null } }).document.querySelector('[data-screen]');
        return el !== null && Object.keys(el).some((k) => k.startsWith('__react'));
      })).toBe(true);
      await mail.locator('[data-ctl="CTL-EML-01-03"]').click();
      await mail.locator('#sp-password').waitFor({ state: 'visible', timeout: 15_000 });
      await expect.poll(() => mail.evaluate(() => {
        const el = (globalThis as unknown as { document: { querySelector(s: string): object | null } }).document.querySelector('[data-screen]');
        return el !== null && Object.keys(el).some((k) => k.startsWith('__react'));
      })).toBe(true);
      await mail.fill('#sp-password', randomBytes(15).toString('base64url'));
      await mail.locator('[data-ctl="CTL-EML-02-04"]').click();
      await mail.waitForURL('**/tech/sign-in?set=1', { timeout: 15_000 });
    } finally {
      await g.context.close();
    }
    await open(async (p, ctx) => {
      await expect.poll(async () => (await list(ctx, 'dayton')).technicians.find((t) => t.name === name)?.userStatus).toBe('active');
      await expect.poll(async () => (await cells(p, name))[0], { timeout: 15_000 }).toContain('Active');
    }, session, '/office/technicians?branch=dayton', ROWS);
  });

  // why: FR-DISP-10 the top bar's Technicians item opens this page for the roles FR-AUTH-1 allows (office and manager); a technician is refused
  it('opens the page from the top bar\'s Technicians item for the office user and the manager, and refuses a technician', async () => {
    for (const who of [session, managerSession]) {
      await open(
        async (p) => {
          await p.locator('.topbar nav a', { hasText: /^Technicians$/ }).click();
          await expect.poll(() => new URL(p.url()).pathname, { timeout: 15_000 }).toBe('/office/technicians');
          await p.waitForSelector(ROWS, { state: 'attached' });
        },
        who!,
        '/office/jobs',
        '.r1-screen[data-screen="SCR-OFC-30"]',
      );
    }
    const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 900 } });
    try {
      await g.context.addCookies([{ name: 'bw_session', value: techSession!, url: origin, httpOnly: true }]);
      const p = await g.context.newPage();
      const res = await p.goto(origin + '/office/technicians', { waitUntil: 'load' });
      expect(res?.status()).toBe(403);
    } finally {
      await g.context.close();
    }
  });
});
