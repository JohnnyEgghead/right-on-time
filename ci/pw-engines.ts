// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser engines every Playwright proof runs on (BUILD_PLAN P1-PAGE-GATES, G-LOOK-PARITY), in one place.
// The proof set is Chromium and WebKit. BW_PW_ENGINES may narrow a local run on a machine without a build, but a
// narrowed run is never silent (F-39): it must name why in BW_PW_ENGINES_WHY, and it then prints a DROPPED notice.
// CI and ci/wave-run.sh set neither variable. Used by ci/page-walkers/walkers.pw.test.ts and ci/look-values/compare.pw.test.ts.
import { chromium, webkit, type BrowserType } from 'playwright';
import { ALL_ENGINE_NAMES, resolveEngines } from './pw-engine-names.ts';

export { ALL_ENGINE_NAMES, resolveEngines };

const byName: Record<string, BrowserType> = { chromium, webkit };

const resolved = resolveEngines(process.env.BW_PW_ENGINES, process.env.BW_PW_ENGINES_WHY);
if (resolved.notice) process.stdout.write(`pw-engines: ${resolved.notice}\n`);

/** The [name, type] pairs a `describe.each` runs over. */
export const engines: [string, BrowserType][] = resolved.names.map((n) => [n, byName[n]!]);
