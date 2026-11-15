// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-23, UC-15 (P4-WEEK Acceptance: Playwright on Chromium and WebKit against the Compose stack at its default settings)
// The Week board (SCR-OFC-34) against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running),
// through its proxy, outside-origin guard on: the week of Sep 14 shows Wed and Fri as peak days, each cell's count equals the count
// API-132 answers, a cell opens the day board on its date, and a change made by another person re-reads the grid in place and posts
// API-172 once. Run by ci/shell-stack.sh after the shell suite and before the clock banner suite (which jumps the shared clock), on
// the same stack: the shell fixture (ci/shell-stack/fixture.sql: the clock row at Tue, Sep 15, 10:41 AM, the office user and her
// session, whose token the script hands over as BW_SHELL_STACK_SESSION) and then ./fixture.sql (12 technicians, their week of jobs,
// the 2 peak days). A *.stack.ts file: its own config runs it.
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';

const base = process.env.BW_SHELL_STACK_URL;
if (!base) throw new Error('BW_SHELL_STACK_URL is not set: run ci/shell-stack.sh');
const origin = new URL(base).origin;
const session = process.env.BW_SHELL_STACK_SESSION;
if (!session) throw new Error('BW_SHELL_STACK_SESSION is not set: run ci/shell-stack.sh');
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the kernel refuses a cookie-carrying write from any other origin (SD-8).
const APP_ORIGIN = 'http://localhost:8080';
const WEEK = '/office/board/week?branch=columbus&week=2026-09-14';

interface Cell { date: string; booked: number; capacity: number; installs: number; state: string }
interface WeekAnswer {
  days: { date: string; peak: boolean; booked: number; capacity: number; unassigned: number }[];
  technicians: { id: string; name: string; installer: boolean; cells: Cell[] }[];
  unassignedJobs: { jobNumber: number; day: string }[];
}

