// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOOK-13, NFR-12 (SCR-CUS-07: the 5 booking site pages, their catalog text and their routes)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU_PAGES, MENU_ROUTES, menuPageFor, type MenuPageData } from './model.ts';

const catalog = (lang: 'en' | 'es') => JSON.parse(readFileSync(path.resolve(import.meta.dirname, `../../../../packages/i18n/catalog/${lang}.json`), 'utf8')) as Record<string, string>;
const en = catalog('en');
const es = catalog('es');
const keysOf = (p: MenuPageData) => [p.name, p.h1, p.lead, ...p.squares.flatMap((s) => [s.title, ...('key' in s.text ? [s.text.key] : [])])];

describe('SCR-CUS-07 booking site pages', () => {
  // why: FR-BOOK-13 the site menu has exactly the 5 pages of UI-SPECIFICATION 2.3, each at its own route, in menu order
  it('has the 5 routes of the specification in menu order', () => {
    expect(MENU_ROUTES).toEqual(['/book/heating', '/book/cooling', '/book/plumbing', '/book/comfort-club', '/book/about-us']);
  });

  // why: FR-BOOK-13 every page's heading, text and 4 squares are catalog text that exists in both languages (the page is in the page's language)
  it('reads every word of every page from the catalog, in English and in Spanish', () => {
    for (const p of Object.values(MENU_PAGES)) {
      expect(p.squares).toHaveLength(4);
      for (const k of keysOf(p)) {
        expect(en[k], `${k} in en`).toBeTruthy();
        expect(es[k], `${k} in es`).toBeTruthy();
      }
    }
  });

  // why: NFR-12 the pages are made-up text with no link to an outside site: no catalog value of the pages holds an address
  it('holds no web address in any bookmenu text', () => {
    for (const lang of [en, es]) {
      for (const [k, v] of Object.entries(lang)) if (k.startsWith('bookmenu.')) expect(v, k).not.toMatch(/https?:|www\.|\.com\b/i);
    }
  });

  // why: FR-BOOK-13 the office hours read Mon-Sat, 7 AM-7 PM (ruling D9-3), 1 catalog value, and About us shows it
  it('says the office hours from the 1 catalog value on About us', () => {
    expect(en['bookmenu.officeHours']).toBe('Mon-Sat, 7 AM-7 PM');
    expect(es['bookmenu.officeHours']).toBe('Lun-sáb, 7 AM-7 PM');
    const last = MENU_PAGES['about-us'].squares[3];
    expect('key' in last.text && last.text.key).toBe('bookmenu.officeHours');
  });

  // why: FR-BOOK-13 About us names the 3 branches from the reference data, not from text the catalog repeats
  it('names the 3 branches on About us', () => {
    const first = MENU_PAGES['about-us'].squares[0];
    expect('branches' in first.text && first.text.branches).toBe('Columbus, Dayton, Springfield');
  });

  // why: FR-DISP-32 only Comfort Club carries the line that says the page signs nobody up, and the line says so in both languages
  it('puts the no-sign-up line on Comfort Club alone', () => {
    expect(Object.values(MENU_PAGES).filter((p) => p.join).map((p) => p.slug)).toEqual(['comfort-club']);
    expect(en['bookmenu.club.join']).toContain('does not sign you up');
    expect(es['bookmenu.club.join']).toContain('no lo inscribe');
    expect(en['bookmenu.club.join']).toContain('{phone}');
  });

  // why: FR-BOOK-13 any other /book/ page name is the unknown-page state: no page, including names on the object prototype and the done route
  it('answers no page for any other name', () => {
    for (const n of ['heating', 'cooling', 'plumbing', 'comfort-club', 'about-us']) expect(menuPageFor(n)?.slug).toBe(n);
    for (const n of ['', 'Heating', 'about', 'club', 'done', 'constructor', '__proto__', 'toString', 'heating/']) expect(menuPageFor(n), n).toBeNull();
  });
});
