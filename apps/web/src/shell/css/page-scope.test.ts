// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1896 (a page sheet's rules apply only on its own screens: the web build scopes every page-*.css as it bundles it)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../../next.config.ts';
import { scopePageSheet } from './page-scope-loader.ts';
import { PAGE_SCOPES, PAGE_SHEET_NAME, scopeSelector, scopeSheet, unscopedSelectors, type SheetScope } from './page-scope.ts';

const STYLES = path.resolve(import.meta.dirname, '../../../styles');
const SRC = path.resolve(import.meta.dirname, '../..');
// Read from the folder at test time: a new page sheet is in the count the day it lands.
const sheets = readdirSync(STYLES).filter((f) => PAGE_SHEET_NAME.test(f)).sort();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('the page sheets in the build', () => {
  it('finds the page sheets in the styles folder', () => {
    expect(sheets.length).toBeGreaterThan(0);
  });

  it('gives every page sheet a scope with at least 1 screen, and names no sheet that is not there', () => {
    const missing = sheets.filter((f) => !PAGE_SCOPES[f] || PAGE_SCOPES[f].screens.length === 0);
    expect(missing).toEqual([]);
    expect(Object.keys(PAGE_SCOPES).filter((f) => !sheets.includes(f))).toEqual([]);
  });

  it('names only screens the app draws (each ID is in the web source)', () => {
    const text = sourceFiles(SRC).filter((f) => !f.includes(`${path.sep}css${path.sep}page-scope`)).map((f) => readFileSync(f, 'utf8')).join('\n');
    const unknown = Object.entries(PAGE_SCOPES).flatMap(([f, s]) => [...s.screens, ...(s.shared ?? [])].filter((id) => !text.includes(`'${id}'`) && !text.includes(`"${id}"`)).map((id) => `${f}: ${id}`));
    expect(unknown).toEqual([]);
  });

  it.each(sheets)('scopes every rule of %s to its screens', (file) => {
    const out = scopePageSheet(path.join(STYLES, file), readFileSync(path.join(STYLES, file), 'utf8'));
    expect(unscopedSelectors(out, PAGE_SCOPES[file] as SheetScope)).toEqual([]);
  });

  it('runs every page sheet, and only the page sheets, through the scoping loader', () => {
    const rule = (config.turbopack?.rules as Record<string, { condition: { path: RegExp }; loaders: string[]; type: string }>)['*.css'];
    expect(rule).toBeDefined();
    const loader = rule!.loaders[0] as string;
    expect(path.resolve(loader)).toBe(path.resolve(import.meta.dirname, 'page-scope-loader.ts'));
    expect(rule!.type).toBe('css');
    for (const f of sheets) expect(rule!.condition.path.test(path.join(STYLES, f)), f).toBe(true);
    for (const f of readdirSync(path.join(STYLES, 'app'))) expect(rule!.condition.path.test(path.join(STYLES, 'app', f)), f).toBe(false);
    for (const f of readdirSync(path.join(STYLES, 'kit'))) expect(rule!.condition.path.test(path.join(STYLES, 'kit', f)), f).toBe(false);
  });
});

describe('the scope check', () => {
  const scope: SheetScope = { screens: ['SCR-CUS-01'] };

  it('fails a sheet with 1 unscoped rule', () => {
    const scoped = scopeSheet('.a { color: red } @media (min-width: 1px) { .b::after { content: "" } }', scope);
    expect(unscopedSelectors(scoped, scope)).toEqual([]);
    expect(unscopedSelectors(`${scoped} .c > .d { color: blue }`, scope)).toEqual(['.c > .d']);
  });

  it('fails a rule scoped on an ancestor instead of its subject, and a rule in an at-rule it does not know', () => {
    const inside = scopeSelector('.x', scope).slice(2);
    expect(unscopedSelectors(`.x${inside} .y { color: red }`, scope)).toEqual([`.x${inside} .y`]);
    expect(unscopedSelectors('@starting-style { .z { opacity: 0 } }', scope)).toHaveLength(1);
    expect(() => scopeSheet('@starting-style { .z { opacity: 0 } }', scope)).toThrow(/does not know/);
  });

  it('stops the build for a page sheet with no scope', () => {
    expect(() => scopePageSheet('/x/apps/web/styles/page-not-listed.css', '.a{}')).toThrow(/has no screen/);
    expect(() => scopePageSheet('/x/apps/web/styles/app/booking.css', '.a{}')).toThrow(/not a page sheet/);
  });
});

describe('the scope transform', () => {
  const one: SheetScope = { screens: ['SCR-CUS-01'] };
  const two: SheetScope = { screens: ['SCR-OFC-02'], shared: ['SCR-OFC-18'] };

  it('puts a zero-specificity suffix on the subject, before a pseudo-element', () => {
    const cus = ':is([data-screen="SCR-CUS-01"], [data-screen-of="SCR-CUS-01"])';
    expect(scopeSelector('.tile b', one)).toBe(`.tile b:where(${cus}, ${cus} *)`);
    expect(scopeSelector('.a:hover::before', one)).toBe(`.a:hover:where(${cus}, ${cus} *)::before`);
    expect(scopeSelector('.a:after', one)).toBe(`.a:where(${cus}, ${cus} *):after`);
  });

  it('scopes a body or html rule to while a screen is shown, never to a shared dialog', () => {
    expect(scopeSelector('body', two)).toBe('body:where(:has(:is([data-screen="SCR-OFC-02"], [data-screen-of="SCR-OFC-02"])))');
    expect(scopeSelector('html body.r1', one)).toBe('html body.r1:where(:has(:is([data-screen="SCR-CUS-01"], [data-screen-of="SCR-CUS-01"])))');
    const both = ':is([data-screen="SCR-OFC-02"], [data-screen-of="SCR-OFC-02"], [data-screen="SCR-OFC-18"], [data-screen-of="SCR-OFC-18"])';
    expect(scopeSelector('body.r1p .x', two)).toBe(`body.r1p .x:where(${both}, ${both} *)`);
  });

  it('keeps strings, comments, keyframes and font faces as they are', () => {
    const css = '/* a { b } */ .q[data-a="x, y { }"] { content: "}" } @keyframes k { from { opacity: 0 } } @font-face { font-family: F }';
    const out = scopeSheet(css, one);
    expect(out).toContain('/* a { b } */');
    expect(out).toContain('.q[data-a="x, y { }"]:where(');
    expect(out).toContain('content: "}"');
    expect(out).toContain('@keyframes k { from { opacity: 0 } }');
    expect(out).toContain('@font-face { font-family: F }');
  });

  it('refuses a scope with no screen or an ID that is not a screen ID', () => {
    expect(() => scopeSheet('.a{}', { screens: [] })).toThrow(/names no screen/);
    expect(() => scopeSheet('.a{}', { screens: ['CUS-01'] })).toThrow(/not a screen ID/);
  });
});
