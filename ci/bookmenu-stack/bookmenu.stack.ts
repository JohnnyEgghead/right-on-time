// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOOK-13, NFR-12, FR-DISP-32 (P5-BOOKING-PAGES Acceptance: Playwright on Chromium and WebKit against the Compose stack at its default settings)
// The booking site menu (SCR-CUS-07 at its 5 routes, CMP-15) against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs
// running), through its proxy, outside-origin guard on: every menu item opens its page at 1440 x 900 and at 520 x 980, each page holds no link to an
// outside site, the pages read and write nothing but the strip's and the footer's own reads, the pages come in Spanish, Book a visit opens the booking
// start, and any other /book/ page name is SCR-SHR-02 answering 404 under the booking site header. Run by ci/shell-stack.sh after the technicians suite
// and before the clock banner suite, on the same stack (public pages: no fixture rows and no session). A *.stack.ts file: its own config runs it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page, Request } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_SHELL_STACK_URL;
if (!base) throw new Error('BW_SHELL_STACK_URL is not set: run ci/shell-stack.sh');
const origin = new URL(base).origin;

const catalog = (lang: 'en' | 'es') => JSON.parse(readFileSync(path.resolve(import.meta.dirname, `../../packages/i18n/catalog/${lang}.json`), 'utf8')) as Record<string, string>;
const en = catalog('en');
const es = catalog('es');

/** The 5 routes in menu order with the catalog key of each page's heading and of its menu label. */
const PAGES = [
  { slug: 'heating', h1: 'bookmenu.heating.h1', label: 'shell.booking.heating' },
  { slug: 'cooling', h1: 'bookmenu.cooling.h1', label: 'shell.booking.cooling' },
  { slug: 'plumbing', h1: 'bookmenu.plumbing.h1', label: 'shell.booking.plumbing' },
  { slug: 'comfort-club', h1: 'bookmenu.club.h1', label: 'shell.booking.club' },
  { slug: 'about-us', h1: 'bookmenu.about.h1', label: 'shell.booking.about' },
] as const;
const VIEWS = [
  { name: '1440 x 900', width: 1440, height: 900 },
  { name: '520 x 980', width: 520, height: 980 },
] as const;
const SCREEN = '.r1-screen[data-screen="SCR-CUS-07"]';

/** The page's links that leave this origin: http(s) hrefs only (a tel: link and a same-page # are not a site), minus the footer's Source link (CTL-CMP-04-01). */
async function outsideLinks(p: Page): Promise<{ page: string[]; footer: string[] }> {
  return p.evaluate((o) => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ href: string; closest(s: string): unknown }> } }).document;
    const out: { page: string[]; footer: string[] } = { page: [], footer: [] };
    for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
      let u: URL;
      try {
        u = new URL(a.href);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(u.protocol) || u.origin === o) continue;
      (a.closest('[data-cmp="CMP-04"]') ? out.footer : out.page).push(a.href);
    }
    return out;
  }, origin);
}

