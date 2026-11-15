// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCatalog, serializeCatalog } from './catalog-format.ts';
import { checkCatalogFiles, checkParity } from './parity.ts';

const dir = fileURLToPath(new URL('../catalog/', import.meta.url));
const enText = readFileSync(`${dir}en.json`, 'utf8');
const esText = readFileSync(`${dir}es.json`, 'utf8');

describe('catalog-parity', () => {
  // why: FR-LANG-2
  it('passes the real catalog pair', () => {
    expect(checkCatalogFiles(enText, esText)).toEqual([]);
  });

  // why: FR-LANG-2
  it('fails a planted key present in English only', () => {
    const en = { ...parseCatalog(enText), 'planted.englishOnly': 'Only English' };
    const issues = checkCatalogFiles(serializeCatalog(en), esText);
    expect(issues).toContainEqual({ kind: 'missing-in-es', key: 'planted.englishOnly' });
  });

  // why: FR-LANG-2
  it('fails a planted key present in Spanish only', () => {
    const es = { ...parseCatalog(esText), 'planted.spanishOnly': 'Solo espanol' };
    expect(checkCatalogFiles(enText, serializeCatalog(es))).toContainEqual({
      kind: 'missing-in-en',
      key: 'planted.spanishOnly',
    });
  });

  // why: F-419
  it('lets a Spanish text template leave {weekday} out, and nothing else: not another argument, not another key, not an added weekday', () => {
    const t = (en: string, es: string) => checkParity({ 'text.x': en }, { 'text.x': es });
    expect(t('Visit {weekday}, {date}', 'Visita del {date}')).toEqual([]);
    expect(t('Visit {weekday}, {date}', 'Visita del {weekday}, {date}')).toEqual([]);
    expect(t('Visit {weekday}, {date}', 'Visita del {weekday}')).toEqual([{ kind: 'icu-mismatch', key: 'text.x' }]);
    expect(t('Visit {date}', 'Visita del {weekday}, {date}')).toEqual([{ kind: 'icu-mismatch', key: 'text.x' }]);
    expect(checkParity({ 'ui.x': 'Visit {weekday}, {date}' }, { 'ui.x': 'Visita del {date}' })).toEqual([{ kind: 'icu-mismatch', key: 'ui.x' }]);
  });

  // why: FR-LANG-2
  it('fails an ICU argument renamed, dropped or retyped between the languages, and passes the plural-category difference (F-148)', () => {
    const bad = (en: string, es: string) => checkParity({ a: en }, { a: es });
    expect(bad('{count, plural, one {# job} other {# jobs}}', '{total, plural, one {# trabajo} other {# trabajos}}')).toEqual([{ kind: 'icu-mismatch', key: 'a' }]);
    expect(bad('Call {name}, {number}', 'Llamar a {name}')).toEqual([{ kind: 'icu-mismatch', key: 'a' }]);
    expect(bad('{n, plural, other {x {name}}}', '{n, plural, other {y {who}}}')).toEqual([{ kind: 'icu-mismatch', key: 'a' }]);
    expect(bad('<b>{name}</b> paused', '<i>{name}</i> pausado')).toEqual([{ kind: 'icu-mismatch', key: 'a' }]);
    expect(bad('{n, number}', '{n}')).toEqual([{ kind: 'icu-mismatch', key: 'a' }]);
    expect(bad('{', 'abierto')).toEqual([{ kind: 'icu-mismatch', key: 'a' }]);
    // control: same arguments, es adds the many category
    expect(bad('{count, plural, one {# job} other {# jobs}}', '{count, plural, one {# trabajo} many {# de trabajos} other {# trabajos}}')).toEqual([]);
    expect(bad('<b>{name}</b> paused', '<b>{name}</b> pausado')).toEqual([]);
  });

  // why: FR-LANG-2
  it('fails a committed catalog that holds the merge driver conflict markers (F-158)', () => {
    const marked = enText.replace(/^(\s+"[^"]+": ".*",?)$/m, '<<<<<<< ours\n$1\n=======\n$1\n>>>>>>> theirs');
    expect(marked).toContain('<<<<<<< ours');
    expect(() => checkCatalogFiles(marked, esText)).toThrow(); // the file does not parse, so the gate script exits red
    expect(() => checkCatalogFiles(enText, esText)).not.toThrow(); // control
  });

  // why: FR-LANG-2
  it('fails an empty Spanish value', () => {
    expect(checkParity({ a: 'Save' }, { a: '' })).toEqual([{ kind: 'empty-es', key: 'a' }]);
    expect(checkParity({ a: 'Save' }, { a: '   ' })).toEqual([{ kind: 'empty-es', key: 'a' }]);
  });

  // why: FR-LANG-2
  it('fails a Spanish value equal to English unless it is allowlisted', () => {
    expect(checkParity({ a: 'Save' }, { a: 'Save' })).toEqual([{ kind: 'es-equals-en', key: 'a' }]);
    for (const word of ['Brightwater', 'PM', 'OK']) {
      expect(checkParity({ a: word }, { a: word })).toEqual([]);
    }
  });

  // why: F-140 the language choices read English / Español in every language; the seed had translated them
  it('allows the 2 language names and the 2 proper names, and the catalogs hold the names as UI-SPEC 13.1 item 7 shows them', () => {
    for (const word of ['English', 'Español', 'Right On Time', 'Heating & Air']) {
      expect(checkParity({ a: word }, { a: word })).toEqual([]);
    }
    for (const lang of [parseCatalog(enText), parseCatalog(esText)]) {
      expect(lang['language.name.en']).toBe('English');
      expect(lang['language.name.es']).toBe('Español');
    }
    expect(checkParity({ a: 'Inglés' }, { a: 'Inglés' })).toEqual([{ kind: 'es-equals-en', key: 'a' }]);
  });

  // why: FR-LANG-2
  it('fails a file that is not key-sorted with 1 key per line', () => {
    const unsorted = '{\n  "b": "B",\n  "a": "A"\n}\n';
    expect(checkCatalogFiles(unsorted, '{\n  "a": "Aa",\n  "b": "Bb"\n}\n')).toContainEqual({
      kind: 'file-format',
      key: 'en.json',
    });
    expect(checkCatalogFiles('{"a":"A","b":"B"}\n', '{\n  "a": "Aa",\n  "b": "Bb"\n}\n')).toContainEqual({
      kind: 'file-format',
      key: 'en.json',
    });
  });
});
