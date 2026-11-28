// SPDX-License-Identifier: AGPL-3.0-or-later
// mac-host-tests (K-19, P10-CHECKS): judges the vitest JSON report of the 2 Mac-only test files.
//   node ci/gates/mac-host-tests-check.ts <report.json>
// Exit 0: both files ran and every case in the report passed. Exit 1: a case was skipped, todo or failed, or a required file
// is missing from the report or ran no case (a file that skips as a whole shows no passed case). Exit 2: the report cannot be read.
// A skip is a failure here: these 2 tests skip on a Linux or case-sensitive host, and a gate that passes with them skipped says nothing.
import { readFileSync } from 'node:fs';
import { isMain } from '../is-main.ts';

export const REQUIRED = ['infra/tests/seed-harold-photos.test.ts', 'infra/tests/render-session.test.ts'] as const;

interface Report { testResults?: { name: string; assertionResults?: { status: string; fullName?: string }[] }[] }

/** The problems the report shows, empty when the gate is green. */
export function judge(report: Report): string[] {
  const files = report.testResults;
  if (!Array.isArray(files)) return ['the report has no testResults'];
  const problems: string[] = [];
  for (const need of REQUIRED) {
    const f = files.find((x) => x.name.endsWith(`/${need}`));
    if (!f) problems.push(`${need} is not in the report`);
    else if (!(f.assertionResults ?? []).some((a) => a.status === 'passed')) problems.push(`${need} ran no passed case`);
  }
  for (const f of files) {
    for (const a of f.assertionResults ?? []) {
      if (a.status !== 'passed') problems.push(`${a.status}: ${f.name.split('/').slice(-3).join('/')} > ${a.fullName ?? '(unnamed)'}`);
    }
  }
  return problems;
}

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  let report: Report;
  try {
    if (!file) throw new Error('usage: mac-host-tests-check.ts <report.json>');
    report = JSON.parse(readFileSync(file, 'utf8')) as Report;
  } catch (e) {
    console.error(`mac-host-tests: cannot read the report: ${(e as Error).message}`);
    process.exit(2);
  }
  const problems = judge(report);
  for (const p of problems) console.error(`mac-host-tests: FAIL ${p}`);
  if (problems.length > 0) process.exit(1);
  const n = (report.testResults ?? []).reduce((sum, f) => sum + (f.assertionResults ?? []).length, 0);
  console.log(`mac-host-tests: PASS ${REQUIRED.length} files, ${n} cases, 0 skipped`);
}
