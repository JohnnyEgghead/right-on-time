// SPDX-License-Identifier: AGPL-3.0-or-later
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs rule module without types
import rule from './log-allowlist.mjs';

const linter = new Linter();
const run = (code: string) =>
  linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { bw: { rules: { 'log-allowlist': rule } } },
        rules: { 'bw/log-allowlist': 'error' },
      },
    ],
    'planted.ts',
  );

describe('log-allowlist', () => {
  // why: SD-42, NFR-05, invariant 6
  it('fails console calls of every method, however reached', () => {
    for (const code of [
      "console.log('x');",
      "console.error('x');",
      "console.info('x'); console.warn('y');",
      "console['log']('x');",
      "globalThis.console.log('x');",
      'const w = console.log; w(1);',
      'const { log } = console; log(1);',
    ]) {
      const out = run(code);
      expect(out.length, code).toBeGreaterThanOrEqual(1);
      expect(out.every((m) => m.ruleId === 'bw/log-allowlist'), code).toBe(true);
    }
  });

  // why: SD-42, NFR-05, invariant 6
  it('fails a free-text write to stdout or stderr, however reached', () => {
    for (const code of [
      "process.stdout.write('x');",
      'process.stdout.write(`call ${phone}\\n`);',
      "process.stderr.write('x');",
      "process['stdout'].write('x');",
      "globalThis.process.stdout.write('x');",
      'const { stdout } = process; stdout.write(1);',
      "import { writeSync } from 'node:fs'; writeSync(1, 'x');",
      "import fs from 'node:fs'; fs.writeSync(2, 'x');",
    ]) {
      expect(run(code).length, code).toBeGreaterThanOrEqual(1);
    }
  });

  // why: SD-42, NFR-05, invariant 6
  it('passes @bw/log calls, other process members and local bindings', () => {
    expect(run("import { createLogger } from '@bw/log'; const log = createLogger({ process: 'worker' }); log.info({ status: 'started' }); log.error({ errorCode: 'x' });")).toEqual([]);
    expect(run('process.on("SIGTERM", () => process.exit(0)); const p = process.env.PORT; process.exitCode = 1;')).toEqual([]);
    expect(run("const f = (console: { log(x: string): void }) => console.log('x');")).toEqual([]);
    expect(run("import fs from 'node:fs'; fs.writeSync(7, 'x'); fs.writeFileSync('a', 'b');")).toEqual([]);
  });

  // why: F-327 (owner ruling a35e8595) the repo's own config applies the rule to the setup program and the migrate service's
  // start.ts, the 2 process sources outside the apps; a planted console.log in each fails, and the clean text passes
  it('applies to packages/setup/src and packages/db/src/cli/start.ts in the repo config', async () => {
    const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname });
    const lint = async (filePath: string, text: string) => (await eslint.lintText(text, { filePath })).flatMap((r) => r.messages.map((m) => m.ruleId));
    for (const filePath of ['packages/setup/src/planted.ts', 'packages/db/src/cli/start.ts']) {
      expect(await lint(filePath, "console.log('x');\n"), filePath).toContain('bw/log-allowlist');
      expect(await lint(filePath, 'export {};\n'), filePath).not.toContain('bw/log-allowlist');
    }
  }, 60_000);
});
