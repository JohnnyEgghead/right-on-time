// SPDX-License-Identifier: AGPL-3.0-or-later
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** The order the stack files run in: by file name, whatever failed or weighed most last time. */
export const byName = <T extends { moduleId: string }>(files: readonly T[]): T[] => [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));

// F-1334: the 2 stack files share 1 world and run in file-name order (mapme.stack.ts, then steps.stack.ts). vitest's default sequencer runs failed files
// first and then the larger ones, so a red steps.stack.ts moved it ahead of mapme.stack.ts, whose sign-in must start Maria's day before steps replays it.
export class NameSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return byName(files);
  }
}
