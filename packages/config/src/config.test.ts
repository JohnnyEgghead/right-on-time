// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/config: the settings of SPECIFICATIONS section 11.1, read once and validated by 1 Zod schema; an invalid value
// stops the process with a named error that never prints the value.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, databasePassword, loadConfig, settingsSchema } from './index.ts';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const spec = readFileSync(path.join(repo, 'docs', 'SPECIFICATIONS.md'), 'utf8');

const composeText = readFileSync(path.join(repo, 'infra', 'compose.yaml'), 'utf8');

/**
 * Whether a process named in a "Read by" cell loads @bw/config: a Compose service whose entry point (its `command`) does
 * not mention @bw/config does not (migrate, setup); anything else (web, worker, pbs, "every process", a kernel part) does.
 */
function loadsConfig(reader: string): boolean {
  const block = new RegExp(`^  ${reader}:\\n((?:    .*\\n|\\n)*)`, 'm').exec(composeText)?.[1];
  const entry = block && /command: \["node", "([^"]+)"\]/.exec(block)?.[1];
  return !entry || readFileSync(path.join(repo, entry), 'utf8').includes('@bw/config');
}

/**
 * The setting names of the 11.1 table (first cell, every backticked name) that @bw/config is to know: the section's rule
 * is "read once at start-up by @bw/config", so a row whose "Read by" cell names only processes that never load it is not one.
 */
function specSettingNames(): string[] {
  const start = spec.indexOf('### 11.1 Settings');
  const end = spec.indexOf('### 11.2', start);
  const names = new Set<string>();
  for (const line of spec.slice(start, end).split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|');
    const readers = (cells[4] ?? '').replace(/\([^)]*\)/g, '').split(',').map((r) => r.trim()).filter(Boolean);
    if (!readers.some(loadsConfig)) continue;
    for (const m of (cells[1] ?? '').matchAll(/`([A-Z_]+)`/g)) names.add(m[1]!);
  }
  return [...names].sort();
}

const fails = (env: Record<string, string>): ConfigError => {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error(`no ConfigError for ${JSON.stringify(Object.keys(env))}`);
};

