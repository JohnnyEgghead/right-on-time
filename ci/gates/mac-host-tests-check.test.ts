// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: K-19 D-34 mac-host-tests: its report checker is red on any skipped, todo or failed case, a missing file or a file that ran none, and green when both Mac-only files ran clean
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { judge, REQUIRED } from './mac-host-tests-check.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'mac-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (need: string, statuses: string[]) => ({
  name: `/w/${need}`,
  assertionResults: statuses.map((status, i) => ({ status, fullName: `case ${i}` })),
});
const clean = () => ({ testResults: REQUIRED.map((n) => file(n, ['passed', 'passed'])) });
const cli = (report: string) => {
  const f = path.join(dir, 'report.json');
  writeFileSync(f, report);
  return spawnSync('node', [path.join(import.meta.dirname, 'mac-host-tests-check.ts'), f], { encoding: 'utf8' });
};

describe('mac-host-tests report check (K-19)', () => {
  // why: K-19 both files ran and every case passed: no problem
  it('is green when both files ran clean', () => {
    expect(judge(clean())).toEqual([]);
  });

  // why: K-19 a skipped case is red, whether in a required file or a planted one (the --plant-skip known-bad)
  it('is red on a skipped or todo case', () => {
    const r = clean();
    r.testResults[0]!.assertionResults.push({ status: 'skipped', fullName: 'planted' });
    expect(judge(r)).toEqual([expect.stringContaining('skipped: ')]);
    const t = clean();
    t.testResults[1]!.assertionResults.push({ status: 'todo', fullName: 'later' });
    expect(judge(t)).toEqual([expect.stringContaining('todo: ')]);
  });

  // why: K-19 a file that skips as a whole (no passed case), a file missing from the report and a failed case are each red
  it('is red on a file with no passed case, a missing file and a failed case', () => {
    const none = clean();
    none.testResults[0]!.assertionResults = [];
    expect(judge(none)).toEqual([`${REQUIRED[0]} ran no passed case`]);
    expect(judge({ testResults: [file(REQUIRED[0], ['passed'])] })).toEqual([`${REQUIRED[1]} is not in the report`]);
    const failed = clean();
    failed.testResults[1]!.assertionResults.push({ status: 'failed', fullName: 'broke' });
    expect(judge(failed)).toEqual([expect.stringContaining('failed: ')]);
    expect(judge({} as never)).toEqual(['the report has no testResults']);
  });

  // why: K-19 the exit codes: 0 clean, 1 a skip, 2 an unreadable report, never a green on a report that cannot be read
  it('exits 0, 1 and 2', () => {
    expect(cli(JSON.stringify(clean())).status).toBe(0);
    const skipped = clean();
    skipped.testResults[0]!.assertionResults.push({ status: 'skipped', fullName: 'planted' });
    const r = cli(JSON.stringify(skipped));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mac-host-tests: FAIL skipped');
    expect(cli('not json').status).toBe(2);
  });
});
