// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-988 F-1111 F-1073 F-1088 (the TestFlight build carries no probe or look reader, and does carry the map glyph and sprite set)
// release/check-seams.py reads a built app. Here it reads planted apps: a clean one passes, and each seam it guards fails it, so the check
// is shown to fail on a build with the seams in. The real proof is the same script on the archive (release/archive.sh step 3) and on the
// bundles Metro makes with and without EXPO_PUBLIC_BW_RIG (the Metro half is in docs/build/spikes/P6-TESTFLIGHT.md).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../../apps/tech-native/release/check-seams.py');
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-seams-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A planted RightOnTime.app: the bundle and binary text, and which map folders exist. */
const STACKS = ['Noto Sans Italic', 'Noto Sans Medium', 'Noto Sans Regular'];
function plant(opts: { js?: string; bin?: string; fonts?: boolean; sprites?: boolean } = {}): string {
  const app = path.join(dir, 'RightOnTime.app');
  mkdirSync(path.join(app, 'map-assets', 'fonts'), { recursive: true });
  mkdirSync(path.join(app, 'map-assets', 'sprites'), { recursive: true });
  writeFileSync(path.join(app, 'main.jsbundle'), opts.js ?? 'function app(){return 1}');
  writeFileSync(path.join(app, 'RightOnTime'), opts.bin ?? 'Mach-O stand-in');
  if (opts.fonts !== false) {
    for (const s of STACKS) {
      mkdirSync(path.join(app, 'map-assets', 'fonts', s), { recursive: true });
      writeFileSync(path.join(app, 'map-assets', 'fonts', s, '0-255.pbf'), 'g');
    }
  }
  if (opts.sprites !== false) for (const f of ['light.json', 'light.png']) writeFileSync(path.join(app, 'map-assets', 'sprites', f), '{}');
  return app;
}
/** A planted .xcarchive around a planted app, with a dSYM whose DWARF file holds `dwarf` (null: no dSYM). */
function plantArchive(opts: Parameters<typeof plant>[0] & { dwarf: string | null }): string {
  const archive = path.join(dir, 'RightOnTime.xcarchive');
  rmSync(archive, { recursive: true, force: true }); // a test plants several in a row
  const app = plant(opts);
  mkdirSync(path.join(archive, 'Products', 'Applications'), { recursive: true });
  renameSync(app, path.join(archive, 'Products', 'Applications', 'RightOnTime.app'));
  if (opts.dwarf !== null) {
    const d = path.join(archive, 'dSYMs', 'RightOnTime.app.dSYM', 'Contents', 'Resources', 'DWARF');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'RightOnTime'), opts.dwarf);
  }
  return archive;
}
const check = (...args: string[]) => spawnSync('python3', ['-I', script, ...args], { encoding: 'utf8' });
/** A list the script holds: `NAME = ["a", "b"]` read from its source, so a word dropped from the list drops out of these tests too. */
const listIn = (name: string): string[] => {
  const m = new RegExp(`^${name} = \\[([\\s\\S]*?)\\]`, 'm').exec(readFileSync(script, 'utf8'));
  return [...(m?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
};

describe('release/check-seams.py (F-988, F-1073)', () => {
  it('passes an app with no seam strings and both map folders', () => {
    // why: F-988 the check must not cry wolf on the shipped build
    const r = check(plant());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 findings');
  });

  it.each([
    ['bwProbe', 'x=Settings.get("bwProbe")'],
    ['bwLook', 'x=Settings.get("bwLook")'],
    ['bwMapNames', 'x=Settings.get("bwMapNames")'],
    ['bwServer', 'x=Settings.get("bwServer")'],
    ['probe/credentials', 'fetch(o+"/probe/credentials")'],
    ['readLook', 'e.readLook=async function(){}'],
    ['map.list.focus', 'testID="map.list.focus"'],
  ])('fails a bundle that holds the seam string %s', (word, js) => {
    // why: F-988 F-1111 F-1088 a build with the seams in must fail the proof, naming the string
    const r = check(plant({ js }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`rig seam string '${word}'`);
  });

  it('looks for every seam string the script lists, in the bundle and in the binary (F-1220 c)', () => {
    // why: F-1220 (c) 7 of the 9 bundle strings and 1 of the 2 binary strings were pinned; dropping another from the list stayed green
    const js = listIn('JS_SEAMS');
    const bin = listIn('BINARY_SEAMS');
    expect(js.length).toBeGreaterThanOrEqual(9);
    expect(bin).toEqual(['uiFamily', 'postScript']);
    for (const w of js) {
      const r = check(plant({ js: `x="${w}"` }));
      expect(r.status, w).toBe(1);
      expect(r.stdout, w).toContain(`rig seam string '${w}'`);
    }
    for (const w of bin) {
      const r = check(plant({ bin: `x ${w} y` }));
      expect(r.status, w).toBe(1);
      expect(r.stdout, w).toContain(`look reader string '${w}'`);
    }
  });

  it('fails an archive whose dSYM holds a compiled look reader symbol, though the executable holds no reader string (F-1220 a)', () => {
    // why: F-1220 (a) a compiled -O arm64 reader holds neither key as bytes (Swift small strings are register immediates): its symbols are the evidence; a planted symbol must fail
    expect(listIn('SYMBOLS')).toEqual(['nameRecord', 'weightClass']);
    for (const w of listIn('SYMBOLS')) {
      const r = check(plantArchive({ dwarf: `...BwLook...${w}...` }));
      expect(r.status, w).toBe(1);
      expect(r.stdout, w).toContain(`dSYM RightOnTime holds the look reader symbol '${w}'`);
    }
    const clean = check(plantArchive({ dwarf: 'BwLookModule definition' }));
    expect(clean.status, clean.stdout).toBe(0);
  });

  it('fails an archive with no dSYM, and says an .app was not checked for symbols (F-1220 a)', () => {
    // why: F-1220 (a) an absent dSYM must not count as a clean one
    const r = check(plantArchive({ dwarf: null }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('has no dSYM');
    expect(check(plant()).stdout).toContain('NOT CHECKED: no dSYM');
  });

  it('fails a map folder that holds only a license, a font stack with no 0-255.pbf, and a sprite sheet with no png (F-1220 b)', () => {
    // why: F-1220 (b) a count of files passed fonts/ holding only OFL-1.1.txt, a map that draws no names
    const licenseOnly = plant({ fonts: false });
    writeFileSync(path.join(licenseOnly, 'map-assets', 'fonts', 'OFL-1.1.txt'), 'license');
    const r = check(licenseOnly);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Noto Sans Regular/0-255.pbf is missing');
    rmSync(path.join(licenseOnly, 'map-assets', 'fonts', 'Noto Sans Medium'), { recursive: true, force: true });
    const one = plant();
    rmSync(path.join(one, 'map-assets', 'fonts', 'Noto Sans Medium', '0-255.pbf'));
    expect(check(one).stdout).toContain('Noto Sans Medium/0-255.pbf is missing');
    rmSync(path.join(one, 'map-assets', 'sprites', 'light.png'));
    expect(check(one).stdout).toContain('sprites/light.png is missing');
  });

  it('names the font stacks the source glyph set holds (F-1220 b)', () => {
    // why: F-1220 (b) the script's list is pinned to apps/web/src/map/assets/fonts, which map-assets.test.ts pins to the stacks the style names
    const fonts = path.resolve(import.meta.dirname, '../../apps/web/src/map/assets/fonts');
    const held = readdirSync(fonts, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(listIn('FONT_STACKS')).toEqual(held);
    expect(listIn('SPRITE_FILES')).toEqual(['light.json', 'light.png']);
  });

  it('fails a binary that holds the look reader strings', () => {
    // why: F-988 the Swift reader compiled into a release build is a look reader in the shipped binary
    const r = check(plant({ bin: 'describe uiFamily postScript' }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("look reader string 'uiFamily'");
  });

  it.each([['fonts'], ['sprites']])('fails a build without the map %s (a map with no names, F-1073)', (which) => {
    // why: F-1073 a build without the glyph and sprite set draws a map with no street, place or water names, and nothing else says so
    const r = check(plant({ [which]: false }));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`map-assets/${which} is missing or empty`);
  });

  it('checks one JavaScript file with --bundle, and exits 2 for a path that is no app', () => {
    // why: F-988 the Metro half of the proof reads a bundle file on its own
    const f = path.join(dir, 'b.js');
    writeFileSync(f, 'x="bwLook"');
    expect(check('--bundle', f).status).toBe(1);
    writeFileSync(f, 'x=1');
    expect(check('--bundle', f).status).toBe(0);
    expect(check(path.join(dir, 'nothing.app')).status).toBe(2);
  });
});

describe('release/device-session.sh stop and mark (F-66)', () => {
  const session = path.resolve(import.meta.dirname, '../../apps/tech-native/release/device-session.sh');
  const run = (...args: string[]) => spawnSync('bash', [session, ...args], { encoding: 'utf8' });
  /** A finished capture: the pid file names no live process, so stop only checks the evidence. */
  const capture = (log: string, marks: string) => {
    writeFileSync(path.join(dir, 'capture.pid'), '999999\n');
    writeFileSync(path.join(dir, 'device.log'), log);
    writeFileSync(path.join(dir, 'marks.txt'), marks);
  };

  it('fails a session that has no capture, an empty log, no line of the app, or a declared required mark', () => {
    // why: F-66 an evidence-capture failure must fail the device session, not leave it green
    expect(run('stop', dir, 'backgrounded').status).toBe(1);
    capture('', '2026-11-09T00:00:00.000Z backgrounded\n');
    expect(run('stop', dir, 'backgrounded').stderr).toContain('device.log is empty');
    capture('nsurlsessiond: other app\n', '2026-11-09T00:00:00.000Z backgrounded\n');
    expect(run('stop', dir, 'backgrounded').stderr).toContain('holds no line of the app');
    capture('RightOnTime[12]: upload\n', '2026-11-09T00:00:00.000Z start\n');
    const r = run('stop', dir, 'backgrounded');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no 'backgrounded' mark");
  });

  it('passes a session with a log naming the app and a backgrounded mark, and mark appends a UTC line', () => {
    // why: F-66 the check must pass a complete capture, and the marks are what the log is read against
    capture('RightOnTime[12]: upload\n', '');
    expect(run('mark', 'backgrounded', dir).status).toBe(0);
    appendFileSync(path.join(dir, 'marks.txt'), '');
    expect(readFileSync(path.join(dir, 'marks.txt'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z backgrounded\n$/);
    expect(run('stop', dir, 'backgrounded').status).toBe(0);
  });

  it('checks the marks the session declares: build 4 step words pass or fail, a missing one fails by name, none declared is refused (F-1357)', () => {
    // why: F-1356 build 4 never backgrounds the app, so stop must not hard-code build 3's mark
    const t = '2026-11-10T00:00:00.000Z';
    const log = 'RightOnTime[12]: upload\n';
    const req = ['step 1 pass|step 1 fail', 'step 2 pass|step 2 fail', 'done'];
    capture(log, `${t} start\n${t} step 1 pass\n${t} step 2 fail\n${t} done\n`);
    expect(run('stop', dir, ...req).status).toBe(0);
    capture(log, `${t} start\n${t} step 1 pass\n${t} done\n`);
    const r = run('stop', dir, ...req);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no 'step 2 pass|step 2 fail' mark");
    capture(log, `${t} start\n${t} step 1 passed\n${t} step 2 fail\n${t} done\n`);
    expect(run('stop', dir, ...req).status).toBe(1);
    capture(log, `${t} start\n`);
    // why: F-1357 a session declares what it needs; stop with no list is refused at the call (exit 2), never passed
    const none = run('stop', dir);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('F-1357');
    capture('', `${t} done\n`);
    expect(run('stop', dir, 'done').stderr).toContain('device.log is empty');
  });

  it('stops a live capture process and still checks the marks', () => {
    // why: F-1356 stop kills the pid the capture wrote; a real child proves the kill and wait path
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    writeFileSync(path.join(dir, 'capture.pid'), `${child.pid}\n`);
    writeFileSync(path.join(dir, 'device.log'), 'RightOnTime[12]: upload\n');
    writeFileSync(path.join(dir, 'marks.txt'), '');
    const r = run('stop', dir, 'done');
    child.kill();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no 'done' mark");
  });
});

describe('the dSYM symbol list and the prebuild source check name what they guard (F-1411)', () => {
  it('lists only names the Swift look reader declares as static functions', () => {
    // why: F-1411 (a) the list was pinned to itself, so renaming the 2 functions blinded the dSYM arm with every test green
    const swift = readFileSync(path.resolve(import.meta.dirname, '../../apps/tech-native/modules/bw-look/ios/BwLookModule.swift'), 'utf8');
    for (const w of listIn('SYMBOLS')) expect(swift, w).toMatch(new RegExp(`static func ${w}\\(`));
  });

  const { checkSource } = createRequire(import.meta.url)('../../apps/tech-native/plugins/with-map-assets.js') as { checkSource: (s: string) => void };
  const source = (opts: { pbf?: boolean; sprites?: string[]; license?: boolean } = {}): string => {
    rmSync(path.join(dir, 'assets'), { recursive: true, force: true });
    const src = path.join(dir, 'assets');
    mkdirSync(path.join(src, 'sprites'), { recursive: true });
    mkdirSync(path.join(src, 'fonts', 'Noto Sans Regular'), { recursive: true });
    if (opts.license) writeFileSync(path.join(src, 'fonts', 'OFL-1.1.txt'), 'license');
    if (opts.pbf !== false) writeFileSync(path.join(src, 'fonts', 'Noto Sans Regular', '0-255.pbf'), 'g');
    for (const f of opts.sprites ?? ['light.json', 'light.png']) writeFileSync(path.join(src, 'sprites', f), 's');
    return src;
  };

  it('stops the prebuild on a fonts folder with no stack glyph range, and on a sprite sheet that is not whole', () => {
    // why: F-1411 (b) a fonts folder holding only OFL-1.1.txt passed the count-the-files check, so the rig build was not stopped
    expect(() => checkSource(source({ license: true }))).not.toThrow();
    expect(() => checkSource(source({ pbf: false, license: true }))).toThrow(/0-255\.pbf is missing/);
    expect(() => checkSource(source({ sprites: ['light.json'] }))).toThrow(/light\.png is missing/);
    rmSync(path.join(dir, 'assets'), { recursive: true, force: true });
    mkdirSync(path.join(dir, 'assets', 'fonts'), { recursive: true });
    writeFileSync(path.join(dir, 'assets', 'fonts', 'OFL-1.1.txt'), 'license');
    expect(() => checkSource(path.join(dir, 'assets'))).toThrow(/holds no font stack folder/);
  });

  it('accepts the committed asset folder', () => {
    // why: F-1411 (b) the stricter check must not stop the real set
    expect(() => checkSource(path.resolve(import.meta.dirname, '../../apps/web/src/map/assets'))).not.toThrow();
  });
});
