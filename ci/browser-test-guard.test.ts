// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling
// Merge-set checks over the browser-test population (browser-free; they read tracked files only).
//   1. No orphaned browser test (F-43): the unit-tests gate excludes every *.pw.test.ts, and each wave gate passes one
//      directory to vitest.browser.config.ts. A *.pw.test.ts outside every such directory (and outside the config's
//      ci/** include) would run in no gate and every run would stay green.
//   2. No unguarded browser context (F-40, F-48): every .ts, .tsx, .js, .jsx, .mjs or .cjs file that imports Playwright
//      (static import, import() or require) opens its contexts through guardedContext (ci/page-walkers/origin-guard.ts),
//      so the outside-origin guard is not opt-in at the import. The EXEMPT tools (not tests or gates; each entry names what it loads) are
//      skipped by path. A test must close the context, not only the browser, for the guard to assert.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tracked = (): string[] => {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\n').filter((f) => f !== '');
};

/** Directories the wave gate scripts pass to vitest.browser.config.ts. */
export function gateDirs(scripts: string[]): string[] {
  return scripts.flatMap((s) => [...s.matchAll(/vitest\.browser\.config\.ts\s+([^\s"'|&;]+)/g)].map((m) => m[1]!.replace(/\/$/, '')));
}

/** *.pw.test.ts files no gate reaches: outside every gate directory, or outside the config include (ci/). */
export function orphans(files: string[], dirs: string[]): string[] {
  return files
    .filter((f) => f.endsWith('.pw.test.ts'))
    .filter((f) => !f.startsWith('ci/') || !dirs.some((d) => f.startsWith(`${d}/`)));
}

// Any context opener, and newPage on anything that is not a context (a browser opens an unguarded page). A page opened on
// a variable named context, ctx or *Context (the guarded one) is allowed.
const OPENS_CONTEXT = /\.(newContext|launchPersistentContext)\(|(?<![cC]ontext|ctx)\.newPage\(/;
const IMPORTS_PLAYWRIGHT =
  /from ['"](playwright|playwright-core|@playwright\/test)['"]|(import|require)\(\s*['"](playwright|playwright-core|@playwright\/test)['"]/;
const SCANNED = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const GUARD_FILE = 'ci/page-walkers/origin-guard.ts';
/** Playwright users that are neither tests nor gate files, so they run with no outside-origin guard (each entry names what it loads). */
export const EXEMPT: Record<string, string> = {
  'mockups/tools/build.mjs': 'mockup build tool; loads local mockup pages',
  'docs/design/tools/contrast_sweep.mjs': 'design contrast tool; loads local pages',
  'infra/spike/s2/selftest/selftest.mjs': 'spike S2 self-test against the hosted spike page (BASE, default https://bw.j7l.io/spike/s2/); not a test or gate',
  'packages/testkit/src/load/pages.ts': "P7-LOAD's NFR-02 page probe, run by the load script against the temporary load server's office pages only; not a test or gate, and a routed context would turn off the HTTP cache its warm loads measure",
};

/** Source files that import Playwright and open a context or page without guardedContext. */
export function unguarded(files: { path: string; src: string }[]): string[] {
  return files
    .filter((f) => SCANNED.test(f.path) && f.path !== GUARD_FILE && !(f.path in EXEMPT))
    .filter((f) => IMPORTS_PLAYWRIGHT.test(f.src))
    .filter((f) => OPENS_CONTEXT.test(f.src))
    .map((f) => f.path);
}

describe('browser test population', () => {
  const files = tracked();
  const scripts = readdirSync('ci/gates')
    .filter((f) => f.endsWith('.sh'))
    .map((f) => readFileSync(`ci/gates/${f}`, 'utf8'));

  it('every *.pw.test.ts sits under a directory a wave gate passes to vitest.browser.config.ts', () => {
    // reason: F-43; a browser test outside the gate directories would run nowhere
    const dirs = gateDirs(scripts);
    expect(dirs.sort()).toEqual(expect.arrayContaining(['ci/look-values', 'ci/page-walkers']));
    expect(files.filter((f) => f.endsWith('.pw.test.ts')).length).toBeGreaterThanOrEqual(2);
    expect(orphans(files, dirs)).toEqual([]);
  });

  it('known-bad: a browser test outside the gate directories is reported as an orphan', () => {
    // reason: F-43; proves the check can fail
    const dirs = ['ci/look-values', 'ci/page-walkers'];
    expect(orphans(['apps/web/src/look.pw.test.ts', 'ci/newgate/x.pw.test.ts', 'ci/page-walkers/walkers.pw.test.ts'], dirs)).toEqual([
      'apps/web/src/look.pw.test.ts',
      'ci/newgate/x.pw.test.ts',
    ]);
    expect(gateDirs(['exec pnpm exec vitest run --config vitest.browser.config.ts ci/new-dir'])).toEqual(['ci/new-dir']);
  });

  it('no file that imports Playwright opens a context or page outside guardedContext', () => {
    // reason: F-40; the outside-origin guard must not be opt-in at the import
    // This file holds the known-bad strings below, so it is not scanned.
    const ts = files.filter((f) => SCANNED.test(f) && f !== 'ci/browser-test-guard.test.ts');
    const read = ts.map((path) => ({ path, src: readFileSync(path, 'utf8') }));
    expect(unguarded(read)).toEqual([]);
  });

  it('known-bad: a Playwright file that calls newContext itself is reported', () => {
    // reason: F-40; proves the check can fail
    const bad = { path: 'ci/x/a.pw.test.ts', src: "import { chromium } from 'playwright';\nconst c = await browser.newContext();" };
    const good = { path: 'ci/x/b.pw.test.ts', src: "import { chromium } from 'playwright';\nconst g = await guardedContext(browser, []);" };
    const page = { path: 'ci/x/c.ts', src: "import { webkit } from 'playwright';\nconst p = await browser.newPage();" };
    expect(unguarded([bad, good, page])).toEqual(['ci/x/a.pw.test.ts', 'ci/x/c.ts']);
  });

  it('known-bad: .mjs, .js, a dynamic import, a non-browser receiver and an unlisted tool are reported', () => {
    // reason: F-48; the scan covers every JS/TS extension, both import forms, and any newPage not on a context
    const mjs = { path: 'ci/x/d.mjs', src: "import { chromium } from 'playwright';\nconst p = await b.newPage();" };
    const dyn = { path: 'ci/x/e.js', src: "const { chromium } = await import('playwright');\nconst p = await (await chromium.launch()).newPage();" };
    const tsx = { path: 'ci/x/f.tsx', src: "import { webkit } from 'playwright';\nconst c = await webkit.launchPersistentContext('p');" };
    const ok = { path: 'ci/x/g.mjs', src: "import { webkit } from 'playwright';\nconst p = await g.context.newPage();\nconst q = await ctx.newPage();" };
    const exempt = { path: 'mockups/tools/build.mjs', src: "import { chromium } from 'playwright';\nconst p = await browser.newPage();" };
    expect(unguarded([mjs, dyn, tsx, ok, exempt])).toEqual(['ci/x/d.mjs', 'ci/x/e.js', 'ci/x/f.tsx']);
    expect(Object.keys(EXEMPT).every((p) => files.includes(p))).toBe(true);
  });
});
