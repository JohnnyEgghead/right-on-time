// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-24, FR-DISP-8, FR-TEXT-15, FR-AUTH-12 (K-08.1, K-08.2, K-08.4, K-08.5, K-08.16, K-08.17, K-08.18, K-08.19, K-08.20; P10-OFFICE-LISTS: the office list screens read once, read the right thing, and keep what the person set)
// Playwright on Chromium and WebKit against the harness app (ci/web-app.ts). The screens render live at /shell-preview/office-lists/<name> (jobs, new-job)
// and /shell-preview/live-reads/<name> (messages, users); every /api/v1 read is answered by the test, which counts the reads and sees what each one
// asked. Run with the page walkers (ci/gates/page-walkers*.sh). The outside-origin guard is on for every page.
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { guardedContext } from './origin-guard.ts';
import { fixtures, rig, ZONE, type Answer, type Rec, type Rig } from './rig.ts';

const [acc, jobs, msg, nj, shell] = await Promise.all([
  fixtures<Rec>('accounts/preview-fixtures.ts'),
  fixtures<Rec>('jobs/jobs-fixtures.ts'),
  fixtures<Rec>('messages/preview-data.ts'),
  fixtures<Rec>('newjob/preview-data.ts'),
  fixtures<Rec>('shell/preview-fixtures.ts'),
]);
const { AREAS, SEARCH, CHANGES } = acc;
const { JOBS_SUCCESS } = jobs;
const { LOG_SUCCESS } = msg;
const { NJ_CUSTOMER, NJ_SERVICES, NJ_TECHS } = nj;
const { CLOCK_RUNNING } = shell;

