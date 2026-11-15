// SPDX-License-Identifier: AGPL-3.0-or-later
// The native Spanish walk's verdict (P6-XCUITEST; FR-LANG-1, FR-LANG-3): xcuitest/SpanishUITests.swift opens every native page-inventory
// row in Spanish and prints each text the accessibility tree holds as `NATIVE-ES-TEXT <row> ["<text>"]`; this reads those lines against the
// shared catalog (packages/i18n/catalog/en.json, es.json) and fails:
//   - an English text: a text that is a whole English catalog value, or holds one of 2 words or more, where that key's Spanish value differs
//     (a value the 2 languages share, a brand or a number, is never English by itself, and a text that is any Spanish value is Spanish);
//     It reads catalog values only (F-1212): English that is no catalog value passes, such as the system's own "Horizontal scroll bar, 1 page"
//     (the app declares only English, so the system and the map library draw their words in English on a Spanish phone, the F-1200 cause);
//   - a screen with no Spanish catalog value on it (an empty or unread screen is not a pass);
//   - a native row of the page inventory the walk never reached (NATIVE_ROWS: UI-SPECIFICATION section 2's rows with a native screen).
//   node ci/native/spanish-walk.ts --log <xcuitest.log> [--catalog <dir>]    exit 0 PASS, 1 FAIL, 2 usage
// A catalog value is a message in ICU form: its {arguments} match any text, a plural or select matches any of its branches (# a number),
// and tags (<b>, <addr>) are dropped, as the screens draw them. A value whose literal words are under 3 letters is not used alone.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../is-main.ts';

/** The page inventory's native rows (UI-SPECIFICATION section 2): SCR-TEC-11 is web only. */
export const NATIVE_ROWS = [
  'SCR-TEC-01', 'SCR-TEC-02', 'SCR-TEC-03', 'SCR-TEC-04', 'SCR-TEC-05', 'SCR-TEC-06', 'SCR-TEC-07', 'SCR-TEC-08', 'SCR-TEC-09', 'SCR-TEC-10',
  'SCR-TEC-12', 'SCR-TEC-13', 'SCR-TEC-14', 'SCR-TEC-15', 'SCR-TEC-16', 'SCR-EML-03',
] as const;

type Catalog = Record<string, string>;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The index of the brace that closes the one at `open`. */
function closing(msg: string, open: number): number {
  let depth = 0;
  for (let i = open; i < msg.length; i++) {
    if (msg[i] === '{') depth++;
    else if (msg[i] === '}' && --depth === 0) return i;
  }
  return msg.length - 1;
}

/** An ICU message as a regular expression source over the text a screen draws, and its literal letters. */
export function messageSource(msg: string, inPlural = false): { re: string; letters: number } {
  let re = '';
  let letters = 0;
  let i = 0;
  const lit = (s: string) => {
    re += esc(s);
    letters += (s.match(/\p{L}/gu) ?? []).length;
  };
  while (i < msg.length) {
    const ch = msg[i] as string;
    if (ch === '{') {
      const end = closing(msg, i);
      const inner = msg.slice(i + 1, end);
      const m = /^\s*(\w+)\s*,\s*(plural|select|selectordinal)\s*,([\s\S]*)$/.exec(inner);
      if (m) {
        const branches: string[] = [];
        const body = m[3] as string;
        let j = 0;
        while (j < body.length) {
          const b = body.indexOf('{', j);
          if (b < 0) break;
          const e = closing(body, b);
          const sub = messageSource(body.slice(b + 1, e), m[2] !== 'select');
          branches.push(sub.re);
          j = e + 1;
        }
        re += `(?:${branches.join('|')})`;
      } else {
        re += '(.+?)';
      }
      i = end + 1;
    } else if (ch === '#' && inPlural) {
      re += '[0-9][0-9.,]*';
      i++;
    } else if (ch === '<') {
      const end = msg.indexOf('>', i);
      if (end < 0) {
        lit(ch);
        i++;
      } else i = end + 1; // a tag: drawn as its content
    } else if (ch === "'" && msg[i + 1] === "'") {
      lit("'");
      i += 2;
    } else {
      lit(ch);
      i++;
    }
  }
  return { re, letters };
}

export interface Matcher { key: string; en: RegExp; es: RegExp; enPlain: string | null }

/** Every Spanish catalog value as a whole-text pattern, those equal to their English included ("English" names itself in both). */
export function spanishValues(es: Catalog): RegExp[] {
  // only values with words of their own: "{name}" alone would make every text Spanish
  return Object.values(es).filter((v) => messageSource(v).letters >= 3 && /\p{L}{3,}/u.test(v.replace(/\{[^{}]*\}/g, '')))
    .map((v) => new RegExp(`^${messageSource(v).re}$`, 'u'));
}

