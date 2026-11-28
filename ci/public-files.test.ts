// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DIST-2, FR-DIST-4, FR-DIST-5, FR-DIST-7, FR-DIST-1 (checks ci/public-files.ts: spdx-header-check, readme-items, copying-ios-present and the public license files, each against planted known-bads and the real tree)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultOwnerFiles } from './public-files.ts';

const repo = path.resolve(import.meta.dirname, '..');
const cli = path.join(repo, 'ci', 'public-files.ts');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
/** The small test trees hold 3 source files, so they run with floor 1; the real tree and the floor test pass their own (F-1576). */
const run = (root: string, which: string, floor: string[] = ['--floor', '1']) => spawnSync('node', [cli, which, '--root', root, ...floor], { encoding: 'utf8', env: GIT_ENV });
/**
 * F-1604: the real tree runs with the caller's own git config, as the gate (ci/gates/public-files-check.sh) and pnpm run ci
 * run the check. GIT_ENV drops that config, and the push job needs it: its workspace folder belongs to the runner's uid, not
 * the job's root, so git refuses the tree (dubious ownership) without the job's safe.directory lines (ci.yml, Trust the workspace for git).
 */
const runReal = (which: string) => spawnSync('node', [cli, which, '--root', repo], { encoding: 'utf8' });

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'public-files-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const COPIED = ['LICENSE', 'LICENSE-DATA.md', 'THIRD-PARTY-NOTICES.md', 'ci/license/policy.json', 'COPYING.iOS', 'README.md', '.env.example', 'REUSE.toml', '.node-version', 'package.json', 'scripts/private-paths.txt'];

/** A small git tree with the real public files, the real private paths list and 3 source files; `edit` changes it before the check runs. */
function tree(name: string, edit: (dir: string) => void = () => {}): string {
  const dir = path.join(tmp, name);
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  mkdirSync(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  for (const f of COPIED) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(path.join(repo, f), path.join(dir, f));
  }
  put('apps/web/src/a.ts', '// SPDX-License-Identifier: AGPL-3.0-or-later\nexport const a = 1;\n');
  put('ci/tool.sh', '#!/usr/bin/env bash\n# SPDX-License-Identifier: AGPL-3.0-or-later\necho ok\n');
  put('packages/db/migrations/0001_x.sql', 'select 1;\n');
  // private paths hold no header and must not be asked for one
  put('docs/build/notes.ts', 'export {};\n');
  put('scripts/launch-x.sh', '#!/usr/bin/env bash\necho private\n');
  put('jl-plan', '#!/usr/bin/env bash\necho private\n');
  edit(dir);
  return dir;
}
const text = (dir: string, rel: string) => readFileSync(path.join(dir, rel), 'utf8');
const change = (dir: string, rel: string, from: string | RegExp, to: string) => {
  const before = text(dir, rel);
  const after = before.replace(from, to);
  if (after === before) throw new Error(`plant did not change ${rel}`);
  writeFileSync(path.join(dir, rel), after);
};

