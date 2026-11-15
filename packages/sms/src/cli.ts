// SPDX-License-Identifier: AGPL-3.0-or-later
// text-budget-check CLI: node packages/sms/src/cli.ts [--require-templates]
// 1. Runs the good control and the 5 FR-TEXT-9 must-fail arms over the committed fixtures.
// 2. Runs the real template set (catalog keys text.<id> in both languages) and prints how many
//    renders it ran.
// Exit 0: arms hold and the real set passes, or is empty without --require-templates.
// Exit 1: an arm did not fail, the control did not pass, or the real set failed.
// Exit 2: the real set is empty and --require-templates was given (P3-TEXTS passes this flag).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARMS, CHECK_ARMS, goodInput, standInSlotValues } from './fixtures.ts';
import { BOOKABLE_DAYS, runTextBudgetCheck, templatesFromCatalogs } from './text-budget.ts';
import type { Report, SlotValues } from './text-budget.ts';

export interface CliResult {
  exit: number;
  lines: string[];
}

export function runCli(
  en: Record<string, string>,
  es: Record<string, string>,
  opts: { requireTemplates: boolean; /** The real slot values (F-162 item 3); default the SD-17-bound stand-ins. */ slots?: SlotValues },
): CliResult {
  const lines: string[] = [];
  let exit = 0;

  const control = runTextBudgetCheck(goodInput());
  lines.push(`control  good fixture set: ${control.outcome}, ${control.templates} templates, ${control.renders} renders`);
  if (control.outcome !== 'pass') {
    exit = 1;
    for (const f of control.failures) lines.push(`  control failure: ${f.kind} ${f.detail}`);
  }

  for (const arm of [...ARMS, ...CHECK_ARMS]) {
    const reports: Report[] = arm.cases.map((c) => runTextBudgetCheck(c));
    const ok = reports.every((r) => r.outcome === 'fail' && r.failures.some((f) => f.kind === arm.expect));
    const renders = reports.reduce((n, r) => n + r.renders, 0);
    lines.push(`${ok ? 'FAILS-AS-EXPECTED' : 'DID-NOT-FAIL'} ${arm.name} (expects ${arm.expect}, ${renders} renders)`);
    if (!ok) exit = 1;
  }

  const { templates, failures: loadFailures } = templatesFromCatalogs(en, es);
  const real = runTextBudgetCheck({
    templates,
    days: BOOKABLE_DAYS,
    slots: opts.slots ?? standInSlotValues(),
  });
  real.failures.push(...loadFailures);
  if (loadFailures.length > 0) real.outcome = 'fail';
  lines.push(`real set: ${real.templates} templates, ${real.renders} renders, outcome ${real.outcome}`);
  if (real.outcome === 'empty') {
    lines.push('real set: 0 templates, nothing to check. This is NOT a pass. P3-TEXTS adds them and runs with --require-templates.');
    if (opts.requireTemplates) exit = exit === 0 ? 2 : exit;
  } else if (real.outcome === 'fail') {
    exit = 1;
    for (const f of real.failures) lines.push(`  ${f.template ?? '-'} ${f.lang ?? '-'} ${f.kind}: ${f.detail}`);
  }
  return { exit, lines };
}

function readCatalog(name: string): Record<string, string> {
  const path = fileURLToPath(new URL(`../../i18n/catalog/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

if (import.meta.main) {
  const r = runCli(readCatalog('en'), readCatalog('es'), {
    requireTemplates: process.argv.includes('--require-templates'),
  });
  console.log(r.lines.join('\n'));
  process.exit(r.exit);
}
