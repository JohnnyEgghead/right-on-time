// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-24, FR-DISP-10, F-293 (P4-JOBS Acceptance: Playwright on Chromium and WebKit against the Compose stack at its default settings)
// The Jobs list (SCR-OFC-30) against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running), through its
// proxy, outside-origin guard on: on Sep 15 the Needs attention group leads with the 3 unassigned jobs, each tab count equals an API count,
// the Booked by column reads Online, Office - <the person> and Old system for the planted jobs (F-293), Not in billing lists a past day's job,
// the search text goes in the request body only, the top bar's Jobs item opens the page for the office user and the manager (a technician is
// refused), and a change made by another person re-reads the rows in place. Run by ci/shell-stack.sh after the shell suite and before the
// week board suite, on the same stack: the shell fixture (the clock row at Tue, Sep 15, 10:41 AM, the office user and her session, whose token
// the script hands over as BW_SHELL_STACK_SESSION) and then ./fixture.sql (2 technicians, 6 customers, 10 jobs, a manager and a technician with
// sessions: BW_JOBS_STACK_MANAGER, BW_JOBS_STACK_TECH). A *.stack.ts file: its own config runs it.
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';

const base = process.env.BW_SHELL_STACK_URL;
if (!base) throw new Error('BW_SHELL_STACK_URL is not set: run ci/shell-stack.sh');
const origin = new URL(base).origin;
const session = process.env.BW_SHELL_STACK_SESSION;
if (!session) throw new Error('BW_SHELL_STACK_SESSION is not set: run ci/shell-stack.sh');
const managerSession = process.env.BW_JOBS_STACK_MANAGER;
const techSession = process.env.BW_JOBS_STACK_TECH;
if (!managerSession || !techSession) throw new Error('BW_JOBS_STACK_MANAGER and BW_JOBS_STACK_TECH are not set: run ci/shell-stack.sh');
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the kernel refuses a cookie-carrying write from any other origin (SD-8).
const APP_ORIGIN = 'http://localhost:8080';
const SCREEN = '.r1-screen[data-screen="SCR-OFC-30"]';
const TABS = ['all', 'unassigned', 'at-risk', 'late', 'not-in-billing'] as const;

interface Answer {
  counts: { all: number; unassigned: number; atRisk: number; late: number; notInBilling: number };
  rows: { jobNumber: number; bookedVia: string; bookedBy: string | null; technician: string | null; needsAttention: boolean }[];
  total: number;
}

/** A POST from the page reaches the real handlers carrying the default stack's origin (the proxy's port is not APP_ORIGIN): the list's read is a POST. */
async function postOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
    return r.fulfill({ response });
  });
}

