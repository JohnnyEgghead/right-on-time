// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1862: a vitest reporter for ci/gates/public-copy-tests.sh step 0. It writes 1 JSON line to the file named by BW_SKIPS_OUT for each test
// that was skipped with a note (ctx.skip(note)): {file, test, note}. The json and junit reporters leave the note out; this one reads it.
import { appendFileSync, writeFileSync } from 'node:fs';

interface SkippedCase {
  fullName: string;
  module: { moduleId: string };
  result(): { state: string; note?: string };
}
interface Module {
  children: { allTests(state: string): Iterable<SkippedCase> };
}

export default class SkipNotesReporter {
  onTestRunEnd(modules: readonly Module[]): void {
    const out = process.env.BW_SKIPS_OUT;
    if (!out) throw new Error('public-copy-skips-reporter: BW_SKIPS_OUT is not set');
    writeFileSync(out, '');
    for (const m of modules) {
      for (const t of m.children.allTests('skipped')) {
        const note = t.result().note ?? '';
        appendFileSync(out, `${JSON.stringify({ file: t.module.moduleId, test: t.fullName, note })}\n`);
      }
    }
  }
}