describe('@bw/config', () => {
  // why: NFR-14, SD-3
  it('knows every setting of the 11.1 table that a process loading it reads, and only those', () => {
    const known = Object.keys(settingsSchema.shape).sort();
    expect(specSettingNames().length).toBeGreaterThan(25);
    expect(known).toEqual(specSettingNames());
  });

  // why: SD-3, FR-AUTH-5, FR-AUTH-6
  it('defaults every setting to its own-copy value, with an empty value counting as unset', () => {
    const c = loadConfig({});
    expect(c.APP_ORIGIN).toBe('http://localhost:8080');
    expect(c.DEMO_MODE).toBe(false);
    expect(c.ACCESS_CODE_ON).toBe(false);
    expect(c.IDLE_RESET_MINUTES).toBe(120);
    expect(c.RESET_COOLDOWN_SECONDS).toBe(300);
    expect(c.IOS_INSTALL_KIND).toBe('none');
    expect(c.LOG_LEVEL).toBe('info');
    expect(c.PHOTOS_DIR).toBe('/data/photos');
    expect(loadConfig({ DEMO_MODE: '', APP_ORIGIN: '' }).APP_ORIGIN).toBe('http://localhost:8080');
    expect(Object.isFrozen(c)).toBe(true);
  });

  // why: SD-3, FR-AUTH-6
  it('accepts the hosted demo profile', () => {
    const demo: Record<string, string> = {};
    for (const line of readFileSync(path.join(repo, 'infra', 'profiles', 'demo.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) demo[m[1]!] = m[2]!;
    }
    const c = loadConfig(demo);
    expect(c.APP_ORIGIN).toBe('https://bw.j7l.io');
    expect(c.DEMO_MODE && c.ACCESS_CODE_ON && c.RESET_PROTECTION && c.NIGHTLY_RESET).toBe(true);
  });

  // why: NFR-14, FR-IOS-2
  it('names the invalid setting and never prints its value', () => {
    const cases: [Record<string, string>, string][] = [
      [{ APP_ORIGIN: 'bw.j7l.io' }, 'APP_ORIGIN'],
      [{ APP_ORIGIN: 'https://bw.j7l.io/app' }, 'APP_ORIGIN'],
      [{ DEMO_MODE: 'yes' }, 'DEMO_MODE'],
      [{ IDLE_RESET_MINUTES: '0' }, 'IDLE_RESET_MINUTES'],
      [{ RESET_COOLDOWN_SECONDS: '5 min' }, 'RESET_COOLDOWN_SECONDS'],
      [{ ACCESS_COOKIE_KEY: 'short-secret-value' }, 'ACCESS_COOKIE_KEY'],
      [{ IOS_INSTALL_KIND: 'unlisted' }, 'IOS_INSTALL_LINK'],
      [{ IOS_INSTALL_KIND: 'none', IOS_INSTALL_LINK: 'https://apps.apple.com/app/x' }, 'IOS_INSTALL_LINK'],
      [{ IOS_INSTALL_KIND: 'adhoc', IOS_INSTALL_LINK: 'itms-services://?action=download-manifest&url=https://evil.example/ios/manifest.plist' }, 'IOS_INSTALL_LINK'],
      [{ IOS_INSTALL_KIND: 'testflight' }, 'IOS_INSTALL_KIND'],
      [{ LOG_LEVEL: 'trace' }, 'LOG_LEVEL'],
      [{ DATABASE_URL: 'mysql://db/x' }, 'DATABASE_URL'],
      [{ PHOTOS_DIR: 'data/photos' }, 'PHOTOS_DIR'],
    ];
    for (const [env, setting] of cases) {
      const e = fails(env);
      expect(e.setting, JSON.stringify(env)).toBe(setting);
      expect(e.message).toMatch(new RegExp(`^invalid setting ${setting}: `));
      expect(e.message).not.toContain('short-secret-value');
    }
  });

  // why: SD-3, FR-IOS-2
  it('accepts the 2 install kinds with their links', () => {
    expect(loadConfig({ IOS_INSTALL_KIND: 'unlisted', IOS_INSTALL_LINK: 'https://apps.apple.com/us/app/id1' }).IOS_INSTALL_KIND).toBe('unlisted');
    const adhoc = { APP_ORIGIN: 'https://bw.j7l.io', IOS_INSTALL_KIND: 'adhoc', IOS_INSTALL_LINK: 'itms-services://?action=download-manifest&url=https://bw.j7l.io/ios/manifest.plist' };
    expect(loadConfig(adhoc).IOS_INSTALL_KIND).toBe('adhoc');
  });

  // why: NFR-14, F-150
  it('reads the database password from its file, and names the file setting when it is missing or empty', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-config-'));
    try {
      const f = path.join(dir, 'password');
      writeFileSync(f, 'a'.repeat(40) + '\n');
      expect(databasePassword({ DATABASE_PASSWORD_FILE: f })).toBe('a'.repeat(40));
      expect(databasePassword({ DATABASE_PASSWORD_FILE: undefined })).toBeUndefined();
      writeFileSync(f, '\n');
      expect(() => databasePassword({ DATABASE_PASSWORD_FILE: f })).toThrow(/invalid setting DATABASE_PASSWORD_FILE/);
      expect(() => databasePassword({ DATABASE_PASSWORD_FILE: path.join(dir, 'none') })).toThrow(/invalid setting DATABASE_PASSWORD_FILE: cannot be read \(ENOENT\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // why: NFR-14, SD-3
  it('stops a process at start with the named error and status 78, before it does anything else', () => {
    const entry = path.join(import.meta.dirname, 'index.ts');
    const script = `import { configOrExit } from ${JSON.stringify(entry)}; configOrExit(); process.stdout.write('started');`;
    const bad = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH ?? '', DEMO_MODE: 'maybe' }, encoding: 'utf8' });
    expect(bad.status).toBe(78);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/^ConfigError: invalid setting DEMO_MODE: /m);
    const good = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(good.stdout).toBe('started');
  });
});
