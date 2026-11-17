// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IMP-1 (CTL-OFC-13-11: the catalog's estimate is the build-measured import run time, SPECIFICATIONS section 14)
// The estimate line "About N minutes" carries the real import run time recorded in docs/build/spikes/P2-SETUP.md,
// rounded up to 5 minutes, in both languages.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');
// F-1852: docs/build/ is a private path (scripts/private-paths.txt), so in a public copy the test that reads the P2-SETUP record skips
// with a note naming it; the private checkout has it and the test runs.
const noRecord = existsSync(path.join(ROOT, 'docs/build/spikes/P2-SETUP.md')) ? '' : 'docs/build/spikes/P2-SETUP.md is not in this copy (a private path the public export leaves out)';

/** The recorded real run time in seconds, from the record's Measured line. */
export function measuredSeconds(record: string): number {
  const m = /^Measured: real import run median ([\d.]+) s\b/m.exec(record);
  if (!m) throw new Error('docs/build/spikes/P2-SETUP.md has no "Measured: real import run median <n> s" line');
  return Number(m[1]);
}

/** Rounded up to 5 minutes (a run of 0 to 5 minutes reads 5). */
export const roundedUpTo5 = (seconds: number): number => Math.max(5, Math.ceil(seconds / 60 / 5) * 5);

describe('the import estimate line (CTL-OFC-13-11)', () => {
  // why: FR-IMP-1
  it("shows the recorded real import run time rounded up to 5 minutes, in English and Spanish", (ctx) => {
    if (noRecord) ctx.skip(noRecord);
    const minutes = roundedUpTo5(measuredSeconds(read('docs/build/spikes/P2-SETUP.md')));
    const en = (JSON.parse(read('packages/i18n/catalog/en.json')) as Record<string, string>)['admin.import.estimate'];
    const es = (JSON.parse(read('packages/i18n/catalog/es.json')) as Record<string, string>)['admin.import.estimate'];
    expect(en).toBe(`About ${minutes} minutes; the board keeps working.`);
    expect(es).toBe(`Unos ${minutes} minutos; el tablero sigue funcionando.`);
  });

  // why: FR-IMP-1
  it('rounds up, never down: 7.3 s and 5 minutes read 5, 5 minutes and 1 second reads 10, 42 minutes reads 45', () => {
    expect([7.3, 300, 301, 42 * 60].map(roundedUpTo5)).toEqual([5, 5, 10, 45]);
    expect(() => measuredSeconds('Measured: (none)')).toThrow(/no "Measured/);
  });
});