/** The keys whose English and Spanish differ and whose English has words of its own (3 letters or more). */
export function matchers(en: Catalog, es: Catalog): Matcher[] {
  const out: Matcher[] = [];
  for (const [key, ev] of Object.entries(en)) {
    const sv = es[key];
    if (sv === undefined || sv === ev) continue;
    const e = messageSource(ev);
    if (e.letters < 3 || !/\p{L}{3,}/u.test(ev.replace(/\{[^{}]*\}/g, ''))) continue;
    const plain = !/[{<#]/.test(ev) && ev.trim().split(/\s+/).length >= 2 && !sv.includes(ev) ? ev.trim() : null;
    out.push({ key, en: new RegExp(`^${e.re}$`, 'u'), es: new RegExp(`^${messageSource(sv).re}$`, 'u'), enPlain: plain });
  }
  return out;
}

/** Spanish catalog values (whole texts) whose English differs: the screen's proof that it is drawn in Spanish. */
function spanishOf(text: string, ms: Matcher[]): string | null {
  for (const m of ms) if (m.es.test(text) && !m.en.test(text)) return m.key;
  return null;
}

/** The English catalog value a text is, or holds, or null. */
export function englishOf(text: string, ms: Matcher[], esAll: RegExp[] = ms.map((m) => m.es)): { key: string; how: 'whole' | 'part' } | null {
  // A text that is a Spanish catalog value is Spanish, whatever English it also looks like ("Use su cuenta...", a language's own name).
  if (esAll.some((r) => r.test(text.trim()))) return null;
  const parts = [text, ...text.split(/, |\n/)].map((p) => p.trim()).filter((p) => p.length > 0);
  for (const m of ms) {
    for (const p of parts) if (m.en.test(p) && !esAll.some((r) => r.test(p))) return { key: m.key, how: 'whole' };
  }
  for (const m of ms) {
    if (m.enPlain === null) continue;
    const at = text.indexOf(m.enPlain);
    if (at < 0) continue;
    const before = at === 0 ? '' : text[at - 1] as string;
    const after = text[at + m.enPlain.length] ?? '';
    if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) return { key: m.key, how: 'part' };
  }
  return null;
}

export interface Verdict { ok: boolean; lines: string[] }

export function judge(log: string, en: Catalog, es: Catalog): Verdict {
  const ms = matchers(en, es);
  const esAll = spanishValues(es);
  const byRow = new Map<string, string[]>();
  for (const line of log.split('\n')) {
    const m = /^NATIVE-ES-TEXT (\S+) (\[.*\])$/.exec(line.trim());
    if (!m) continue;
    let text: string;
    try {
      text = String((JSON.parse(m[2] as string) as unknown[])[0] ?? '');
    } catch {
      continue;
    }
    byRow.set(m[1] as string, [...(byRow.get(m[1] as string) ?? []), text]);
  }
  const lines: string[] = [];
  let ok = true;
  for (const row of NATIVE_ROWS) {
    const texts = byRow.get(row);
    if (!texts) {
      ok = false;
      lines.push(`FAIL ${row}: not reached (no NATIVE-ES-TEXT line)`);
      continue;
    }
    const english = texts.map((t) => ({ t, hit: englishOf(t, ms, esAll) })).filter((x) => x.hit !== null);
    const spanish = texts.map((t) => spanishOf(t, ms)).filter((k) => k !== null);
    for (const x of english) lines.push(`FAIL ${row}: English text ${JSON.stringify(x.t)} (${x.hit?.how} of ${x.hit?.key})`);
    if (spanish.length === 0) lines.push(`FAIL ${row}: no Spanish catalog value among its ${texts.length} texts`);
    if (english.length > 0 || spanish.length === 0) ok = false;
    else lines.push(`ok   ${row}: ${texts.length} texts, ${spanish.length} Spanish catalog values, no English`);
  }
  const extra = [...byRow.keys()].filter((r) => !(NATIVE_ROWS as readonly string[]).includes(r));
  for (const r of extra) lines.push(`note ${r}: walked, not a native inventory row`);
  lines.push(`spanish walk: ${ok ? 'PASS' : 'FAIL'} (${NATIVE_ROWS.length} native rows, ${ms.length} catalog keys differ between English and Spanish)`);
  return { ok, lines };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const logFile = at('--log');
  if (!logFile) {
    console.error('usage: node ci/native/spanish-walk.ts --log <xcuitest.log> [--catalog <dir>]');
    process.exit(2);
  }
  const dir = at('--catalog') ?? path.join(import.meta.dirname, '..', '..', 'packages', 'i18n', 'catalog');
  const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Catalog;
  const v = judge(readFileSync(logFile, 'utf8'), read('en.json'), read('es.json'));
  for (const l of v.lines) console.log(l);
  process.exit(v.ok ? 0 : 1);
}
