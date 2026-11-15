// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BaseSequencer } from 'vitest/node';
import config from './vitest.config.ts';
import { byName, NameSequencer } from './sequencer.ts';

const A = '/r/ci/mapme-stack/mapme.stack.ts';
const B = '/r/ci/mapme-stack/steps.stack.ts';

describe('the mapme stack file order', () => {
  // why: F-1334 the 2 stack files share 1 world, so mapme.stack.ts (the sign-in that starts Maria's day) must run before steps.stack.ts, however the last run went
  it('sorts by file name, not by failure or size', async () => {
    expect(byName([{ moduleId: B }, { moduleId: A }]).map((f) => f.moduleId)).toEqual([A, B]);
    const seq = new NameSequencer({} as never);
    expect((await seq.sort([{ moduleId: B }, { moduleId: A }] as never)).map((f) => f.moduleId)).toEqual([A, B]);
  });

  // why: F-1334 the config must name the sequencer: without it vitest runs a failed or larger file first (the red seen after a steps.stack.ts failure)
  it('is what the stack config runs with', () => {
    const seq = (config as { test?: { sequence?: { sequencer?: unknown } } }).test?.sequence?.sequencer;
    expect(seq).toBe(NameSequencer);
    expect(seq).not.toBe(BaseSequencer);
  });
});
