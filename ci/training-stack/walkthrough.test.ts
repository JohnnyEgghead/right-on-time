// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DIST-10, SC-04 (the training sheet and the 10-task walkthrough exist in the release, and the script is built so a run can read its steps)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRAINING_SHEET_PATH, WALKTHROUGH_PATH, parseStep, parseWalkthrough, problems, readWalkthrough, repoRoot } from './walkthrough-steps.ts';

const text = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** The publish set leaves out each line of scripts/private-paths.txt (a directory with a trailing slash, or a file). */
function leftOut(rel: string): boolean {
  return text('scripts/private-paths.txt')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('**/'))
    .some((l) => (l.endsWith('/') ? rel.startsWith(l) : rel === l));
}

describe('the dispatcher training sheet and walkthrough (FR-DIST-10)', () => {
  // why: FR-DIST-10 both files exist in the release: they are in the repository and the publish export does not leave them out
  it('are published files', () => {
    for (const rel of [TRAINING_SHEET_PATH, WALKTHROUGH_PATH]) {
      expect(existsSync(path.join(repoRoot, rel)), rel).toBe(true);
      expect(leftOut(rel), `${rel} is on the private paths list`).toBe(false);
    }
  });

  // why: FR-DIST-10, SC-04 the script holds 10 tasks, each naming the screen it shows and the control it uses, every step in a form the Playwright run can read
  it('the walkthrough has 10 tasks that name their screen and control, in steps a run can read', () => {
    const tasks = readWalkthrough();
    expect(problems(tasks)).toEqual([]);
    expect(tasks.reduce((n, t) => n + t.steps.length, 0)).toBeGreaterThan(40);
  });

  // why: FR-DIST-10 the training sheet lists the same 10 tasks, by the walkthrough's own titles, so the person reads one story
  it('the training sheet lists the 10 tasks of the walkthrough', () => {
    const sheet = text(TRAINING_SHEET_PATH);
    for (const t of readWalkthrough()) expect(sheet, `Task ${t.n}`).toContain(t.title);
    expect(sheet).toContain('walkthrough.md');
  });

  // why: FR-DIST-10 a step that begins with no known verb is an error, and a step out of number is an error: the reader never skips a line it cannot understand
  it('the reader refuses what it cannot read', () => {
    expect(() => parseStep('Wiggle "Reassign".')).toThrow(/no known verb/);
    expect(() => parseWalkthrough('## Task 1. A\nScreen: "A"\nControl: "B"\n2. See "A".')).toThrow(/out of order/);
    expect(problems(parseWalkthrough('## Task 1. A\nScreen: "A"\nControl: "B"\n1. See "A".'))).toEqual(
      expect.arrayContaining([expect.stringContaining('expected 10 tasks'), expect.stringContaining('no step clicks or picks the control "B"')]),
    );
  });
});
