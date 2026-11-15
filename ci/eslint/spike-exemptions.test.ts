// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DEMO-2, FR-LANG-2, F-180, F-125
// The native spike's lint exemptions are gone with the spike (P6-NATIVE-SHELL): a clock read or an inline JSX string anywhere in the
// native app, under its old spike paths included, fails the repo's own eslint.config.mjs (inline config off). The 1 clock exemption
// left is spike S2's web shell, and it holds exactly the 7 reads eslint.config.mjs names, each outside every shipped bundle.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { lintClockText, ROOT } from '../gates/G-CI4/lib.ts';

const CLOCK = 'export const t = Date.now();\nexport const d = new Date();\n';

async function lintRule(code: string, file: string, rule: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: ROOT, allowInlineConfig: false, ruleFilter: ({ ruleId }) => ruleId === rule });
  const [res] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return (res?.messages ?? []).filter((m) => m.ruleId === rule).map((m) => `${m.line}: ${m.message}`);
}

describe('no exemption for the native app (F-180, F-125)', () => {
  it.each(['apps/tech-native/src/planted.ts', 'apps/tech-native/src/spike/s4/planted.ts', 'apps/tech-native/spike/planted.ts', 'apps/tech-native/index.ts'])(
    'fails a planted clock read as %s', async (file) => {
      const r = await lintClockText(CLOCK, file);
      expect(r.fatal).toEqual([]);
      expect(r.hits.map((h) => h.line)).toEqual([1, 2]);
    },
  );

  it.each(['apps/tech-native/src/spike/s4/Planted.tsx', 'apps/tech-native/src/screens/Planted.tsx'])('fails a planted inline JSX string as %s', async (file) => {
    const hits = await lintRule('import { Text } from "react-native";\nexport const X = () => <Text>Queue note and photo</Text>;\n', file, 'bw/no-inline-strings');
    expect(hits).toHaveLength(1);
  });

  it('keeps 1 clock exemption, spike S2\'s web shell, holding the 7 reads the config names and nothing the release image ships', async () => {
    const config = readFileSync(path.join(ROOT, 'eslint.config.mjs'), 'utf8');
    expect(config).toContain("ignores: ['packages/time/src/real.ts', 'apps/web/spike/s2/**'],");
    expect(config).not.toMatch(/tech-native\/src\/spike|apps\/\*\/spike/);
    const reads: string[] = [];
    for (const f of ['apps/web/spike/s2/public/app.js', 'apps/web/spike/s2/server.mjs']) {
      readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        if (/Date\.now\(\)|new Date\(\)|performance\.timeOrigin/.test(line)) reads.push(`${path.basename(f)}:${i + 1}`);
      });
    }
    expect(reads).toEqual(['app.js:45', 'app.js:77', 'app.js:89', 'app.js:98', 'app.js:110', 'server.mjs:38', 'server.mjs:76']);
    for (const r of [':45, :77, :89, :98, :110', 'server.mjs:38, :76']) expect(config).toContain(r);
    expect(readFileSync(path.join(ROOT, 'infra/image/Dockerfile.dockerignore'), 'utf8').split('\n')).toContain('apps/web/spike');
  });
});