describe.each(engines)('the booking site menu on the Compose stack, %s', (_engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** A fresh context at 1 size; the guard throws on close if any request left the stack's origin. */
  async function visit<T>(view: (typeof VIEWS)[number], fn: (p: Page, requests: Request[]) => Promise<T>, lang?: 'es'): Promise<T> {
    const g = await guardedContext(browser, [origin], { viewport: { width: view.width, height: view.height } });
    try {
      if (lang) await g.context.addCookies([{ name: 'bw_lang', value: lang, url: origin }]);
      const p = await g.context.newPage();
      const requests: Request[] = [];
      p.on('request', (r) => requests.push(r));
      return await fn(p, requests);
    } finally {
      await g.context.close();
    }
  }

  /** Opens `/book/<slug>` by the site menu: a header link on a wide screen, the Menu list on a narrow one (CTL-CMP-15-05). */
  async function openByMenu(p: Page, slug: string): Promise<void> {
    const nav = p.locator('header.site nav a');
    if ((await nav.count()) > 0 && (await nav.first().isVisible())) {
      await Promise.all([p.waitForURL(`${origin}/book/${slug}`), p.locator(`header.site nav a[href="/book/${slug}"]`).click()]);
      return;
    }
    await p.locator('header.site button[data-ctl="CTL-CMP-15-05"]').click();
    await Promise.all([p.waitForURL(`${origin}/book/${slug}`), p.locator(`.bw-site-menu a[href="/book/${slug}"]`).click()]);
  }

  for (const view of VIEWS) {
    // why: FR-BOOK-13 every menu item opens its page, in the page's language, at both sizes with nothing wider than the screen (the guard sees no outside request)
    it(`every menu item opens its page at ${view.name}`, async () => {
      await visit(view, async (p) => {
        const first = await p.goto(`${origin}/book/${PAGES[0].slug}`, { waitUntil: 'load' });
        expect(first?.status()).toBe(200);
        for (const [i, page] of PAGES.entries()) {
          if (i > 0) await openByMenu(p, page.slug);
          await p.waitForSelector(`${SCREEN} .split`, { state: 'attached' });
          expect(await p.locator(SCREEN).count()).toBe(1);
          expect((await p.locator(`${SCREEN} h1`).textContent())?.trim()).toBe(en[page.h1]);
          expect((await p.locator(`${SCREEN} .kicker`).textContent())?.trim()).toBe(en[page.label]);
          expect(await p.title()).toBe(en['shell.app.doc']);
          // The header's current item is the page's own (wide screens draw the menu in the header; narrow ones in the Menu list).
          if ((await p.locator('header.site nav').count()) > 0) expect(await p.locator('header.site nav a[aria-current="page"]').getAttribute('href')).toBe(`/book/${page.slug}`);
          const wide = await p.evaluate(() => {
            const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document;
            return d.documentElement.scrollWidth - d.documentElement.clientWidth;
          });
          expect(wide, `${page.slug} scrolls sideways by ${wide} px`).toBeLessThanOrEqual(0);
        }
      });
    });

    // why: NFR-12 no link on the 5 pages leaves the site: the site menu, the page body and Book a visit are same-origin, and the only other address is the footer's Source link
    it(`holds no outside link on any of the 5 pages at ${view.name}`, async () => {
      await visit(view, async (p) => {
        for (const page of PAGES) {
          await p.goto(`${origin}/book/${page.slug}`, { waitUntil: 'load' });
          await p.waitForSelector(`${SCREEN} .split`, { state: 'attached' });
          // The footer's Source link comes from API-02 once it lands; wait for it so the exception below is the one being made.
          await p.waitForSelector('footer.r1-foot [data-ctl="CTL-CMP-04-01"]', { state: 'attached' });
          const links = await outsideLinks(p);
          expect(links.page, `${page.slug} links out`).toEqual([]);
          expect(links.footer).toHaveLength(1);
        }
      });
    });
  }

  // why: FR-BOOK-13 the pages read nothing and write nothing: the only calls are the demo strip's clock read and the footer's app-info read
  it('makes no call but the strip and the footer reads', async () => {
    await visit(VIEWS[0], async (p, requests) => {
      for (const page of PAGES) {
        await p.goto(`${origin}/book/${page.slug}`, { waitUntil: 'load' });
        await p.waitForSelector('footer.r1-foot [data-ctl="CTL-CMP-04-01"]', { state: 'attached' });
      }
      const calls = requests.filter((r) => new URL(r.url()).pathname.startsWith('/api/'));
      expect(calls.length).toBeGreaterThan(0);
      for (const r of calls) {
        expect(r.method(), r.url()).toBe('GET');
        expect(new URL(r.url()).pathname, r.url()).toMatch(/^\/api\/v1\/(clock|app-info)$/);
      }
    });
  });

  // why: FR-BOOK-13 the pages come in the page's language: Spanish heading, text and office hours, with no English left from the catalog of the page
  it('shows each page in Spanish, with the office hours on About us', async () => {
    await visit(
      VIEWS[0],
      async (p) => {
        for (const page of PAGES) {
          await p.goto(`${origin}/book/${page.slug}`, { waitUntil: 'load' });
          await p.waitForSelector(`${SCREEN} .split`, { state: 'attached' });
          expect(await p.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)).toBe('es');
          expect((await p.locator(`${SCREEN} h1`).textContent())?.trim()).toBe(es[page.h1]);
          expect((await p.locator(`${SCREEN} .kicker`).textContent())?.trim()).toBe(es[page.label]);
          expect((await p.locator(`${SCREEN} .sq`).count())).toBe(4);
        }
        // The last page is About us: its fourth square names the office hours (CTL-CUS-07-01).
        expect((await p.locator(`${SCREEN} .sq`).nth(3).textContent()) ?? '').toContain('Lun-sáb, 7 AM-7 PM');
      },
      'es',
    );
  });

  // why: FR-BOOK-13 About us names the office hours Mon-Sat, 7 AM-7 PM (ruling D9-3) and Comfort Club says it signs nobody up (FR-DISP-32)
  it('names the office hours on About us and the no-sign-up line on Comfort Club', async () => {
    await visit(VIEWS[0], async (p) => {
      await p.goto(`${origin}/book/about-us`, { waitUntil: 'load' });
      expect(((await p.locator(`${SCREEN} .sq`).nth(3).textContent()) ?? '').includes('Mon-Sat, 7 AM-7 PM')).toBe(true);
      await p.goto(`${origin}/book/comfort-club`, { waitUntil: 'load' });
      expect((await p.locator(`${SCREEN} .join`).textContent())?.trim()).toBe(en['bookmenu.club.join']!.replace('{phone}', '(614) 555-0100'));
    });
  });

  // why: FR-BOOK-13 Book a visit on a page opens the booking start (step 1 of SCR-CUS-01 is P5-BOOKING's page; this suite checks the way there)
  it('opens the booking start from Book a visit', async () => {
    await visit(VIEWS[0], async (p) => {
      await p.goto(`${origin}/book/cooling`, { waitUntil: 'load' });
      await Promise.all([p.waitForURL(`${origin}/book`), p.locator(`${SCREEN} a[data-ctl="CTL-CUS-07-02"]`).click()]);
      expect(new URL(p.url()).pathname).toBe('/book');
    });
  });

  // why: F-925 a signed-out reader on any not-found page gets Book a visit with the calendar icon (CTL-SHR-02-02), not Go to your home page
  it('answers a signed-out not-found page outside /book with Book a visit and the calendar icon', async () => {
    await visit(VIEWS[0], async (p) => {
      const res = await p.goto(`${origin}/nothing-here`, { waitUntil: 'load' });
      expect(res?.status()).toBe(404);
      await p.waitForSelector('.r1-screen[data-screen="SCR-SHR-02"]', { state: 'attached' });
      const way = p.locator('a[data-ctl="CTL-SHR-02-02"]');
      expect((await way.textContent())?.trim()).toBe(en['shell.booking.book']);
      expect(await way.getAttribute('href')).toBe('/book');
      expect(await way.locator('i[data-icon]').getAttribute('data-icon')).toBe('calendar');
    });
  });

  for (const view of VIEWS) {
    // why: FR-BOOK-13 any other /book/ page name is SCR-SHR-02 answering 404 under the booking site header, with Book a visit as the way on (DK-133)
    it(`answers an unknown page name with the Page not found page under the booking header at ${view.name}`, async () => {
      await visit(view, async (p) => {
        for (const name of ['nothing-here', 'Heating', 'about']) {
          const res = await p.goto(`${origin}/book/${name}`, { waitUntil: 'load' });
          expect(res?.status(), name).toBe(404);
          await p.waitForSelector('.r1-screen[data-screen="SCR-SHR-02"]', { state: 'attached' });
          expect(await p.locator('header.site[data-cmp="CMP-15"]').count(), name).toBe(1);
          expect(await p.locator('.shr-head').count(), name).toBe(0);
          const way = p.locator('a[data-ctl="CTL-SHR-02-02"]');
          expect((await way.textContent())?.trim()).toBe(en['shell.booking.book']);
          expect(await way.getAttribute('href')).toBe('/book');
          expect((await p.locator('h1').textContent())?.trim()).toBe(en['shell.shr.notFound.title']);
        }
      });
    });
  }
});
