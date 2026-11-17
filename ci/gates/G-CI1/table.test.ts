// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI1 step 1 (no database): the offline conflict table constant (@bw/domain OFFLINE_CONFLICT_TABLE, the only copy
// in code, which the 36 server cases of cells.db.test.ts are generated from) held cell for cell to REQUIREMENTS
// section 4.3's own table, read from the document, so the server cases and the requirement cannot drift apart.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANGE_COLUMNS, conflictVerdict, ITEM_ACTIONS, OFFLINE_CONFLICT_TABLE } from '../../../packages/domain/src/index.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** REQUIREMENTS section 4.3's table, read from the document: row label -> column header -> Apply or Flag. */
export function requirementsTable(text: string): Map<string, Map<string, string>> {
  const start = text.indexOf('**Offline conflict table (FR-TECH-6).**');
  if (start < 0) throw new Error('REQUIREMENTS has no offline conflict table');
  const all = text.slice(start).split('\n');
  const first = all.findIndex((l) => l.startsWith('|'));
  const end = all.findIndex((l, i) => i > first && !l.startsWith('|'));
  const lines = all.slice(first, end);
  const cells = (l: string) => l.split('|').slice(1, -1).map((c) => c.trim());
  const header = cells(lines[0] as string).slice(1);
  const out = new Map<string, Map<string, string>>();
  for (const l of lines.slice(2)) {
    const [label, ...verdicts] = cells(l);
    out.set(label ?? '', new Map(header.map((h, i) => [h, verdicts[i] ?? ''])));
  }
  return out;
}

const ROW_LABEL: Record<string, string> = {
  note: 'Add note', photo: 'Add photo', on_my_way: '"On my way"', arrived: 'Arrived',
  finished: 'Finished, with parts or "No parts used"', no_one_home: '"No one home"',
};
const COLUMN_HEADER: Record<string, string> = {
  no_change: 'No change', details: 'Details only', rescheduled: 'Rescheduled (same technician)',
  assigned: 'Reassigned to another technician', canceled: 'Canceled', status_set: 'Status set by the office',
};

/** Every disagreement between the constant and the document's table. */
export function tableProblems(req: Map<string, Map<string, string>>, verdict: (action: string, column: string) => string): string[] {
  const out: string[] = [];
  const rows = [...req.keys()].sort();
  if (rows.join('|') !== Object.values(ROW_LABEL).sort().join('|')) out.push(`rows differ: ${rows.join(', ')}`);
  for (const action of ITEM_ACTIONS) {
    const row = req.get(ROW_LABEL[action] as string);
    if (!row) continue;
    if ([...row.keys()].sort().join('|') !== Object.values(COLUMN_HEADER).sort().join('|')) out.push(`${action}: columns differ`);
    for (const column of CHANGE_COLUMNS) {
      const want = (row.get(COLUMN_HEADER[column] as string) ?? '').toLowerCase();
      if (verdict(action, column) !== want) out.push(`(${action}, ${column}): constant ${verdict(action, column)}, REQUIREMENTS ${want}`);
    }
  }
  return out;
}

const doc = () => readFileSync(path.join(ROOT, 'docs', 'REQUIREMENTS.md'), 'utf8');
// F-1852: docs/REQUIREMENTS.md is a private path (scripts/private-paths.txt), so in a public copy the tests that read it skip with a
// note naming it; the private checkout has it and they run.
const noRequirements = existsSync(path.join(ROOT, 'docs', 'REQUIREMENTS.md')) ? '' : 'docs/REQUIREMENTS.md is not in this copy (a private path the public export leaves out)';

describe('G-CI1: the conflict table constant equals REQUIREMENTS section 4.3 (FR-TECH-6)', () => {
  // why: FR-TECH-6
  it('agrees cell for cell, 6 rows by 6 columns, with nothing extra on either side', (ctx) => {
    if (noRequirements) ctx.skip(noRequirements);
    expect(tableProblems(requirementsTable(doc()), conflictVerdict)).toEqual([]);
    expect(Object.keys(OFFLINE_CONFLICT_TABLE)).toHaveLength(6);
  });

  // why: F-479
  it('pins the 36 cells: the columns and rows are the document\'s 6 and 6, not whatever the generating lists hold', () => {
    expect([...CHANGE_COLUMNS].sort()).toEqual(Object.keys(COLUMN_HEADER).sort());
    expect([...ITEM_ACTIONS].sort()).toEqual(Object.keys(ROW_LABEL).sort());
    expect(CHANGE_COLUMNS.length * ITEM_ACTIONS.length).toBe(36);
  });

  // why: FR-TECH-6 (must-fail, every run)
  it('reports a planted flipped cell and a planted missing row', (ctx) => {
    if (noRequirements) ctx.skip(noRequirements);
    const flipped = (a: string, c: string) => (a === 'finished' && c === 'assigned' ? 'apply' : conflictVerdict(a, c));
    expect(tableProblems(requirementsTable(doc()), flipped)).toEqual(['(finished, assigned): constant apply, REQUIREMENTS flag']);
    const noArrived = doc().replace(/^\| Arrived \|.*\n/m, '');
    expect(tableProblems(requirementsTable(noArrived), conflictVerdict)[0]).toMatch(/^rows differ/);
  });
});