let app: WebApp;
beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('the office lists on %s', (_name, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // F-2108: each case's first wait after open is for the page load (it hydrates, then sends its first read and draws it), bounded like
  // rig.next's reads; every wait after it is for what the live page does, with the default bound.
  const LOAD_MS = 15_000;
  async function open(path: string, setup: (r: Rig) => void, clock?: string) {
    const g = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await g.context.newPage();
    if (clock) await page.clock.install({ time: new Date(clock) });
    const r = await rig(page);
    setup(r);
    await page.goto(app.origin + path, { waitUntil: 'domcontentloaded' });
    return { page, r, close: () => g.context.close() };
  }

  // why: FR-DISP-24 K-08 row 2 a tab click rewrote the address to ?tab= alone, so a page opened with ?branch= lost the branch from the address and showed the stored or home branch after the next read
  it('jobs: a tab click keeps the branch of the address', async () => {
    const { page, r, close } = await open('/shell-preview/office-lists/jobs?branch=dayton', (x) => {
      x.on('POST /job-searches', () => ({ contract: 'API-133', data: JOBS_SUCCESS }));
      x.on('GET /me', () => ({ contract: 'API-07', data: { branch: 'columbus' } }));
    });
    try {
      await expect.poll(() => r.count('POST /job-searches'), { timeout: LOAD_MS }).toBeGreaterThan(0);
      expect((r.all('POST /job-searches')[0]!.body as Rec).branch).toBe('dayton');
      const before = r.count('POST /job-searches');
      await page.getByRole('tab').nth(3).click();
      await expect.poll(() => r.count('POST /job-searches')).toBeGreaterThan(before);
      await page.waitForTimeout(500);
      const last = r.all('POST /job-searches').at(-1)!.body as Rec;
      expect([last.tab, last.branch]).toEqual(['late', 'dayton']);
      expect(new URL(page.url()).searchParams.get('branch')).toBe('dayton');
    } finally {
      await close();
    }
  });

  const newJobPath = `/shell-preview/office-lists/new-job?customer=${NJ_CUSTOMER.id}&date=2026-09-17`;
  const W = (n: number) => `0192f000-0000-7000-8000-00000000010${n}`;
  const day = (date: string, left = 4) => ({
    date, mode: 'two_hour', state: 'open', reason: null, left,
    windows: [1, 2].map((n) => ({ windowId: W(n), start: `${date}T${n === 1 ? '08' : '10'}:00:00-04:00${ZONE}`, end: `${date}T${n === 1 ? '10' : '12'}:00:00-04:00${ZONE}`, state: 'open', left: 2 })),
  });
  const days = [day('2026-09-16'), day('2026-09-17'), day('2026-09-18')];
  // F-2074: the full API-10 answer (demoNow, realNow, replay, resetAvailableInSeconds), so every new-job case runs with the clock read working.
  const fullClock = (at: string) => ({ ...CLOCK_RUNNING, demoNow: `${at}${ZONE}`, realNow: `${at}${ZONE}`, replay: { running: false, done: 0, total: 0 }, resetAvailableInSeconds: 0 });
  const newJobSetup = (x: Rig, create?: () => Answer, clock: () => unknown = () => fullClock('2026-09-15T12:00:00-04:00')) => {
    x.on('GET /customers/:id', () => ({ contract: 'API-35', data: NJ_CUSTOMER }));
    x.on('GET /public/services', () => ({ contract: 'API-110', data: { services: NJ_SERVICES } }));
    x.on('GET /availability', () => ({ contract: 'API-29', data: { days } }));
    x.on('GET /technicians/room', () => ({ contract: 'API-30', data: NJ_TECHS }));
    x.on('GET /clock', () => ({ contract: 'API-10', data: clock() }));
    if (create) x.on('POST /jobs', create);
  };
  const pickService = async (page: Page) => {
    await page.locator('[data-ctl="CTL-OFC-04-03"] button').nth(4).click();
  };

  // why: FR-DISP-8 K-08 row 16 a page opened with a date from the board read the days again on the first day click, because the wanted date was a dependency of the read
  it('new job: the first day click reads no availability again', async () => {
    const { page, r, close } = await open(newJobPath, (x) => newJobSetup(x));
    try {
      await pickService(page);
      await expect.poll(() => r.count('GET /availability')).toBe(1);
      await expect.poll(() => page.locator('[data-ctl="CTL-OFC-04-06"] button').count()).toBe(3);
      await page.locator('[data-ctl="CTL-OFC-04-06"] button').nth(0).click();
      await expect.poll(() => page.locator('[data-ctl="CTL-OFC-04-07"] button').count()).toBeGreaterThan(0);
      await page.waitForTimeout(500);
      expect(r.count('GET /availability')).toBe(1);
    } finally {
      await close();
    }
  });

  /** An answer the test holds until it says so. */
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((res) => (open = res));
    return { opened, open };
  };
  const lastBody = (r: Rig, key: string) => r.all(key).at(-1)!.body as Rec;

  // why: FR-DISP-24 K-08 row 1 a branch change in the top bar kept the page number, so page 3 of one branch was asked of the next
  it('jobs: page 3 then a branch change sends page 1', async () => {
    const { page, r, close } = await open('/shell-preview/office-lists/jobs?branch=columbus', (x) => {
      x.on('POST /job-searches', () => ({ contract: 'API-133', data: JOBS_SUCCESS }));
    });
    try {
      await expect.poll(() => r.count('POST /job-searches'), { timeout: LOAD_MS }).toBeGreaterThan(0);
      await page.locator('[data-ctl="CTL-OFC-30-12"] .pp [role="button"]', { hasText: /^3$/ }).click();
      await expect.poll(() => lastBody(r, 'POST /job-searches').page).toBe(3);
      await page.evaluate("window.history.pushState(null, '', '?branch=dayton')");
      await expect.poll(() => lastBody(r, 'POST /job-searches').branch).toBe('dayton');
      await page.waitForTimeout(300);
      expect(lastBody(r, 'POST /job-searches').page).toBe(1);
      // F-2072: no read for the new branch carried the old page number (the reset was an effect, so a page-3 read of dayton was sent first)
      const forDayton = r.all('POST /job-searches').map((c) => c.body as Rec).filter((b) => b.branch === 'dayton');
      expect(forDayton.map((b) => b.page)).toEqual([1]);
    } finally {
      await close();
    }
  });

  // why: FR-DISP-24 K-08 row 1 a page past the last page (the list shrank) showed an empty list with no way back; the page goes to the last page
  it('jobs: a page past the last page goes to the last page', async () => {
    const { page, r, close } = await open('/shell-preview/office-lists/jobs?branch=columbus', (x) => {
      x.on('POST /job-searches', (n) => ({ contract: 'API-133', data: n === 1 ? JOBS_SUCCESS : { ...JOBS_SUCCESS, rows: [], pages: 2, total: 60 } }));
    });
    try {
      await expect.poll(() => r.count('POST /job-searches'), { timeout: LOAD_MS }).toBeGreaterThan(0);
      await page.locator('[data-ctl="CTL-OFC-30-12"] .pp [role="button"]', { hasText: /^3$/ }).click();
      await expect.poll(() => lastBody(r, 'POST /job-searches').page).toBe(2);
    } finally {
      await close();
    }
  });

  const messagesPath = '/shell-preview/live-reads/messages?branch=columbus&date=2026-09-15';
  const withTries = (tries: number) => ({ ...LOG_SUCCESS, texts: LOG_SUCCESS.texts.map((t: Rec) => (t.id.endsWith('03') ? { ...t, tries } : t)) });

  // why: FR-TEXT-15 K-08 row 5 each text event made a read of the log at once, so 3 events together made 3 reads; a read in flight is joined and 1 more follows
  it('messages: 3 text events together make at most 2 reads of the log', async () => {
    const { page, r, close } = await open(messagesPath, (x) => {
      x.on('POST /text-searches', () => ({ contract: 'API-45', data: LOG_SUCCESS }));
    });
    try {
      await expect.poll(() => page.getByText('Deborah Lin').count(), { timeout: LOAD_MS }).toBeGreaterThan(0);
      await expect.poll(() => r.streamHeld()).toBe(1);
      const before = r.count('POST /text-searches');
      r.events('text.changed', 'text.changed', 'text.changed');
      await r.flush();
      await expect.poll(() => r.count('POST /text-searches')).toBeGreaterThan(before);
      await page.waitForTimeout(600);
      expect(r.count('POST /text-searches') - before).toBeLessThanOrEqual(2);
    } finally {
      await close();
    }
  });

  // why: FR-TEXT-15 K-08 row 4 the highlight timer of an earlier change cleared the highlight of a later change early; 1 timer, re-armed by the later change
  it('messages: a second change re-arms the highlight for its whole time', async () => {
    const { page, r, close } = await open(messagesPath, (x) => {
      x.on('POST /text-searches', (n) => ({ contract: 'API-45', data: withTries(n <= 1 ? 2 : n === 2 ? 3 : 4) }));
    });
    try {
      await expect.poll(() => page.getByText('Deborah Lin').count(), { timeout: LOAD_MS }).toBeGreaterThan(0);
      await expect.poll(() => r.streamHeld()).toBe(1);
      r.events('text.changed');
      await r.flush();
      await expect.poll(() => page.locator('tr.live').count()).toBeGreaterThan(0);
      const t1 = Date.now();
      await expect.poll(() => r.streamHeld(), { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(Math.max(0, 3000 - (Date.now() - t1)));
      r.events('text.changed');
      await r.flush();
      await expect.poll(() => r.count('POST /text-searches')).toBeGreaterThan(2);
      await page.waitForTimeout(Math.max(0, 4600 - (Date.now() - t1)));
      expect(await page.locator('tr.live').count()).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  // why: FR-TEXT-15 K-08 row 4 leaving the page clears the highlight timer (the cleanup at MessagesScreen's unmount), so it never sets state on a page that is gone
  it('messages: leaving the page by a client-side move clears the armed highlight timer', async () => {
    const { page, r, close } = await open(messagesPath, (x) => {
      x.on('POST /text-searches', (n) => ({ contract: 'API-45', data: withTries(n <= 1 ? 2 : 3) }));
      x.on('POST /user-searches', () => ({ contract: 'API-43', data: SEARCH }));
    });
    try {
      await expect.poll(() => page.getByText('Deborah Lin').count(), { timeout: LOAD_MS }).toBeGreaterThan(0);
      await expect.poll(() => r.streamHeld()).toBe(1);
      // F-2074: record the 4 s timers the page arms (FRESH_MS) and the timers it clears.
      await page.evaluate(() => {
        const w = globalThis as unknown as { __armed: number[]; __cleared: number[]; setTimeout: (...a: unknown[]) => number; clearTimeout: (id?: number) => void };
        w.__armed = [];
        w.__cleared = [];
        const set = w.setTimeout.bind(globalThis);
        const clear = w.clearTimeout.bind(globalThis);
        w.setTimeout = (fn: unknown, ms?: unknown, ...rest: unknown[]) => {
          const id = set(fn, ms, ...rest);
          if (ms === 4000) w.__armed.push(id);
          return id;
        };
        w.clearTimeout = (id?: number) => {
          if (id !== undefined) w.__cleared.push(id);
          clear(id);
        };
      });
      r.events('text.changed');
      await r.flush();
      await expect.poll(() => page.locator('tr.live').count()).toBeGreaterThan(0);
      const armed = await page.evaluate(() => (globalThis as unknown as { __armed: number[] }).__armed);
      expect(armed).toHaveLength(1);
      await page.evaluate(() => (globalThis as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push('/shell-preview/live-reads/users'));
      await expect.poll(() => page.url()).toContain('/live-reads/users');
      // F-2113: the new address is written in the move's commit (Next writes history in an insertion effect), and the screen's unmount
      // cleanup runs after it, in React's passive-effect pass: so the cleared timers are waited for, not read once on the new address.
      await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __cleared: number[] }).__cleared)).toContain(armed[0]);
    } finally {
      await close();
    }
  });

  // why: FR-DISP-8 K-08 row 17 a window_full answer turned the window Full in the page only; the room the server holds was not read again
  it('new job: a window_full answer reads the availability once', async () => {
    const { page, r, close } = await open(newJobPath, (x) => newJobSetup(x, () => ({ problem: { code: 'window_full', status: 409 } })));
    try {
      await pickService(page);
      await expect.poll(() => page.locator('[data-ctl="CTL-OFC-04-06"] button').count()).toBe(3);
      await page.locator('[data-ctl="CTL-OFC-04-06"] button').nth(1).click();
      await page.locator('[data-ctl="CTL-OFC-04-07"] button').first().click();
      await page.locator('[data-ctl="CTL-OFC-04-08"] button.pick').first().click();
      const before = r.count('GET /availability');
      await page.locator('[data-ctl="CTL-OFC-04-09"]').click();
      await expect.poll(() => r.count('POST /jobs')).toBe(1);
      await page.waitForTimeout(600);
      expect(r.count('GET /availability') - before).toBe(1);
    } finally {
      await close();
    }
  });

  // why: F-2073 the local Full mark of a window_full answer was cleared in the same batch by the days going to loading; it shows until the held re-read lands
  it('new job: a window_full answer keeps the Full mark on screen while the days are read again', async () => {
    const g = gate();
    const { page, r, close } = await open(newJobPath, (x) => {
      newJobSetup(x, () => ({ problem: { code: 'window_full', status: 409 } }));
      x.on('GET /availability', async (n) => {
        if (n > 1) await g.opened;
        return { contract: 'API-29', data: { days } };
      });
    });
    try {
      await pickService(page);
      await expect.poll(() => page.locator('[data-ctl="CTL-OFC-04-06"] button').count()).toBe(3);
      await page.locator('[data-ctl="CTL-OFC-04-06"] button').nth(1).click();
      await page.locator('[data-ctl="CTL-OFC-04-07"] button').first().click();
      await page.locator('[data-ctl="CTL-OFC-04-08"] button.pick').first().click();
      await page.locator('[data-ctl="CTL-OFC-04-09"]').click();
      await expect.poll(() => r.count('GET /availability')).toBe(2); // the re-read is out and held
      await expect.poll(() => page.locator(`[data-window-id="${W(1)}"].full`).count()).toBe(1);
      g.open();
      await expect.poll(() => page.locator(`[data-window-id="${W(1)}"].full`).count()).toBe(0); // the server's room replaces the local mark
    } finally {
      await close();
    }
  });

  // why: FR-DISP-8 K-08 row 18 the days offered start at the demo day, and a demo day that moved did not read them again
  it('new job: a new demo day reads the availability again', async () => {
    let at = '2026-09-15T23:59:40-04:00';
    const { page, r, close } = await open(newJobPath, (x) => newJobSetup(x, undefined, () => fullClock(at)), '2026-09-15T12:00:00-04:00');
    try {
      await pickService(page);
      await expect.poll(() => r.count('GET /availability')).toBe(1);
      at = '2026-09-16T00:00:30-04:00';
      await page.clock.runFor(40_000);
      await expect.poll(() => r.count('GET /availability')).toBe(2);
    } finally {
      await close();
    }
  });

  const usersSetup = (x: Rig, search: (n: number, body: Rec) => Rec, turnOn: Promise<void>) => {
    const omar = SEARCH.users.find((u: Rec) => u.status === 'turned_off')!;
    x.on('POST /user-searches', (n, body) => ({ contract: 'API-149', data: search(n, body) }));
    x.on('GET /roles', () => ({ contract: 'API-151', data: { areas: AREAS } }));
    x.on('GET /users/changes', () => ({ contract: 'API-152', data: { changes: CHANGES, next: null } }));
    x.on('POST /users/:id/turn-on', async () => {
      await turnOn;
      return { contract: 'API-170', data: { user: { ...omar, status: 'active' } } };
    });
  };

  // why: FR-AUTH-12 K-08 row 19 the list read after Turn on used the filters of the moment of the press, so a filter changed while it was in flight was undone
  it('users: a filter changed while Turn on is in flight is the filter of the list read after it', async () => {
    const g = gate();
    const { page, r, close } = await open('/shell-preview/live-reads/users', (x) => usersSetup(x, () => SEARCH, g.opened));
    try {
      await expect.poll(() => page.locator('[data-ctl="CTL-OFC-43-13"]').count(), { timeout: LOAD_MS }).toBeGreaterThan(0);
      await page.locator('[data-ctl="CTL-OFC-43-13"]').first().click();
      await expect.poll(() => r.count('POST /users/:id/turn-on')).toBe(1);
      await page.locator('[data-ctl="CTL-OFC-43-03"] select').selectOption('manager');
      await expect.poll(() => lastBody(r, 'POST /user-searches').role).toBe('manager');
      const before = r.count('POST /user-searches');
      g.open();
      await expect.poll(() => r.count('POST /user-searches')).toBeGreaterThan(before);
      expect(lastBody(r, 'POST /user-searches').role).toBe('manager');
    } finally {
      await close();
    }
  });

  // why: FR-AUTH-12 K-08 row 20 the last user of page 2 moved, and the page asked for stayed 2: an empty page with no pager; the page goes to the last page
  it('users: a page past the last page after a change is read again as the last page', async () => {
    let moved = false;
    const g = gate();
    g.open();
    const { page, r, close } = await open('/shell-preview/live-reads/users', (x) =>
      usersSetup(x, (_n, body) => (body.page === 1 ? SEARCH : moved ? { ...SEARCH, users: [], pages: 1, total: 6 } : { ...SEARCH, pages: 2 }), g.opened));
    try {
      await expect.poll(() => page.locator('[data-ctl="CTL-OFC-43-09"] button').count(), { timeout: LOAD_MS }).toBe(2);
      await page.locator('[data-ctl="CTL-OFC-43-09"] button').nth(1).click();
      await expect.poll(() => lastBody(r, 'POST /user-searches').page).toBe(2);
      await expect.poll(() => page.locator('[data-ctl="CTL-OFC-43-13"]').count()).toBeGreaterThan(0);
      moved = true;
      await page.locator('[data-ctl="CTL-OFC-43-13"]').first().click();
      await expect.poll(() => lastBody(r, 'POST /user-searches').page).toBe(1);
    } finally {
      await close();
    }
  });
});
