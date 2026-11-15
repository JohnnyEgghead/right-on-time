// SPDX-License-Identifier: AGPL-3.0-or-later
// The native gates' own logic on fixed inputs (P6-XCUITEST): the Spanish walk's verdict over a walk log, and native-no-demo's scan over a
// bundle. The real runs are xcuitest/suite.sh's (the simulator's walk, the app's built bundle); these hold the rules each verdict applies.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogEntries, MIN_ENTRIES, scan } from './native-no-demo.ts';
import { englishOf, judge, matchers, messageSource, NATIVE_ROWS, spanishValues } from './spanish-walk.ts';

const dir = path.join(import.meta.dirname, '..', '..', 'packages', 'i18n', 'catalog');
const en = JSON.parse(readFileSync(path.join(dir, 'en.json'), 'utf8')) as Record<string, string>;
const es = JSON.parse(readFileSync(path.join(dir, 'es.json'), 'utf8')) as Record<string, string>;
const ms = matchers(en, es);
const line = (row: string, text: string) => `NATIVE-ES-TEXT ${row} ${JSON.stringify([text])}`;
/** A walk where every native row shows 1 Spanish catalog value (the Today tab's name) and the test's own data. */
const spanishWalk = (extra: string[] = []) => [...NATIVE_ROWS.flatMap((r) => [line(r, es['tech.tab.today'] as string), line(r, 'Harold Jenkins')]), ...extra].join('\n');

describe('the Spanish walk verdict', () => {
  // why: FR-LANG-1 an ICU message matches the text a screen draws: its arguments, a plural's branches and its number
  it('reads ICU messages as the screens draw them', () => {
    const waiting = new RegExp(`^${messageSource(en['tech.sync.old'] as string).re}$`, 'u');
    expect(waiting.test('1 item has waited more than 24 hours to send.')).toBe(true);
    expect(waiting.test('3 items have waited more than 24 hours to send.')).toBe(true);
    expect(waiting.test('1 elemento lleva más de 24 horas sin enviarse.')).toBe(false);
  });

  // why: FR-LANG-1, FR-LANG-3 a walk with Spanish on every native row and no English passes
  it('passes a Spanish walk of every native row', () => {
    const v = judge(spanishWalk(), en, es);
    expect(v.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(v.ok).toBe(true);
  });

  // why: FR-LANG-3 the planted English value on a native screen fails the walk, whole or inside a composed line
  it('fails an English value on a native screen', () => {
    const whole = judge(spanishWalk([line('SCR-TEC-10', en['tech.me.notifications'] as string)]), en, es);
    expect(whole.ok).toBe(false);
    expect(whole.lines.some((l) => l.startsWith('FAIL SCR-TEC-10: English text') && l.includes('tech.me.notifications'))).toBe(true);
    expect(englishOf(`Hoy - ${en['tech.job.noHistory'] as string}`, ms)?.how).toBe('part');
  });

  // why: FR-LANG-1 a native row never reached, or a row with no Spanish on it, is a FAIL, never a pass
  it('fails a row not reached and a row with no Spanish', () => {
    const missing = judge(spanishWalk().split('\n').filter((l) => !l.includes(' SCR-TEC-16 ')).join('\n'), en, es);
    expect(missing.ok).toBe(false);
    expect(missing.lines).toContain('FAIL SCR-TEC-16: not reached (no NATIVE-ES-TEXT line)');
    const noSpanish = judge(spanishWalk().split('\n').filter((l) => !(l.includes(' SCR-TEC-03 ') && l.includes(es['tech.tab.today'] as string))).join('\n'), en, es);
    expect(noSpanish.ok).toBe(false);
    expect(noSpanish.lines.some((l) => l.startsWith('FAIL SCR-TEC-03: no Spanish catalog value'))).toBe(true);
  });

  // why: FR-LANG-1 text both languages share (a name, a number, a value equal in both catalogs) is never English by itself
  it('does not count shared text as English', () => {
    const esAll = spanishValues(es);
    for (const t of ['English', 'Use su cuenta de trabajo de Brightwater.', 'Harold Jenkins', '24830', '(614) 555-0100', '10:00 AM - 12:00 PM']) expect(englishOf(t, ms, esAll)).toBeNull();
  });
});

describe('native-no-demo', () => {
  const bundle = (pairs: Record<string, string>) => {
    const base: Record<string, string> = {};
    for (let i = 0; i < MIN_ENTRIES; i++) base[`tech.fixture.k${i}`] = `Value number ${i} for the fixture`;
    return `__d(function(g,r,i,a,m,e,d){m.exports=${JSON.stringify({ ...base, ...pairs })}},1,[]);var x={"notakey":"demo"};`;
  };

  // why: FR-IOS-4 a bundle whose catalog holds no "demo" passes, and code strings outside the catalog are not the catalog
  it('passes a catalog with no demo', () => {
    const v = scan(bundle({ 'tech.tab.today': 'Today' }));
    expect(v.ok).toBe(true);
    expect(catalogEntries(bundle({})).some((e) => e.key === 'notakey')).toBe(false);
  });

  // why: FR-IOS-4 the planted catalog value containing "demo" (any case) fails, and so does a key containing it
  it('fails a planted catalog value or key containing demo', () => {
    expect(scan(bundle({ 'tech.tab.today': 'Today (DEMO)' })).ok).toBe(false);
    expect(scan(bundle({ 'tech.signin.demo': 'Sign in as' })).ok).toBe(false);
  });

  // why: FR-IOS-4 a bundle with no catalog found is a FAIL, and the shipped bundle must hold the export's values
  it('fails when the catalog is not found or the shipped bundle differs', () => {
    expect(scan('var x = 1;').ok).toBe(false);
    const js = bundle({ 'tech.tab.today': 'Today' });
    const shipped = Buffer.from(Object.values(JSON.parse(/m\.exports=(\{.*\})\}/.exec(js)?.[1] ?? '{}') as Record<string, string>).join('\u0000'), 'utf8');
    expect(scan(js, shipped).ok).toBe(true);
    expect(scan(js, Buffer.from('nothing here', 'utf8')).ok).toBe(false);
  });
});

describe('native-no-demo.sh', () => {
  // why: F-1204 the gate changes directory before it writes, so a relative --out must land under the caller's directory, not under apps/tech-native
  it('writes a relative --out under the caller directory', () => {
    const caller = mkdtempSync(path.join(os.tmpdir(), 'bw-no-demo-'));
    const bin = path.join(caller, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\necho fake export failed >&2\nexit 1\n');
    chmodSync(path.join(bin, 'npx'), 0o755);
    const sh = path.join(import.meta.dirname, '..', 'gates', 'native-no-demo.sh');
    const r = spawnSync('bash', [sh, '--out', 'rel-out'], { cwd: caller, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(existsSync(path.join(caller, 'rel-out', 'export.log'))).toBe(true);
  });
});