describe('the real tree', () => {
  // why: FR-DIST-2, FR-DIST-4, FR-DIST-5, FR-DIST-7 all 3 checks and the public license files pass the committed tree
  it('passes spdx-header-check, readme-items, copying-ios-present and the license files', () => {
    for (const which of ['spdx', 'readme', 'copying', 'files', 'private-refs', 'ipv4', 'owner-ids']) {
      const r = runReal(which);
      expect(r.status, `${which}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('public-files-check: PASS');
    }
  });

  // why: FR-DIST-2 LICENSE is the AGPL-3.0 text, and the migration files that cannot carry a header are covered by REUSE.toml
  it('holds the AGPL-3.0 text and covers the checksum-pinned migrations in REUSE.toml', () => {
    expect(readFileSync(path.join(repo, 'LICENSE'), 'utf8')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007');
    const reuse = readFileSync(path.join(repo, 'REUSE.toml'), 'utf8');
    expect(reuse).toContain('packages/db/migrations/**');
    expect(reuse).toContain('AGPL-3.0-or-later');
  });

  // why: F-321 .env.example carries a SAMPLE_PASSWORD_SEED of 16 or more characters, a published value
  it('holds a SAMPLE_PASSWORD_SEED of 16 or more characters in .env.example, and no other setting', () => {
    const lines = readFileSync(path.join(repo, '.env.example'), 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^SAMPLE_PASSWORD_SEED=.{16,}$/);
  });
});

describe('spdx-header-check', () => {
  // why: FR-DIST-2 a clean tree passes, and private paths and the exempt migrations are not asked for a header
  it('passes a tree whose public source files all carry the header', () => {
    const r = run(tree('spdx-ok'), 'spdx');
    expect(r.status, r.stderr).toBe(0);
  });

  // why: FR-DIST-2 a planted source file with no header fails, and the file is named
  it('fails a planted source file with no header', () => {
    const dir = tree('spdx-none', (d) => writeFileSync(path.join(d, 'apps/web/src/b.tsx'), 'export const b = 2;\n'));
    const r = run(dir, 'spdx');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/web/src/b.tsx: no SPDX-License-Identifier');
  });

  // why: FR-DIST-2 the header removed from a file that had it fails
  it('fails when the header is removed from a source file', () => {
    const dir = tree('spdx-removed', (d) => change(d, 'apps/web/src/a.ts', /^\/\/ SPDX[^\n]*\n/, ''));
    const r = run(dir, 'spdx');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/web/src/a.ts');
  });

  // why: FR-DIST-2 every source file's notice says "or later": AGPL-3.0-only and a bare AGPL-3.0 fail
  it('fails a header that says only, or leaves out the or later', () => {
    for (const [name, id] of [['spdx-only', 'AGPL-3.0-only'], ['spdx-bare', 'AGPL-3.0']] as const) {
      const dir = tree(name, (d) => change(d, 'apps/web/src/a.ts', 'AGPL-3.0-or-later', id));
      const r = run(dir, 'spdx');
      expect(r.status, name).toBe(1);
      expect(r.stderr).toContain('is not exactly AGPL-3.0-or-later');
    }
  });

  // why: FR-DIST-2 a shell file needs the header too, on the line after its shebang, and an extensionless script is found by its shebang
  it('checks shell files and extensionless scripts', () => {
    const dir = tree('spdx-sh', (d) => {
      writeFileSync(path.join(d, 'ci/other.sh'), '#!/usr/bin/env bash\necho no header\n');
      writeFileSync(path.join(d, '.hook'), '');
      mkdirSync(path.join(d, 'hooks'));
      writeFileSync(path.join(d, 'hooks/pre-push'), '#!/bin/sh\nexit 0\n');
    });
    const r = run(dir, 'spdx');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ci/other.sh');
    expect(r.stderr).toContain('hooks/pre-push');
  });

  // why: F-1574 an SPDX line above the shebang leaves a script that no longer runs, so the shebang must stay on line 1
  it('fails a script whose SPDX line sits above its shebang', () => {
    const dir = tree('spdx-above-shebang', (d) => {
      writeFileSync(path.join(d, 'ci/bad.sh'), '# SPDX-License-Identifier: AGPL-3.0-or-later\n#!/usr/bin/env bash\necho x\n');
    });
    const r = run(dir, 'spdx');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ci/bad.sh: the shebang is not on line 1');
  });

  // why: F-1576 the header population has a pinned floor, and .cjs and .cts are source suffixes
  it('fails when fewer source files than the floor are found, and counts .cjs and .cts', () => {
    const dir = tree('spdx-floor', (d) => {
      writeFileSync(path.join(d, 'ci/x.cjs'), 'module.exports = 1;\n');
      writeFileSync(path.join(d, 'ci/x.cts'), 'export {};\n');
    });
    const low = run(dir, 'spdx', ['--floor', '9']);
    expect(low.status).toBe(1);
    expect(low.stderr).toContain('fewer than the pinned floor of 9');
    const r = run(dir, 'spdx');
    expect(r.stderr).toContain('ci/x.cjs');
    expect(r.stderr).toContain('ci/x.cts');
    const real = runReal('spdx');
    expect(real.status, real.stderr).toBe(0);
  });

  // why: FR-DIST-2 a missing LICENSE, or one that is not the AGPL-3.0 text, fails
  it('fails when LICENSE is missing or is not the AGPL-3.0 text', () => {
    const missing = tree('spdx-nolicense', (d) => rmSync(path.join(d, 'LICENSE')));
    expect(run(missing, 'spdx').status).toBe(1);
    const wrong = tree('spdx-wronglicense', (d) => writeFileSync(path.join(d, 'LICENSE'), 'MIT License\n'));
    expect(run(wrong, 'spdx').stderr).toContain('LICENSE is not the GNU AGPL version 3 text');
  });

  // why: FR-DIST-2 the exempt migrations are covered by REUSE.toml: without it naming them, the check fails
  it('fails when REUSE.toml no longer covers the migrations', () => {
    const dir = tree('spdx-noreuse', (d) => rmSync(path.join(d, 'REUSE.toml')));
    const r = run(dir, 'spdx');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REUSE.toml does not name packages/db/migrations/');
  });
});

describe('readme-items', () => {
  // why: FR-DIST-7 the copied real README passes in the planted tree
  it('passes the README of the tree', () => {
    const r = run(tree('readme-ok'), 'readme');
    expect(r.status, r.stderr).toBe(0);
  });

  // why: FR-DIST-7, OI-29 a README with its demo-mode item removed fails, and so does one that lost the reset protection setting
  it('fails a README with the demo mode item removed, and one with the reset protection item removed', () => {
    const noDemo = tree('readme-nodemo', (d) => writeFileSync(path.join(d, 'README.md'), text(d, 'README.md').split('\n').filter((l) => !l.includes('DEMO_MODE')).join('\n')));
    const a = run(noDemo, 'readme');
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('OI-29: the demo mode setting (DEMO_MODE) is not in the README');
    const noReset = tree('readme-noreset', (d) => writeFileSync(path.join(d, 'README.md'), text(d, 'README.md').split('\n').filter((l) => !l.includes('RESET_PROTECTION')).join('\n')));
    const b = run(noReset, 'readme');
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('OI-29: the reset protection setting (RESET_PROTECTION) is not in the README');
  });

  // why: OI-29 the reset protection setting must sit beside demo mode: moved away from it, the check fails
  it('fails when the reset protection setting is not beside demo mode', () => {
    const dir = tree('readme-far', (d) => {
      const lines = text(d, 'README.md').split('\n');
      const row = lines.findIndex((l) => l.startsWith('| `RESET_PROTECTION`'));
      const [moved] = lines.splice(row, 1);
      writeFileSync(path.join(d, 'README.md'), [...lines, '', 'x', 'x', 'x', 'x', 'x', moved].join('\n'));
    });
    const r = run(dir, 'readme');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not beside DEMO_MODE');
  });

  // why: F-1575 the RESET_PROTECTION row must carry both values as table cells; off and off (or on and on) fails
  it('fails a RESET_PROTECTION row that does not hold both off and on', () => {
    for (const [name, to] of [['off-off', '| `RESET_PROTECTION` | `off` | `off` |'], ['on-on', '| `RESET_PROTECTION` | `on` | `on` |']] as const) {
      const dir = tree(`readme-value-${name}`, (d) => change(d, 'README.md', /^\| `RESET_PROTECTION` \| `off` \| `on` \|/m, to));
      const r = run(dir, 'readme');
      expect(r.status, name).toBe(1);
      expect(r.stderr).toContain('own-copy default (off) and the hosted value (on)');
    }
  });

  // why: FR-DIST-7 each of the 5 items fails the check when it is removed from the README
  it('fails each of the 5 FR-DIST-7 items when it is removed', () => {
    const cases: [string, RegExp, string][] = [
      ['compose', /infra\/compose\.yaml/g, 'infra/file'],
      ['desktop', /Docker Desktop/g, 'Docker D'],
      ['colima', /Colima/g, 'Other'],
      ['developer', /PostgreSQL 18/g, 'PostgreSQL'],
      ['addresses', /fictional/gi, 'made up'],
      ['phones', /repeat/g, 'vary'],
    ];
    for (const [name, from, to] of cases) {
      const dir = tree(`readme-item-${name}`, (d) => change(d, 'README.md', from, to));
      const r = run(dir, 'readme');
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toContain('public-files-check: FAIL readme-items: item ');
    }
  });

  // why: FR-DIST-7 the developer path names the Node and pnpm versions of the tree, so a version change without a README change fails
  it('fails when the README names another Node version than .node-version', () => {
    const dir = tree('readme-node', (d) => writeFileSync(path.join(d, '.node-version'), '99.0.0\n'));
    const r = run(dir, 'readme');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('item 3');
  });
});

describe('copying-ios-present', () => {
  // why: FR-DIST-4 the permission file is present and names the AGPL section 7 permission for the App Store
  it('passes the tree with COPYING.iOS', () => {
    expect(run(tree('copying-ok'), 'copying').status).toBe(0);
  });

  // why: FR-DIST-4 a tree without COPYING.iOS fails
  it('fails a tree without COPYING.iOS', () => {
    const dir = tree('copying-absent', (d) => rmSync(path.join(d, 'COPYING.iOS')));
    expect(existsSync(path.join(dir, 'COPYING.iOS'))).toBe(false);
    const r = run(dir, 'copying');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('COPYING.iOS is missing');
  });

  // why: FR-DIST-4 an empty COPYING.iOS, or one that no longer names section 7 and the App Store, fails
  it('fails a COPYING.iOS without the permission', () => {
    const dir = tree('copying-empty', (d) => writeFileSync(path.join(d, 'COPYING.iOS'), 'placeholder\n'));
    expect(run(dir, 'copying').status).toBe(1);
  });
});

describe('the data license and the sample seed', () => {
  // why: FR-DIST-5 LICENSE-DATA.md must name the ODbL and the OpenStreetMap credit
  it('fails a data license without the ODbL, the credit, or the file', () => {
    const noOdbl = tree('data-noodbl', (d) => writeFileSync(path.join(d, 'LICENSE-DATA.md'), '© OpenStreetMap contributors\n'));
    expect(run(noOdbl, 'files').stderr).toContain('does not name the ODbL');
    const noCredit = tree('data-nocredit', (d) => writeFileSync(path.join(d, 'LICENSE-DATA.md'), 'ODbL, the Open Database License\n'));
    expect(run(noCredit, 'files').stderr).toContain('OpenStreetMap credit');
    const absent = tree('data-absent', (d) => rmSync(path.join(d, 'LICENSE-DATA.md')));
    expect(run(absent, 'files').status).toBe(1);
  });

  // why: F-321 a .env.example with a seed under 16 characters, no seed line, or no file fails
  it('fails an .env.example with a short seed, no seed, or no file', () => {
    const short = tree('env-short', (d) => writeFileSync(path.join(d, '.env.example'), 'SAMPLE_PASSWORD_SEED=short\n'));
    expect(run(short, 'files').stderr).toContain('shorter than 16');
    const none = tree('env-none', (d) => writeFileSync(path.join(d, '.env.example'), '# nothing\n'));
    expect(run(none, 'files').stderr).toContain('no SAMPLE_PASSWORD_SEED');
    const absent = tree('env-absent', (d) => rmSync(path.join(d, '.env.example')));
    expect(run(absent, 'files').status).toBe(1);
  });
});

describe('third-party notices (F-248)', () => {
  // why: F-248 the CC-BY-4.0 credit of caniuse-lite (and any credit the license policy records) must ship in THIRD-PARTY-NOTICES.md
  it('passes the real notices, and fails when a credit is cut, the file is gone, or the policy gains a credit the file lacks', () => {
    expect(run(tree('tpn-ok'), 'files').status).toBe(0);
    const cut = tree('tpn-cut', (d) => change(d, 'THIRD-PARTY-NOTICES.md', 'packaged by the browserslist project', 'packaged by browserslist'));
    expect(run(cut, 'files').stderr).toContain('does not carry the credit "caniuse-lite: browser support data');
    const gone = tree('tpn-gone', (d) => rmSync(path.join(d, 'THIRD-PARTY-NOTICES.md')));
    expect(run(gone, 'files').stderr).toContain('THIRD-PARTY-NOTICES.md is missing');
    const more = tree('tpn-more', (d) => change(d, 'ci/license/policy.json', '"restricted": {', '"restricted": {\n    "X-1": { "credit": "made-up-lib: a planted credit" },'));
    expect(run(more, 'files').stderr).toContain('made-up-lib: a planted credit');
  });
  // why: F-248 the notices ship in the release image beside the code: the image allowlist sends them and the app stage copies them
  it('is sent to the image build and copied into the app stage with the license files', () => {
    const ignore = readFileSync(path.join(repo, 'infra/image/Dockerfile.dockerignore'), 'utf8').split('\n');
    for (const f of ['LICENSE', 'LICENSE-DATA.md', 'THIRD-PARTY-NOTICES.md']) expect(ignore).toContain(`!${f}`);
    const docker = readFileSync(path.join(repo, 'infra/image/Dockerfile'), 'utf8');
    const app = docker.slice(docker.indexOf(' AS app'), docker.indexOf(' AS plant'));
    expect(app).toMatch(/^COPY LICENSE LICENSE-DATA\.md THIRD-PARTY-NOTICES\.md \.\/$/m);
  });
});

describe('export-private (F-1682, --export)', () => {
  const PRIVATE = ['docs/build/notes.ts', 'jl-plan', 'scripts/launch-x.sh'];
  // why: F-1682 the publish checks its candidate commit as an export: a private path in it must turn the check red, never be left out quietly
  it('fails an export that holds a private path, naming it, and leaves the checkout mode as it was', () => {
    const t = tree('export-private');
    const bad = run(t, 'private-refs', ['--floor', '1', '--export']);
    expect(bad.status).toBe(1);
    for (const f of PRIVATE) expect(bad.stderr).toContain(`FAIL export-private: ${f} is a private path`);
    // This checkout's own tree holds private paths by design: without --export they are left out, as before.
    expect(run(t, 'private-refs').status).toBe(0);
  });
  it('passes an export with no private path', () => {
    const t = tree('export-clean', (d) => { for (const f of PRIVATE) rmSync(path.join(d, f)); });
    const r = run(t, 'private-refs', ['--floor', '1', '--export']);
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('private-refs (F-1571, owner answer 44079436)', () => {
  const body = (d: string, rel: string) => writeFileSync(path.join(d, rel), '// SPDX-License-Identifier: AGPL-3.0-or-later\nexport const x = "python3 ci/vendor/jl-dev/tool.py";\n');

  // why: F-1571 the 2 vendored jl-dev scripts stay private, so an exported file that calls one has a dangling reference and must turn the check red
  it('fails when an exported file names ci/vendor/, and passes without it', () => {
    expect(run(tree('refs-clean'), 'private-refs').status).toBe(0);
    const bad = tree('refs-bad', (d) => body(d, 'apps/web/src/a.ts'));
    const r = run(bad, 'private-refs');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/web/src/a.ts: names the private path ci/vendor/');
  });

  // why: F-1571 a file under a private path is not exported, so naming ci/vendor/ there is not a reference of the public tree
  it('does not count a private file, and fails when ci/vendor/ leaves scripts/private-paths.txt', () => {
    const priv = tree('refs-private', (d) => { mkdirSync(path.join(d, 'docs', 'build'), { recursive: true }); body(d, 'docs/build/notes.ts'); });
    expect(run(priv, 'private-refs').status).toBe(0);
    const open = tree('refs-open', (d) => change(d, 'scripts/private-paths.txt', /^ci\/vendor\/$/m, ''));
    const r = run(open, 'private-refs');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ci/vendor/ is not in scripts/private-paths.txt');
  });

  // why: F-1571 an untracked link to a folder in the listing (a linked node_modules, as the Linux pre-check rig has) is skipped, not read
  it('skips a link to a folder in the file listing', () => {
    const linked = tree('refs-link', (d) => { mkdirSync(path.join(d, 'elsewhere')); symlinkSync(path.join(d, 'elsewhere'), path.join(d, 'linked')); });
    const r = run(linked, 'private-refs');
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('ipv4 (F-1609)', () => {
  const put = (d: string, rel: string, text: string) => writeFileSync(path.join(d, rel), text);
  // A public-range address built here so no committed file holds one; 8.8.8.8 is a documented resolver,.
  const real = ['5', '6', '7', '8'].join('.');

  // why: F-1609 the hosted server's address must not ship in the public export: a real IPv4 literal in an exported file turns the check red, the clean tree stays green
  it('fails on a public-range address, naming the file and line but not the address', () => {
    expect(run(tree('ip-clean'), 'ipv4').status).toBe(0);
    const bad = tree('ip-bad', (d) => put(d, 'apps/web/src/a.ts', `// SPDX-License-Identifier: AGPL-3.0-or-later\nexport const host = 'admin@${real}';\n`));
    const r = run(bad, 'ipv4');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/web/src/a.ts: line 2');
    expect(r.stderr).not.toContain(real);
  });

  // why: F-1609 the allowlist: loopback, 0.0.0.0, documentation ranges, private ranges, a public resolver and version-shaped strings pass
  it('passes loopback, documentation, private and version-shaped addresses', () => {
    const ok = ['127.0.0.1', '0.0.0.0', '203.0.113.10', '198.51.100.7', '192.0.2.1', '10.1.2.3', '172.18.0.2', '192.168.1.1', '1.1.1.1'].map((a) => `x ${a}:443`).join('\n');
    const t = tree('ip-ok', (d) => put(d, 'apps/web/src/a.ts', `// SPDX-License-Identifier: AGPL-3.0-or-later\n// Mozilla/5.0 Chrome/${real} Safari/537.36 v${real} 300.1.2.3\n// ${ok}\n`));
    const r = run(t, 'ipv4');
    expect(r.status, r.stderr).toBe(0);
  });

  // why: F-1609 an address at the end of a sentence or in a URL is still an address
  it('catches an address ending a sentence and one in a URL', () => {
    const t = tree('ip-forms', (d) => put(d, 'apps/web/src/a.ts', `// SPDX-License-Identifier: AGPL-3.0-or-later\n// reach it at ${real}.\n// https://${real}/x\n`));
    const r = run(t, 'ipv4');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('line 2, 3');
  });

  // why: F-1626 plant 1: an address in a URL path after a letter and a slash (ipinfo.io/<address>) fails, while Chrome/<version> still passes
  it('catches an address after a host or path word and a slash, and still passes a product version', () => {
    const t = tree('ip-path', (d) => put(d, 'apps/web/src/a.ts', `// SPDX-License-Identifier: AGPL-3.0-or-later\n// https://ipinfo.io/${real}\n// GET /api/${real}\n// Mozilla/5.0 Chrome/${real} Safari/537.36\n`));
    const r = run(t, 'ipv4');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('line 2, 3');
    expect(r.stderr).not.toContain('line 2, 3, 4');
    expect(r.stderr).not.toContain(real);
  });

  // why: F-1626 plant 2: the dashed form a cloud host name carries fails; a dashed private address passes
  it('catches the dashed cloud host form', () => {
    const dashed = real.replaceAll('.', '-');
    const t = tree('ip-dashed', (d) => put(d, 'apps/web/src/a.ts', `// SPDX-License-Identifier: AGPL-3.0-or-later\n// ec2-${dashed}.us-east-2.compute.amazonaws.com\n// ip-10-0-0-1.ec2.internal\n`));
    const r = run(t, 'ipv4');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('line 2');
    expect(r.stderr).not.toContain('line 2, 3');
    expect(r.stderr).not.toContain(dashed);
  });

  // why: F-1609 a private file is not exported, so an address there is not a leak of the public tree
  it('does not count a private file', () => {
    const t = tree('ip-private', (d) => put(d, 'docs/build/notes.ts', `export const x = '${real}';\n`));
    expect(run(t, 'ipv4').status).toBe(0);
  });
});

describe('owner-ids (F-1621, owner answer dedc3b70)', () => {
  // Stand-in ids, built here so no committed file holds them whole; the planted owner file is the tree's own infra/owner.env (private).
  const TEAM = ['T3AM', 'ID0001'].join('');
  const KEY = ['K3Y', 'ID00001'].join('');
  const owner = (d: string, body = `# the owner file\nBW_APPLE_TEAM_ID=${TEAM}\nBW_ASC_KEY_ID=${KEY}\n`) => {
    mkdirSync(path.join(d, 'infra'), { recursive: true });
    writeFileSync(path.join(d, 'infra', 'owner.env'), body);
  };
  const put = (d: string, rel: string, data: string | Buffer) => {
    mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    writeFileSync(path.join(d, rel), data);
  };
  /** The planted owner file only, as the publish run would name a file outside the checked tree. */
  const runOwner = (root: string, ...files: string[]) => run(root, 'owner-ids', ['--floor', '1', ...files.flatMap((f) => ['--owner-env', f])]);

  // why: F-1621 the instrument: an id in an exported file of any type (json, plist, mjs, ts, sh, md, a binary) turns the check red, each file named, the value never printed
  it('fails on each exported file type holding an id, naming the file, and passes the clean tree', () => {
    const clean = tree('ids-clean', (d) => owner(d));
    const ok = runOwner(clean, path.join(clean, 'infra', 'owner.env'));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('owner ids: 2 looked for, from 1 owner file(s), in none of the exported files');
    const plants: [string, string | Buffer][] = [
      ['apps/tech-native/app.json', `{"expo":{"ios":{"appleTeamId":"${TEAM}"}}}\n`],
      ['apps/tech-native/release/ExportOptions.plist', `<plist><dict><key>teamID</key><string>${TEAM}</string></dict></plist>\n`],
      ['apps/tech-native/release/asc.mjs', `// SPDX-License-Identifier: AGPL-3.0-or-later\nconst KEY_ID = '${KEY}';\n`],
      ['ci/native/asc.test.ts', `// SPDX-License-Identifier: AGPL-3.0-or-later\nexport const k = 'AuthKey_${KEY}.p8';\n`],
      ['apps/tech-native/release/xcb.sh', `#!/usr/bin/env bash\n# SPDX-License-Identifier: AGPL-3.0-or-later\nkid="${KEY}"\n`],
      ['docs/public/RELEASE.md', `The team is ${TEAM}.\n`],
      ['apps/tech-native/assets/blob.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]), Buffer.from(KEY), Buffer.from([0, 2])])],
    ];
    const bad = tree('ids-bad', (d) => {
      owner(d);
      for (const [rel, data] of plants) put(d, rel, data);
    });
    const r = runOwner(bad, path.join(bad, 'infra', 'owner.env'));
    expect(r.status).toBe(1);
    for (const [rel] of plants) expect(r.stderr).toContain(`owner-ids: ${rel}: holds the`);
    expect(r.stderr).toContain('ci/native/asc.test.ts: holds the App Store Connect API key id (BW_ASC_KEY_ID');
    expect(r.stderr).toContain('apps/tech-native/app.json: holds the Apple team id (BW_APPLE_TEAM_ID');
    expect(r.stderr + r.stdout).not.toContain(TEAM);
    expect(r.stderr + r.stdout).not.toContain(KEY);
  });

  // why: F-1621 the default owner files are the checked tree's: a tree whose own owner file names the ids is checked with no option
  it('reads the checked tree\'s own owner file by default', () => {
    const bad = tree('ids-default', (d) => { owner(d); put(d, 'apps/web/src/a.ts', `// SPDX-License-Identifier: AGPL-3.0-or-later\nexport const t = '${TEAM}';\n`); });
    const r = run(bad, 'owner-ids');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/web/src/a.ts: holds the Apple team id');
  });

  // why: F-1621 scripts/publish.sh checks the candidate commit, the export, which has no owner file, with the private checkout's ci/public-files.ts: that checkout's owner file must be read
  it('reads this checkout\'s own owner file too, so an export with none is still checked', () => {
    const files = defaultOwnerFiles(path.join(tmp, 'an-export'));
    expect(files).toContain(path.join(repo, 'infra', 'owner.env'));
    expect(files).toContain(path.join(tmp, 'an-export', 'infra', 'owner.env'));
    // The publish shape: the checked tree has no owner file, the ids come from a file outside it.
    const outside = path.join(tmp, 'private-owner.env');
    writeFileSync(outside, `BW_APPLE_TEAM_ID=${TEAM}\nBW_ASC_KEY_ID=${KEY}\n`);
    const exp = tree('ids-export', (d) => put(d, 'apps/tech-native/app.json', `{"appleTeamId":"${TEAM}"}\n`));
    const r = runOwner(exp, outside);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/tech-native/app.json: holds the Apple team id');
  });

  // why: F-1621 an id in a private file (the build records, the owner file itself) is not exported, so it is not a leak
  it('does not count a private file', () => {
    const t = tree('ids-private', (d) => { owner(d); put(d, 'docs/build/notes.md', `${TEAM} ${KEY}\n`); put(d, '.build/evidence/x.log', `-authenticationKeyID ${KEY}\n`); });
    const r = runOwner(t, path.join(t, 'infra', 'owner.env'));
    expect(r.status, r.stderr).toBe(0);
  });

  // why: F-1621 the check never passes by finding nothing: an owner file without an id, or with a malformed one, fails; only no owner file at all (a public copy) passes, and says so
  it('fails an owner file that lacks an id or holds a malformed one, and passes a tree with no owner file', () => {
    const none = tree('ids-none');
    const n = runOwner(none, path.join(none, 'infra', 'owner.env'), path.join(none, 'infra', 'owner.local.env'));
    expect(n.status, n.stderr).toBe(0);
    expect(n.stdout).toContain('owner ids: no owner file, nothing to look for');
    const lacks = tree('ids-lacks', (d) => owner(d, `BW_APPLE_TEAM_ID=${TEAM}\n# BW_ASC_KEY_ID=${KEY}\n`));
    const l = runOwner(lacks, path.join(lacks, 'infra', 'owner.env'));
    expect(l.status).toBe(1);
    expect(l.stderr).toContain('no owner file holds BW_ASC_KEY_ID');
    const odd = tree('ids-odd', (d) => owner(d, `BW_APPLE_TEAM_ID=${TEAM.toLowerCase()}\nBW_ASC_KEY_ID=\n`));
    const o = runOwner(odd, path.join(odd, 'infra', 'owner.env'));
    expect(o.status).toBe(1);
    expect(o.stderr).toContain('BW_APPLE_TEAM_ID in the owner file is not 10 capitals or digits');
    expect(o.stderr).toContain('BW_ASC_KEY_ID in the owner file is not 10 capitals or digits');
    expect(o.stderr).not.toContain(TEAM.toLowerCase());
  });
});

describe('the P10-CHECKS cases (K-12, K-13, K-15, K-21, J-31, J-32, J-35; F-2025)', () => {
  const put = (d: string, rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    writeFileSync(path.join(d, rel), body);
  };
  const CHECKOUT = (extra: string) => `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n${extra}      - run: echo hi\n`;

  // why: FR-DIST-1 K-12 K-13 K-15 K-21 J-31 J-32 J-35 each new case passes the committed tree, so the head run of the gate is green
  it('passes the real tree', () => {
    for (const which of ['fonts', 'css', 'workflows', 'changelog', 'engines', 'domain', 'spike']) {
      const r = runReal(which);
      expect(r.status, `${which}: ${r.stderr}`).toBe(0);
    }
  });

  // why: FR-DIST-6 K-12 a font folder with no license file fails and is named; the license file beside it turns it green
  it('fails a font folder with no license file, and passes it with one', () => {
    const bad = tree('font-bad', (d) => put(d, 'apps/web/fonts/Inter.woff2', 'x'));
    const r = run(bad, 'fonts');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/web/fonts/ holds a font and no license file');
    const ok = tree('font-ok', (d) => { put(d, 'apps/web/fonts/Inter.woff2', 'x'); put(d, 'apps/web/fonts/OFL-1.1.txt', 'SIL OFL'); });
    expect(run(ok, 'fonts').status).toBe(0);
  });

  // why: FR-DIST-6 K-13 F-2025 a .css file with no SPDX line and no REUSE.toml cover fails; an SPDX line, or a cover for its path, turns it green
  it('fails a .css file with no SPDX line and no REUSE.toml cover, and passes one with either', () => {
    const noCover = (d: string) => change(d, 'REUSE.toml', /# K-13[\s\S]*$/, '');
    const bad = tree('css-bad', (d) => { noCover(d); put(d, 'apps/web/styles/a.css', 'a { color: red; }\n'); });
    const r = run(bad, 'css');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/web/styles/a.css: no SPDX-License-Identifier line');
    const spdx = tree('css-spdx', (d) => { noCover(d); put(d, 'apps/web/styles/a.css', '/* SPDX-License-Identifier: AGPL-3.0-or-later */\na { color: red; }\n'); });
    expect(run(spdx, 'css').status).toBe(0);
    const covered = tree('css-cover', (d) => put(d, 'apps/web/styles/a.css', 'a { color: red; }\n'));
    expect(run(covered, 'css').status).toBe(0);
    // A cover that names another license, or another folder, is no cover.
    const other = tree('css-other', (d) => { change(d, 'REUSE.toml', /\*\*\/\*\.css/, 'docs/**/*.css'); put(d, 'apps/web/styles/a.css', 'a { color: red; }\n'); });
    expect(run(other, 'css').status).toBe(1);
  });

  // why: K-15 a checkout step without persist-credentials: false fails and is named; with the line (or the key set to false later in its block) it passes
  it('fails a checkout without persist-credentials: false, and passes one with it', () => {
    const bad = tree('wf-bad', (d) => put(d, '.github/workflows/x.yml', CHECKOUT('')));
    const r = run(bad, 'workflows');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('.github/workflows/x.yml:4: a checkout step without persist-credentials: false');
    const wrong = tree('wf-true', (d) => put(d, '.github/workflows/x.yml', CHECKOUT('        with:\n          persist-credentials: true\n')));
    expect(run(wrong, 'workflows').status).toBe(1);
    const ok = tree('wf-ok', (d) => put(d, '.github/workflows/x.yml', CHECKOUT('        with:\n          persist-credentials: false\n')));
    expect(run(ok, 'workflows').status).toBe(0);
    // A false in the NEXT step does not count for this one.
    const next = tree('wf-next', (d) => put(d, '.github/workflows/x.yml', 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/other@v1\n        with:\n          persist-credentials: false\n'));
    expect(run(next, 'workflows').status).toBe(1);
  });

  // why: K-21 an export with no CHANGELOG.md fails, and one that holds it passes
  it('fails a tree with no CHANGELOG.md, and passes one that holds it', () => {
    const bad = tree('cl-bad');
    const r = run(bad, 'changelog');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CHANGELOG.md is missing');
    expect(run(tree('cl-ok', (d) => put(d, 'CHANGELOG.md', '# Changelog\n')), 'changelog').status).toBe(0);
  });

  // why: FR-DIST-7 J-31 an engines.node that is not the major of .node-version fails; the real one passes
  it('fails an engines.node that does not match .node-version', () => {
    const bad = tree('eng-bad', (d) => change(d, 'package.json', /"node": ">=\d+"/, '"node": ">=24"'));
    const r = run(bad, 'engines');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('engines.node is ">=24"');
    expect(run(tree('eng-ok'), 'engines').status).toBe(0);
  });

  // why: J-32 a shipped file that names the company domain fails and is named; a private file that names it does not
  it('fails a shipped file that names brightwaterair.com', () => {
    const bad = tree('dom-bad', (d) => put(d, 'apps/web/src/a.ts', '// SPDX-License-Identifier: AGPL-3.0-or-later\nexport const e = \'x@brightwaterair.com\';\n'));
    const r = run(bad, 'domain');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apps/web/src/a.ts: names brightwaterair.com');
    expect(run(tree('dom-private', (d) => put(d, 'docs/build/notes.md', 'x@brightwaterair.com\n')), 'domain').status).toBe(0);
  });

  // why: FR-DIST-1 J-35 an export that holds infra/spike/ fails, and so does a private-paths.txt that no longer lists it; the clean export passes
  it('fails an export that holds infra/spike/, and a private-paths list without it', () => {
    const bad = tree('spike-bad', (d) => put(d, 'infra/spike/s1/load.mjs', 'x\n'));
    const r = run(bad, 'spike', ['--floor', '1', '--export']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL spike: infra/spike/s1/load.mjs: the export holds infra/spike/');
    const dropped = tree('spike-dropped', (d) => change(d, 'scripts/private-paths.txt', /^infra\/spike\/$/m, ''));
    const d = run(dropped, 'spike');
    expect(d.status).toBe(1);
    expect(d.stderr).toContain('infra/spike/ is not in scripts/private-paths.txt');
    expect(run(tree('spike-ok'), 'spike').status).toBe(0);
  });
});
