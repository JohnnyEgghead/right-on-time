// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's entry and its kit assets: the Intl polyfills install before the first render (F-141); the icons are the web app's
// own DK-70 paths; the Inter faces are the kit's font at the weights the styles name, each found by app.json's font plugin.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_PATHS } from '../../web/src/shell/icon-paths.ts';
import { FONT_FILES, FONT_WEIGHTS, inter } from './ui/fonts.ts';
import { NATIVE_ICON_PATHS } from './ui/icon-paths.ts';
import { STEP_ICON_PATHS } from './ui/icon-paths-steps.ts';

const APP = path.resolve(import.meta.dirname, '..');
// F-1852: mockups/ is a private path (scripts/private-paths.txt), so in a public copy the test that reads the kit frame skips with a
// note naming it; the private checkout has it and the test runs.
const noFrame = existsSync(path.join(APP, '../../mockups/pages/r1-ios-b.html')) ? '' : 'mockups/pages/r1-ios-b.html is not in this copy (a private path the public export leaves out)';

/** A TrueType file's OS/2 weight class and its name records 6 (PostScript) and 16 (typographic family), read from the tables. */
function face(file: string): { weight: number; postScript: string; family: string } {
  const b = readFileSync(file);
  const tables = new Map<string, number>();
  for (let i = 0; i < b.readUInt16BE(4); i++) tables.set(b.toString('latin1', 12 + i * 16, 16 + i * 16), b.readUInt32BE(12 + i * 16 + 8));
  const os2 = tables.get('OS/2') as number;
  const name = tables.get('name') as number;
  const read = (id: number) => {
    const count = b.readUInt16BE(name + 2);
    const base = name + b.readUInt16BE(name + 4);
    for (let i = 0; i < count; i++) {
      const r = name + 6 + i * 12;
      if (b.readUInt16BE(r) === 3 && b.readUInt16BE(r + 6) === id) return b.subarray(base + b.readUInt16BE(r + 10), base + b.readUInt16BE(r + 10) + b.readUInt16BE(r + 8)).swap16().toString('utf16le');
    }
    return '';
  };
  return { weight: b.readUInt16BE(os2 + 4), postScript: read(6), family: read(16) };
}

describe('the native entry', () => {
  // why: FR-LANG-1, F-141 the entry installs the R7 section 3.1 polyfills before the app renders
  it('calls installIntlPolyfills at load and renders the app only once it settled', () => {
    const src = readFileSync(path.join(APP, 'index.ts'), 'utf8');
    expect(src).toMatch(/import \{ installIntlPolyfills \} from '@bw\/i18n\/src\/polyfills\.ts';/);
    expect(src).toMatch(/^const polyfills = installIntlPolyfills\(\);$/m);
    expect(src).toMatch(/polyfills\.then\(\(\) => setReady\(true\)/);
    expect(src).toMatch(/return ready \? createElement\(App\) : null;/);
    expect(src.indexOf('installIntlPolyfills()')).toBeLessThan(src.indexOf('registerRootComponent(Entry)'));
  });
});

describe('the native kit assets', () => {
  // why: FR-IOS-1 the native icons are the kit's DK-70 paths, the same strings the web app draws
  it('draws each icon with the web app\'s own path', () => {
    for (const [name, d] of Object.entries(NATIVE_ICON_PATHS)) expect(d, name).toBe(ICON_PATHS[name as keyof typeof ICON_PATHS]);
  });

  // why: FR-TECH-5 the Steps list's turn arrows are DK-117's own (kit 0.9, F-1233): each path is the kit frame's string, drawn the same way
  it('draws each turn arrow with the kit frame\'s own path', (ctx) => {
    if (noFrame) ctx.skip(noFrame);
    const frame = readFileSync(path.join(APP, '../../mockups/pages/r1-ios-b.html'), 'utf8');
    for (const [name, d] of Object.entries(STEP_ICON_PATHS)) expect(frame, name).toContain(`${name}: '${d}'`);
    expect(Object.keys(NATIVE_ICON_PATHS).filter((n) => n in STEP_ICON_PATHS)).toEqual([]);
  });

  // why: FR-IOS-1 every weight a style names is an Inter face of that weight, embedded by app.json's font plugin
  it('has 1 Inter face per weight, named as the styles name it, and app.json embeds each', () => {
    const appJson = JSON.parse(readFileSync(path.join(APP, 'app.json'), 'utf8')) as { expo: { plugins: unknown[] } };
    const plugin = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-font') as [string, { fonts: string[] }];
    expect(plugin[1].fonts).toEqual([...FONT_FILES]);
    const script = readFileSync(path.join(APP, 'scripts', 'make-fonts.py'), 'utf8');
    expect(script).toContain(`WEIGHTS = [${FONT_WEIGHTS.join(', ')}]`);
    for (const w of FONT_WEIGHTS) {
      expect(face(path.join(APP, 'assets', 'fonts', `Inter-W${w}.ttf`))).toEqual({ weight: w, postScript: inter(w), family: 'Inter' });
    }
  });
});
