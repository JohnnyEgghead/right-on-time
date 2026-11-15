// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs real `git merge` in a temporary repo under the OS temp dir, never in this checkout.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCatalog, serializeCatalog } from './catalog-format.ts';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const FILE = 'packages/i18n/catalog/en.json';

let repo = '';
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (cat: Record<string, string>) => writeFileSync(join(repo, FILE), serializeCatalog(cat));
const commitOn = (branch: string, cat: Record<string, string>) => {
  git('checkout', '-q', branch);
  write(cat);
  git('commit', '-q', '-am', `set ${branch}`);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'bw-merge-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'merge.bw-catalog.driver', `node ${join(scripts, 'merge-catalog.ts')} %O %A %B %P`);
  execFileSync('mkdir', ['-p', join(repo, 'packages/i18n/catalog')]);
  writeFileSync(join(repo, '.gitattributes'), readFileSync(join(repoRoot, '.gitattributes')));
  write({ 'a.keep': 'Keep', 'm.mid': 'Mid' });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('branch', 'one');
  git('branch', 'two');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('catalog merge driver', () => {
  // why: FR-LANG-2
  it('merges 2 branches that add different keys, with no conflict and key-sorted output', () => {
    commitOn('one', { 'a.keep': 'Keep', 'm.mid': 'Mid', 'z.last': 'Last' });
    commitOn('two', { 'a.keep': 'Keep', 'b.early': 'Early', 'm.mid': 'Mid' });
    git('merge', '-q', '--no-edit', 'one');
    expect(readFileSync(join(repo, FILE), 'utf8')).toBe(
      serializeCatalog({ 'a.keep': 'Keep', 'b.early': 'Early', 'm.mid': 'Mid', 'z.last': 'Last' }),
    );
  });

  // why: FR-LANG-2
  it('stops with "catalog key collision" when 2 branches set 1 key to different values', () => {
    commitOn('one', { 'a.keep': 'Keep', 'm.mid': 'Mid ONE' });
    commitOn('two', { 'a.keep': 'Keep', 'm.mid': 'Mid TWO' });
    let output = '';
    try {
      git('merge', '--no-edit', 'one');
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(output).toContain('catalog key collision');
    expect(output).toContain('m.mid');
    // The driver never picked a value: git reports the file unmerged.
    expect(git('status', '--porcelain')).toMatch(/^(UU|AA) /m);
  });

  // why: F-137
  it('leaves git-style conflict markers on a collision, so the file does not parse and an add cannot silently keep ours', () => {
    commitOn('one', { 'a.keep': 'Keep', 'm.mid': 'Mid ONE', 'z.new': 'Z' });
    commitOn('two', { 'a.keep': 'Keep', 'm.mid': 'Mid TWO' });
    expect(() => git('merge', '--no-edit', 'one')).toThrow();
    const text = readFileSync(join(repo, FILE), 'utf8');
    expect(text).toContain('<<<<<<< ours');
    expect(text).toContain('>>>>>>> theirs');
    expect(text).toMatch(/<<<<<<< ours\n\s+"m\.mid": "Mid TWO",\n=======\n\s+"m\.mid": "Mid ONE",\n>>>>>>> theirs/);
    expect(text).toContain('"z.new": "Z"'); // keys that merged cleanly stay in the file
    expect(() => parseCatalog(text)).toThrow(); // so parity/typecheck go red if it is committed
  });

  // why: F-137
  it('control: a clean merge writes no conflict markers and parses', () => {
    commitOn('one', { 'a.keep': 'Keep', 'm.mid': 'Mid', 'z.last': 'Last' });
    commitOn('two', { 'a.keep': 'Keep', 'b.early': 'Early', 'm.mid': 'Mid' });
    git('merge', '-q', '--no-edit', 'one');
    const text = readFileSync(join(repo, FILE), 'utf8');
    expect(text).not.toContain('<<<<<<<');
    expect(() => parseCatalog(text)).not.toThrow();
  });

  // why: FR-LANG-2
  it('takes a change made on one side only, and keeps a deliberate removal', () => {
    commitOn('one', { 'a.keep': 'Keep CHANGED', 'm.mid': 'Mid' });
    commitOn('two', { 'a.keep': 'Keep' }); // removed m.mid
    git('merge', '-q', '--no-edit', 'one');
    expect(readFileSync(join(repo, FILE), 'utf8')).toBe(serializeCatalog({ 'a.keep': 'Keep CHANGED' }));
  });

  // why: FR-LANG-2
  it('treats a key removed on one side and changed on the other as a collision', () => {
    commitOn('one', { 'a.keep': 'Keep', 'm.mid': 'Mid CHANGED' });
    commitOn('two', { 'a.keep': 'Keep' });
    expect(() => git('merge', '--no-edit', 'one')).toThrow(/catalog key collision/);
  });
});

describe('merge driver registration', () => {
  // why: setup
  it('.gitattributes routes both catalog files to the driver', () => {
    const attrs = readFileSync(join(repoRoot, '.gitattributes'), 'utf8');
    expect(attrs).toContain('packages/i18n/catalog/en.json merge=bw-catalog');
    expect(attrs).toContain('packages/i18n/catalog/es.json merge=bw-catalog');
  });

  // why: setup
  it('the prepare script sets the driver in git config and is idempotent', () => {
    const script = join(scripts, 'register-merge-driver.ts');
    const run = () => execFileSync('node', [script], { cwd: repo, env, stdio: 'pipe' });
    const read = () => git('config', '--local', '--get-all', 'merge.bw-catalog.driver');
    git('config', '--local', '--unset', 'merge.bw-catalog.driver');
    run();
    const first = read();
    run();
    expect(read()).toBe(first);
    expect(first.trim()).toBe('node packages/i18n/scripts/merge-catalog.ts %O %A %B %P');
  });

  // The shipped registration, as the repo runs it: the repo's own relative command, run by git from the work tree top.
  const registerShipped = () => {
    git('config', '--local', '--unset-all', 'merge.bw-catalog.driver');
    execFileSync('mkdir', ['-p', join(repo, 'packages/i18n')]);
    symlinkSync(scripts, join(repo, 'packages/i18n/scripts'));
    symlinkSync(join(scripts, '../src'), join(repo, 'packages/i18n/src'));
    execFileSync('node', ['packages/i18n/scripts/register-merge-driver.ts'], { cwd: repo, env, stdio: 'pipe' });
  };

  // why: F-138
  it('a merge run with the registered (shipped, relative) driver command merges and stops on a collision', () => {
    registerShipped();
    git('add', '-A');
    git('commit', '-q', '-m', 'link');
    git('branch', '-f', 'one', 'main');
    git('branch', '-f', 'two', 'main');
    commitOn('one', { 'a.keep': 'Keep', 'm.mid': 'Mid', 'z.last': 'Last' });
    commitOn('two', { 'a.keep': 'Keep', 'b.early': 'Early', 'm.mid': 'Mid' });
    git('merge', '-q', '--no-edit', 'one');
    expect(readFileSync(join(repo, FILE), 'utf8')).toBe(
      serializeCatalog({ 'a.keep': 'Keep', 'b.early': 'Early', 'm.mid': 'Mid', 'z.last': 'Last' }),
    ); // control: the driver ran (a text merge would also be clean here, so the collision below is the proof)
    git('reset', '-q', '--hard', 'two');
    commitOn('one', { 'a.keep': 'Keep', 'b.early': 'Early', 'm.mid': 'Mid ONE', 'z.last': 'Last' });
    commitOn('two', { 'a.keep': 'Keep', 'b.early': 'Early', 'm.mid': 'Mid TWO', 'z.last': 'Last' });
    expect(() => git('merge', '--no-edit', 'one')).toThrow(/catalog key collision/);
  });

  // why: F-155
  it('4 registrations at the same moment all exit 0 and leave both config values set', async () => {
    git('config', '--local', '--unset-all', 'merge.bw-catalog.driver');
    const script = join(scripts, 'register-merge-driver.ts');
    for (let round = 0; round < 3; round++) {
      const codes = await Promise.all(
        [1, 2, 3, 4].map(
          () =>
            new Promise<number | null>((resolve) => {
              const p = spawn('node', [script], { cwd: repo, env, stdio: 'ignore' });
              p.on('close', resolve);
            }),
        ),
      );
      expect(codes).toEqual([0, 0, 0, 0]);
      expect(git('config', '--local', '--get', 'merge.bw-catalog.name').trim()).not.toBe('');
      expect(git('config', '--local', '--get', 'merge.bw-catalog.driver').trim()).toBe(
        'node packages/i18n/scripts/merge-catalog.ts %O %A %B %P',
      );
      git('config', '--local', '--unset-all', 'merge.bw-catalog.driver');
      git('config', '--local', '--unset-all', 'merge.bw-catalog.name');
    }
  }, 60_000);

  // why: F-139
  it('best effort: the prepare command is a no-op without the script, and a write git refuses warns with git output and exits 0', () => {
    const prepare = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: { prepare: string } }).scripts
      .prepare;
    const empty = mkdtempSync(join(tmpdir(), 'bw-prep-'));
    try {
      // must-pass: no script file in the tree (a manifests-only Docker layer).
      expect(() => execFileSync('sh', ['-c', prepare], { cwd: empty, env, stdio: 'pipe' })).not.toThrow();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // must-fail-then-warn: a stale .git/config.lock, so git cannot take the config lock. A read-only .git
    // (chmod 555) does not work here: root ignores the mode and git writes anyway (F-159, CI runs as root).
    git('config', '--local', '--unset-all', 'merge.bw-catalog.driver');
    const lock = join(repo, '.git', 'config.lock');
    writeFileSync(lock, '');
    try {
      const r = spawnSync('node', [join(scripts, 'register-merge-driver.ts')], { cwd: repo, env, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('warning: could not set git config merge.bw-catalog');
      expect(r.stderr).toMatch(/lock|permission|denied/i); // git's own message is kept
    } finally {
      rmSync(lock, { force: true });
    }
  }, 60_000);

  // why: F-139
  it('control: writing a value that is already set takes no lock (works with config.lock held)', () => {
    const script = join(scripts, 'register-merge-driver.ts');
    execFileSync('node', [script], { cwd: repo, env, stdio: 'pipe' }); // sets both values
    // A held config.lock stops any git config write, root included (a chmod 555 does not, F-160): a clean exit with empty
    // stderr proves the script attempted no write. The paired case above proves the same lock does make a write warn.
    const lock = join(repo, '.git', 'config.lock');
    writeFileSync(lock, '');
    try {
      const r = spawnSync('node', [script], { cwd: repo, env, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    } finally {
      rmSync(lock, { force: true });
    }
  });
});
