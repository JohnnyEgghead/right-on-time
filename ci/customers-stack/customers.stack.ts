// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-7, FR-DISP-10, FR-DISP-29, FR-DISP-30, FR-DISP-31, FR-DISP-32 (P4-CUSTOMERS Acceptance: Playwright on Chromium and WebKit against the Compose stack at its default settings)
// The customer search and the customer page (SCR-OFC-05, SCR-OFC-06 and the dialogs SCR-OFC-38, -39) against the Compose stack at its
// default settings (real PostgreSQL 18, real handlers, pbs running), through its proxy, outside-origin guard on: searching O'Brien finds
// Sean O'Brien, Kathleen O'Brien-Miller and Kathy OBrien; the top bar's Customers item opens the page for the office user and for the
// manager; a new customer is created from a listed street and found; an edit and a time zone change land on the page. Run by
// ci/shell-stack.sh after the week board suite: the shell fixture (the office user and her session, BW_SHELL_STACK_SESSION), then
// ci/week-stack/fixture.sql, then ./fixture.sql (a manager with BW_CUSTOMERS_MANAGER, the streets and customers). A *.stack.ts file:
// its own config runs it.
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';

const base = process.env.BW_SHELL_STACK_URL;
if (!base) throw new Error('BW_SHELL_STACK_URL is not set: run ci/shell-stack.sh');
const origin = new URL(base).origin;
const office = process.env.BW_SHELL_STACK_SESSION;
const manager = process.env.BW_CUSTOMERS_MANAGER;
if (!office || !manager) throw new Error('BW_SHELL_STACK_SESSION and BW_CUSTOMERS_MANAGER are not set: run ci/shell-stack.sh');
// FR-DISP-20's 2 profiles (the shell.stack.ts shape): a touch phone at 520 x 980, and a computer at 1440 x 900.
const PHONE: BrowserContextOptions = { viewport: { width: 520, height: 980 }, isMobile: true, hasTouch: true };
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const SEAN = '0192f000-0000-7000-8000-00000000c0a1';
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the kernel refuses a cookie-carrying write from any other origin (SD-8).
const APP_ORIGIN = 'http://localhost:8080';

async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
    return r.fulfill({ response });
  });
}