/** A write from the page reaches the real handlers carrying the default stack's origin (the proxy's port is not APP_ORIGIN). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
    return r.fulfill({ response });
  });
}

describe.each(engines)('the week board on the Compose stack, %s', (_engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open<T>(fn: (p: Page, ctx: BrowserContext) => Promise<T>): Promise<T> {
    const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 900 } });
    try {
      await g.context.addCookies([{ name: 'bw_session', value: session!, url: origin, httpOnly: true }]);
      const p = await g.context.newPage();
      await writeOrigin(p);
      const res = await p.goto(origin + WEEK, { waitUntil: 'load' });
      expect(res?.status()).toBe(200);
      await p.waitForSelector('.r1-screen[data-screen="SCR-OFC-34"] .wk .c', { state: 'attached' });
      return await fn(p, g.context);
    } finally {
      await g.context.close();
    }
  }

  const read = async (ctx: BrowserContext): Promise<WeekAnswer> => {
    const r = await ctx.request.get(`${origin}/api/v1/board/week?branch=columbus&week=2026-09-14`);
    expect(r.status()).toBe(200);
    return ((await r.json()) as { data: WeekAnswer }).data;
  };
  /** The grid's rows as the page draws them: the 7 header cells, then 7 children per row (label and 6 days). */
  const grid = (p: Page) =>
    p.evaluate(() => {
      const wk = (globalThis as unknown as { document: { querySelector(s: string): { children: ArrayLike<{ textContent: string | null; className: string }> } } }).document.querySelector('.wk');
      const kids = Array.from(wk.children, (c) => ({ text: (c.textContent ?? '').replace(/\s+/g, ' ').trim(), cls: c.className }));
      const head = kids.slice(0, 7);
      const rows: { text: string; cls: string }[][] = [];
      for (let i = 7; i + 6 < kids.length; i += 7) rows.push(kids.slice(i, i + 7));
      return { head, rows };
    });

  // why: FR-DISP-23 the week of Sep 14 shows Wed and Fri as peak days, with the Peak tag, the peak panel and the Peak days tile
  it('shows Wed, Sep 16 and Fri, Sep 18 as the week\'s peak days', async () => {
    await open(async (p, ctx) => {
      const g = await grid(p);
      const peakHeads = g.head.slice(1).filter((h) => h.cls.includes('peak')).map((h) => h.text);
      expect(peakHeads).toHaveLength(2);
      expect(peakHeads[0]).toMatch(/^Wed, Sep 16.*Peak/);
      expect(peakHeads[1]).toMatch(/^Fri, Sep 18.*Peak/);
      expect(g.head.slice(1).filter((h) => h.cls.includes('today')).map((h) => h.text)[0]).toMatch(/^Tue, Sep 15.*Today/);
      expect(await p.locator('.pkd b').textContent()).toBe('Wed, Sep 16 and Fri, Sep 18');
      expect(await p.locator('.pkd small').textContent()).toContain('Wed, Sep 16, Heat advisory, switched by Dana R., Mon, Sep 14, 4:10 PM.');
      expect(await p.locator('.tile.peak .num').textContent()).toBe('2');
      expect((await read(ctx)).days.map((d) => d.peak)).toEqual([false, false, true, false, true, false]);
    });
  });

  // why: FR-DISP-23 each cell's count equals the count API-132 answers (jobs booked of the day's capacity), the totals include the Unassigned jobs
  it('draws every cell with the booked and capacity the API answers', async () => {
    await open(async (p, ctx) => {
      const api = await read(ctx);
      const g = await grid(p);
      // row 0: Unassigned, rows 1 to 12: the technicians, row 13: the totals
      expect(g.rows).toHaveLength(api.technicians.length + 2);
      api.technicians.forEach((t, r) => {
        t.cells.forEach((c, i) => {
          const text = g.rows[r + 1]![i + 1]!.text;
          if (c.state === 'day_off') expect(text, `${t.name} ${c.date}`).toBe('Day off');
          else if (t.installer && c.installs > 0) expect(text, `${t.name} ${c.date}`).toMatch(new RegExp(`^${c.installs}install`));
          else expect(text, `${t.name} ${c.date}`).toMatch(new RegExp(`^${c.booked}of ${c.capacity}(Done|Full|\\d+ open)$`));
        });
      });
      api.days.forEach((d, i) => {
        expect(g.rows[0]![i + 1]!.text, d.date).toMatch(new RegExp(`^${d.unassigned}jobs?`));
        expect(g.rows[g.rows.length - 1]![i + 1]!.text, d.date).toMatch(new RegExp(`^${d.booked}of ${d.capacity}\\d+%$`));
      });
    });
  });

  // why: UC-15 a cell opens the day board on its date, and so does the day's header
  it('opens the day board on the picked date from a cell and from a day header', async () => {
    await open(async (p) => {
      const carter = p.locator('.wk > .who', { hasText: 'Jamal Carter' });
      expect(await carter.count()).toBe(1);
      // the cells in document order: 6 Unassigned, then each technician's 6 (Bell 6 to 11, Carter 12 to 17): Carter's Wed is the 15th
      await p.locator('.wk .c').nth(14).click();
      await expect.poll(() => new URL(p.url()).pathname + new URL(p.url()).search).toBe('/office/board?branch=columbus&date=2026-09-16');
    });
    await open(async (p) => {
      await p.locator('.wk .hd', { hasText: 'Fri, Sep 18' }).locator('a.bw-wk-day').click();
      await expect.poll(() => new URL(p.url()).pathname + new URL(p.url()).search).toBe('/office/board?branch=columbus&date=2026-09-18');
    });
  });

  // why: F-1538 (F-1537 class) the Week toggle on a day that is not a Monday opens the week that holds it, not a 422: Tue, Sep 15 -> the week of Sep 14
  it('opens the week of Sep 14 from the day board on Tue, Sep 15 with the Week toggle', async () => {
    const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 900 } });
    try {
      await g.context.addCookies([{ name: 'bw_session', value: session!, url: origin, httpOnly: true }]);
      const p = await g.context.newPage();
      await writeOrigin(p);
      // The toggle reads the shown day from the loaded board, so the click waits for the board's answer (API-23 or whichever path answers it).
      const answered = p.waitForResponse((r) => /\/api\/v1\/board\?/.test(r.url()) && r.request().method() === 'GET');
      const res = await p.goto(`${origin}/office/board?branch=columbus&date=2026-09-15`, { waitUntil: 'load' });
      expect(res?.status()).toBe(200);
      await answered;
      // The page is hydrated and live once its status pill reads Live; before that the toggle's handler may not be attached.
      await expect.poll(() => p.locator('.bw-live .r1-live').first().textContent(), { timeout: 20_000 }).toBe('Live');
      await p.locator('[role="radio"]', { hasText: 'Week' }).first().dispatchEvent('click'); // dispatched: the toggle never passes Playwright's stable check on the live board, so a pointer click lands off it
      await expect.poll(() => new URL(p.url()).pathname + new URL(p.url()).search, { timeout: 15_000 }).toBe('/office/board/week?branch=columbus&week=2026-09-14');
      await p.waitForSelector('.r1-screen[data-screen="SCR-OFC-34"] .wk .c', { state: 'attached' });
      expect((await grid(p)).head[1]!.text).toMatch(/^Mon, Sep 14/);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-DISP-23 a change made by another person re-reads the grid in place (EVT-01), and the finished re-read posts API-172 once (OI-48, SD-43)
  it('re-reads the grid in place when a job is assigned, and posts the board delay sample', async () => {
    await open(async (p, ctx) => {
      await expect.poll(() => p.locator('.bw-live .r1-live').first().textContent()).toBe('Live');
      const before = await read(ctx);
      // The first job with no technician, and a technician with room that day (Carter on Tue, Hoffman on Thu, ...).
      const job = before.unassignedJobs[0]!;
      const col = before.days.findIndex((d) => d.date === job.day);
      const tech = before.technicians.find((t) => !t.installer && t.cells[col]!.state === 'has_room')!;
      const posted: number[] = [];
      p.on('response', (r) => {
        if (r.url().endsWith('/api/v1/board-delay-samples') && r.request().method() === 'POST') posted.push(r.status());
      });
      const was = tech.cells[col]!.booked;
      const w = await ctx.request.post(`${origin}/api/v1/jobs/${job.jobNumber}/assignment`, { headers: { origin: APP_ORIGIN }, data: { technicianId: tech.id, baseVersion: 1 } });
      expect(w.status(), await w.text()).toBe(200);
      const row = p.locator('.wk > .who', { hasText: tech.name });
      expect(await row.count()).toBe(1);
      // no reload: the same page shows the technician's cell 1 job higher, and 1 fewer unassigned
      await expect
        .poll(async () => {
          const g = await grid(p);
          const i = before.technicians.findIndex((t) => t.id === tech.id);
          return /^\d+of \d+/.exec(g.rows[i + 1]![col + 1]!.text)?.[0];
        }, { timeout: 15_000 })
        .toBe(`${was + 1}of ${tech.cells[col]!.capacity}`);
      await expect
        .poll(async () => /^\d+/.exec((await grid(p)).rows[0]![col + 1]!.text)?.[0], { timeout: 15_000 })
        .toBe(String(before.days[col]!.unassigned - 1));
      await expect.poll(() => posted.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      expect(posted.every((s) => s === 204), `API-172 answered ${posted.join(',')}`).toBe(true);
    });
  });
});
