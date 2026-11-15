// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-MAP-3, FR-TECH-5 (P6-TESTFLIGHT-4: apps/tech-native/release/render-session.sh fills the owner's session page, the password among its values, from a mode 600 file, without printing it; offline, with a stub renderer and a dummy password)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'apps/tech-native/release/render-session.sh');
const SECRET = 'd'.repeat(18);
let tmp: string;
let state: string;
let tpl: string;
let pw: string;
let stub: string;

const run = (args: string[], dir = state) =>
  spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, BW_STAGING_DIR: dir, BW_MD2HTML: stub } });
const FULL = ['SERVER=https://203-0-113-9.sslip.io', 'BUILD=4', 'BOOKING_CUSTOMER=Nora Quillfeather', 'BOOKING_OPEN=the job before it'];

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'render-session-'));
  state = path.join(tmp, 'state');
  tpl = path.join(tmp, 'tpl.md');
  pw = path.join(tmp, 'pw.txt');
  stub = path.join(tmp, 'md2html-stub.py');
  writeFileSync(tpl, '# Page\n\nAddress {{SERVER}}, build {{BUILD}}.\n\nPassword {{PASSWORD}}.\n\nCustomer {{BOOKING_CUSTOMER}}: {{BOOKING_OPEN}}.\n');
  writeFileSync(pw, `${SECRET}\n`, { mode: 0o600 });
  // The stand-in for md2html.py: the same -o contract, a trivial page.
  writeFileSync(stub, 'import sys\nsrc = sys.argv[1]\nout = sys.argv[sys.argv.index("-o") + 1]\nopen(out, "w").write("<html>" + open(src).read() + "</html>")\n');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('render-session (P6-TESTFLIGHT-4)', () => {
  // why: FR-TECH-5 every token is filled, the page holds the password, both files are mode 600, and only the html path is printed
  it('fills every token, writes mode 600 files, prints only the html path and never the secret', () => {
    const r = run([tpl, 'session', '--password-file', pw, '--no-open', ...FULL]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(path.join(realpath(state), 'session.html'));
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).not.toContain(SECRET);
    const merged = readFileSync(path.join(state, 'session.md'), 'utf8');
    expect(merged).toContain(`Password ${SECRET}.`);
    expect(merged).toContain('Address https://203-0-113-9.sslip.io, build 4.');
    expect(merged).toContain('Customer Nora Quillfeather: the job before it.');
    expect(merged).not.toMatch(/\{\{/);
    expect(readFileSync(path.join(state, 'session.html'), 'utf8')).toContain(SECRET);
    for (const f of ['session.md', 'session.html']) expect(statSync(path.join(state, f)).mode & 0o777).toBe(0o600);
  });

  // why: FR-TECH-5 the default password file is the one staging.sh world writes into the state folder
  it('reads maria-password.txt from the state folder when no file is named', () => {
    writeFileSync(path.join(state, 'maria-password.txt'), `${SECRET}\n`, { mode: 0o600 });
    const r = run([tpl, 'default', '--no-open', ...FULL]);
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(state, 'default.md'), 'utf8')).toContain(`Password ${SECRET}.`);
  });

  // why: FR-TECH-5 a token left unfilled stops the render: no page is left, and the message names the token but not the secret
  it('refuses a leftover token and leaves no page', () => {
    const r = run([tpl, 'left', '--password-file', pw, '--no-open', ...FULL.filter((a) => !a.startsWith('BUILD='))]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BUILD');
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(existsSync(path.join(state, 'left.md'))).toBe(false);
    expect(existsSync(path.join(state, 'left.html'))).toBe(false);
  });

  // why: FR-TECH-5 a KEY the template has no token for is a typo; it is refused rather than dropped
  it('refuses a KEY the template does not hold', () => {
    const r = run([tpl, 'typo', '--password-file', pw, '--no-open', ...FULL, 'BUILDD=4']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BUILDD');
  });

  // why: FR-TECH-5 the secret must never land in the repo: a state folder inside it is refused before anything is written
  it('refuses a state folder inside the repo and writes nothing there', () => {
    const inRepo = mkdtempSync(path.join(root, 'infra', 'tests', '.render-session-'));
    try {
      const r = run([tpl, 'inrepo', '--password-file', pw, '--no-open', ...FULL], inRepo);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('inside the repo');
      expect(r.stdout + r.stderr).not.toContain(SECRET);
      expect(existsSync(path.join(inRepo, 'inrepo.md'))).toBe(false);
      expect(existsSync(path.join(inRepo, 'inrepo.html'))).toBe(false);
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  // why: F-1352 the guard judges file identity: a folder inside another checkout of the repo (a git work tree) is refused by both scripts
  it('refuses a state folder inside another git work tree, in render-session.sh and staging.sh', () => {
    const other = path.join(tmp, 'other-checkout');
    mkdirSync(other);
    expect(spawnSync('git', ['init', '-q', other]).status).toBe(0);
    const inOther = path.join(other, 'state');
    const r = run([tpl, 'other', '--password-file', pw, '--no-open', ...FULL], inOther);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('inside the repo');
    expect(existsSync(path.join(inOther, 'other.md'))).toBe(false);
    const s = spawnSync('bash', [path.join(root, 'infra/deploy/staging.sh'), 'status'], { encoding: 'utf8', env: { ...process.env, BW_STAGING_DIR: path.join(other, 'state2') } });
    expect(s.status).toBe(2);
    expect(s.stderr).toContain('inside the repo');
  });

  // why: F-1352 on a case-insensitive disk a mis-cased path to the repo is the same folder: pwd -P keeps the typed case, so only file identity catches it
  it('refuses a mis-cased path into the repo (case-insensitive disks only)', (ctx) => {
    const inRepo = mkdtempSync(path.join(root, 'infra', 'tests', '.render-session-'));
    try {
      const shouted = inRepo.toUpperCase();
      if (!existsSync(shouted)) return ctx.skip(); // a case-sensitive disk has no mis-cased path
      const r = run([tpl, 'cased', '--password-file', pw, '--no-open', ...FULL], shouted);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('inside the repo');
      expect(existsSync(path.join(inRepo, 'cased.md'))).toBe(false);
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  // why: FR-TECH-5 a value that holds a token cannot add one: the single pass leaves its text as typed
  it('does not search a value for tokens', () => {
    mkdirSync(path.join(tmp, 'state2'), { recursive: true });
    const r = run([tpl, 'inject', '--password-file', pw, '--no-open', ...FULL.map((a) => (a.startsWith('BUILD=') ? 'BUILD={{PASSWORD}}' : a))], path.join(tmp, 'state2'));
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(tmp, 'state2', 'inject.md'), 'utf8')).toContain('build {{PASSWORD}}.');
  });
});

function realpath(p: string): string {
  return spawnSync('bash', ['-c', 'cd "$1" && pwd -P', '_', p], { encoding: 'utf8' }).stdout.trim();
}