describe.each(engines)('the jobs list on the Compose stack, %s', (_engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open<T>(
    fn: (p: Page, ctx: BrowserContext) => Promise<T>, who = session!, path = '/office/jobs', ready = `${SCREEN} table[data-ctl="CTL-OFC-30-10"] tbody tr`,
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

  const list = async (ctx: BrowserContext, body: Record<string, unknown> = {}): Promise<Answer> => {
    const r = await ctx.request.post(`${origin}/api/v1/job-searches`, { headers: { origin: APP_ORIGIN }, data: { branch: 'columbus', ...body } });
    expect(r.status(), await r.text()).toBe(200);
    return ((await r.json()) as { data: Answer }).data;
  };
  /** The table's job rows as the page draws them: the job number and the cells' text. */
  const lines = (p: Page) =>
    p.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ className: string; textContent: string | null; children: ArrayLike<{ textContent: string | null }> }> } }).document;
      return Array.from(d.querySelectorAll('table[data-ctl="CTL-OFC-30-10"] tbody tr'), (tr) => ({
        group: tr.className.includes('day'),
        cells: Array.from(tr.children, (c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()),
      }));
    });

  // why: FR-DISP-24 on Sep 15 the Needs attention group leads with the 3 unassigned jobs, and each tab count equals the count API-133 answers
  it('leads with the 3 unassigned jobs under Needs attention, and each tab count equals an API count', async () => {
    await open(async (p, ctx) => {
      const rows = await lines(p);
      expect(rows[0]).toMatchObject({ group: true });
      expect(rows[0]!.cells[0]).toBe('Needs attention');
      expect(rows.slice(1, 4).map((r) => r.cells[0])).toEqual(['24800', '26001', '26002']);
      for (const r of rows.slice(1, 4)) expect(r.cells[5], r.cells[0]).toMatch(/^Unassigned/);
      expect(rows[4]!.group).toBe(true);
      expect(rows[4]!.cells[0]).toBe('Today, Tue, Sep 15');
      const all = await list(ctx);
      expect(all.rows.slice(0, 3).map((r) => r.jobNumber)).toEqual([24800, 26001, 26002]);
      const counts = [all.counts.all, all.counts.unassigned, all.counts.atRisk, all.counts.late, all.counts.notInBilling];
      expect(counts[1]).toBe(3);
      for (const [i, tab] of TABS.entries()) {
        const badge = await p.locator(`${SCREEN} .tabs a`).nth(i).locator('.n').textContent();
        expect([tab, Number(badge)]).toEqual([tab, counts[i]]);
        await p.locator(`${SCREEN} .tabs a`).nth(i).click();
        await expect.poll(async () => (await lines(p)).filter((r) => !r.group).length, { timeout: 15_000 }).toBe(Math.min(counts[i]!, 50));
        expect((await list(ctx, { tab })).total).toBe(counts[i]);
      }
    });
  });

  // why: F-293 CTL-OFC-30-20 the Booked by column reads Online, Office - <the person> and Old system for the planted online, office and seed jobs
  it('reads Online, Office - Keisha T. and Old system in the Booked by column', async () => {
    await open(async (p, ctx) => {
      const rows = await lines(p);
      const by = (n: string) => rows.find((r) => r.cells[0] === n)!.cells[6];
      expect(by('26001')).toBe('Office - Keisha T.');
      expect(by('24800')).toBe('Office - Keisha T.');
      expect(by('26002')).toBe('Online');
      expect(by('26005')).toBe('Old system');
      const api = await list(ctx);
      const v = (n: number) => api.rows.find((r) => r.jobNumber === n)!;
      expect([v(26001).bookedVia, v(26001).bookedBy]).toEqual(['office', 'Keisha Thompson']);
      expect([v(26002).bookedVia, v(26002).bookedBy]).toEqual(['online', null]);
      expect([v(26005).bookedVia, v(26005).bookedBy]).toEqual(['seed', null]);
    });
  });

  // why: FR-DISP-24 UD-44 the Not in billing tab lists the retrying and waiting jobs whatever their day, and links to the billing page
  it('lists the jobs not in billing, a past day\'s too, and links to the billing page', async () => {
    await open(async (p) => {
      await p.locator(`${SCREEN} .tabs a`).nth(4).click();
      await expect.poll(async () => (await lines(p)).filter((r) => !r.group).map((r) => r.cells[0]).sort(), { timeout: 15_000 }).toEqual(['26006', '26010']);
      const rows = await lines(p);
      expect(rows.find((r) => r.cells[0] === '26006')!.cells[7]).toContain('Not in billing'); // the worker may already have moved it on (retry to waiting): either word is the list's
      expect(rows.find((r) => r.cells[0] === '26010')!.cells[7]).toMatch(/Not in billing.*Waiting for a person/);
      const link = p.locator(`${SCREEN} a[data-ctl="CTL-OFC-30-15"]`);
      expect(await link.getAttribute('href')).toBe('/office/billing?branch=columbus');
      await link.click();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/office/billing');
    });
  });

  // why: NFR-05 FR-DISP-24 the search text goes in the request body only (never the URL), finds a customer or a phone, and Clear filters restores the list
  it('sends the search in the request body only, finds by name and phone, and clears', async () => {
    await open(async (p) => {
      const sent: { url: string; body: string | null }[] = [];
      p.on('request', (r) => {
        if (r.url().includes('/api/v1/job-searches')) sent.push({ url: r.url(), body: r.postData() });
      });
      const box = p.locator(`${SCREEN} .sbox input`);
      await box.fill('Hendricks');
      await expect.poll(async () => (await lines(p)).filter((r) => !r.group).map((r) => r.cells[0]), { timeout: 15_000 }).toEqual(['26001']);
      expect(sent.some((s) => s.body?.includes('Hendricks'))).toBe(true);
      expect(sent.every((s) => !s.url.includes('Hendricks'))).toBe(true);
      expect(p.url()).not.toContain('Hendricks');
      await box.fill('555-0177');
      await expect.poll(async () => (await lines(p)).filter((r) => !r.group).map((r) => r.cells[0]), { timeout: 15_000 }).toEqual(['26001']);
      await box.fill('zzzz nothing');
      await expect.poll(() => p.locator(`${SCREEN} .bw-jb-note`).textContent(), { timeout: 15_000 }).toBe('No job matches zzzz nothing.');
      await p.locator(`${SCREEN} button[data-ctl="CTL-OFC-30-09"]`).click();
      await expect.poll(async () => (await lines(p)).filter((r) => !r.group).length, { timeout: 15_000 }).toBeGreaterThan(3);
      expect(await box.inputValue()).toBe('');
    });
  });

  // why: FR-DISP-10 the top bar's Jobs item opens this page for the roles FR-AUTH-1 allows (office and manager); a technician is refused
  it('opens the page from the top bar\'s Jobs item for the office user and the manager, and refuses a technician', async () => {
    for (const who of [session, managerSession]) {
      await open(
        async (p) => {
          await p.locator('.topbar nav a', { hasText: /^Jobs$/ }).click();
          await expect.poll(() => new URL(p.url()).pathname, { timeout: 15_000 }).toBe('/office/jobs');
          await p.waitForSelector(`${SCREEN} table[data-ctl="CTL-OFC-30-10"] tbody tr`, { state: 'attached' });
        },
        who!,
        '/office/billing',
        '.r1-screen[data-screen="SCR-OFC-10"]',
      );
    }
    const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 900 } });
    try {
      await g.context.addCookies([{ name: 'bw_session', value: techSession!, url: origin, httpOnly: true }]);
      const p = await g.context.newPage();
      const res = await p.goto(origin + '/office/jobs', { waitUntil: 'load' });
      expect(res?.status()).toBe(403);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-DISP-24 a change made by another person re-reads the rows in place (EVT-01): a job moved to the other technician shows the new name without a reload
  it('re-reads the rows in place when another person reassigns a job', async () => {
    await open(async (p, ctx) => {
      await expect.poll(() => p.locator(`${SCREEN} .r1-live`).first().textContent()).toBe('Live');
      const day = await ctx.request.get(`${origin}/api/v1/board?branch=columbus&date=2026-09-16`);
      expect(day.status()).toBe(200);
      const board = ((await day.json()) as { data: { technicians: { id: string; name: string; jobs: { jobNumber: number; version: number }[] }[] } }).data;
      const mine = board.technicians.find((t) => t.jobs.some((j) => j.jobNumber === 26007))!;
      const other = board.technicians.find((t) => ['Zed Zimmer', 'Zoe Zook'].includes(t.name) && t.id !== mine.id)!;
      const version = mine.jobs.find((j) => j.jobNumber === 26007)!.version;
      const row = p.locator(`${SCREEN} tbody tr`, { has: p.locator('a.jl', { hasText: /^26007$/ }) });
      expect(await row.textContent()).toContain(mine.name);
      const w = await ctx.request.post(`${origin}/api/v1/jobs/26007/assignment`, { headers: { origin: APP_ORIGIN }, data: { technicianId: other.id, baseVersion: version } });
      expect(w.status(), await w.text()).toBe(200);
      await expect.poll(async () => (await row.textContent()) ?? '', { timeout: 20_000 }).toContain(other.name);
    });
  });
});
