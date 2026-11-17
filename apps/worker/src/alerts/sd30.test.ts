// SPDX-License-Identifier: AGPL-3.0-or-later
// The alert types of SPECIFICATIONS SD-30 held to the document: the type list and the default switches in code equal the
// table in docs/SPECIFICATIONS.md, so a drift in either fails here. Pure: no database.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ALERT_FACTS, ALERT_TYPES } from '@bw/domain';

// F-1852: docs/SPECIFICATIONS.md is a private path (scripts/private-paths.txt), so a public copy has none and every test here skips
// with a note naming it; the private checkout has it and every test runs.
const SPEC = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'docs', 'SPECIFICATIONS.md');
const noSpec = existsSync(SPEC) ? '' : 'docs/SPECIFICATIONS.md is not in this copy (a private path the public export leaves out)';
const spec = noSpec ? '' : readFileSync(SPEC, 'utf8');
beforeEach((ctx) => {
  if (noSpec) ctx.skip(noSpec);
});

function sd30Rows(): { type: string; cells: string[] }[] {
  const start = spec.indexOf('**SD-30. Alert types.**');
  const end = spec.indexOf('1 open alert per type and subject at a time.', start);
  return spec
    .slice(start, end)
    .split('\n')
    .filter((l) => /^\| `[a-z_]+` \|/.test(l))
    .map((l) => {
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      return { type: cells[0]!.replaceAll('`', ''), cells };
    });
}

describe('SD-30 alert types', () => {
  // why: SD-30, FR-HLTH-4
  it('lists exactly the types of the table, in its order', () => {
    expect(ALERT_TYPES).toEqual(sd30Rows().map((r) => r.type));
  });

  // why: SD-30, FR-HLTH-4
  it('carries the bell and managers\' email defaults of the table for every type', () => {
    for (const row of sd30Rows()) {
      const facts = ALERT_FACTS[row.type as (typeof ALERT_TYPES)[number]];
      expect(facts, row.type).toBeDefined();
      expect([row.type, facts.bell, facts.managersEmail]).toEqual([row.type, row.cells[4] === 'on', row.cells[5] === 'on']);
    }
  });

  // why: SD-30
  it('marks the types the table writes as Info (state Info) as info types', () => {
    const info = sd30Rows().filter((r) => /\(state Info\)/.test(r.cells[1]!)).map((r) => r.type);
    expect(ALERT_TYPES.filter((t) => ALERT_FACTS[t].info)).toEqual(info);
  });
});
