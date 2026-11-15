// SPDX-License-Identifier: AGPL-3.0-or-later
// native-no-demo (FR-IOS-4; SPECIFICATIONS 6.12 "No demo wording", section 14 Content and catalog; BUILD_PLAN gate table: owner P6-XCUITEST):
// a string scan of the native app's built bundle's catalog finds no "demo".
//   node ci/native/native-no-demo.ts --bundle <main.jsbundle as JavaScript> [--hbc <the app's main.jsbundle>]   exit 0 PASS, 1 FAIL, 2 usage
// The bundle is the app's release JavaScript (ci/gates/native-no-demo.sh makes it with `expo export:embed`, the command the Xcode build
// phase runs before Hermes compiles it). The catalog in it is every string pair "<key>": "<value>" whose key has a catalog key's form
// (lowercase words joined by dots: tech.tab.today); every such key and value is scanned for "demo" in any case. With --hbc, the shipped
// Hermes bundle is read too: every catalog value of 12 characters or more found in the JavaScript must be in it (UTF-8 or UTF-16LE), so the
// scan is of what ships (a rebuilt or stale export fails here, not silently).
// Fewer than MIN_ENTRIES catalog entries means the catalog was not found: a FAIL, never a pass.
import { readFileSync } from 'node:fs';
import { isMain } from '../is-main.ts';

export const MIN_ENTRIES = 200;
const KEY = /^[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/;
const PAIR = /"((?:[^"\\\n]|\\.)*)"\s*:\s*"((?:[^"\\\n]|\\.)*)"/g;
const DEMO = /demo/i;

export interface Entry { key: string; value: string }

/** The catalog entries of a JavaScript bundle (string pairs with a catalog key), each key once per value. */
export function catalogEntries(js: string): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const m of js.matchAll(PAIR)) {
    let key: string, value: string;
    try {
      key = JSON.parse(`"${m[1] as string}"`) as string;
      value = JSON.parse(`"${m[2] as string}"`) as string;
    } catch {
      continue;
    }
    if (!KEY.test(key)) continue;
    const id = `${key}\u0000${value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, value });
  }
  return out;
}

export interface Verdict { ok: boolean; lines: string[] }

export function scan(js: string, hbc?: Buffer): Verdict {
  const entries = catalogEntries(js);
  const lines: string[] = [];
  let ok = true;
  if (entries.length < MIN_ENTRIES) {
    ok = false;
    lines.push(`FAIL the bundle holds ${entries.length} catalog entries (under ${MIN_ENTRIES}): the catalog was not found`);
  }
  const hits = entries.filter((e) => DEMO.test(e.key) || DEMO.test(e.value));
  for (const h of hits) lines.push(`FAIL ${h.key}: ${JSON.stringify(h.value)}`);
  if (hits.length > 0) ok = false;
  if (hbc) {
    const long = entries.filter((e) => e.value.length >= 12);
    const missing = long.filter((e) => !hbc.includes(Buffer.from(e.value, 'utf8')) && !hbc.includes(Buffer.from(e.value, 'utf16le')));
    lines.push(`shipped bundle: ${long.length - missing.length} of ${long.length} catalog values of 12 characters or more found in it`);
    for (const m of missing.slice(0, 5)) lines.push(`FAIL not in the shipped bundle: ${m.key}`);
    if (missing.length > 0) ok = false;
  }
  lines.push(`native-no-demo: ${ok ? 'PASS' : 'FAIL'} (${entries.length} catalog entries in the bundle, ${hits.length} with "demo")`);
  return { ok, lines };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const bundle = at('--bundle');
  if (!bundle) {
    console.error('usage: node ci/native/native-no-demo.ts --bundle <main.jsbundle as JavaScript> [--hbc <the app main.jsbundle>]');
    process.exit(2);
  }
  const hbcPath = at('--hbc');
  const v = scan(readFileSync(bundle, 'utf8'), hbcPath ? readFileSync(hbcPath) : undefined);
  for (const l of v.lines) console.log(l);
  process.exit(v.ok ? 0 : 1);
}
