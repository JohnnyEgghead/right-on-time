// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOARD-1, NFR-09 (P10-NEWEST-ANSWER, F-2007: an office read whose request changes shows the answer to the newest request, never a stale one)
// Playwright on Chromium and WebKit against the harness app (ci/web-app.ts): each live office screen is rendered at /shell-preview/live-reads/<name>,
// every /api/v1 read is held by the test, and the test answers the second read first and the first read last. The screen must show the second
// read's data. Run with the page walkers (ci/gates/page-walkers*.sh). The outside-origin guard is on for every page.
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { guardedContext } from './origin-guard.ts';
import { DEMO_NOW, fixtures, rig, type Rec, type Rig } from './rig.ts';

const [acc, imp, msg, shell, win] = await Promise.all([
  fixtures<Rec>('accounts/preview-fixtures.ts'),
  fixtures<Rec>('import/preview-data.ts'),
  fixtures<Rec>('messages/preview-data.ts'),
  fixtures<Rec>('shell/preview-fixtures.ts'),
  fixtures<Rec>('windows/preview-data.ts'),
]);
const { CHANGED, CHANGES, SEARCH, AREAS } = acc;
// F-2088: the users case needs 2 turned-off users; built here so the shared seed stays as other tests read it
const OFF = [
  SEARCH.users.find((u: Rec) => u.status === 'turned_off')!,
  { ...SEARCH.users.find((u: Rec) => u.status === 'turned_off')!, id: 'u-second-off', name: 'Second Off', email: 'soff@brightwater.example' },
];
const TWO_OFF = { ...SEARCH, users: [...SEARCH.users, OFF[1]] };
const { dupsData, MERGES, MERGES_TOTAL, runsReal } = imp;
const { LOG_EMPTY, LOG_SUCCESS } = msg;
const { CLOCK_RUNNING } = shell;
const { SETTINGS } = win;

