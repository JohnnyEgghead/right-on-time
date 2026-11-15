// SPDX-License-Identifier: AGPL-3.0-or-later
// The native catalog subset (F-1199): the committed apps/tech-native/src/ui/catalog-native.json is exactly what the native import graph
// can show, and the derivation fails on every key route it cannot see. Fixture graphs hold the rules; the real graph holds the file.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DATA_KEYS, derive, OUT, subsetText } from './catalog-subset.ts';

const root = path.join(import.meta.dirname, '..', '..');
const cat = (lang: string) => JSON.parse(readFileSync(path.join(root, 'packages', 'i18n', 'catalog', `${lang}.json`), 'utf8')) as Record<string, string>;
const en = cat('en');
const es = cat('es');

const tmp = mkdtempSync(path.join(tmpdir(), 'catalog-subset-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** A fixture repo: files by relative path; the entry is app/index.ts. */
function fixture(files: Record<string, string>): string {
  const dir = path.join(tmp, `f${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const KEYS = ['a.one', 'a.two', 'status.open', 'status.done', 'service.cut', 'other.demo'];

describe('the native catalog subset', () => {
  // why: F-1199 FR-IOS-4 the native build ships only the catalog keys native code uses; a stale subset or an unseen key route fails here
  it('is exactly the derivation over the native import graph, with no key route the derivation cannot see', () => {
    const d = derive(Object.keys(en));
    expect(d.findings).toEqual([]);
    expect(readFileSync(path.join(root, OUT), 'utf8')).toBe(subsetText(d.keys, en, es));
    expect(d.files).toContain('apps/tech-native/src/App.tsx');
    expect(d.files).not.toContain('packages/i18n/src/catalog.ts');
  });

  // why: F-1199 FR-IOS-4, FR-LANG-1 the subset is the shared catalog's words (both languages), never reworded and never a demo word
  it('holds the same keys in en and es, every one a shared catalog key, none with "demo"', () => {
    const s = JSON.parse(readFileSync(path.join(root, OUT), 'utf8')) as { en: Record<string, string>; es: Record<string, string> };
    expect(Object.keys(s.es)).toEqual(Object.keys(s.en));
    for (const k of Object.keys(s.en)) {
      expect(s.en[k]).toBe(en[k]);
      expect(s.es[k]).toBe(es[k]);
      expect(`${k} ${s.en[k]} ${s.es[k]}`).not.toMatch(/demo/i);
    }
  });

  // why: F-1199 the derivation is mechanical: a literal key, a template head's family, and only the files the bundle can hold
  it('takes literals and template families, follows value imports and skips type-only ones', () => {
    const dir = fixture({
      'app/index.ts': "import { b } from './b.ts';\nimport type { X } from './typed.ts';\nexport const a = ['a.one', b(`status.${String(1)}`)];\n",
      'app/b.ts': "export const b = (k: string) => k;\nexport const n = 'not.a.key';\n",
      'app/typed.ts': "export type X = 'a.two';\nexport const t = 'a.two';\n",
    });
    const d = derive(KEYS, dir, 'app/index.ts');
    expect(d.keys).toEqual(['a.one', 'status.done', 'status.open']);
    expect(d.files).toEqual(['app/b.ts', 'app/index.ts']);
    expect(d.findings).toEqual([]);
  });

  // why: F-1199 a key that reaches t() through a cast has no literal: the test fails unless DATA_KEYS names the field and its family
  it('fails on a key cast from data it does not know, and takes the family of a declared data key', () => {
    expect(DATA_KEYS['serviceLabelKey']).toBe('service.');
    const dir = fixture({
      'app/index.ts': "type MessageKey = string;\ndeclare const t: (k: MessageKey) => string;\ndeclare const j: { serviceLabelKey: string; mystery: string };\n" +
        "export const a = t(j.serviceLabelKey as MessageKey);\nexport const b = t(j.mystery as never);\n",
    });
    const d = derive(KEYS, dir, 'app/index.ts');
    expect(d.keys).toEqual(['service.cut']);
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0]).toMatchObject({ file: 'app/index.ts', line: 5 });
    expect(d.findings[0]?.what).toContain('j.mystery');
  });

  // why: F-1212 a cast to an alias of MessageKey or to keyof typeof, and a formatMessage id that is no literal, reach t() unseen unless refused
  it('fails on a cast to a key alias or keyof typeof, and on a non-literal formatMessage id outside the allowed files', () => {
    const dir = fixture({
      'app/index.ts': "type MessageKey = string;\ntype K = MessageKey;\nconst c = { a: 1 };\ndeclare const t: (k: MessageKey) => string;\ndeclare const j: { mystery: string };\n" +
        "declare const intl: { formatMessage: (d: { id: string }) => string };\n" +
        "export const a = t(j.mystery as K);\nexport const b = t(j.mystery as keyof typeof c);\nexport const d = intl.formatMessage({ id: j.mystery });\nexport const e = intl.formatMessage({ id: 'a.one' });\n",
    });
    const d = derive(KEYS, dir, 'app/index.ts');
    expect(d.findings.map((f) => f.line)).toEqual([7, 8, 9]);
    expect(d.findings[2]?.what).toContain('formatMessage');
    expect(d.keys).toEqual(['a.one']);
  });

  // why: F-1199 FR-IOS-4 importing the shared catalog as a value would ship every key again (the 55 demo entries of the first red run)
  it('fails on a value import of the full shared catalog', () => {
    const dir = fixture({
      'app/index.ts': "import { catalogs } from '../packages/i18n/src/catalog.ts';\nimport type { MessageKey } from '../packages/i18n/src/catalog.ts';\nexport default catalogs;\n",
      'packages/i18n/src/catalog.ts': "export const catalogs = { en: { 'other.demo': 'x' } };\nexport type MessageKey = string;\n",
    });
    const d = derive(KEYS, dir, 'app/index.ts');
    expect(d.findings).toHaveLength(1);
    expect(d.findings[0]).toMatchObject({ file: 'app/index.ts', line: 1 });
    expect(d.findings[0]?.what).toContain('full catalog');
    expect(d.files).not.toContain('packages/i18n/src/catalog.ts');
  });
});
