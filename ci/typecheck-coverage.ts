// SPDX-License-Identifier: AGPL-3.0-or-later
// typecheck-coverage (findings F-2, F-23): every tracked TypeScript file (.ts, .tsx, .mts, .cts; not .d.ts)
// must be in a typecheck: the root tsconfig.json, or the tsconfig.json of the apps/* or packages/* directory
// it sits in (`pnpm -r typecheck` runs those). A package file outside its tsconfig include is in none.
//   node ci/typecheck-coverage.ts
// Exit 0: all covered. Exit 1: a file is in no typecheck (each printed). Exit 2: cannot judge.
// Env (for tests): CI_ROOT (repo root; its tsconfig.json and git index are read).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const root = realpathSync(process.env.CI_ROOT ? path.resolve(process.env.CI_ROOT) : path.resolve(import.meta.dirname, '..'));
const run = promisify(execFile);

async function lines(cmd: string, args: string[]): Promise<string[]> {
  const { stdout } = await run(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').filter(Boolean);
}

/** fn over every item, at most `limit` at once, results in item order. */
async function pooled<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

try {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const listed = async (project: string): Promise<string[]> =>
    (await lines('node', [tsc, '--listFilesOnly', '-p', project])).map((f) => path.relative(root, f));
  const projects = ['tsconfig.json'];
  for (const group of ['apps', 'packages']) {
    if (!existsSync(path.join(root, group))) continue;
    for (const d of readdirSync(path.join(root, group), { withFileTypes: true })) {
      const project = path.join(group, d.name, 'tsconfig.json');
      if (d.isDirectory() && existsSync(path.join(root, project))) projects.push(project);
    }
  }
  // F-276: the listings are independent read-only tsc runs (about 20, 18 s one after another on the loaded wave
  // container), so they run side by side, at most 1 per CPU.
  const typechecked = new Set((await pooled(projects, availableParallelism(), listed)).flat());
  const tracked = await lines('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts', '*.cts']);
  const population = tracked.filter((f) => !f.endsWith('.d.ts'));
  const missing = population.filter((f) => !typechecked.has(f));
  for (const f of missing) console.error(`typecheck-coverage: ${f} is in no typecheck (add it to tsconfig.json include)`);
  if (missing.length > 0) process.exit(1);
  console.log(`typecheck-coverage: ok (${population.length} TypeScript files, all in a typecheck)`);
} catch (e) {
  console.error(`typecheck-coverage: cannot judge: ${(e as Error).message}`);
  process.exit(2);
}