let app: WebApp;
beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('the newest answer is the one shown on %s', (_name, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open(path: string, setup: (r: Rig) => void) {
    const g = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await g.context.newPage();
    const r = await rig(page);
    setup(r);
    await page.goto(app.origin + path, { waitUntil: 'domcontentloaded' });
    return { page, r, close: () => g.context.close() };
  }

  // why: FR-BOOK-17 K-05 the booking windows page re-reads when the branch changes, and an earlier branch's answer that landed last was shown over the newer branch's
  it('windows: the branch picked last is the one shown when the earlier branch answers last', async () => {
    const { page, r, close } = await open('/shell-preview/live-reads/windows?branch=columbus', (x) => x.hold('GET /branches/:id/booking-settings'));
    try {
      const key = 'GET /branches/:id/booking-settings';
      await (await r.next(key)).answer('API-90', SETTINGS);
      const first = page.locator('input.bw-step-in').first();
      await expect.poll(() => first.inputValue()).toBe(String(SETTINGS.windows[0]!.limit));
      const withLimit = (branch: string, limit: number) => ({ ...SETTINGS, branch, windows: SETTINGS.windows.map((w: Rec) => ({ ...w, limit })) });
      await page.evaluate("window.history.pushState(null, '', '?branch=dayton')");
      const a = await r.next(key);
      await page.evaluate("window.history.pushState(null, '', '?branch=springfield')");
      const b = await r.next(key);
      await b.answer('API-90', withLimit('springfield', 7));
      await expect.poll(() => first.inputValue()).toBe('7');
      await a.answer('API-90', withLimit('dayton', 3));
      await page.waitForTimeout(500);
      expect(await first.inputValue()).toBe('7');
    } finally {
      await close();
    }
  });

  // why: FR-IMP-3 K-05 the duplicates page re-reads for the filter picked, and the answer to an earlier filter that landed last was shown as the newer filter's
  it('duplicates: the filter picked last is the one shown when the earlier filter answers last', async () => {
    const { page, r, close } = await open('/shell-preview/live-reads/duplicates', (x) => {
      x.hold('GET /import/duplicates');
      x.auto('GET /import/runs', 'API-84', runsReal);
    });
    try {
      const d = dupsData();
      const answer = (pairs: typeof d.pairs) => ({ progress: d.progress, pairs, next: null });
      await (await r.next('GET /import/duplicates')).answer('API-85', answer(d.pairs));
      const select = page.locator('.shw select');
      await expect.poll(() => select.count()).toBe(1);
      await select.selectOption('merged');
      const a = await r.next('GET /import/duplicates');
      await select.selectOption('kept_separate');
      const b = await r.next('GET /import/duplicates');
      expect([a.url.searchParams.get('status'), b.url.searchParams.get('status')]).toEqual(['merged', 'kept_separate']);
      await b.answer('API-85', answer(d.pairs));
      await expect.poll(() => select.inputValue()).toBe('kept_separate');
      await a.answer('API-85', answer([]));
      await page.waitForTimeout(500);
      expect(await select.inputValue()).toBe('kept_separate');
    } finally {
      await close();
    }
  });

  // why: FR-IMP-4 K-05 the merge history re-reads for the name typed, and the answer to an earlier name that landed last was shown as the newer name's
  it('history: the name typed last is the one shown when the earlier name answers last', async () => {
    const { page, r, close } = await open('/shell-preview/live-reads/history', (x) => {
      x.hold('GET /import/merges', 'GET /import/duplicates', 'GET /import/runs');
    });
    try {
      await (await r.next('GET /import/runs')).answer('API-84', runsReal);
      await (await r.next('GET /import/duplicates')).answer('API-85', { progress: dupsData().progress, pairs: [], next: null });
      await (await r.next('GET /import/merges')).answer('API-87', { merges: MERGES, next: null, total: MERGES_TOTAL });
      const find = page.locator('#bw-find-merge');
      await expect.poll(() => find.count()).toBe(1);
      const item = (name: string) => ({ ...MERGES[0]!, mergeId: MERGES[0]!.mergeId, records: { a: { ...MERGES[0]!.records.a, name }, b: { ...MERGES[0]!.records.b, name } } });
      await find.fill('aaa');
      const a = await r.next('GET /import/merges');
      await find.fill('bbb');
      const b = await r.next('GET /import/merges');
      expect([a.url.searchParams.get('name'), b.url.searchParams.get('name')]).toEqual(['aaa', 'bbb']);
      await b.answer('API-87', { merges: [item('Bella Beta')], next: null, total: 1 });
      await expect.poll(() => page.getByText('Bella Beta').count()).toBeGreaterThan(0);
      await a.answer('API-87', { merges: [item('Aaron Alpha')], next: null, total: 1 });
      await page.waitForTimeout(500);
      expect(await page.getByText('Aaron Alpha').count()).toBe(0);
      await expect.poll(() => page.getByText('Bella Beta').count()).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  // why: FR-TEXT-15 K-08.3 the text log re-reads for each filter picked, and the answer to an earlier filter that landed last was shown as the newer filter's
  it('messages: the filter picked last is the one shown when the earlier filter answers last', async () => {
    const { page, r, close } = await open('/shell-preview/live-reads/messages?branch=columbus&date=2026-09-15', (x) => {
      x.hold('POST /text-searches');
    });
    try {
      await (await r.next('POST /text-searches')).answer('API-45', LOG_SUCCESS);
      await expect.poll(() => page.getByText('Deborah Lin').count()).toBeGreaterThan(0);
      const selects = page.locator('select.bw-pm-sel');
      await selects.nth(0).selectOption({ index: 1 });
      const a = await r.next('POST /text-searches');
      await selects.nth(1).selectOption({ index: 1 });
      const b = await r.next('POST /text-searches');
      expect([JSON.stringify(a.body) === JSON.stringify(b.body)]).toEqual([false]);
      await b.answer('API-45', LOG_EMPTY);
      await expect.poll(() => page.getByText('Deborah Lin').count()).toBe(0);
      await a.answer('API-45', LOG_SUCCESS);
      await page.waitForTimeout(500);
      expect(await page.getByText('Deborah Lin').count()).toBe(0);
    } finally {
      await close();
    }
  });

  // why: FR-AUTH-12 K-08.21 the changes list re-reads after each change made on the users page, and an earlier read that landed last was shown over the newer one
  it('users: the changes read last is the one shown when the earlier read answers last', async () => {
    const { page, r, close } = await open('/shell-preview/live-reads/users', (x) => {
      x.auto('POST /user-searches', 'API-149', TWO_OFF);
      x.auto('GET /roles', 'API-151', { areas: AREAS });
      x.hold('GET /users/changes', 'POST /users/:id/turn-on');
    });
    try {
      await (await r.next('GET /users/changes')).answer('API-152', { changes: CHANGES, next: null });
      const chg = page.locator('[data-ctl="CTL-OFC-43-12"]');
      await expect.poll(() => chg.innerText()).toContain('Derek Simmons');
      // F-2088: the 2 reads come from 2 different turned-off users (the server refuses a 2nd Turn on for 1 user); the case adds the 2nd user here
      const turnOn = page.locator('[data-ctl="CTL-OFC-43-13"]');
      await expect.poll(() => turnOn.count()).toBe(2);
      await turnOn.nth(0).click();
      await (await r.next('POST /users/:id/turn-on')).answer('API-170', { user: { ...OFF[0], status: 'active' } });
      const a = await r.next('GET /users/changes');
      await turnOn.nth(1).click();
      await (await r.next('POST /users/:id/turn-on')).answer('API-170', { user: { ...OFF[1], status: 'active' } });
      const b = await r.next('GET /users/changes');
      await b.answer('API-152', { changes: CHANGED, next: null });
      await expect.poll(() => chg.innerText()).not.toContain('Derek Simmons');
      await a.answer('API-152', { changes: CHANGES, next: null });
      await page.waitForTimeout(500);
      await expect.poll(() => chg.innerText()).not.toContain('Derek Simmons');
      await expect.poll(() => chg.innerText()).toContain('Omar Haddad');
    } finally {
      await close();
    }
  });

  // why: FR-DEMO-6 K-04 the demo strip read the clock on a world reset only, so a clock move left it showing the old time; K-05 the read made after the event is the one shown
  it('demo strip: a clock.changed event reads the clock again and the newest read is the one shown', async () => {
    const { page, r, close } = await open('/shell-preview/live-reads/demo-strip', (x) => {
      x.hold('GET /clock', 'GET /events');
    });
    try {
      const clock = { ...CLOCK_RUNNING, realNow: DEMO_NOW, resetAvailableInSeconds: 0, replay: { running: false, done: 0, total: 0 } };
      const moved = { ...clock, lastMove: { by: 'Dana Ruiz', kind: 'jump', toDemo: '2026-09-15T18:05:00-04:00[America/New_York]' } };
      const mount = await r.next('GET /clock');
      const stream = await r.next('GET /events');
      await mount.answer('API-10', clock);
      await expect.poll(() => page.locator('[data-demo-time]').count()).toBe(1);
      await stream.frame('clock.changed');
      const second = await r.next('GET /clock');
      await second.answer('API-10', moved);
      await expect.poll(() => page.locator('[data-cmp="CMP-01"] .moved').count()).toBe(1);
    } finally {
      await close();
    }
  });
});
