// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling
import { describe, expect, it } from 'vitest';
import { TECH_JOB_CASES, UNCASED, uncoveredStates } from './tech-job-cases.ts';
import type { TechShellCase } from './tech-shell-cases.ts';

// Browser-free: stays in the merge set (the unit-tests gate). The browser test that reads the real frame captions is tech-job.pw.test.ts.
describe('uncoveredStates (the coverage rule of SCR-TEC-04 to -07 and -09)', () => {
  const exempt = Object.keys(UNCASED)[0]!;
  const caseFor = (caption: string): TechShellCase => ({ name: 'planted', frame: 'f.html', captions: [caption], app: '/x', ready: 'body', pairs: [] });

  // why: F-1267 an uncased caption with a named reason is not a gap
  it('lets an exempt caption with no case pass, and names a caption with neither a case nor an exemption', () => {
    expect(uncoveredStates([exempt], TECH_JOB_CASES)).toEqual([]);
    expect(uncoveredStates(['SCR-TEC-05 Add note: Planted state'], TECH_JOB_CASES)).toEqual(['SCR-TEC-05 Add note: Planted state']);
  });

  // why: F-1267 a caption that is both exempt and cased fails, so the entry goes when its owning task builds the case and a later loss of the case goes red
  it('fails an exemption that a case also covers', () => {
    const got = uncoveredStates([exempt], [...TECH_JOB_CASES, caseFor(exempt)]);
    expect(got).toEqual([`UNCASED names a caption a case covers, remove the entry: ${exempt}`]);
  });

  // why: F-1267 no exemption in the committed list is already covered by a committed case
  it('has no stale exemption among the committed cases', () => {
    expect(uncoveredStates([], TECH_JOB_CASES)).toEqual([]);
  });
});
