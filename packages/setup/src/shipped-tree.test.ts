// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-237 (setup runs the generator from the shipped tree)
// Setup runs from the app image (the compose service `setup`), which ships packages/*/src and an allowlist of other
// files (infra/image/Dockerfile.dockerignore), never ci/. So no product file may import from ci/, and every file setup
// reads at run time must be on the allowlist, with @bw/setup installed in the image.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function productFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'testing' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) out.push(...productFiles(p));
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'testing.ts') out.push(p);
  }
  return out;
}

const srcDirs = (top: string): string[] => readdirSync(path.join(ROOT, top))
  .map((d) => path.join(ROOT, top, d, 'src')).filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });

describe('setup runs from the shipped tree (F-237)', () => {
  // why: F-237
  it('no product file under packages/*/src or apps/*/src imports from ci/', () => {
    const offenders: string[] = [];
    for (const dir of [...srcDirs('packages'), ...srcDirs('apps')]) {
      for (const f of productFiles(dir)) {
        for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
          const spec = m[1] as string;
          if (!spec.startsWith('.')) continue;
          const target = path.relative(ROOT, path.resolve(path.dirname(f), spec));
          if (target === 'ci' || target.startsWith(`ci${path.sep}`)) offenders.push(`${path.relative(ROOT, f)} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // why: F-237
  it("the image installs @bw/setup and ships the generator's committed inputs that setup reads", () => {
    const allow = readFileSync(path.join(ROOT, 'infra/image/Dockerfile.dockerignore'), 'utf8').split('\n');
    for (const f of ['technicians.json', 'named-people.json', 'MANIFEST.json']) expect(allow, f).toContain(`!packages/generator/${f}`);
    expect(allow).toContain('!packages/*/src');
    expect(allow, 'F-362: readVerifiedMaps reads the map manifest at run time').toContain('!packages/maps/MANIFEST.json');
    expect(readFileSync(path.join(ROOT, 'infra/image/Dockerfile'), 'utf8')).toMatch(/pnpm install [^\n]*--filter @bw\/setup\.\.\./);
  });
});
