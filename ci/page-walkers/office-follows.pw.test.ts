// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-LANG-1, NFR-09 (P6-OFFICE-FOLLOWS: each language in its own name, and the web technician app's icons and name)
// Playwright on Chromium and WebKit against the harness app (ci/web-app.ts): the start page's iPhone app sign-ins and the import duplicates
// page name each language in its own name in either page language (owner ruling 6c62973f "'Español' everywhere"), and the web technician
// app's manifest lists the iPhone app's icon at 180, 192 and 512 px under the name Right On Time Web, which install step 3 names (owner
// answer e4cf66d3). The outside-origin guard is on for every page. Run with the page walkers (ci/gates/page-walkers*.sh).
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { guardedContext } from './origin-guard.ts';

let app: WebApp;
beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

/** The pixel size a PNG states in its IHDR chunk (bytes 16 to 24). */
const pngSize = (b: Buffer): [number, number] => [b.readUInt32BE(16), b.readUInt32BE(20)];

describe.each(engines)('office follows on %s', (_name, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function texts(path: string, lang: 'en' | 'es', selector: string): Promise<string[]> {
    const g = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    try {
      if (lang === 'es') await g.context.addCookies([{ name: 'bw_lang', value: 'es', url: app.origin }]);
      const p = await g.context.newPage();
      await p.goto(app.origin + path, { waitUntil: 'networkidle' });
      expect(await p.locator('html').getAttribute('lang')).toBe(lang);
      await p.waitForSelector(selector);
      return await p.locator(selector).allTextContents();
    } finally {
      await g.context.close();
    }
  }

  // why: FR-LANG-1 the iPhone app sign-ins name Spanish "Español" and English "English" in either page language
  it.each(['en', 'es'] as const)('the start page names each language in its own name, page in %s', async (lang) => {
    const cells = await texts('/shell-preview/auth-start/link', lang, '[data-ctl="CTL-GATE-02-04"] tbody tr td:nth-child(3)');
    expect(cells).toContain('Español');
    expect(cells).toContain('English');
    expect(cells).not.toContain('Spanish');
    expect(cells).not.toContain('Inglés');
  });

  // why: FR-LANG-1 the duplicates page's Text language row names Spanish "Español" for the Spanish speaker and English "English" for the other, in either page language (F-1280)
  it.each(['en', 'es'] as const)('the duplicates page names the text language in its own name, page in %s', async (lang) => {
    const rows = await texts('/shell-preview/import-dups/dups-spanish', lang, '[data-ctl="CTL-OFC-14-06"] table.c tbody tr:nth-child(4) td.v');
    expect(rows).toEqual(['Español', 'English']);
  });

  // why: NFR-09 install step 3 names Right On Time Web in both page languages
  it.each(['en', 'es'] as const)('the install page step 3 names Right On Time Web, page in %s', async (lang) => {
    const steps = await texts('/shell-preview/tech-install/iphone', lang, '.steps11 li');
    expect(steps[2]).toContain('Right On Time Web');
    expect(steps[2]).toMatch(lang === 'en' ? /^3Open Right On Time Web from your home screen/ : /^3Abra Right On Time Web desde su pantalla/);
  });

  // why: NFR-09 the manifest lists the 3 square icons and the name Right On Time Web, each icon a PNG of the size it names
  it('serves the manifest with the 3 square icons and the name Right On Time Web', async () => {
    const m = (await (await fetch(app.origin + '/tech/manifest.webmanifest')).json()) as { name: string; short_name: string; icons: { src: string; sizes: string; type: string }[] };
    expect([m.name, m.short_name]).toEqual(['Right On Time Web', 'Right On Time Web']);
    expect(m.icons.map((i) => i.sizes)).toEqual(['180x180', '192x192', '512x512']);
    for (const i of m.icons) {
      const res = await fetch(app.origin + i.src);
      expect([res.status, res.headers.get('content-type'), i.type]).toEqual([200, 'image/png', 'image/png']);
      const n = Number(i.sizes.split('x')[0]);
      expect(pngSize(Buffer.from(await res.arrayBuffer()))).toEqual([n, n]);
    }
  });
});