describe.each(engines)('the customers pages on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open<T>(session: string, path: string, ready: string, fn: (p: Page) => Promise<T>, profile: BrowserContextOptions = DESKTOP, onPage?: (p: Page) => void): Promise<T> {
    const g = await guardedContext(browser, [origin], profile);
    try {
      await g.context.addCookies([{ name: 'bw_session', value: session, url: origin, httpOnly: true }]);
      const p = await g.context.newPage();
      onPage?.(p);
      await writeOrigin(p);
      const res = await p.goto(origin + path, { waitUntil: 'load' });
      expect(res?.status()).toBe(200);
      await p.waitForSelector(ready, { state: 'attached' });
      return await fn(p);
    } finally {
      // The page's write route (writeOrigin) may still be fetching the jobs search (API-133) when the test ends (F-1359): the guard's close lets it
      // finish before the context closes (F-1421).
      await g.context.close();
    }
  }
  const SEARCH = '.r1-screen[data-screen="SCR-OFC-05"]';
  const names = (p: Page) => p.locator(`${SEARCH} table[data-ctl="CTL-OFC-05-03"] tbody a.nm`).allTextContents();

  // why: FR-DISP-7 searching O'Brien finds Sean O'Brien, Kathleen O'Brien-Miller and Kathy OBrien, however the apostrophe and hyphen are typed
  it("finds Sean O'Brien, Kathleen O'Brien-Miller and Kathy OBrien for O'Brien", async () => {
    await open(office, '/office/customers', `${SEARCH} input.bw-cu-q`, async (p) => {
      for (const q of ["O'Brien", 'obrien']) {
        await p.fill(`${SEARCH} input.bw-cu-q`, q);
        await expect.poll(() => names(p), { timeout: 15_000 }).toEqual(expect.arrayContaining(["Sean O'Brien", "Kathleen O'Brien-Miller", 'Kathy OBrien']));
      }
      // the first row is selected and its customer shows in the preview panel
      await expect.poll(() => p.locator(`${SEARCH} aside.pv b`).first().textContent(), { timeout: 15_000 }).toBeTruthy();
      // the query stays out of the address bar and the links (NFR-05)
      expect(p.url()).not.toContain('brien');
    });
  });

  // why: FR-DISP-10 the top bar's Customers item opens the customer search for the office user and for the manager, the two roles FR-AUTH-1 allows
  it('opens the customer search from the top bar for the office user and for the manager', async () => {
    for (const session of [office, manager]) {
      await open(session, '/office/board/week?branch=columbus&week=2026-09-14', '.r1-screen[data-screen="SCR-OFC-34"] .wk', async (p) => {
        await p.locator('.topbar nav a', { hasText: 'Customers' }).click();
        await p.waitForSelector(SEARCH, { state: 'attached' });
        expect(new URL(p.url()).pathname).toBe('/office/customers');
      });
    }
  });

  // why: FR-DISP-29 with the guard on, a new customer made from a listed Columbus street, a house number and Spanish texts lands on their page with the street's branch, ZIP code and map position, and search then finds them
  it('creates a customer with Spanish texts from a listed street and a house number: branch, ZIP code and map position come from the street', async () => {
    const name = `Lucia Moreno ${engine}`;
    let id = '';
    await open(office, '/office/customers', `${SEARCH} input.bw-cu-q`, async (p) => {
      await p.click('[data-ctl="CTL-OFC-05-12"]');
      const dlg = p.locator('.r1-dlg[data-screen="SCR-OFC-38"]');
      await dlg.waitFor();
      await dlg.locator('#cu-name-new').fill(name);
      await dlg.locator('#cu-mobile-new').fill('(614) 555-0172');
      await dlg.locator('#cu-lang-new').selectOption('es');
      await dlg.locator('#cu-street-new').fill('calum');
      await dlg.locator('.ddl [role="option"]', { hasText: 'Calumet St' }).first().click();
      await dlg.locator('#cu-house-new').fill('2310');
      expect(await dlg.locator('input.bw-cu-cb').isChecked()).toBe(true);
      // The page's own read of the new customer (API-35), as it lands on their page.
      const read = p.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/v1\/customers\/[0-9a-f-]{36}$/.test(r.url()));
      await dlg.locator('button[data-ctl="CTL-OFC-38-08"]').click();
      await p.waitForURL(/\/office\/customers\/[0-9a-f-]{36}$/);
      id = new URL(p.url()).pathname.split('/').pop() as string;
      type Read = { data: { branch: string; language: string; contact: { textsOn: boolean }; address: { zip: string; city: string }; position: { lon: number; lat: number } } };
      const d = ((await (await read).json()) as Read).data;
      // Calumet St's 2 listed points (fixture.sql): house 2310 takes point (2310 - 1) mod 2, the second, as an online booking does (FR-BOOK-12).
      expect(d).toMatchObject({ branch: 'columbus', language: 'es', contact: { textsOn: true }, address: { zip: '43202', city: 'Clintonville' }, position: { lon: -83.021, lat: 40.051 } });
      const screen = '.r1-screen[data-screen="SCR-OFC-06"]';
      await p.waitForSelector(`${screen} h1`, { state: 'attached' });
      expect(await p.locator(`${screen} h1`).textContent()).toBe(name);
      expect(await p.locator('[data-ctl="CTL-OFC-06-09"] dd').first().textContent()).toBe('2310 Calumet StClintonville, OH 43202');
      expect(await p.locator('.meta[data-ctl="CTL-OFC-06-24"] span').first().textContent()).toBe('Clintonville, Columbus branch');
      expect(await p.locator('[data-ctl="CTL-OFC-06-03"] dd').nth(1).textContent()).toBe('Spanish');
      // the map position: the app's own map opens on it (SCR-OFC-40)
      await p.click('[data-ctl="CTL-OFC-06-20"]');
      await p.waitForSelector('.r1-dlg[data-screen="SCR-OFC-40"] [data-cmp="CMP-05"][data-map-state="ready"]', { timeout: 45_000 });
      expect(await p.locator('.r1-dlg[data-screen="SCR-OFC-40"] [data-cmp="CMP-05"]').getAttribute('data-map-center')).toBe('-83.02100,40.05100');
    });
    await open(office, '/office/customers', `${SEARCH} input.bw-cu-q`, async (p) => {
      await p.fill(`${SEARCH} input.bw-cu-q`, name);
      await expect.poll(() => names(p), { timeout: 15_000 }).toEqual([name]);
      expect(await p.locator(`${SEARCH} table[data-ctl="CTL-OFC-05-03"] tbody a.nm`).first().getAttribute('href')).toBe(`/office/customers/${id}`);
    });
  });

  // why: FR-DISP-31 the customer page shows the member's contact, address, Comfort Club and upcoming visit; Edit changes the name; the time zone changes in place; the membership is not office-editable (FR-DISP-32)
  it('shows a member, edits the name and the time zone, and offers no way to change the membership', async () => {
    const id = '0192f000-0000-7000-8000-00000000c0a1';
    await open(office, `/office/customers/${id}`, '.r1-screen[data-screen="SCR-OFC-06"] h1', async (p) => {
      const screen = '.r1-screen[data-screen="SCR-OFC-06"]';
      expect(await p.locator(`${screen} h1`).textContent()).toBe("Sean O'Brien");
      expect(await p.locator(`${screen} .chip.club`).first().textContent()).toContain('Comfort Club member');
      expect(await p.locator('[data-ctl="CTL-OFC-06-03"]').textContent()).toContain('(614) 555-0163');
      expect(await p.locator('[data-ctl="CTL-OFC-06-29"]').textContent()).toContain('job 29999');
      expect(await p.locator('[data-ctl="CTL-OFC-06-21"]').textContent()).toContain('Renews');
      // F-695: the What was done cell of the done job 29998 draws its 2 work-done lines, in order, through the page.
      const done = p.locator('[data-ctl="CTL-OFC-06-12"] tbody tr', { has: p.locator('a[href="/office/jobs/29998"]') });
      expect(await done.locator('td').last().innerText()).toBe('Replaced the run capacitor\nCleaned the condenser coil');
      // Edit: the membership note is read-only text, and a changed name is saved
      await p.click('[data-ctl="CTL-OFC-06-16"]');
      const dlg = p.locator('.r1-dlg[data-screen="SCR-OFC-39"]');
      await dlg.waitFor();
      expect(await dlg.locator('[data-ctl="CTL-OFC-39-06"]').textContent()).toContain('cannot be changed here');
      const unique = `Sean O'Brien ${engine}`;
      await dlg.locator('#cu-name-edit').fill(unique);
      await dlg.locator('button[data-ctl="CTL-OFC-39-07"]').click();
      await expect.poll(() => p.locator(`${screen} h1`).textContent(), { timeout: 15_000 }).toBe(unique);
      // the time zone, in place
      await p.click('[data-ctl="CTL-OFC-06-05"]');
      await p.locator('[data-ctl="CTL-OFC-06-06"] select').selectOption('America/Chicago');
      await p.click('[data-ctl="CTL-OFC-06-07"]');
      await expect.poll(() => p.locator('[data-ctl="CTL-OFC-06-04"]').textContent(), { timeout: 15_000 }).toBe('Central (America/Chicago)');
      // put the zone and the name back for the next engine
      await p.click('[data-ctl="CTL-OFC-06-05"]');
      await p.locator('[data-ctl="CTL-OFC-06-06"] select').selectOption('America/New_York');
      await p.click('[data-ctl="CTL-OFC-06-07"]');
      await expect.poll(() => p.locator('[data-ctl="CTL-OFC-06-04"]').textContent(), { timeout: 15_000 }).toBe('Eastern (America/New_York)');
      await p.click('[data-ctl="CTL-OFC-06-16"]');
      const again = p.locator('.r1-dlg[data-screen="SCR-OFC-39"]');
      await again.waitFor();
      await again.locator('#cu-name-edit').fill("Sean O'Brien");
      await again.locator('button[data-ctl="CTL-OFC-39-07"]').click();
      await expect.poll(() => p.locator(`${screen} h1`).textContent(), { timeout: 15_000 }).toBe("Sean O'Brien");
    });
  });

  // why: FR-DISP-31 an unknown customer is the Page not found page
  it('answers the Page not found page for an unknown customer', async () => {
    const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 900 } });
    try {
      await g.context.addCookies([{ name: 'bw_session', value: office, url: origin, httpOnly: true }]);
      const p = await g.context.newPage();
      await p.goto(origin + '/office/customers/00000000-0000-7000-8000-000000000009', { waitUntil: 'load' });
      await p.waitForSelector('[data-screen="SCR-SHR-02"]', { state: 'attached', timeout: 15_000 });
    } finally {
      await g.context.close();
    }
  });

  const PAGE = '.r1-screen[data-screen="SCR-OFC-06"] h1';
  const CALL = '[data-ctl="CTL-OFC-06-15"] [data-ctl="CTL-CMP-16-01"]';

  // why: FR-DISP-20 on a touch phone profile the customer page's Call (CMP-16) is a telephone link to the customer's mobile
  it("the customer page's Call opens the dialer on a coarse-pointer phone", async () => {
    await open(office, `/office/customers/${SEAN}`, PAGE, async (p) => {
      expect(await p.evaluate('matchMedia("(pointer: coarse) and (hover: none)").matches')).toBe(true);
      await expect.poll(() => p.locator(CALL).evaluate((e) => e.tagName)).toBe('A');
      expect(await p.locator(CALL).getAttribute('href')).toBe('tel:+16145550163');
    }, PHONE);
  });

  // why: FR-DISP-20 on a desktop profile pressing the customer page's Call shows the number and starts no call
  it("the customer page's Call shows the number on a desktop and starts no call", async () => {
    await open(office, `/office/customers/${SEAN}`, PAGE, async (p) => {
      const call = p.locator(CALL);
      expect(await call.evaluate((e) => e.tagName)).toBe('BUTTON');
      expect(await p.locator('a[href^="tel:"]').count()).toBe(0);
      expect(await p.locator('[data-call-number]').count()).toBe(0);
      await call.click();
      expect(await p.locator('[data-call-number]').textContent()).toBe('(614) 555-0163');
      expect(await p.locator('[role="status"]:has([data-call-number])').count()).toBe(1);
      expect(p.url()).toBe(`${origin}/office/customers/${SEAN}`);
    }, DESKTOP);
  });

  // why: FR-DISP-31 Open in maps shows the address's stored map position on the app's own map, outside-origin guard on, on a phone profile and a desktop profile
  for (const [label, profile] of [['phone', PHONE], ['desktop', DESKTOP]] as const) {
    it(`Open in maps shows the stored position on the app's own map, ${label} profile`, async () => {
      const reads: { lon: number; lat: number }[] = [];
      await open(office, `/office/customers/${SEAN}`, PAGE, async (p) => {
        // the stored position, as the page read it (API-35): fixture.sql writes -83.02, 40.05 for Sean O'Brien
        await expect.poll(() => reads.length).toBeGreaterThan(0);
        expect(reads[0]).toEqual({ lon: -83.02, lat: 40.05 });
        await p.click('[data-ctl="CTL-OFC-06-20"]');
        const dlg = p.locator('.r1-dlg[data-screen="SCR-OFC-40"]');
        await p.waitForSelector('.r1-dlg[data-screen="SCR-OFC-40"] [data-cmp="CMP-05"][data-map-state="ready"], .r1-dlg[data-screen="SCR-OFC-40"] [data-cmp="CMP-05"][data-map-state="failed"]', { timeout: 45_000 });
        const map = dlg.locator('[data-cmp="CMP-05"]');
        expect(await map.getAttribute('data-map-state')).toBe('ready');
        expect(await map.getAttribute('data-map-file')).toBe('columbus.pmtiles');
        expect(Number(await map.getAttribute('data-map-features'))).toBeGreaterThan(0);
        expect(await map.getAttribute('data-map-markers')).toBe('1');
        // The map reports it opened on the stored position, and the house marker is drawn there: the middle of the shown map.
        expect(await map.getAttribute('data-map-center')).toBe('-83.02000,40.05000');
        const canvas = await dlg.locator('.maplibregl-canvas').boundingBox();
        const marker = await dlg.locator('[data-marker-id="home"]').boundingBox();
        if (!canvas || !marker) throw new Error('no map canvas or no house marker on the page');
        expect(Math.abs(marker.x + marker.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThanOrEqual(2);
        expect(Math.abs(marker.y + marker.height / 2 - (canvas.y + canvas.height / 2))).toBeLessThanOrEqual(2);
        expect(await dlg.locator('[data-ctl="CTL-OFC-40-02"]').textContent()).toContain('2291 Calumet St');
        // no outside maps app or site: no link out of the app in the dialog but the map credit
        expect(await dlg.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).toEqual(['https://www.openstreetmap.org/copyright']);
      }, profile, (p) => p.on('response', (r) => {
        if (r.request().method() === 'GET' && r.url() === `${origin}/api/v1/customers/${SEAN}`) {
          void r.json().then((b: { data: { position: { lon: number; lat: number } } }) => reads.push(b.data.position)).catch(() => undefined);
        }
      }));
    });
  }

  // why: FR-DISP-30, NFR-05 searching a sample customer's street and a sample phone number finds that customer, and neither query is in any request URL or the address bar
  it("finds Sean O'Brien by his street and by his phone number, with neither query in any URL", async () => {
    const urls: string[] = [];
    await open(office, '/office/customers', `${SEARCH} input.bw-cu-q`, async (p) => {
      for (const q of ['Calumet', '555-0163']) {
        await p.fill(`${SEARCH} input.bw-cu-q`, q);
        await expect.poll(() => names(p), { timeout: 15_000 }).toContain("Sean O'Brien");
        expect(p.url()).toBe(`${origin}/office/customers`);
      }
    }, DESKTOP, (p) => p.on('request', (r) => urls.push(r.url())));
    expect(urls.some((u) => u.endsWith('/api/v1/customer-searches'))).toBe(true);
    expect(urls.filter((u) => /calumet|555-?0163|5550163/i.test(u))).toEqual([]);
  });

  // why: FR-DISP-32 the customer page shows a member's "Member since", the benefits text and "Renews", and "None" for a customer with no membership
  it('shows Member since, the benefits and Renews for a member, and None for a customer with no membership', async () => {
    await open(office, `/office/customers/${SEAN}`, PAGE, async (p) => {
      const club = p.locator('[data-ctl="CTL-OFC-06-21"]');
      expect(await club.locator('.card-h h3').textContent()).toBe('Comfort Club');
      expect(await club.locator('.card-h .muted').textContent()).toBe('Member since Mar 2019');
      expect(await club.locator('ul li').allTextContents()).toEqual([
        '2 tune-ups a year: AC in spring, furnace in fall', '15% off repairs, no visit fee', 'A reminder when a tune-up is due',
      ]);
      expect(await club.locator('.ren').textContent()).toBe('Renews Mar 1, 2027 - paid yearly');
    });
    await open(office, '/office/customers/0192f000-0000-7000-8000-00000000c0a2', PAGE, async (p) => {
      const club = p.locator('[data-ctl="CTL-OFC-06-21"]');
      expect(await club.locator('.ren').textContent()).toBe('None');
      expect(await club.locator('.card-h .muted').count()).toBe(0);
      expect(await club.locator('ul li').count()).toBe(0);
      expect(await p.locator('.r1-screen[data-screen="SCR-OFC-06"] .chip.club').count()).toBe(0);
    });
  });
});
