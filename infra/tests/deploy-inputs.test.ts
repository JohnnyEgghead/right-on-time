// SPDX-License-Identifier: AGPL-3.0-or-later
// F-100: the clean-tree guard in infra/deploy/deploy.sh is scoped to DEPLOY_INPUTS, what the deploy ships.
// These tests keep that list in step with the image's COPY sources and the staged files.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const deploy = readFileSync(path.join(root, 'infra/deploy/deploy.sh'), 'utf8');

const inputs = (() => {
  const m = /^DEPLOY_INPUTS=\(([\s\S]*?)^\)/m.exec(deploy);
  if (!m) throw new Error('DEPLOY_INPUTS not found in deploy.sh');
  return (m[1] as string).split(/\s+/).filter(Boolean);
})();
const covered = (p: string) => inputs.some((i) => p === i || p.startsWith(`${i}/`));

describe('infra/deploy/deploy.sh clean-tree guard (F-100)', () => {
  // why: F-100
  it('covers every COPY source of the image and every file the stage copies', () => {
    const dockerfile = readFileSync(path.join(root, 'infra/image/Dockerfile'), 'utf8');
    const copySources = [...dockerfile.matchAll(/^COPY (?!--from)(\S+) /gm)].map((m) => m[1] as string);
    expect(deploy).toContain('git status --porcelain -- "${DEPLOY_INPUTS[@]}"');
    expect(copySources.length).toBeGreaterThan(0);
    const stageSources = [...deploy.matchAll(/^cp (?:-R )?(.+?) "\$stage\/"/gm)].flatMap((m) => (m[1] as string).split(/\s+/).filter((s) => s.startsWith('infra/')));
    expect(stageSources.length).toBeGreaterThan(0);
    for (const p of [...copySources, ...stageSources, 'infra/image/Dockerfile', 'infra/hosted/hosted.env', 'infra/profiles/demo.env']) {
      expect(covered(p), `${p} is shipped but not in DEPLOY_INPUTS`).toBe(true);
    }
  });

  // why: F-100
  it('does not stop on an uncommitted .build record, and stops on a changed shipped file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-guard-'));
    try {
      const sh = (cmd: string) => execFileSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
      const body = `DEPLOY_INPUTS=(${inputs.join(' ')})\n`;
      mkdirSync(path.join(dir, 'apps/web/src'), { recursive: true });
      mkdirSync(path.join(dir, '.build'), { recursive: true });
      writeFileSync(path.join(dir, 'apps/web/src/a.ts'), 'x\n');
      writeFileSync(path.join(dir, 'guard.sh'), `${body}git status --porcelain -- "\${DEPLOY_INPUTS[@]}"\n`);
      sh('git init -q . && git config user.email t@e.x && git config user.name t && git add apps && git commit -q -m init');
      writeFileSync(path.join(dir, '.build/BUILD_STATE.md'), 'dirty record\n');
      expect(sh('bash guard.sh').trim()).toBe('');
      writeFileSync(path.join(dir, 'apps/web/src/a.ts'), 'changed\n');
      expect(sh('bash guard.sh')).toContain('apps/web/src/a.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
